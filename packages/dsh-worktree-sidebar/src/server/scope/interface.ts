/**
 * scope 域对外契约：接管 `workspaceFileScope` 的解析，命中绑定就把会话的文件根指到 worktree。
 *
 * 本文件只做收口——单例与它的 `ScopeApi` 形状的物理定义都在 `impl/service`（形状不从门面转出），解析判定在 `impl/resolve`，
 * provider 未注册时的等价实现兜底在 `impl/fallback`。单例本身不出这道门：它一旦被转出就成了
 * 本域的第二张公开契约，调用方还能持有它、绕过释放。
 */
import type { ScopeDeps } from "./deps.ts";
import { scopeService } from "./impl/service/index.ts";

/** 装配 scope 域（组合根在 `apply` 期调用一次）。重复装配是编程错误，当场抛错。 */
export function installScope(deps: ScopeDeps): void {
  scopeService.install(deps);
}

/** 卸载 scope 域，与 `installScope` 配对：把 resolver 交还官方。此后能力面当场失败。 */
export function releaseScope(): void {
  scopeService.release();
}

/** 当前**生效**的 worktree 根；null 表示该会话按 cwd 走。 */
export function effectiveWorktree(sessionId: string): Promise<string | null> {
  return scopeService.effectiveWorktree(sessionId);
}
