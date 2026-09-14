/**
 * scope 域对外契约：接管 `workspaceFileScope` 的解析，命中绑定就把会话的文件根指到 worktree。
 *
 * 接管是**全局替换**（一个键只有一个解析器），所以本域的三条纪律是硬的：
 * 1. 捕获委托对象必须在 configure 之前；
 * 2. configure 抛错（别人已接管）就整片放弃，不抢；
 * 3. 解析器永不抛出，任何异常都回落官方语义。
 */
import type { ScopeDeps } from "./deps.ts";
import { createFallback } from "./impl/fallback/index.ts";
import { effectiveWorktree, resolveScope } from "./impl/resolve/index.ts";

/** scope 域的服务面。 */
export interface ScopeApi {
  /**
   * 当前**生效**的 worktree 根；null 表示该会话按 cwd 走。
   * 浏览器路由读它，所以它与解析器给出的答案是同一个（G7）。
   */
  effectiveWorktree(sessionId: string): Promise<string | null>;
  /** 是否成功接管。未接管时 `effectiveWorktree` 恒为 null。 */
  isInstalled(): boolean;
}

interface Installed {
  readonly deps: ScopeDeps;
  readonly dispose: () => void;
}

let installed: Installed | null = null;

/** 未接管时的服务面：一律回答「按 cwd 走」。 */
const NOT_INSTALLED: ScopeApi = {
  effectiveWorktree: async () => null,
  isInstalled: () => false,
};

/** 装配 scope 域。 */
export function installScope(deps: ScopeDeps): ScopeApi {
  if (installed !== null) throw new Error("dsh-worktree-sidebar: scope 域已装配");

  // 捕获委托对象必须在这里、在 configure 之前（见 deps.ts 的 TypertPort.current 注释）。
  const captured = deps.typert.current()?.resolve;
  const delegate = captured ?? createFallback(deps.defaults);

  let dispose: () => void;
  try {
    dispose = deps.typert.configure((sessionId) => resolveScope(deps, delegate, sessionId));
  } catch (cause) {
    // 第三方已经接管这个键：接管权是全局唯一的，本插件只放弃并出声，不抢。
    const reason = cause instanceof Error ? cause.message : String(cause);
    deps.logger.warn(
      "dsh-worktree-sidebar: workspaceFileScope 已有解析器，放弃接管（文件根保持官方语义）— " +
        reason,
    );
    return NOT_INSTALLED;
  }

  installed = { deps, dispose };
  return {
    effectiveWorktree: (sessionId) => effectiveWorktree(deps, sessionId),
    isInstalled: () => true,
  };
}

/** 卸载 scope 域：disposer 之后官方默认解析原样恢复。幂等。 */
export function releaseScope(): void {
  const current = installed;
  installed = null;
  if (current === null) return;
  try {
    current.dispose();
  } catch {
    // 卸载阶段不做失败上报，避免掩盖首个异常。
  }
}

/** 供组合根在未接管时（或装配前）拿到一个安全的默认面。 */
export function notInstalled(): ScopeApi {
  return NOT_INSTALLED;
}

export type { FileScope } from "./deps.ts";
