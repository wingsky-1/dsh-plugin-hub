/**
 * dsh-mcp-manager — inject/interface.ts：模型面+目录域（inject）门面（D10，#664 阶段 6）。
 *
 * 工具注册面：ws_mcp_* 四原子 + pre-execute guard（registerMiddlewareTools /
 * registerDirectMcpGuard）。目录外模块**只能**从这里引用
 * （verify-dir-imports 静态强制）。
 */
export { registerMiddlewareTools, registerDirectMcpGuard } from "./middleware-register.ts";
