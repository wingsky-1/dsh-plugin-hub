/**
 * scope 域依赖声明。这里全部是本插件自己的窄类型——官方 typert 的类型体操留在组合根的适配层里，
 * 于是本域可以完全脱离 cordis 与官方类型被单测驱动。
 */
import type { BindingApi } from "../binding/interface.ts";
import type { GitApi } from "../git/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

export type { LoggerPort } from "../shared/interface.ts";

/** 与官方同形的文件根解析结果。 */
export interface FileScope {
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

/**
 * binding 域给本域的能力面。**含 `drop`**：检测到失效绑定时要摘掉它，
 * 好让客户端的 revision 缓存随之失效（见 G5 与 `impl/resolve` 的注释）。
 */
export type BindingPort = Pick<BindingApi, "get" | "drop">;

/** git 域给本域的能力面：只要一个归属判定。 */
export type GitPort = Pick<GitApi, "belongsTo">;

/** typert 查找表的一个描述符。`resolve` 是「当前生效的那一个」。 */
export interface LookupDescriptorPort {
  readonly resolve: (sessionId: string) => Promise<FileScope | undefined>;
}

/** typert 查找表。键名由本域持有，官方类型只在组合根出现。 */
export interface TypertPort {
  /**
   * 读**当前生效**的描述符。
   *
   * 调用时机是硬约束：必须在 `configure` **之前**。configure 之后 `get` 回的是我们自己的包装，
   * 官方 resolve 从此不可达——晚一步读，捕获到的就是自己，委托会变成无限递归。
   */
  current(): LookupDescriptorPort | undefined;
  /**
   * 注册我们的解析器。
   * @throws 当该键已经被别人 configure 过时（第三方接管是全局唯一的，这里只捕获、不抢）。
   */
  configure(resolver: (sessionId: string) => Promise<FileScope | undefined>): () => void;
}

/**
 * 会话 header 里本域要的那一个事实。
 *
 * 刻意是一个**有形状的对象**而不是 `string | undefined`：官方把「没有 header」与「header 存在但没有 cwd」
 * 分得很开（前者返回 undefined，后者回落沙箱根），把两者压成同一个 undefined 就会在一个
 * 本该有文件根的会话上凭空回 undefined。
 */
export interface HeaderFace {
  readonly cwd: string | undefined;
}

/** 官方默认解析所需的宿主面。缺省等价实现（provider 未注册时的兜底）照它取三个事实。 */
export interface DefaultScopePort {
  /** 活会话的 header；无该会话返回 undefined。 */
  live(sessionId: string): HeaderFace | undefined;
  /** 已持久化会话的 header；无 sessionPersistence 服务或缺该记录时返回 undefined。 */
  stored(sessionId: string): Promise<HeaderFace | undefined>;
  /** 沙箱工作区根（官方在 header 存在但 cwd 缺失时用它）。 */
  sandboxRoot(): string | undefined;
}

export interface ScopeDeps {
  readonly logger: LoggerPort;
  readonly binding: BindingPort;
  readonly git: GitPort;
  readonly typert: TypertPort;
  readonly defaults: DefaultScopePort;
  /**
   * 目录存在性判定。缺省直连 fs（`impl/resolve` 的 `directoryExists`）。
   * 注入点存在的理由不是「方便测试」，而是这条判据的两条分支（目录消失 / 读不了）在真实权限下无法稳定构造，
   * 而它们的正确性直接决定用户会不会被永久摘掉绑定。
   */
  readonly existsDirectory?: (path: string) => boolean;
}
