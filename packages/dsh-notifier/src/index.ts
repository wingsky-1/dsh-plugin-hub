/**
 * dsh-notifier — 审批/完成/错误事件通知（宿主端）。
 *
 * 本文件只做装配：apply + 事件订阅 + 生命周期清理。职责划分：
 * - config.ts      配置契约/默认值/validateSettings/sanitizeSettings/迁移源路径
 * - quiet-hours.ts 免打扰判定（parseHHMM / isInQuietHours）
 * - message.ts     通知文案单表/脱敏/格式化/agent 事件读取（纯函数）
 * - history.ts     通知历史 jsonl 存储（滚动/按天清理/原子写）
 * - settings.ts    官方 settings 命名空间接线（installNotifierSettings，issue #76）
 * - migrate.ts     存量自建 json 一次性迁移（E1-E7/R1）
 * - server.ts      SSE 枢纽 + 系统通知通道 + HTTP 路由
 *
 * 配置（issue #76）：官方 settings 命名空间为唯一事实源（settings.yaml 单一
 * 存储）；组合层通知配置作为命名空间 base 层；旧 `~/.dsh/dsh-notifier.json`
 * 启动时一次性迁移（改名 .migrated.bak / 损坏 .corrupted.bak）。enabled 为
 * 组合层开关：禁用态仍注册路由+命名空间+迁移（H2/H3），notify() 入口判定。
 * 读取面经描述器（describe redactSecrets）取 user/revision，写入面经
 * service.update(ns, patch, expectedRevision) 乐观并发。
 *
 * 事件源（均经源码核验）：
 * - 审批请求：approval/request waterfall（ApprovalService.request 派发；
 *   真实触发方为沙箱提权 / 动态插件激活等。tools/pre-execute 的 gate ask
 *   在当前 DSH 部署中无产生者，不可用）。在 next() 之前通知（next 阻塞到
 *   用户审批结束），不短路
 * - 任务完成：agent/status（scoped emit，{agent, status}，idle | running）
 *   running → idle 跃迁，per-agent 状态机，多会话互不误报；子代理
 *   （origin === 'subagent'，或 fork 型委派且运行时归属成立——见 message.ts
 *   isSubagentOf 双信号注释）走独立开关/事件类型 subagent-done；
 *   用户暂停/中断（turn/end reason aborted）固定静默。
 *   完成判定为单源 push + 快照兜底（issue #290 阶段二）：idle 判定以
 *   session/event 推送流记忆（eventStreamEnds，post-commit 同步派发、恒定
 *   新鲜）为主证据源；快照回读（lastTurnEndOf）仅在 push 缺失（插件中途
 *   挂载 / 重载窗口内已派发但新 fiber 未记忆）时作兜底——快照一次性读滞后
 *   不再被 lastEndedTurn 固化为永久静默；同一 turn 两源汇合于同一判定点，
 *   天然只通知一次。abort-early（本轮无新 closure）陈旧快照经 running 基线
 *   守卫拦截，不误报完成。跳过路径输出可观测 warn（标识证据来源）。
 * - 任务错误：agent/error（{agent, turn, step, error}），60 秒滚动窗口合并
 * - 轮结束：agent/turn-stopping（serial，{agent, turn}，仅宿主通知，不跑模型）
 * - 会话销毁：agent/disposed（清理 per-agent 状态）
 *
 * 通道：
 * - 系统通知：Windows PowerShell WinRT toast（lib/toast.ps1，零依赖）；
 *   Linux/macOS 用 notify-send（存在才调用）；均失败则仅记录日志
 * - 浏览器通知：SSE（text/event-stream，mcp-manager 同款模式）推帧，
 *   客户端 Notification API 展示（页面隐藏时）
 *
 * 配置路径（issue #76 后）：官方 settings 命名空间（设置 → 插件 → dsh-notifier
 * 卡片 PUT /config 写，落盘官方 settings.yaml）；旧 ~/.dsh/dsh-notifier.json 仅
 * 作为存量迁移源，迁移后改名归档，不再读写。
 * 安全：通知文本只含工具名/会话标识/申请理由等元信息，不含工具参数（防敏感信息外泄）。
 */
