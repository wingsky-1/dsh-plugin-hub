/**
 * scope 域装配：接管 `workspaceFileScope` 的解析，命中绑定就把会话的文件根指到 worktree。
 *
 * 接管是**全局替换**（一个键只有一个解析器），所以本域的三条纪律是硬的：
 * 1. 捕获委托对象必须在 configure 之前；
 * 2. configure 抛错（别人已接管）就整片放弃，不抢；
 * 3. 解析器永不抛出，任何异常都回落官方语义。
 *
 * **provider 由别人注册，我们等它**：官方 dsh-api-workspace-files 在自己的 apply 期才
 * `register("workspaceFileScope", …)`，与本插件的装配先后由宿主启动序决定。所以 provider 不在时
 * 本域既不自己复刻官方默认语义、也不失败，而是**订阅查找表、等它出现**（先订阅再重读一次：
 * 只重读不订阅会漏掉两者之间注册的 provider，只订阅不重读会漏掉订阅之前就已注册的那一个）。
 * 等待期不接管——文件根按官方语义走，这是**正常启动态**而不是降级。
 *
 * 状态（委托对象、装配入参、两个 disposer）住在实例里；域是**进程内单例**，第二次 `install` 由
 * 状态守卫**显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import type { FileScope, ScopeDeps, SessionChainPort } from "../../deps.ts";
import type { WorktreeOrigin } from "../resolve/index.ts";
import {
  bindingOrigin,
  effectiveWorktree as resolveEffectiveWorktree,
  resolveScope,
} from "../resolve/index.ts";

/** 未装配时能力面的失败文案：读到它就说明装配守卫有洞，当场暴露而不是拿旧 deps 出结果。 */
const NOT_INSTALLED = "dsh-worktree-sidebar: scope 域尚未装配";

/**
 * 接管状态。`waiting` 与 `abandoned` 都不接管，但成因不同，故分开报：
 * 前者是「宿主还没把 provider 装上」（正常启动态，会自动收敛），后者是「这个键被别人占了」（终态）。
 */
export type TakeoverState = "idle" | "waiting" | "live" | "abandoned";

/** 委托对象：官方的 resolve（provider 缺失时不接管，所以没有第二来源）。 */
type Delegate = (sessionId: string) => Promise<FileScope | undefined>;

/** scope 域的服务面。 */
export interface ScopeApi {
  /**
   * 当前**生效**的 worktree 根；null 表示该会话按 cwd 走。
   * 浏览器路由读它，所以它与解析器给出的答案是同一个（G7）。
   */
  effectiveWorktree(sessionId: string): Promise<string | null>;
  /**
   * 该会话的**绑定来源**（自己的登记 / 继承来的登记 / 没有）。工具面读它，用来区分
   * 「本会话自己的登记」与「继承自哪个会话」。
   *
   * 它与 `effectiveWorktree` 的**唯一差别是不设 takeover 门**（后者在 `state !== "live"` 时回 null）。
   * 这是刻意的：工具面要的是「登记事实」，而「文件根有没有真的换根」是宿主启动期读数，
   * 由 `/health` 的 `scopeTakeover` 报告。waiting / abandoned 期两者结论不同，不是 bug。
   */
  worktreeOrigin(sessionId: string): Promise<WorktreeOrigin>;
  /** 接管状态的诊断读数：只给 health 用，判定逻辑不看它。接管与否看它是否等于 `live`。 */
  takeoverState(): TakeoverState;
  /** 会话链持久面的读数：查了几次、坏了几次、最后一次为什么坏。同样只给 health 用。 */
  chainDiagnostics(): ChainDiagnostics;
}

/**
 * 会话链持久面的读数。
 *
 * 它存在的唯一理由是**那处收口是无声的**：持久面读不出来时本域按「到顶」处理（正确的行为），
 * 于是功能悄悄降级成 live-only，而真机上插件的 `logger.warn` 不落盘（§19.5），
 * 排查时既没有日志也没有别的痕迹。health 是唯一一条能落地的观测面。
 */
export interface ChainDiagnostics {
  /** 持久面被查了几次：父链的「会话不在册」回落，以及每次会话身份核对。 */
  readonly storedReads: number;
  /** 其中抛错的次数——到顶收口就是在这里发生的。 */
  readonly storedFailures: number;
  /** 最后一次失败的原因；没有失败时缺席。 */
  readonly lastFailure: string | undefined;
}

/**
 * 内部计数器：对外那份是**只读快照**，这里才是唯一被改的那一份。
 * 拆成两个形状是有意的——调用方拿到的读数改不动，域内记账又不必绕开类型。
 */
interface ChainReading {
  storedReads: number;
  storedFailures: number;
  lastFailure: string | undefined;
}

/** `workspaceFileScope` 的接管者：唯一实例。 */
class ScopeService implements ScopeApi {
  private state: TakeoverState = "idle";
  private deps: ScopeDeps | undefined;
  /** 捕获到的委托对象。释放即丢掉，不留在实例上供下一次装配复用。 */
  private delegate: Delegate | undefined;
  /** configure 交回的释放面：调用它官方默认解析即恢复。 */
  private dispose: (() => void) | undefined;
  /** 查找表订阅的退订面。等待期需要它，进入终态后它只是空转。 */
  private unsubscribe: (() => void) | undefined;
  /** 等待期只出一次声：通知可能来很多次，每次都报会把日志淹掉。 */
  private warnedWaiting = false;
  /** 持久面读数。跨调用存活，所以只能住在这里，不能住在 `inherit`（那是无状态函数）。 */
  private chain: ChainReading = { storedReads: 0, storedFailures: 0, lastFailure: undefined };

