/** 宿主端组合根：收窄宿主上下文、按依赖顺序装配各域、卸载逆序释放。 */
/** 路由清单经这里出去，构建期注入客户端（bundle-host.ts 只认入口的 ROUTES 导出）。 */
export { ROUTES } from "./contract.ts";

/** 稳定的 cordis 插件名。 */
export const name = "worktree-sidebar";

/**
 * 挂载点。S0/S1 阶段宿主端只有纯逻辑，还没有需要 ctx 的域，故签名先不带参数；
 * 装配 api / tools / scope 三个域的那一片会把 ctx 加回来。
 */
export function apply(): void {}
