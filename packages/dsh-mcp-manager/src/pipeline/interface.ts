/**
 * dsh-mcp-manager — pipeline/interface.ts：执行管道域唯一对外引用面（D10，#664 阶段 2 首个应用）。
 *
 * 本目录（执行管道域）对外承诺：两执行路径（supervisor 直呼 / ws_mcp_call）共用的
 * 纯函数族——参数归一（args）、错误取消息（msg）、凭据脱敏（redact）、超时兜底
 * （timeout）、授权匹配（authorize）、结果投影（project）。
 *
 * 目录外模块**只能**从这里引用（verify-dir-imports 静态强制）；策略裁决族
 * （policyAllows/isToolDenied 等）依赖 workspace 域函数，阶段 4 并入 authorize.ts。
 */
export { normalizeArguments } from "./args.ts";
export { msgOf } from "./msg.ts";
export { createRedactor } from "./redact.ts";
export { withTimeout } from "./timeout.ts";
export { globMatch } from "./authorize.ts";
export {
  defaultCallResultFallbackText,
  projectCallToolResult,
} from "./project.ts";
export type {
  CallResultTextHandlers,
  ProjectedCallResult,
} from "./project.ts";