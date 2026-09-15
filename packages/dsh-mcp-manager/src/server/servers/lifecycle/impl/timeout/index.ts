/**
 * dsh-mcp-manager — servers/lifecycle/impl/timeout/index.ts：装载等待窗口（§3.4）。
 *
 * 官方把「首连」与「首次 syncTools」串在同一个 connectGeneration 里，且都在 connection.ready
 * 之前完成，所以 ready settle 同时意味着首连与首次发现都已结束（成功或失败）。官方**没有**
 * 连接超时参数——10s 内出结论这个产品语义只能由我方包在句柄等待上。
 *
 * 窗口分两段：
 * 1. `withTimeout(handle.ready, connectTimeoutMs)`；超时投影 failed 并**保留实例不 dispose**
 *    （官方仍在后台退避重连，dispose 等于把常驻重连语义丢掉）。
 * 2. 工具面宽限：官方注册进 ctx.tools 是同步的、且发生在 ready 之前，所以 ready settle 之后
 *    只需再让出一个 tick；一个 tick 后前缀仍为空即 §3.1 的 failed ②。（不按
 *    DISCOVERY_TIMEOUT_MS 轮询：那个预算已经在 ready 内部结算掉了，拿它再等一轮只是让
 *    「首连失败」的结论晚 10s 到达，而结论并不会变。）
 *
 * 晚到结算守卫：dispose 之后、或账本条目已被更新的代际替换之后到达的结算一律丢弃，不再改状态
 * （对齐现状 connectInternal 的代际守卫）。
 */
import { CONNECT_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS } from "../../../../shared/interface.ts";
import { SERVER_STATES } from "../../../../../shared/interface.ts";
import type { ServerState } from "../../../../../shared/interface.ts";
import type { MountedPlugin } from "../../../../shared/interface.ts";
import { diagnosticText } from "../logs/index.ts";
import { lifecyclePorts } from "../service/index.ts";

/** 等待窗口入参：句柄、超时预算与三个只读查询（不自持状态，故本块可纯测）。 */
export interface MountWindowInput {
  /** 账本键 = 交给官方的 serverName；工具注册面按它拼前缀。 */
  readonly id: string;
  readonly handle: MountedPlugin;
  /**
   * 连接等待预算（ms）。缺省取共享层的 CONNECT_TIMEOUT_MS。做成入参而不是在块内写死常量，
   * 是为了让用例用小预算驱动真超时——拿 10s 跑一条超时用例既慢，又把测试挂在真实墙钟上。
   */
  readonly connectTimeoutMs?: number;
  /** 该代际是否仍是账本当前条目：晚到结算据此丢弃。 */
  isCurrent(): boolean;
  /** 工具注册面查询：该 id 前缀下是否已有注册工具。 */
  hasTools(id: string): boolean;
  /**
   * 窗口内收到的官方原文（按到达顺序现读）。
   *
   * 官方是本插件**唯一**的错因来源：成功连接零日志，失败与放弃重连才说话，而宿主默认既不打印
   * 也不落盘——不把原文附进 failed 文案，用户拿到的就只有我方那两段判词。
   */
  diagnostics?(): readonly string[];
  /** 状态投影出口：窗口在起点（connecting）与结算点各回调一次；丢弃的结算不回调。 */
  onState(state: ServerState): void;
}

/** 窗口结算结果：settled 携带最终态，discarded 表示本次结算作废（调用方不得据此改状态）。 */
export type MountWindowOutcome =
  | { readonly kind: "settled"; readonly state: ServerState; readonly error?: string }
  | { readonly kind: "discarded" };

/**
 * 跑完一次装载等待窗口。本函数**不 dispose 任何东西**：连接失败的实例归后台重连，
 * 拆除归调用方的账本动作。
 */
export async function awaitMountWindow(input: MountWindowInput): Promise<MountWindowOutcome> {
  const { withTimeout } = lifecyclePorts.get().pipeline;
  const budgetMs = input.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  // 起点先判一次废弃：这一代际若在窗口开始前就已被拆掉或被顶替，点亮 connecting 只会留下一个
  // 「亮了却永不结算」的假状态——本函数之后所有出口都是 discarded、不再回调。此时一个信号都不发，
  // 状态由调用方自己的拆除路径负责。
  if (isAbandoned(input)) return { kind: "discarded" };
  input.onState(SERVER_STATES.connecting);
  let failure: string | undefined;
  try {
    await withTimeout(
      input.handle.ready,
      budgetMs,
      `连接超时（${budgetMs}ms）：官方实例保留不 dispose，仍在后台退避重连`,
    );
  } catch (error) {
    failure = errorText(error);
  }
  if (isAbandoned(input)) return { kind: "discarded" };
  if (failure !== undefined) {
    return settle(input, SERVER_STATES.failed, withOfficialLogs(input, failure));
  }
  if (!input.hasTools(input.id)) {
    await yieldOneTick();
    if (isAbandoned(input)) return { kind: "discarded" };
  }
  if (input.hasTools(input.id)) return settle(input, SERVER_STATES.connected);
  return settle(input, SERVER_STATES.failed, withOfficialLogs(input, missingToolFaceText()));
}

/** 代际守卫判据：句柄已拆，或账本里这一条已被别的代际顶掉。 */
function isAbandoned(input: MountWindowInput): boolean {
  return input.handle.disposed || !input.isCurrent();
}

function settle(input: MountWindowInput, state: ServerState, error?: string): MountWindowOutcome {
  input.onState(state);
  return error === undefined ? { kind: "settled", state } : { kind: "settled", state, error };
}

/**
 * 让出一个 tick。官方注册是同步的且发生在 ready 之前，窗口只需覆盖「ready 的 then 链尚未跑完」
 * 这一小段；这里用宏任务而非微任务，让同一 tick 内排队的其它 then 也先跑完。
 */
function yieldOneTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * failed 的文案：官方把发现预算（默认 10s）算在 ready 内部，我方只在 ready 之后给一个 tick，
 * 所以这里点名的是官方预算而不是我方等待时长——不这样写会把「谁超时了」记错账。
 */
function missingToolFaceText(): string {
  return `已连接但工具注册面未出现（官方发现预算 ${DISCOVERY_TIMEOUT_MS}ms 已在 ready 内结算）：官方实例在后台重连`;
}

/**
 * failed 文案的统一收尾：把窗口内收到的官方原文接在后面。
 *
 * 只接 failed：connected 说明官方没话说（成功连接零日志），discarded 的结算本就不进状态面，
 * 两处附原文只会把正常路径的文案撑长。
 *
 * 官方一条都没说时返回原文：接一句空的「官方日志：」等于让读的人以为官方说了句空话。
 */
function withOfficialLogs(input: MountWindowInput, text: string): string {
  const diagnostics = input.diagnostics?.();
  const official = diagnostics === undefined ? undefined : diagnosticText(diagnostics);
  return official === undefined ? text : `${text}；${official}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
