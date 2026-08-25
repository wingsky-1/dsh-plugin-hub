/**
 * dsh-notifier — 审批/完成/错误事件通知（宿主端）。
 *
 * 本文件只做装配：apply + 事件订阅 + 生命周期清理。职责划分：
 * - config.ts     配置契约/默认值/normalizeConfig/路径
 * - quiet-hours.ts 免打扰判定（parseHHMM / isInQuietHours）
 * - message.ts    通知文案单表/脱敏/格式化/agent 事件读取（纯函数）
 * - history.ts    通知历史 jsonl 存储（滚动/按天清理/原子写）
 * - server.ts     SSE 枢纽 + 系统通知通道 + HTTP 路由
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
 *   用户暂停/中断（turn/end reason aborted）固定静默
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
 * 配置：~/.dsh/dsh-notifier.json（PUT /config 可改，落盘）
 * 安全：通知文本只含工具名/会话标识/申请理由等元信息，不含工具参数（防敏感信息外泄）。
 */
// 官方类型层（issue #16，锁 0.1.1-rc.2；仅 import type，编译期擦除，
// 禁止运行时值导入——contract-check 有门禁）。session/title 事件键由
// dsh-session-title 经 declare module 注入 SessionEventMap，必须引入其类型面。
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-user-approval";
import { errorMessage } from "../../../shared/host-utils.js";
import { CONFIG_KEYS, DEFAULT_CONFIG, configFile, historyFile, normalizeConfig, toastScriptPath } from "./config.js";
import type { NotifierApplyConfig, NotifyConfig } from "./config.js";
import { isInQuietHours } from "./quiet-hours.js";
import { HISTORY_LIMIT, createHistoryStore } from "./history.js";
import { NOTIFY_KINDS, sanitizeErrorText, sessionTitleOf, isSubagentOf, lastTurnEndOf } from "./message.js";
import type { NotifyDetail } from "./message.js";
import { ROUTES, buildRoutes, createSseHub, createSystemNotifier } from "./server.js";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 需要的服务：webServer（路由）。 */
export const inject = ["webServer"];

// ---------------------------------------------------------------- 导出面
// 公共符号定义在各职责模块，此处统一 re-export——包导出面与拆分前完全一致。

export { QUIET_ALLOW_KINDS, isInQuietHours, parseHHMM } from "./quiet-hours.js";
export type { QuietHoursConfig } from "./quiet-hours.js";
export { CONFIG_KEYS, DEFAULT_CONFIG, configFile, historyFile, normalizeConfig, toastScriptPath } from "./config.js";
export type { NotifierApplyConfig, NotifyConfig } from "./config.js";
export { HISTORY_LIMIT } from "./history.js";
export {
  buildSystemCommand,
  formatDuration,
  isSubagentOf,
  lastTurnEndOf,
  prettyToolName,
  sanitizeErrorText,
  sessionTitleOf,
} from "./message.js";
export type { NotifyDetail } from "./message.js";
export { ROUTES } from "./server.js";

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readBody / errorMessage）。
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";

/**
 * 挂载 dsh-notifier。
 * @param ctx 宿主插件上下文。
 * @param config 配置（enabled / configFile 覆盖 / toastScript 覆盖）。
 */
