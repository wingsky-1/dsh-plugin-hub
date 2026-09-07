/**
 * dsh-notifier — 审批/完成/错误事件通知（宿主端）。
 *
 * 本文件只做装配：apply + 事件订阅 + 生命周期清理。职责划分：
 * - config.ts          配置契约/默认值/validateSettings/sanitize*Settings/迁移源路径
 * - quiet-hours.ts     免打扰判定（parseHHMM / isInQuietHours）
 * - message.ts         通知文案单表/脱敏/格式化/agent 事件读取（纯函数）
 * - history.ts         通知历史 jsonl 存储（滚动/按天清理/原子写）
 * - settings.ts        官方 settings 命名空间接线（installNotifierSettings，issue #76）
 * - settings-bridge.ts settings 状态镜像维护、读写通道与存量迁移（#592）
 * - outbound.ts        出站频道解析与限流门管理（#592）
 * - event-handlers.ts  审批/完成/错误/会话事件处理与判定状态机（#592）
 * - migrate.ts         存量自建 json 一次性迁移（E1-E7/R1）
 * - server.ts          SSE 枢纽 + 系统通知通道 + HTTP 路由
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-user-approval";
import { errorMessage } from "../../../shared/host-utils.js";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  configFile,
  historyFile,
  statusFile,
  normalizeConfig,
  sanitizeSettings,
  toastScriptPath,
  resolveSoundSetting,
} from "./config.ts";
import type { NotifierApplyConfig, NotifyConfig } from "./config.ts";
import { isInQuietHours } from "./quiet-hours.ts";
import { HISTORY_LIMIT, createHistoryStore } from "./history.ts";
import { createDoneBatcher } from "./aggregate.ts";
import type { DoneBatcher } from "./aggregate.ts";
import { sanitizeErrorText, sessionTitleOf, isSubagentOf, lastTurnEndOf } from "./message.ts";
import type { NotifyDetail, SubagentOwnership } from "./message.ts";
import { SETTINGS_NS, installNotifierSettings } from "./settings.ts";
import { migrateLegacyConfig } from "./migrate.ts";
import { ROUTES, buildRoutes, createSseHub, createSystemNotifier } from "./server.ts";
import { createNotifierService } from "./service.ts";
import type { NotifierServiceInternal, NotifyChannel, NotifySentEvent } from "./service.ts";
import { createStatusStore } from "./status.ts";
import { createBarkChannel, createBarkGate } from "./channel-bark.ts";
import { createWebhookChannel } from "./channel-webhook.ts";
import { createSettingsBridge } from "./settings-bridge.ts";
import { createOutboundChannelResolver } from "./outbound.ts";
import { createEventHandlers } from "./event-handlers.ts";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 需要的服务：webServer（路由）。 */
export const inject = ["webServer"];

// ---------------------------------------------------------------- 导出面
// 公共符号定义在各职责模块，此处统一 re-export——包导出面与拆分前完全一致。