// 官方类型层（issue #16，锁 0.1.1-rc.2；仅 import type，编译期擦除，
// 禁止运行时值导入——contract-check 有门禁）。session/title 事件键由
// dsh-session-title 经 declare module 注入 SessionEventMap，必须引入其类型面。
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-user-approval";
import { errorMessage } from "../../../shared/host-utils.js";
import { CONFIG_KEYS, DEFAULT_CONFIG, configFile, historyFile, normalizeConfig, sanitizeSettings, toastScriptPath } from "./config.ts";
import type { NotifierApplyConfig, NotifyConfig } from "./config.ts";
import { isInQuietHours } from "./quiet-hours.ts";
import { HISTORY_LIMIT, createHistoryStore } from "./history.ts";
import { createDoneBatcher } from "./aggregate.ts";
import type { DoneBatcher } from "./aggregate.ts";
import { sanitizeErrorText, sessionTitleOf, isSubagentOf, lastTurnEndOf } from "./message.ts";
import type { NotifyDetail } from "./message.ts";
import { SETTINGS_NS, installNotifierSettings } from "./settings.ts";
import type { OwnerScopeLike, SettingsServiceLike } from "./settings.ts";
import { migrateLegacyConfig } from "./migrate.ts";
import { ROUTES, buildRoutes, createSseHub, createSystemNotifier } from "./server.ts";
import { createNotifierService } from "./service.ts";
import type { NotifierServiceInternal } from "./service.ts";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 需要的服务：webServer（路由）。 */
export const inject = ["webServer"];

// ---------------------------------------------------------------- 导出面
// 公共符号定义在各职责模块，此处统一 re-export——包导出面与拆分前完全一致。

export { QUIET_ALLOW_KINDS, isInQuietHours, parseHHMM } from "./quiet-hours.ts";
export type { QuietHoursConfig } from "./quiet-hours.ts";
export { CONFIG_KEYS, DEFAULT_CONFIG, configFile, historyFile, normalizeConfig, sanitizeSettings, validateSettings, toastScriptPath } from "./config.ts";
export type { NotifierApplyConfig, NotifyConfig, SettingInvalid } from "./config.ts";
export { HISTORY_LIMIT } from "./history.ts";
export { SETTINGS_NS, installNotifierSettings } from "./settings.ts";
export { migrateLegacyConfig, MIGRATED_BAK_SUFFIX, CORRUPTED_BAK_SUFFIX } from "./migrate.ts";
export type { MigrationOutcome } from "./migrate.ts";
export {
  buildSystemCommand,
  formatDuration,
  isSubagentOf,
  lastTurnEndOf,
  prettyToolName,
  sanitizeErrorText,
  sessionTitleOf,
} from "./message.ts";
export type { NotifyDetail } from "./message.ts";
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

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readBody / errorMessage）。
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";

/**
 * 挂载 dsh-notifier。
 * @param ctx 宿主插件上下文。
 * @param config 配置（enabled / configFile 迁移源 / toastScript 覆盖）。
 */