export async function apply(ctx: Context, config: NotifierApplyConfig = {}): Promise<void> {
  if (config.enabled === false) return;
  const storeFile = typeof config.configFile === "string" ? config.configFile : configFile();
  const toastScript = typeof config.toastScript === "string" ? config.toastScript : toastScriptPath();
  const historyPath = typeof config.historyFile === "string" ? config.historyFile : historyFile();

  /** 当前配置（内存单一事实源，PUT 后落盘）。 */
  let current = normalizeConfig(undefined);

  async function loadConfig() {
    try {
      if (!existsSync(storeFile)) return;
      const data = JSON.parse(await readFile(storeFile, "utf8"));
      current = normalizeConfig(data);
    } catch (error) {
      ctx.logger.warn(`dsh-notifier: 配置读取失败（使用默认）: ${errorMessage(error)}`);
    }
  }

  async function saveConfig() {
    try {
      await mkdir(dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, JSON.stringify(current, null, 2), "utf8");
      await rename(tmp, storeFile);
    } catch (error) {
      ctx.logger.warn(`dsh-notifier: 配置落盘失败: ${errorMessage(error)}`);
    }
  }

  // ------------------------------------------------------------ 组装各职责模块

  const sse = createSseHub();
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

  /** 通知历史追加（fire-and-forget 落盘，见 history.ts）。 */
  function appendHistory(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }) {
    historyStore.append(entry);
  }

  // ------------------------------------------------------------ 通知主入口

  /**
   * 通知入口：免打扰检查（被拦截也记录「未发出」历史）→ 系统通知 → SSE 广播 → 历史落盘。
   * @param kind ask / done / error / turn-end。
   * @param detail {tool?, taskTitle?, reason?, durationMs?, turn?, step?, message?, mergedCount?}（不含工具参数）。
   */
  function notify(kind: string, detail: NotifyDetail = {}): boolean {
    const spec = NOTIFY_KINDS[kind];
    const ts = Date.now();
    const title = spec?.title ?? "DSH 通知";
    const message = spec?.message({ ...detail, ts }) ?? detail.message ?? "";
    const suppressedByQuiet = (() => {
      if (!isInQuietHours(new Date(), current.quietHours)) return false;
      // 免打扰紧急例外：allowKinds 中的 kind（如 ask/question——卡住的审批需要叫醒）仍放行
      const allows = current.quietHours.allowKinds ?? [];
      return !allows.includes(kind);
    })();
    if (suppressedByQuiet) {
      // 免打扰拦截：**仍落一条「未发出」历史 + 日志**，让用户能核对「到底发没发」
      ctx.logger.info(`dsh-notifier: ${kind} 被免打扰拦截（未发出）：${message.replace(/\n/g, " / ")}`);
      appendHistory({ ts, kind, title, message, suppressed: "quiet" });
      return false;
    }
    const payload = { type: "notify", kind, title, message, ts };
    if (current.systemNotify) system.notify(title, message);
    if (current.browserNotify) sse.broadcast(payload);
    ctx.logger.info(`dsh-notifier: ${kind} ${message.replace(/\n/g, " / ")}`);
    appendHistory({ ts, kind, title, message });
    return true;
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
  const agentStates = new Map<string, { runningSeen: boolean; startedAt: number; lastEndedTurn?: number }>(); // agentId -> { runningSeen, startedAt, lastEndedTurn }

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
    })
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
    })
  );

  /**
   * 完成通知风暴聚合（done / subagent-done）：
   * 首条「完成」立即原样通知（单条场景零感知延迟）；同时起 doneMergeWindowMs
   * 窗口（0=关闭聚合），窗口内到达的后续完成只累积标题与计数，窗口到点**补发
   * 一条聚合通知**（「另有 N 个任务已完成」）——并行子代理收尾时 10 条刷屏收敛
   * 为首条 + 1 条汇总。窗口定时器 unref，卸载时由全局 disposer 清空。
   */
  let doneBatch: { kind: string; count: number; titles: string[] } | null = null;
  let doneBatchTimer: NodeJS.Timeout | null = null;
  function enqueueDone(kind: string, title: string | undefined, durationMs: number) {
    const label = title ?? (kind === "subagent-done" ? "子任务" : "任务");
    const mergeMs = current.doneMergeWindowMs;
    if (mergeMs <= 0) {
      // 完成聚合已关闭：每条完成即时通知（不合并）
      notify(kind, { taskTitle: label, durationMs });
      return;
    }
    if (doneBatch === null) {
      notify(kind, { taskTitle: label, durationMs });
      doneBatch = { kind, count: 1, titles: [label] };
      doneBatchTimer = setTimeout(flushDoneMerge, mergeMs);
      doneBatchTimer.unref();
      return;
    }
    if (doneBatch.kind !== kind) {
      flushDoneMerge();
      enqueueDone(kind, title, durationMs);
      return;
    }
    doneBatch.count += 1;
    doneBatch.titles.push(label);
    if (doneBatch.titles.length > 4) doneBatch.titles = doneBatch.titles.slice(-4);
  }
  function flushDoneMerge() {
    if (doneBatchTimer !== null) {
      clearTimeout(doneBatchTimer);
      doneBatchTimer = null;
    }
    const batch = doneBatch;
    doneBatch = null;
    // 窗口内还有后续完成 → 补发聚合条（首波已单独通知，这里汇总其余）
    if (batch !== null && batch.count > 1) {
      notify(batch.kind, { taskTitle: batch.titles.slice(1).join("、"), mergedCount: batch.count - 1 });
    }
  }

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
          const ended = lastTurnEndOf(agent);
          const hasNewEnd = ended !== undefined && (state.lastEndedTurn === undefined || ended.turn > state.lastEndedTurn);
          if (ended !== undefined) state.lastEndedTurn = ended.turn;
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
          if (!hasNewEnd || ended === undefined || ended.kind !== "completed") return;
          const taskTitle = sessionTitleOf(agent);
          // 子代理判定（issue #49 双信号）：origin 命中即 spawn 型；未命中查
          // 运行时归属（fork 型委派 worker）；归属不成立/agents 服务缺位一律
          // 保守走主任务分支——用户 fork 主线不被静默。三类 header 形态与
          // 冷 resume 保守边界见 isSubagentOf 注释。
          if (isSubagentOf(agent, ctx.agents)) {
            if (current.notifySubagentDone) enqueueDone("subagent-done", taskTitle, durationMs);
          } else if (current.notifyTaskDone) {
            enqueueDone("done", taskTitle, durationMs);
          }
        } else if (status === "running") {
          state.runningSeen = true;
          state.startedAt = Date.now();
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: agent/status 处理失败: ${errorMessage(error)}`);
      }
    })
  );

  /** 会话销毁时清理其状态机条目（含错误合并窗口与 turn 去重，防 Map/Set 无界增长）。 */
  disposers.push(
    ctx.on("agent/disposed", ({ agent }) => {
      if (agent?.id !== undefined) {
        agentStates.delete(agent.id);
        errorMerge.delete(agent.id);
        for (const key of [...turnNotified]) {
          if (key.startsWith(agent.id + ":")) turnNotified.delete(key);
        }
      }
    })
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
    })
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
    })
  );

  // ------------------------------------------------------------ 路由注册

  // 关键：路由注册必须在 ctx.effect 内执行——apply 主体直接调用 ctx 服务
  // （webServer.register）会在 cordis isolate 链就绪前访问服务，触发
  // "Cyclic __proto__ value"（loader isolate 处理），导致插件激活失败。
  const routes = buildRoutes({
    getConfig: () => current,
    putConfig: async (raw) => {
      current = normalizeConfig(raw);
      await saveConfig();
      return current;
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

  // ------------------------------------------------------------ 启动与清理

  await loadConfig();

  // ⚠️ 清理必须放在 effect **返回的 disposer** 里，不能写在 fn 主体：
  // ctx.effect(fn) 的 fn 在 apply 时立即同步执行，只有返回值才在 fiber
  // 卸载时调用。若把 disposeRoutes() 写在 fn 主体，等于注册完立刻注销。
  ctx.effect(
    () => () => {
      sse.dispose();
      // M4 定时器清理：审批提醒、完成风暴窗口
      for (const t of askRemindTimers.values()) clearTimeout(t);
      askRemindTimers.clear();
      if (doneBatchTimer !== null) {
        clearTimeout(doneBatchTimer);
        doneBatchTimer = null;
      }
      doneBatch = null;
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