export { QUIET_ALLOW_KINDS, isInQuietHours, parseHHMM } from "./quiet-hours.ts";
export type { QuietHoursConfig } from "./quiet-hours.ts";
export {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  ASSEMBLY_SETTING_KEYS,
  configFile,
  historyFile,
  statusFile,
  normalizeConfig,
  sanitizeSettings,
  sanitizePatchSettings,
  validateSettings,
  toastScriptPath,
  normalizeBarkBaseUrl,
  normalizeBarkLevels,
  redactConfigView,
  unmaskChannels,
  SECRET_MASK,
  BARK_ID_PATTERN,
  BARK_RESERVED_KEYS,
  SOUND_IDS,
  isSoundSetting,
  resolveSoundSetting,
} from "./config.ts";
export type { NotifierApplyConfig, NotifyConfig, SettingInvalid, BarkChannelConfig, BarkLevel, SoundId, SoundSetting, SoundChannel } from "./config.ts";
export { HISTORY_LIMIT } from "./history.ts";
export { SETTINGS_NS, installNotifierSettings } from "./settings.ts";
export { migrateLegacyConfig, MIGRATED_BAK_SUFFIX, CORRUPTED_BAK_SUFFIX } from "./migrate.ts";
export { createStatusStore } from "./status.ts";
export type { StatusStore, ChannelStatusEntry } from "./status.ts";
export {
  createBarkChannel,
  createBarkGate,
  SEVERITY_LEVEL,
  BARK_TIMEOUT_MS,
  BARK_RETRIES,
  BARK_MAX_INFLIGHT,
} from "./channel-bark.ts";
export {
  createWebhookChannel,
  renderWebhookBody,
  priorityFor,
  SEVERITY_NTFY_PRIORITY,
  SEVERITY_GOTIFY_PRIORITY,
  WEBHOOK_DEFAULT_TIMEOUT_SEC,
  WEBHOOK_MIN_TIMEOUT_SEC,
  WEBHOOK_MAX_TIMEOUT_SEC,
} from "./channel-webhook.ts";
export type { MigrationOutcome } from "./migrate.ts";
export {
  buildSystemCommand,
  buildSoundCommand,
  formatDuration,
  isSubagentOf,
  lastTurnEndOf,
  prettyToolName,
  sanitizeErrorText,
  sessionTitleOf,
  MAC_SOUND_NAMES,
  LINUX_TONE_FILES,
  LINUX_DEFAULT_TONE_FILE,
  WIN_TONE_FILES,
  TONE_BASE_DIRS,
  toneFileCandidates,
} from "./message.ts";
export type { NotifyDetail, SystemTone } from "./message.ts";
export { ROUTES, applyConfigPatch } from "./server.ts";
export type { PatchResult, RouteDeps } from "./server.ts";
export {
  BUILTIN_CHANNELS,
  KIND_SEVERITY,
  createNotifierService,
  getNotifierService,
} from "./service.ts";
export type {
  ChannelCapabilities,
  KindRegistration,
  NotifyChannel,
  NotifyRequest,
  NotifyResult,
  NotifierService,
  NotifierServiceDeps,
  NotifierServiceInternal,
  NotifySeverity,
} from "./service.ts";

export { createSettingsBridge } from "./settings-bridge.ts";
export type { SettingsBridge } from "./settings-bridge.ts";
export { createEventHandlers } from "./event-handlers.ts";
export type { EventHandlers, EventHandlersDeps } from "./event-handlers.ts";

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readBody / errorMessage）。
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";

function resolveStorePaths(config: NotifierApplyConfig) {
  return {
    toastScript: typeof config.toastScript === "string" ? config.toastScript : toastScriptPath(),
    historyPath: typeof config.historyFile === "string" ? config.historyFile : historyFile(),
    statusPath: typeof config.statusFile === "string" ? config.statusFile : statusFile(),
  };
}

function safeDisposeAll(disposers: Array<() => void>): void {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // 忽略
    }
  }
}

function createSentEmitter(ctx: Context): (payload: NotifySentEvent) => void {
  return function emitSent(payload: NotifySentEvent): void {
    try {
      (ctx as unknown as { emit?: (name: string, ...args: unknown[]) => void }).emit?.("wingsky-notify/sent", payload);
    } catch {
      // 事件派发失败不影响投递语义（终态仍可见于 status 文件与历史）
    }
  };
}

/**
 * 挂载 dsh-notifier。
 * @param ctx 宿主插件上下文。
 * @param config 配置（enabled / configFile 迁移源 / toastScript 覆盖）。
 */
