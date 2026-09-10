/**
 * dsh-mcp-manager — bootstrap/interface.ts：组合根门面（D10，#664 阶段 6）。
 *
 * 组合根 = apply 系列装配（apply/apply-config/apply-runtime/apply-services/
 * apply-guidance）。目录外模块**只能**从这里引用（verify-dir-imports
 * 静态强制）；service-contract 静态扫描路径指向 apply-services.ts（源码级）。
 */
export { apply, MCP_GUIDANCE } from "./apply.ts";
export { resolveDebugConfig, resolveMiddlewareMode } from "./apply-config.ts";
export { makeMiddlewareHotSwitch } from "./apply-runtime.ts";
