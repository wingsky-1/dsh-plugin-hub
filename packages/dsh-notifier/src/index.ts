/**
 * dsh-notifier — 审批/完成/错误事件通知（宿主端）。
 *
 * 本文件只做装配：apply + 事件订阅 + 生命周期清理；唯一允许 import 全部域
 * interface.ts 的汇聚点（§3 门面纪律）。职责划分按目标目录树：
 * - config/      配置契约/归一化/校验/脱敏/路径/免打扰/settings 接线/桥/迁移
 * - text/        文案单表/脱敏/格式化/系统命令构造（纯函数）
 * - channels/    内置与配置驱动频道（browser/system/bark/webhook/outbound）
 * - server/      SSE 枢纽/系统通知通道/HTTP 路由
 * - pipeline/    裁决与投递纯函数（PR1 机械提炼；PR2 行为重构）
 * - sdk/         通知中心 service（对外 ABI 实现）
 * - events/      事件处理器/完成聚合/会话读取
 * - stores/      历史 jsonl / 投递状态存储
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-user-approval";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../../../shared/host-utils.js";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  SETTINGS_NS,
  configFile,
  createSettingsBridge,
  historyFile,
  installNotifierSettings,
  isInQuietHours,
  migrateLegacyConfig,
  normalizeConfig,
  resolveSoundSetting,
  sanitizeSettings,
  seqFile,
  statusFile,
  toastScriptPath,
} from "./config/interface.ts";
import type { NotifierApplyConfig, NotifyConfig } from "./config/interface.ts";
import { HISTORY_LIMIT, createHistoryStore, createStatusStore } from "./stores/interface.ts";
import { createDoneBatcher, createEventHandlers } from "./events/interface.ts";
import type { DoneBatcher, SubagentOwnership } from "./events/interface.ts";
import { sanitizeErrorText } from "./text/interface.ts";
import type { NotifyDetail } from "./text/interface.ts";
import { ROUTES, buildRoutes, createSseHub, createSystemNotifier } from "./server/interface.ts";
import { BUILTIN_CHANNELS, createNotifierService } from "./sdk/interface.ts";
import type { NotifierServiceInternal, NotifySentEvent } from "./sdk/interface.ts";
import type { BrowserDispatchSpec, DeliverPayload, ResolvedTarget, SystemDispatchSpec } from "./pipeline/interface.ts";
import { buildBrowserFrame, createBarkChannel, createBrowserChannel, createOutboundChannelResolver, createSystemChannel, createWebhookChannel } from "./channels/interface.ts";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 需要的服务：webServer（路由）。 */
export const inject = ["webServer"];

// ---------------------------------------------------------------- 导出面
// 公共符号定义在各域，此处统一 re-export（全部经域 interface.ts 收口）——
// 包导出面与拆分前完全一致（导出面快照门禁零 diff）。

export { QUIET_ALLOW_KINDS, isInQuietHours, parseHHMM } from "./config/interface.ts";
export type { QuietHoursConfig } from "./config/interface.ts";
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
} from "./config/interface.ts";
export type { NotifierApplyConfig, NotifyConfig, SettingInvalid, BarkChannelConfig, BarkLevel, SoundId, SoundSetting, SoundChannel } from "./config/interface.ts";
export { HISTORY_LIMIT } from "./stores/interface.ts";
export { SETTINGS_NS, installNotifierSettings } from "./config/interface.ts";
export { migrateLegacyConfig, MIGRATED_BAK_SUFFIX, CORRUPTED_BAK_SUFFIX } from "./config/interface.ts";
export { createStatusStore } from "./stores/interface.ts";
export type { StatusStore, ChannelStatusEntry } from "./stores/interface.ts";
export {
  createBarkChannel,
  SEVERITY_LEVEL,
  BARK_TIMEOUT_MS,
} from "./channels/interface.ts";
export {
  createWebhookChannel,
  renderWebhookBody,
  priorityFor,
  SEVERITY_NTFY_PRIORITY,
  SEVERITY_GOTIFY_PRIORITY,
  WEBHOOK_DEFAULT_TIMEOUT_SEC,
  WEBHOOK_MIN_TIMEOUT_SEC,
  WEBHOOK_MAX_TIMEOUT_SEC,
} from "./channels/interface.ts";
// PR2（D23）：浏览器通知帧纯构造（播放层经 DeliverDeps.play 消费；有意新增导出）
export { buildBrowserFrame } from "./channels/interface.ts";
export type { MigrationOutcome } from "./config/interface.ts";
export {
  buildSystemCommand,
  buildSoundCommand,
  formatDuration,
  prettyToolName,
  sanitizeErrorText,
  MAC_SOUND_NAMES,
  LINUX_TONE_FILES,
  LINUX_DEFAULT_TONE_FILE,
  WIN_TONE_FILES,
  TONE_BASE_DIRS,
  toneFileCandidates,
} from "./text/interface.ts";
export type { NotifyDetail, SystemTone } from "./text/interface.ts";
export { isSubagentOf, lastTurnEndOf, sessionTitleOf } from "./events/interface.ts";
export { ROUTES, applyConfigPatch } from "./server/interface.ts";
export type { PatchResult, RouteDeps } from "./server/interface.ts";
export { KIND_SEVERITY } from "./text/interface.ts";
export {
  BUILTIN_CHANNELS,
  createNotifierService,
  getNotifierService,
} from "./sdk/interface.ts";
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
} from "./sdk/interface.ts";

