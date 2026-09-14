/**
 * dsh-mcp-manager — pipeline/interface.ts：执行管道域唯一对外引用面（D10，#664 阶段 2 首个应用）。
 *
 * 本目录（执行管道域）对外承诺：两执行路径（supervisor 直呼 / ws_mcp_call）共用的
 * 纯函数族——参数归一（args 块）、错误取消息（msg 块）、凭据脱敏（redact 块）、超时
 * 兜底（timeout 块）、授权匹配与策略裁决（authorize 块，阶段 6 并入 policyAllows/
 * isToolDenied 等策略族）、结果投影（project 块）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）。
 *
 * 本域**建 deps.ts**（§3.1 规则 2 的「有对上依赖就建」；决策⑥ 以运行时能力消费为准）：
 * authorize 块静态值引 workspace 域三个符号（parseFullServerName / bareServerName /
 * MIDDLEWARE_GLOBAL_ROOT，附录 E.4），宿主能力（ctx/Context/logger）实测 0 命中。端口在
 * 「本域改成 install(deps)」的那一笔接线——今天直接值引仍在，deps.ts 先立形状。
 */
export { normalizeArguments } from "./impl/args/index.ts";
export { msgOf } from "./impl/msg/index.ts";
export { createRedactor } from "./impl/redact/index.ts";
export { withTimeout } from "./impl/timeout/index.ts";
export {
  globMatch,
  policyAllows,
  policyDenialReason,
  isToolDenied,
  toolDisabledReason,
} from "./impl/authorize/index.ts";
export { defaultCallResultFallbackText, projectCallToolResult } from "./impl/project/index.ts";
export type { CallResultTextHandlers, ProjectedCallResult } from "./impl/project/index.ts";