export function apply(ctx: Context, config: NotifierApplyConfig = {}): void {
  const settingsBridge = createSettingsBridge(ctx, config);
  const currentConfig = settingsBridge.getCurrent;

  const { toastScript, historyPath, statusPath } = resolveStorePaths(config);

  const sse = createSseHub({ getMaxConnections: () => currentConfig().maxConnections });
  const system = createSystemNotifier({
    toastScript,
    warn: (message) => ctx.logger.warn(message),
  });
  const historyStore = createHistoryStore({
    file: historyPath,
    maxAgeDays: () => currentConfig().historyMaxAgeDays,
    warn: (message) => ctx.logger.warn(message),
  });
  const statusStore = createStatusStore({
    file: statusPath,
    warn: (message) => ctx.logger.warn(message),
  });

  const outboundChannels = createOutboundChannelResolver(() => currentConfig().channels);
  const emitSent = createSentEmitter(ctx);

  const notifierService: NotifierServiceInternal = createNotifierService({
    current: currentConfig,
    enabled: () => config.enabled !== false,
    sse,
    system,
    history: historyStore,
    logger: ctx.logger,
    outboundChannels,
    recordStatus: (channelId, status, error) => statusStore.record(channelId, status, error),
    emitSent,
    setConfirm: (kind, confirmed) => {
      settingsBridge.confirmKindToConfig(kind, confirmed).catch((err) => {
        ctx.logger.warn(`dsh-notifier: kind 确认写入失败 — ${errorMessage(err)}`);
      });
    },
  });

  if (typeof (ctx as unknown as { provide?: unknown }).provide === "function") {
    (ctx as unknown as { provide: (name: string, svc: unknown) => void }).provide("wingsky.notifier", notifierService);
  }

  function notify(kind: string, detail: NotifyDetail = {}): boolean {
    const results = notifierService.sendKind(kind, detail);
    return results.some((r) => r.status === "ok");
  }

  const doneBatcher: DoneBatcher = createDoneBatcher({
    getWindowMs: () => currentConfig().doneMergeWindowMs,
    notify,
  });

  const eventHandlers = createEventHandlers({
    getConfig: currentConfig,
    notify,
    appendHistory: (entry) => historyStore.append(entry),
    doneBatcher,
    logger: ctx.logger,
    getAgents: () =>
      typeof ctx.get === "function" ? (ctx.get("agents", false) as SubagentOwnership | undefined) : undefined,
    getUserQuestionsService: () =>
      typeof ctx.get === "function" ? (ctx.get("userQuestions", false) as { ask?: unknown } | undefined) : undefined,
  });

  eventHandlers.hookUserQuestions();

  const disposers: Array<() => void> = [
    ctx.on("approval/request", (req, next) => eventHandlers.handleApprovalRequest(req, next), { global: true, prepend: true }),
    ctx.on("internal/service", (name) => eventHandlers.handleInternalService(name), { global: true }),
    ctx.on("session/event", (session, event) => eventHandlers.handleSessionEvent(session, event), { global: true }),
    ctx.on("agent/status", (payload) => eventHandlers.handleAgentStatus(payload), { global: true }),
    ctx.on("agent/disposed", (payload) => eventHandlers.handleAgentDisposed(payload), { global: true }),
    ctx.on("agent/error", (payload) => eventHandlers.handleAgentError(payload), { global: true }),
    ctx.on("agent/turn-stopping", (payload) => eventHandlers.handleAgentTurnStopping(payload), { global: true }),
  ];

  const routes = buildRoutes({
    resolve: currentConfig,
    readUser: settingsBridge.readUser,
    writable: settingsBridge.isWritable,
    update: settingsBridge.updateConfig,
    logger: ctx.logger,
    sse,
    system,
    history: historyStore,
    sendTest: (channelId?: string) =>
      notifierService.sendKind("test", {}, { bypassQuiet: true, onlyChannel: channelId }),
    statusReader: () => statusStore.read(),
    listKinds: () => notifierService.listKinds(),
    setConfirm: settingsBridge.confirmKindToConfig,
  });

  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = routes.map((route) => ctx.webServer.register(route));
      return () => safeDisposeAll(routeDisposers);
    },
    "dsh-notifier: routes",
  );

  ctx.effect(
    () => () => {
      sse.dispose();
      eventHandlers.dispose();
      doneBatcher.dispose();
      safeDisposeAll(disposers);
      disposeRoutes();
    },
    "dsh-notifier",
  );
}