export { createSettingsBridge } from "./config/interface.ts";
export type { SettingsBridge } from "./config/interface.ts";
export { createEventHandlers } from "./events/interface.ts";
export type { EventHandlers, EventHandlersDeps } from "./events/interface.ts";

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readBody / errorMessage）。
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";

function resolveStorePaths(config: NotifierApplyConfig) {
  const statusPath = typeof config.statusFile === "string" ? config.statusFile : statusFile();
  // R-6/D22 选项 A：seq 计数器随 status 文件同目录（statusFile 覆盖时测试经
  // mkdtemp 隔离；未覆盖时 dirname(statusPath)=DSH_HOME，本公式即 seqFile()）。
  const seqPath = join(dirname(statusPath), basename(seqFile()));
  return {
    toastScript: typeof config.toastScript === "string" ? config.toastScript : toastScriptPath(),
    historyPath: typeof config.historyFile === "string" ? config.historyFile : historyFile(),
    statusPath,
    seqPath,
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

  const { toastScript, historyPath, statusPath, seqPath } = resolveStorePaths(config);

  // R-6/D22 选项 A：seq 计数器持久化注入（服务端重启续计数，客户端零改动）。
  // 缺文件 = 首启静默回退 0；损坏 = warn + 回退 0（宁可归零不可卡死续计数面）。
  // 写面为同步 tmp+rename 原子写——createSseHub 的 dispose 同步落盘依赖此同步性
  // （正常停止零丢失；kill -9 崩溃窗口 ≤ 500ms 防抖窗口，R-6 已登记）。
  function loadSeq(): number {
    try {
      const parsed = JSON.parse(readFileSync(seqPath, "utf8")) as unknown;
      if (typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 && Number.isInteger(parsed)) return parsed;
      ctx.logger.warn(`dsh-notifier: seq 计数文件损坏，回退 0：${seqPath}`);
      return 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") ctx.logger.warn(`dsh-notifier: seq 计数文件读取失败，回退 0：${errorMessage(error)}`);
      return 0;
    }
  }
  function saveSeq(seq: number): void {
    try {
      const tmp = `${seqPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
      writeFileSync(tmp, String(seq), "utf8");
      renameSync(tmp, seqPath);
    } catch (error) {
      ctx.logger.warn(`dsh-notifier: seq 计数写入失败: ${errorMessage(error)}`);
    }
  }

  const sse = createSseHub({
    getMaxConnections: () => currentConfig().maxConnections,
    loadSeq,
    saveSeq,
  });
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

  // PR2（D23）：内置频道实例经装配层创建（实例只承载 id+capabilities 入投递池），
  // 播放决议随裁决快照解析并经 DeliverDeps.play 值传递——browser→SSE 帧、
  // system→system.notify（spec.pop/spec.sound；notify resolve false → throw →
  // 终态 failed，对照落位前的 dispatchSystem 语义，B4）。
  const browserChannel = createBrowserChannel({ sse });
  const systemChannel = createSystemChannel({ system });

  const notifierService: NotifierServiceInternal = createNotifierService({
    current: currentConfig,
    enabled: () => config.enabled !== false,
    history: historyStore,
    logger: ctx.logger,
    outboundChannels,
    builtinChannels: [
      { id: BUILTIN_CHANNELS.browser, channel: browserChannel },
      { id: BUILTIN_CHANNELS.system, channel: systemChannel },
    ],
    recordStatus: (channelId, status, error) => statusStore.record(channelId, status, error),
    emitSent,
    setConfirm: (kind, confirmed) => {
      settingsBridge.confirmKindToConfig(kind, confirmed).catch((err) => {
        ctx.logger.warn(`dsh-notifier: kind 确认写入失败 — ${errorMessage(err)}`);
      });
    },
    play: (target: ResolvedTarget, payload: DeliverPayload) => {
      if (target.id === BUILTIN_CHANNELS.browser) {
        sse.broadcast(buildBrowserFrame(payload, target.dispatch as BrowserDispatchSpec));
        return undefined;
      }
      const spec = target.dispatch as SystemDispatchSpec;
      return system.notify(spec.pop, spec.sound, payload.title, payload.body).then((ok) => {
        if (!ok) throw new Error("system notification failed (self-play or command error)");
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