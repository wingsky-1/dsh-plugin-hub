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

export interface ScopeDeps {
  readonly logger: LoggerPort;
  readonly binding: BindingPort;
  readonly git: GitPort;
  readonly typert: TypertPort;
  /**
   * 目录存在性判定。缺省直连 fs（`impl/resolve` 的 `directoryExists`）。
   * 注入点存在的理由不是「方便测试」，而是这条判据的两条分支（目录消失 / 读不了）在真实权限下无法稳定构造，
   * 而它们的正确性直接决定用户会不会被永久摘掉绑定。
   */
  readonly existsDirectory?: (path: string) => boolean;
}