  /** 装配 scope 域。重复装配是编程错误，当场暴露。 */
  install(deps: ScopeDeps): void {
    if (this.state !== "idle") throw new Error("dsh-worktree-sidebar: scope 域只能装配一次");
    this.chain = { storedReads: 0, storedFailures: 0, lastFailure: undefined };
    // 持久面加一圈读数：失败被 `inherit` 收口成「到顶」，收口点之外没有别人看得见那次失败。
    this.deps = { ...deps, sessions: this.observed(deps.sessions) };
    this.state = "waiting";
    // 先订阅、再重读一次：provider 可能正好在两者之间注册，那次通知已经发完了。
    this.unsubscribe = deps.typert.subscribe(() => this.attempt());
    this.attempt();
  }

  /**
   * 卸载：把 resolver 交还官方、退订、丢掉捕获到的委托与装配入参，复位状态。重复调用无害。
   * 此后到达的解析请求回 undefined（gateway 走它自己的 lookup-not-found），不会拿旧 deps 继续服务。
   */
  release(): void {
    const unsubscribe = this.unsubscribe;
    const dispose = this.dispose;
    this.state = "idle";
    this.deps = undefined;
    this.delegate = undefined;
    this.dispose = undefined;
    this.unsubscribe = undefined;
    this.warnedWaiting = false;
    this.chain = { storedReads: 0, storedFailures: 0, lastFailure: undefined };
    if (unsubscribe !== undefined) {
      try {
        unsubscribe();
      } catch {
        // 卸载阶段不做失败上报，避免掩盖首个异常。
      }
    }
    if (dispose === undefined) return;
    try {
      dispose();
    } catch {
      // 同上。
    }
  }

  takeoverState(): TakeoverState {
    return this.state;
  }

  /** 读数是快照：调用方拿不到本域内部那个对象，改不动它。 */
  chainDiagnostics(): ChainDiagnostics {
    return { ...this.chain };
  }

  /**
   * 给会话链的持久面加一圈读数。失败**照原样抛回**，收口仍在调用方——
   * 这里只负责记账，不改变任何判定。
   *
   * 身份核对也走同一条持久面，所以它同样计入读数：只统计父链会让「身份读不出来」这类
   * 故障在 health 上完全不可见。
   */
  private observed(inner: SessionChainPort): SessionChainPort {
    return {
      liveParentOf: (sessionId) => inner.liveParentOf(sessionId),
      storedParentOf: (sessionId) => this.counted(() => inner.storedParentOf(sessionId)),
      liveIdentityOf: (sessionId) => inner.liveIdentityOf(sessionId),
      storedIdentityOf: (sessionId) => this.counted(() => inner.storedIdentityOf(sessionId)),
    };
  }

  /** 记一次持久面读取：无论成败都算一次读，抛错另计一次失败并留下最后原因。 */
  private async counted<T>(read: () => Promise<T>): Promise<T> {
    this.chain.storedReads += 1;
    try {
      return await read();
    } catch (cause) {
      this.chain.storedFailures += 1;
      this.chain.lastFailure = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    }
  }

  async effectiveWorktree(sessionId: string): Promise<string | null> {
    const deps = this.deps;
    if (deps === undefined) throw new Error(NOT_INSTALLED);
    // 还没接管（等 provider）或接管权被别人占了时文件根保持官方语义，客户端因此不动它。
    if (this.state !== "live") return null;
    return resolveEffectiveWorktree(deps, sessionId);
  }

  /**
   * 绑定来源。**不设 takeover 门**：登记是否存在与「文件根是否已经换成它」是两件事，
   * 工具面（register / create / remove）要的是前者的完整答案——它据此决定能不能摘、
   * 该不该报「继承自哪个会话」。把工具面也卡在 `live` 上，接管冲突时连一条已确认失效的
   * 登记都清理不掉。
   */
  async worktreeOrigin(sessionId: string): Promise<WorktreeOrigin> {
    const deps = this.deps;
    if (deps === undefined) throw new Error(NOT_INSTALLED);
    return bindingOrigin(deps, sessionId);
  }

  /**
   * 试一次接管。provider 没出现就退回等待态，等待由查找表的变更通知再次叫醒。
   */
  private attempt(): void {
    if (this.state !== "waiting") return;
    const deps = this.deps;
    if (deps === undefined) return;
    const descriptor = deps.typert.current();
    if (descriptor === undefined) {
      if (!this.warnedWaiting) {
        this.warnedWaiting = true;
        deps.logger.warn(
          "dsh-worktree-sidebar: workspaceFileScope 的 provider 尚未注册，先等它出现（文件根暂按官方语义）",
        );
      }
      return;
    }
    // 三件事都必须在 configure 之前落定：configure 会**同步**发出一次查找表变更通知，
    // 重入的 attempt 只有看到终态（并已拿到委托）才不会把自己判成「已被别人占用」。
    const delegate = descriptor.resolve;
    this.delegate = delegate;
    this.state = "live";
    try {
      this.dispose = deps.typert.configure((sessionId) => this.resolve(sessionId));
    } catch (cause) {
      // 第三方已经接管这个键：接管权是全局唯一的，本插件只放弃并出声，不抢。
      // 「已被占用」是**当次**的事实——不缓存成永久结论，release 之后再装配会重新尝试。
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.state = "abandoned";
      this.delegate = undefined;
      this.dispose = undefined;
      deps.logger.warn(
        "dsh-worktree-sidebar: workspaceFileScope 已有解析器，放弃接管（文件根保持官方语义）— " +
          reason,
      );
    }
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