export function apply(ctx: Context, config: NotifierApplyConfig = {}): void {
  // 组合层通知配置（settings 命名空间的 base 层；enabled 是组合层开关，不进
  // user 层）。注意：应用配置现在只读 settings 命名空间解析值 + 本 entry。
  const entry = (sanitizeSettings(config) ?? {}) as Record<string, unknown>;
  const storeFile = typeof config.configFile === "string" ? config.configFile : configFile();
  const toastScript = typeof config.toastScript === "string" ? config.toastScript : toastScriptPath();
  const historyPath = typeof config.historyFile === "string" ? config.historyFile : historyFile();

  /**
   * 当前配置（运行时镜像，与 settings 命名空间解析值保持同步）。
   * settings attach 后由 setSource 指向 scope.get()，变更经 onChange 刷新；
   * 服务缺失时回落组合层 entry（normalizeConfig 兜底默认值）。
   */
  let current: NotifyConfig = normalizeConfig(entry);
  /** settings 读取来源 thunk（attach 后为 scope.get()）。 */
  let source: () => NotifyConfig = () => current;
  /** settings 服务 attach 状态（writable / readUser 依据）。 */
  let attachedService: SettingsServiceLike | undefined;
  /** attach 后的 owner scope（迁移写入面）。 */
  let attachedScope: OwnerScopeLike | undefined;
  /** 读取 settings user 层（描述器 redactSecrets 后取 user/revision）。 */
  function readUser(): { user: Record<string, unknown>; revision?: number } {
    if (!attachedService) return { user: {}, revision: undefined };
    try {
      const descriptor = attachedService.describe({ redactSecrets: true }).find((d) => d.ns === SETTINGS_NS);
      return {
        user: (descriptor?.user && typeof descriptor.user === "object" ? descriptor.user : {}) as Record<string, unknown>,
        revision: descriptor?.revision,
      };
    } catch {
      return { user: {}, revision: undefined };
    }
  }

  // ------------------------------------------------------------ 组装各职责模块

  const sse = createSseHub({ getMaxConnections: () => current.maxConnections });
  const system = createSystemNotifier({
    getSoundEnabled: () => current.notifySound,
    toastScript,
    warn: (message) => ctx.logger.warn(message),
  });
  const historyStore = createHistoryStore({
    file: historyPath,
    maxAgeDays: () => current.historyMaxAgeDays,
    warn: (message) => ctx.logger.warn(message),
  });

  // ------------------------------------------------------------ 通知中心 service（M1）

  /**
   * 通知中心核心服务：'wingsky.notifier'（M1，issue #366）。
   * - 内置事件源经 service.sendKind 走完整文案管线（等价搬移前 notify 语义）；
   * - 外部调用方（hub 插件）经 ctx['wingsky.notifier'].send 发送（缺省广播）；
   * - 动态 kind 注册 → 待确认 → 确认后放行（suppressed 落史复用免打扰路径）。
   * 依赖注入与旧装配层完全同源（sse/system/history/current/enabled），
   * 无新状态面；卸载随 fiber disposer 统一清理（service 本身无定时器）。
   */
  const notifierService: NotifierServiceInternal = createNotifierService({
    current: () => current,
    enabled: () => config.enabled !== false,
    sse,
    system,
    history: historyStore,
    logger: ctx.logger,
  });
  // 暴露服务（官方 storageDomain 模式，mcp-manager 同款）：fake ctx 无 provide
  // 时静默降级（单测 mock 兼容）。重复 provide 同名服务 cordis 会抛错——本插件
  // 单实例无竞态；若出现，属装配错误应显式失败。
  if (typeof (ctx as unknown as { provide?: unknown }).provide === "function") {
    (ctx as unknown as { provide: (name: string, svc: unknown) => void }).provide("wingsky.notifier", notifierService);
  }

  /** 通知历史追加（fire-and-forget 落盘，见 history.ts）。 */
  function appendHistory(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }) {
    historyStore.append(entry);
  }

  // ------------------------------------------------------------ 通知主入口

  /**
   * 通知入口（M1：委托通知中心 service，行为与搬移前完全一致）。
   * - enabled 总开关（H3）、免打扰检查（suppressed 落史）、fail-soft 逐频道
   *   分发、历史落盘全部收敛到 service.sendKind（单一管线，评审 #1）；
   * - 返回 boolean 语义保持：results 中存在任一 ok 频道 = 真正发出。
   * @param kind ask / done / error / turn-end 等内置 kind。
   * @param detail {tool?, taskTitle?, reason?, durationMs?, turn?, step?, message?, mergedCount?}（不含工具参数）。
   */
  function notify(kind: string, detail: NotifyDetail = {}): boolean {
    const results = notifierService.sendKind(kind, detail);
    return results.some((r) => r.status === "ok");
  }

  // ------------------------------------------------------------ 事件监听

  const disposers: Array<() => void> = [];

  /**
   * 任务完成状态机（per-agent）：见到某会话 running 记 pendingDone，下次该会话
   * idle 时判定是否通知（带耗时）。多会话/子代理各自独立跟踪，互不误报。
   * 子代理（isSubagentOf 双信号：origin === 'subagent' 或 fork 型委派运行时
   * 归属成立）走独立开关 notifySubagentDone 与独立事件类型 subagent-done；
   * 用户暂停/中断（turn/end reason aborted）固定静默。
   */
  const agentStates = new Map<string, { runningSeen: boolean; startedAt: number; lastEndedTurn?: number; runningBaseline?: { turn: number; kind: string } }>(); // agentId -> { runningSeen, startedAt, lastEndedTurn, runningBaseline }

  /**
   * 审批请求：approval/request waterfall（源码核验：真实审批由 dsh-sandbox
   * 提权 / 动态插件激活等调用 ApprovalService.request 触发；tools/pre-execute
   * 的 gate ask 在当前 DSH 部署中无产生者，故不挂那里）。在 await next()
   * 之前通知——next() 会阻塞到用户审批结束，这正是"等待审批"提醒的时机；
   * 不短路，返回 next() 结果。
   */
  /** 审批超时二次提醒：per-request 定时器表；next() settle（用户已决定）即清除。 */
  const askRemindTimers = new Map<string, NodeJS.Timeout>();

  disposers.push(
    ctx.on("approval/request", async (req, next) => {
      if (!current.notifyAsk) return next();
      const askDetail = () => ({
        tool: req?.toolName as string | undefined,
        taskTitle: sessionTitleOf(req?.agent),
        // 审批理由最常内嵌命令回显与凭据片段，进通知前必须脱敏（120 字符截断）
        reason: req?.reason ? sanitizeErrorText(req.reason, 120) : undefined,
      });
      try {
        notify("ask", askDetail());
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: approval/request 通知失败: ${errorMessage(error)}`);
      }
      // 审批超时二次提醒（askRemindMin 分钟未响应再弹一条，正文带已等待时长）。
      // DSH 无 "approval/decided" 的 cordis 事件可监听——审批结束的唯二信号是
      // next() Promise 的决议/拒绝（对抗评审共识③），故定时器绑定 next() settle。
      const askKey = req?.agent?.id ?? String(req?.toolName ?? "?");
      if (current.askRemindMin > 0) {
        const timer = setTimeout(() => {
          if (askRemindTimers.get(askKey) === timer) {
            askRemindTimers.delete(askKey);
            try {
              notify("ask", { ...askDetail(), remindMinutes: current.askRemindMin });
            } catch (error) {
              ctx.logger.warn(`dsh-notifier: 审批超时提醒失败: ${errorMessage(error)}`);
            }
          }
        }, current.askRemindMin * 60000);
        timer.unref(); // 不阻止进程退出（服务有主循环；测试环境不挂死）
        askRemindTimers.set(askKey, timer);
      }
      try {
        return await next();
      } finally {
        const t = askRemindTimers.get(askKey);
        if (t !== undefined) {
          clearTimeout(t);
          askRemindTimers.delete(askKey);
        }
      }
    }, { global: true })
  );

  /**
   * 用户提问通知：dsh-user-questions 的 service 不发出任何 cordis 事件
   * （ask() 直连 UI provider），故包装 service 的 ask 方法补发通知。
   * 热重载安全：svc.ask 上若残留上一 fiber 的包装（__dshNotifierWrapped），
   * 先解包取原始实现再包装——保证包装始终指向当前 fiber 的 SSE 连接，
   * 避免旧包装广播到已失效连接导致「历史有记录但收不到提醒」。
   */
  /** userQuestions service 的 ask 方法（含热重载解包字段）。 */
  interface AskFunction {
    (request: unknown): Promise<unknown>;
    __dshNotifierWrapped?: boolean;
    __dshNotifierOriginal?: AskFunction;
  }

  function hookUserQuestions() {
    let svc: { ask?: unknown } | undefined;
    try {
      svc = typeof ctx.get === "function" ? (ctx.get("userQuestions", false) as { ask?: unknown } | undefined) : undefined;
    } catch {
      svc = undefined;
    }
    if (!svc || typeof svc.ask !== "function") return;
    // 解包：跳过上一 fiber 的残留包装，取原始 ask
    let original: AskFunction = svc.ask as AskFunction;
    if (typeof original.__dshNotifierWrapped === "boolean" && typeof original.__dshNotifierOriginal === "function") {
      original = original.__dshNotifierOriginal;
    }
    // ⚠️ ask 是依赖 this 的类方法：必须 bind 到 service 实例，
    // 否则调用时 this 为 undefined（"Cannot read properties of undefined"）。
    // __dshNotifierOriginal 存已 bind 版本，热重载解包后直接可调用。
    const callOriginal: AskFunction = original.bind(svc);
    const wrapped = (async (request: unknown) => {
      try {
        if (current.notifyQuestion) {
          const first = Array.isArray(request && (request as { questions?: unknown[] }).questions) ? (request as { questions?: unknown[] }).questions![0] : undefined;
          notify("question", {
            tool: "ask_user_question",
            taskTitle: sessionTitleOf((request as { agent?: Agent } | null | undefined)?.agent),
            // 提问文本同样可能内嵌上下文片段，进通知前脱敏（120 字符截断）
            question: first && (first as { question?: unknown }).question ? sanitizeErrorText((first as { question?: unknown }).question, 120) : undefined,
          });
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: 提问通知失败: ${errorMessage(error)}`);
      }
      return callOriginal(request);
    }) as AskFunction;
    wrapped.__dshNotifierWrapped = true;
    wrapped.__dshNotifierOriginal = callOriginal;
    svc.ask = wrapped;
  }

  // 启动时若 service 已注册则立即包装；未注册则等 internal/service 事件兜底。
  hookUserQuestions();
  disposers.push(
    ctx.on("internal/service", (name) => {
      if (name === "userQuestions") hookUserQuestions();
    }, { global: true })
  );

  /**
   * 完成通知风暴聚合（done / subagent-done）：M0 纯搬移为独立模块
   * （src/aggregate.ts createDoneBatcher），语义与搬移前完全一致——首条
   * 「完成」立即原样通知 + 起 doneMergeWindowMs 窗口（0=关闭聚合），窗口内
   * 后续完成只累积标题与计数，窗口到点**补发一条聚合通知**。窗口定时器
   * unref，卸载时由全局 disposer 调 dispose() 清空。
   */
  const doneBatcher: DoneBatcher = createDoneBatcher({
    getWindowMs: () => current.doneMergeWindowMs,
    notify,
  });

  /**
   * 完成判定辅源记忆（issue #272）：session/event 推送流记录的 per-session
   * 最新 turn/end。主源在 idle 时从 agent.session.events 快照回读 turn/end，
   * 该读是一次性快照——任何一次读滞后都会被下方 lastEndedTurn 的无条件推进
   * 固化为「后续 turn 全部已处理」的永久静默（#272 报告场景的根因）。本推送
   * 源 post-commit 逐条派发（官方 SessionEventMap 声明面），不依赖快照回读，
   * 作为互补证据根治单点依赖。仅记最新一条：完成判定只关心「比已通知 turn
   * 更新的闭合」，历史无用；agent/disposed 时随状态机一并清理。
   */
  const eventStreamEnds = new Map<string, { turn: number; kind: string }>(); // sessionId -> 最新推送 turn/end

  disposers.push(
    ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "turn/end") return;
        const reason = event.data?.reason;
        if (reason === undefined || reason === null || typeof reason !== "object") return;
        // 运行时防御同 lastTurnEndOf（payload 跨宿主边界，不受信）
        const sessionId = session?.id !== undefined ? String(session.id) : undefined;
        if (sessionId === undefined) return;
        const turn = typeof event.data?.turn === "number" ? event.data.turn : NaN;
        if (!Number.isFinite(turn)) return; // 非有限 turn 的证据不可用：直接 skip 不落记忆，
        // 否则 {turn:NaN} 会在合并处凭 ended===undefined 短路成 best、经首轮
        // rememberedTurn===undefined 放行误报后把 lastEndedTurn 推进为 NaN，
        // 此后真实完成因 x > NaN 恒 false 被永久吞掉（#284 复核闸 P1）。
        eventStreamEnds.set(sessionId, {
          turn,
          kind: String((reason as { kind?: unknown }).kind ?? ""),
        });
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: session/event 处理失败: ${errorMessage(error)}`);
      }
    }, { global: true })
  );

  /**
   * 任务完成：agent/status running → idle 跃迁（按 agent 分组）。
   * 分支不再被 notifyTaskDone 门控（否则 notifyTaskDone=false +
   * notifySubagentDone=true 时子代理完成被拦下）：进入即先取耗时并
   * 无条件重置状态，再做中断抑制与主/子分流。
   */
  disposers.push(
    ctx.on("agent/status", ({ agent, status }) => {
      try {
        const agentId = agent?.id ?? "?";
        let state = agentStates.get(agentId);
        if (state === undefined) {
          state = { runningSeen: false, startedAt: 0 };
          agentStates.set(agentId, state);
        }
        if (status === "idle" && state.runningSeen) {
          const durationMs = state.startedAt > 0 ? Date.now() - state.startedAt : 0;
          // 无条件重置（顺带修复既有 bug：notifyTaskDone=false 时 runningSeen
          // 不重置，之后重开开关会误报很久以前的「完成」）。
          state.runningSeen = false;
          state.startedAt = 0;
          // 中断抑制（S1）：本轮 idle 必须闭合了新的 turn/end 才判定结束。
          // 「abort 早于本轮 turn/start 落盘」时本轮无 turn/end（loop turn()
          // 首行 throwIfAborted 在 try 外），读到的 turn/end 是上一次运行的
          // ——无新 closure 宁可静默，不误报完成。
          //
          // 证据面收敛——单源 push + 快照兜底（issue #290 阶段二）：
          // 完成判定证据主源 = session/event 推送流（eventStreamEnds，
          // post-commit 同步派发、恒定新鲜）：eventStreamEnds 有该 session
          // 记录时直接采信 push、不读快照。快照回读（lastTurnEndOf）仅在
          // push 缺失（插件于 agent 运行中途挂载 / 重载窗口内已派发但新
          // fiber 未记忆）时作兜底——不再「按 turn 取新」双源互补。
          //
          // abort-early 陈旧快照冻结（C-1）：兜底快照必须较 running 基线
          // 推进才视为「本轮新 closure」——abort 早于本轮 turn/start 落盘
          // 时本轮无新 turn/end，快照读到的仍是上一次运行的 completed；若
          // 快照 turn ≤ running 基线（本轮无推进），把陈旧快照冻结、不作
          // 本轮证据（宁静静默，不误报完成）。状态机记忆为空（重载后首次
          // idle）时同样成立：记忆重置不把旧证据当新轮完成（D-2）。
          const streamedRaw = eventStreamEnds.get(agentId);
          // 合并处对称守卫（#284 复核闸 P1 纵深）：仅接受 turn 有限的证据——
          // 入口（lastTurnEndOf / session/event 处理器）已各自 skip 非有限
          // turn，此处兜底保证任何畸形证据既不能成 best、也不能推进记忆。
          const pushed = streamedRaw !== undefined && Number.isFinite(streamedRaw.turn) ? streamedRaw : undefined;
          // 快照兜底仅在 push 缺失时读取（单源 push 为主证据，不读快照）。
          const snapshot = pushed === undefined ? lastTurnEndOf(agent) : undefined;
          const baselineTurn = state.runningBaseline?.turn;
          const stale =
            pushed === undefined &&
            snapshot !== undefined &&
            baselineTurn !== undefined &&
            snapshot.turn <= baselineTurn;
          const best = pushed ?? (stale ? undefined : snapshot);
          const evidenceSource = pushed !== undefined ? "push" : snapshot !== undefined ? (stale ? "快照冻结" : "快照兜底") : "无";
          const rememberedTurn = state.lastEndedTurn;
          const hasNewEnd = best !== undefined && (rememberedTurn === undefined || best.turn > rememberedTurn);
          // 非正常结束不判「完成」：本轮 turn/end 无新 closure（hasNewEnd）
          // 或 kind 属于 aborted/interrupted/error/blocked 时静默——失败由
          // agent/error 单独负责「任务出错」通知，被阻塞由对应事件负责，
          // 避免同一轮既报异常又误报「任务完成」。
          // - aborted：用户停止生成（agent.cancel {kind:"user"}）与中断
          //   interrupt_agent 均落此值；interrupted 为未来兼容保留。
          // - error：任务运行失败（dsh-agent-loop turn 的 catch 分支写入）。
          // - blocked：本轮被阻塞（preStep reject，如等待用户问题）提前结束。
          // 完成判定用白名单：仅 kind === "completed" 才通知「任务完成」。
          // max-tokens（输出被截断）与一切未知 kind 一律静默——避免把非正常
          // 结束误报为完成（与 DSH accountsForClaim 对未知 kind 保守不成功的
          // 语义对齐；失败由 agent/error 单独负责「任务出错」）。
          if (!hasNewEnd || best === undefined || best.kind !== "completed") {
            // P0 warn 兜底（issue #272）：跳过路径必须可观测——#272 的报告
            // 场景正是该分支全程零日志，静默固化无从排查。warn 只进服务端
            // 日志，不打扰用户；aborted 等设计内静默同样留痕（kind 字段区分）。
            ctx.logger.warn(
              `dsh-notifier: 完成判定跳过（不发 done）agent=${agentId} kind=${best?.kind ?? "none"} ` +
                `证据源=${evidenceSource} 快照turn=${snapshot !== undefined ? String(snapshot.turn) : "-"} ` +
                `推送turn=${pushed !== undefined ? String(pushed.turn) : "-"} ` +
                `记忆turn=${rememberedTurn ?? "-"}`,
            );
            // B-3：非 completed 闭包照常消费——aborted/error/blocked/
            // max-tokens/未知 kind 照旧跳过通知（不误报完成），但
            // lastEndedTurn 照常推进（同 turn 再现 idle 不重复处理）。
            if (best !== undefined) state.lastEndedTurn = best.turn;
            return;
          }
          const taskTitle = sessionTitleOf(agent);
          // 子代理判定（issue #49 双信号）：origin 命中即 spawn 型；未命中查
          // 运行时归属（fork 型委派 worker）；归属不成立/agents 服务缺位一律
          // 保守走主任务分支——用户 fork 主线不被静默。三类 header 形态与
          // 冷 resume 保守边界见 isSubagentOf 注释。
          // 根因 A 安全化（issue #290）：agents 服务未注入（inject 仅
          // ["webServer"]）时 cordis 严格属性访问会抛 cannot get property
          // "agents" without inject——必须经 ctx.get(name, false) 安全读取
          // （L258 userQuestions 同款先例），缺位返回 undefined → 走主任务分支，
          // 不再触发 THROW truthy 误判。显式防御 typeof ctx.get 兼容 fake ctx。
          const agents = typeof ctx.get === "function" ? ctx.get("agents", false) : undefined;
          if (isSubagentOf(agent, agents)) {
            if (current.notifySubagentDone) doneBatcher.enqueue("subagent-done", taskTitle, durationMs);
          } else if (current.notifyTaskDone) {
            doneBatcher.enqueue("done", taskTitle, durationMs);
          }
          // B-1：lastEndedTurn 提交后置三态化（issue #290）——推进移到分流
          // 判定与入队之后：发出成功 / 免打扰拦截（suppressed） / 开关禁用
          // （notifyTaskDone=false / notifySubagentDone=false 未入队）三态均
          // 提交；批次成员按「入队成功」提交（doneBatcher.enqueue 被调用即推进，
          // 与 flushDoneMerge 成败解耦）；异常路径（外层 catch）不达此处不提交。
          if (best !== undefined) state.lastEndedTurn = best.turn;
        } else if (status === "running") {
          state.runningSeen = true;
          state.startedAt = Date.now();
          // 记录本轮开始前的快照基线（abort-early 冻结判据）：running 时
          // 快照最新 turn/end 即「本轮之前已落盘」的证据；idle 时快照若
          // 仍未推进（≤ 基线），说明本次 running→idle 无新 closure（abort
          // 早于 turn/start），陈旧快照不得当本轮新证据（C-1/D-2）。
          state.runningBaseline = lastTurnEndOf(agent);
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: agent/status 处理失败: ${errorMessage(error)}`);
      }
    }, { global: true })
  );

  /** 会话销毁时清理其状态机条目（含错误合并窗口、推送源记忆与 turn 去重，防 Map/Set 无界增长）。 */
  disposers.push(
    ctx.on("agent/disposed", ({ agent }) => {
      if (agent?.id !== undefined) {
        agentStates.delete(agent.id);
        eventStreamEnds.delete(agent.id);
        errorMerge.delete(agent.id);
        for (const key of [...turnNotified]) {
          if (key.startsWith(agent.id + ":")) turnNotified.delete(key);
        }
      }
    }, { global: true })
  );

  /** 合并错误表：per-agent 滚动窗口，窗口内后续错误不单独通知。 */
  const errorMerge = new Map<string, { count: number; since: number; lastMessages: string[] }>(); // agentId -> { count, since, lastMessages }

  /** 任务错误（60 秒滚动窗口内合并同类错误，防刷屏；窗口内被吞的错误保留
   *  最近 2 条摘要，窗口过期后随通知提示「窗口内其他错误」）。 */
  disposers.push(
    ctx.on("agent/error", (payload) => {
      try {
        if (!current.notifyTaskError) return;
        const agentId = payload?.agent?.id;
        const key = agentId ?? "?";
        const now = Date.now();
        const rawMessage = payload?.error instanceof Error ? payload.error.message : errorMessage(payload?.error);
        const sanitized = sanitizeErrorText(rawMessage);
        const mergeMs = current.errorMergeWindowMs;
        const prev = mergeMs > 0 ? errorMerge.get(key) : undefined;
        if (prev !== undefined && now - prev.since < mergeMs) {
          prev.count += 1;
          prev.since = now;
          prev.lastMessages.push(sanitized.slice(0, 80));
          if (prev.lastMessages.length > 2) prev.lastMessages.shift();
          // 合并分支落一条带标记的历史，确保用户可核对「到底发没发」
          appendHistory({ ts: now, kind: "error", title: "DSH：任务出错", message: `（合并）${sanitized.slice(0, 120)}`, suppressed: "merged" });
          return;
        }
        const mergedCount = prev !== undefined ? prev.count : 0;
        const mergedErrors = prev !== undefined ? prev.lastMessages : [];
        // 先通知，确认放行后再开窗/推进——免打扰拦截时不消耗合并窗口
        const notified = notify("error", {
          message: sanitized,
          taskTitle: sessionTitleOf(payload?.agent),
          turn: typeof payload?.turn === "number" ? payload.turn : undefined,
          step: typeof payload?.step === "number" ? payload.step : undefined,
          mergedCount,
          mergedErrors,
        });
        if (notified) {
          errorMerge.set(key, { count: 0, since: now, lastMessages: [] });
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: agent/error 处理失败: ${errorMessage(error)}`);
      }
    }, { global: true })
  );

  /** turn-stopping 已通知的 (agentId, turn) 去重（防同轮被反复 emit 时重复记录刷屏）。 */
  const turnNotified = new Set<string>();

  /** 轮结束（默认关）。cordis serial 事件签名是 cb(payload)，无 next——调用 next() 会 TypeError 且污染整轮。 */
  disposers.push(
    ctx.on("agent/turn-stopping", async (payload) => {
      try {
        if (current.notifyTurnEnd) {
          const turn = typeof payload?.turn === "number" ? payload.turn : NaN;
          const key = `${payload?.agent?.id ?? "?"}:${Number.isFinite(turn) ? turn : "?"}`;
          if (turnNotified.has(key)) return; // 同一 (agent, talk) 只通知一次，防刷屏
          turnNotified.add(key);
          notify("turn-end", {
            turn: Number.isFinite(turn) ? turn : undefined,
            taskTitle: sessionTitleOf(payload?.agent),
          });
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: turn-stopping 处理失败: ${errorMessage(error)}`);
      }
    }, { global: true })
  );

  // ------------------------------------------------------------ 路由注册

  // 关键：路由注册必须在 ctx.effect 内执行——apply 主体直接调用 ctx 服务
  // （webServer.register）会在 cordis isolate 链就绪前访问服务，触发
  // "Cyclic __proto__ value"（loader isolate 处理），导致插件激活失败。
  const routes = buildRoutes({
    // effective = settings 命名空间解析值（attach 后 current 已指向 scope.get()）
    resolve: () => current,
    readUser,
    writable: () => attachedService !== undefined,
    update: (patch: object, expectedRevision?: number) => {
      const service = attachedService;
      if (!service) return Promise.reject(new Error("settings service unavailable"));
      // 乐观并发（F4）必须经 service.update(ns, ...)（SettingsProvider 公开
      // 方法，write 内做 revision 校验）——scope.update 会丢弃该参数。
      return service.update(SETTINGS_NS, patch, expectedRevision);
    },
    logger: ctx.logger,
    sse,
    system,
    history: historyStore,
  });
  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = routes.map((route) => ctx.webServer.register(route));
      return () => {
        for (const dispose of routeDisposers) {
          try {
            dispose();
          } catch {
            // 忽略
          }
        }
      };
    },
    "dsh-notifier: routes"
  );

  // ------------------------------------------------------------ settings 接线 + 存量迁移

  // GUI 设置卡片数据面 + 存量迁移（issue #76）：settings 命名空间 attach 后——
  //   1. onScope 内先做存量 dsh-notifier.json 迁移（前置于一切 enabled 判定，
  //      禁用用户升级/禁用态同样迁移，E7）；
  //   2. setSource 把读取来源切到 scope.get()（schema defaults → base(entry) →
  //      user 层的官方解析顺序，无双轨合并）；
  //   3. 热更新统一由 scope.watch 驱动 onChange 刷新 current 镜像。
  // 服务缺失（未注入 settings）时：writable=false → PUT 503，路由/通知保持降级
  // 可用（current 恒为组合层 entry 归一化值），与 lan-proxy 同语义。
  installNotifierSettings(ctx, entry, {
    setSource: (s) => {
      source = s;
      current = s();
    },
    onChange: () => {
      current = source();
    },
    onScope: (scope, service) => {
      attachedScope = scope;
      attachedService = service;
      // 迁移（rename-first 幂等；损坏/中断/回滚均在 migrate.ts 内处理并 warn，
      // 失败不阻塞启动——E6）。hasUserValues 判定「user 层已有值 = 迁移已完成」。
      void migrateLegacyConfig(
        storeFile,
        {
          update: (patch) => service.update(SETTINGS_NS, patch),
          hasUserValues: () => {
            const { user } = readUser();
            return user !== undefined && Object.keys(user).length > 0;
          },
        },
        ctx.logger
      ).catch((err) => {
        ctx.logger.warn(`dsh-notifier: 存量配置迁移异常 — ${errorMessage(err)}`);
      });
    },
  });

  // ------------------------------------------------------------ 启动与清理

  // 配置源已就绪（entry 归一化）；若 settings 已 attach（inject 回调同步触发），
  // current 已指向 scope.get()。无需 loadConfig（自建 json 读写链路已废弃）。

  // ⚠️ 清理必须放在 effect **返回的 disposer** 里，不能写在 fn 主体：
  // ctx.effect(fn) 的 fn 在 apply 时立即同步执行，只有返回值才在 fiber
  // 卸载时调用。若把 disposeRoutes() 写在 fn 主体，等于注册完立刻注销。
  ctx.effect(
    () => () => {
      sse.dispose();
      // M4 定时器清理：审批提醒、完成风暴窗口（聚合批处理器内部）
      for (const t of askRemindTimers.values()) clearTimeout(t);
      askRemindTimers.clear();
      doneBatcher.dispose();
      turnNotified.clear();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 忽略
        }
      }
      disposeRoutes();
    },
    "dsh-notifier"
  );
}
