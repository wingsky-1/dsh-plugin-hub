/**
 * dsh-mcp-manager — servers/lifecycle/impl/state/index.ts：六态投影（纯函数）。
 *
 * 官方 dsh-mcp-client **不暴露任何状态 API**（运行时只导出 Config / apply / inject / name），
 * 所以六态只能由「我方动作 + 工具注册面 + 我方超时封装」投影，而不是读官方内部状态。词表的
 * 物理定义在 src/shared/status.ts（跨端契约：summary().counts 的键序与客户端分组共用同一份），
 * 本文件不另造词表、只投影。
 *
 * 三条不可观测性（降级表述写在这里，因为投影口径由此确定）：
 * 1. **首连失败的具体 cause 拿不到**。官方在 failOnStartupError:false 下不抛（apply 正常
 *    resolve），connection.ready 的 {error} 只回到官方内部；改用 true 换 cause 会让失败的
 *    fiber 直接 FAILED、其 ctx.effect 被回收，官方后台重连随之消失。故 failed 携带的 error
 *    一律是我方文案，不含官方原始错因。
 * 2. **重连次数 / 退避剩余 / 放弃时点不可观测**。官方只在日志里出这些信息（connection attempt
 *    failed / retrying in Nms / reconnect stopped），而文案属官方内部实现、rc 内可变——状态机
 *    **不建在日志文案上**。failed 的判定用「工具前缀消失且无进一步变化」，不用「第 N 次 warn」。
 * 3. **reconnecting 窗口本身无信号**。官方断线瞬间不注销工具（工具在下次 syncTools swap 或
 *    dispose 才换），「工具还在 = 正在重连」与「工具还在 = 连接正常」不可区分。故本态只在
 *    **可判时点**投影（调用转发失败且错因来自连接层、主动低频注册面比对、切回前台重建期间）；
 *    其余时点投影为 connected，而实际链路可能已断——这是换引擎的既知代价。
 */
import { SERVER_STATES } from "../../../../../shared/interface.ts";
import type { ServerState } from "../../../../../shared/interface.ts";

/** 投影输入：三个输入面的快照，全部由调用方读取后递进来（本文件不持有状态）。 */
export interface ServerStateInput {
  /** 配置面启用（server.enabled === false 时为 false）。 */
  readonly enabled: boolean;
  /** 用户持久化禁用（配置面之外的第二个 disabled 来源）。 */
  readonly userDisabled: boolean;
  /** 我方已发起拆除：用户 disconnect / remove / update 拆旧代际，或本插件卸载。 */
  readonly tornDown: boolean;
  /** 已发起 mount（我方动作面）。 */
  readonly mountStarted: boolean;
  /** ready 已 settle（成功与失败都 settle）。 */
  readonly readySettled: boolean;
  /** 我方连接等待窗口已到期（含 ready 直接 reject 的形态）。 */
  readonly windowExpired: boolean;
  /** 句柄已 dispose。 */
  readonly disposed: boolean;
  /** 该代际曾进入 connected——区分「首连就没成功」与「连上过又掉线」。 */
  readonly everConnected: boolean;
  /** server.reconnect.enabled !== false；为 false 时掉线不再有后台重连，直接 failed。 */
  readonly reconnectEnabled: boolean;
  /** 工具注册面查询：该 id 前缀下是否已有注册工具（输入面 B）。 */
  hasTools(id: string): boolean;
}

/**
 * 六态投影。判据的先后即语义优先级：配置面（disabled）先于运行态；我方拆除（stopped）先于
 * 一切链路信号（旧注册可能尚未注销，工具面此时不可信）；窗口未结束（connecting）先于工具面结果。
 */
export function projectServerState(id: string, input: ServerStateInput): ServerState {
  if (!input.enabled || input.userDisabled) return SERVER_STATES.disabled;
  if (input.tornDown || input.disposed) return SERVER_STATES.stopped;
  if (!input.mountStarted) return SERVER_STATES.stopped;
  if (!input.readySettled) {
    // connecting 纯属我方动作面（发起 mount 到 ready settle 或我方超时之间），与工具面无关。
    return input.windowExpired ? SERVER_STATES.failed : SERVER_STATES.connecting;
  }
  if (input.hasTools(id)) return SERVER_STATES.connected;
  // ready 已 settle 而工具前缀为空：曾 connected 且允许重连 → 半确定的 reconnecting（可判时点）；
  // 否则是 §3.1 的 failed ①（我方窗口耗尽）或 ②（首连 / 首次发现失败，官方已进后台重连）。
  if (!input.everConnected) return SERVER_STATES.failed;
  return input.reconnectEnabled ? SERVER_STATES.reconnecting : SERVER_STATES.failed;
}
