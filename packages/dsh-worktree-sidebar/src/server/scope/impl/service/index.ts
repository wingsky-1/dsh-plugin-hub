/**
 * scope 域装配：接管 `workspaceFileScope` 的解析，命中绑定就把会话的文件根指到 worktree。
 *
 * 接管是**全局替换**（一个键只有一个解析器），所以本域的三条纪律是硬的：
 * 1. 捕获委托对象必须在 configure 之前；
 * 2. configure 抛错（别人已接管）就整片放弃，不抢；
 * 3. 解析器永不抛出，任何异常都回落官方语义。
 *
 * 状态（捕获到的委托、装配入参与那个 disposer）住在实例里；域是**进程内单例**，第二次 `install` 由
 * `installed` 守卫**显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import type { FileScope, ScopeDeps } from "../../deps.ts";
import { createFallback } from "../fallback/index.ts";
import { effectiveWorktree as resolveEffectiveWorktree, resolveScope } from "../resolve/index.ts";

/** 未装配时能力面的失败文案：读到它就说明装配守卫有洞，当场暴露而不是拿旧 deps 出结果。 */
const NOT_INSTALLED = "dsh-worktree-sidebar: scope 域尚未装配";

/** 委托对象：官方的 resolve，或 provider 缺失时的等价兜底。 */
type Delegate = (sessionId: string) => Promise<FileScope | undefined>;

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

/** `workspaceFileScope` 的接管者：唯一实例。 */
class ScopeService implements ScopeApi {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  private deps: ScopeDeps | undefined;
  /** 捕获到的委托对象。释放即丢掉，不留在实例上供下一次装配复用。 */
  private delegate: Delegate | undefined;
  /** configure 交回的释放面：调用它官方默认解析即恢复。 */
  private dispose: (() => void) | undefined;

  /** 装配 scope 域。重复装配是编程错误，当场暴露。 */
  install(deps: ScopeDeps): void {
    if (this.installed) throw new Error("dsh-worktree-sidebar: scope 域只能装配一次");
    // 捕获委托对象必须在这里、在 configure 之前（见 deps.ts 的 TypertPort.current 注释）。
    const captured = deps.typert.current()?.resolve;
    this.installed = true;
    this.deps = deps;
    this.delegate = captured ?? createFallback(deps.defaults);
    try {
      this.dispose = deps.typert.configure((sessionId) => this.resolve(sessionId));
    } catch (cause) {
      // 第三方已经接管这个键：接管权是全局唯一的，本插件只放弃并出声，不抢。
      // 「已被占用」是**当次**的事实——不缓存成永久结论，release 之后再装配会重新尝试。
      const reason = cause instanceof Error ? cause.message : String(cause);
      deps.logger.warn(
        "dsh-worktree-sidebar: workspaceFileScope 已有解析器，放弃接管（文件根保持官方语义）— " +
          reason,
      );
      this.dispose = undefined;
    }
  }

  /**
   * 卸载：把 resolver 交还官方、丢掉捕获到的委托与装配入参，复位装配标记。重复调用无害。
   * 此后到达的解析请求回 undefined（gateway 走它自己的 lookup-not-found），不会拿旧 deps 继续服务。
   */
  release(): void {
    this.installed = false;
    this.deps = undefined;
    this.delegate = undefined;
    const dispose = this.dispose;
    this.dispose = undefined;
    if (dispose === undefined) return;
    try {
      dispose();
    } catch {
      // 卸载阶段不做失败上报，避免掩盖首个异常。
    }
  }

  isInstalled(): boolean {
    return this.dispose !== undefined;
  }

  async effectiveWorktree(sessionId: string): Promise<string | null> {
    const deps = this.deps;
    if (deps === undefined) throw new Error(NOT_INSTALLED);
    // 没有接管权（该键已被第三方占用）时文件根保持官方语义，客户端因此不动它。
    if (this.dispose === undefined) return null;
    return resolveEffectiveWorktree(deps, sessionId);
  }

  /**
   * 交给官方 typert 的解析器。委托对象与装配入参都按**调用当刻**取：释放之后这个闭包只剩
   * undefined，官方拿到的是它自己的 lookup-not-found，而不是一份过期绑定。
   */
  private async resolve(sessionId: string): Promise<FileScope | undefined> {
    const deps = this.deps;
    const delegate = this.delegate;
    if (deps === undefined || delegate === undefined) return undefined;
    return resolveScope(deps, delegate, sessionId);
  }
}

/** 本域唯一实例：类不外放，外面 `new` 不出第二份接管者。 */
export const scopeService = new ScopeService();
