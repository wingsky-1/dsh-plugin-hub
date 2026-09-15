/**
 * scope 域依赖声明。这里全部是本插件自己的窄类型——官方 typert 的类型体操留在组合根的适配层里，
 * 于是本域可以完全脱离 cordis 与官方类型被单测驱动。
 */
import type * as bindingApi from "../binding/interface.ts";
import type * as gitApi from "../git/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

/** 与官方同形的文件根解析结果。 */
export interface FileScope {
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

/**
 * binding 域给本域的能力面。**含 `drop`**：检测到失效绑定时要摘掉它，
 * 好让客户端的 revision 缓存随之失效（见 G5 与 `impl/resolve` 的注释）。
 */
export type BindingPort = Pick<typeof bindingApi, "get" | "drop">;

/** git 域给本域的能力面：只要一个归属判定。 */
type GitPort = Pick<typeof gitApi, "belongsTo">;

/** typert 查找表的一个描述符。`resolve` 是「当前生效的那一个」。 */
export interface LookupDescriptorPort {
  readonly resolve: (sessionId: string) => Promise<FileScope | undefined>;
}

/** typert 查找表。键名由本域持有，官方类型只在组合根出现。 */
export interface TypertPort {
  /**
   * 读**当前生效**的描述符；provider 尚未注册时返回 undefined。
   *
   * 调用时机是硬约束：必须在 `configure` **之前**。configure 之后 `get` 回的是我们自己的包装，
   * 官方 resolve 从此不可达——晚一步读，捕获到的就是自己，委托会变成无限递归。
   */
  current(): LookupDescriptorPort | undefined;
  /**
   * 订阅这张查找表的变化（该键的 provider 注册与撤销都会触发）。
   *
   * provider 是**别人**注册的：官方 dsh-api-workspace-files 在自己的 apply 期才 `register`，
   * 谁先谁后由宿主启动序决定。所以本域不能只在 install 那一刻读一次——读不到就等这条通知。
   */
  subscribe(listener: () => void): () => void;
  /**
   * 注册我们的解析器。
   * @throws 当该键已经被别人 configure 过时（第三方接管是全局唯一的，这里只捕获、不抢）。
   */
  configure(resolver: (sessionId: string) => Promise<FileScope | undefined>): () => void;
}

/**
 * 会话链只读面：本域只要「父会话是谁」这一个事实，但它有**两个来源**。
 *
 * 子 agent 的会话是**独立会话**——dsh-subagent 在创建它时只把父的 cwd 拷进子 header
 * （dsh-subagent/lib/index.js:504-510），所以「子 agent 跟着父会话的 worktree」不会自动发生：
 * 绑定记在父会话 id 上，子会话自己那条永远是空的，不问父链就永远看不到。
 *
 * 而父链只在**活会话**的 header 上随时可读：官方 `ctx.sessions.get` 是 live-only
 * （`dsh-session/lib/index.js:1550-1557`）。UI 里能点选的子会话恰恰是**已结束**的那些，
 * 所以还要一条持久读面。两者的分工必须显式——用 `undefined` 同时表示「没有父」和「不在册」时，
 * 每个普通会话都会去问一次持久面，把一次确定的「到顶」变成请求路径上的额外 IO。
 */
export type LiveParent =
  | { readonly kind: "parent"; readonly id: string }
  | { readonly kind: "root" }
  | { readonly kind: "not-live" };

export interface SessionChainPort {
  /** 活会话的父链读数；不在册时回 `not-live`，由本域决定要不要回落持久面。 */
  liveParentOf(sessionId: string): LiveParent;
  /**
   * 已结束会话的父 id（持久 header）。取不到回 undefined。
   * 后端出错（找不到 / 父链成环 / 持久化失败）**可以抛**，由本域收口成「到顶」。
   */
  storedParentOf(sessionId: string): Promise<string | undefined>;
}

export interface ScopeDeps {
  readonly logger: LoggerPort;
  readonly binding: BindingPort;
  readonly git: GitPort;
  readonly typert: TypertPort;
  readonly sessions: SessionChainPort;
  /**
   * 目录存在性判定。缺省直连 fs（`impl/resolve` 的 `directoryExists`）。
   * 注入点存在的理由不是「方便测试」，而是这条判据的两条分支（目录消失 / 读不了）在真实权限下无法稳定构造，
   * 而它们的正确性直接决定用户会不会被永久摘掉绑定。
   */
  readonly existsDirectory?: (path: string) => boolean;
}
