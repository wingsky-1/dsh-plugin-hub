/**
 * 客户端依赖面：全部是窄接口，浏览器对象与官方组件只出现在 `index.ts` 的适配层里。
 *
 * 这样接管逻辑（注册顺序、失败即零注册、半成品自愈）可以在没有浏览器、没有官方运行时的前提下被单测驱动——
 * 而它正是最需要被逐条断言的部分：这里每一条分支失效都只会让侧边栏「什么都不显示」或「显示别人的东西」。
 */

/** 官方座位上的一条已登记项（运行时形状见 dsh-client-ui-slots 的 StoredEntry）。 */
export interface StoredEntryLike {
  readonly component: unknown;
  readonly options: {
    readonly key?: string;
    readonly id?: string;
    readonly order?: number;
    readonly priority?: number;
  };
  /** 官方组件的业务面工厂。我们搬运它、并在外面套一层改写 hooks。 */
  readonly inject?: ((...args: unknown[]) => Record<string, unknown>) | undefined;
  readonly store?: unknown;
  readonly locale?: string | undefined;
}

/** 官方座位登记表（只声明本包用到的方法）。 */
export interface ClientSlotsPort {
  entriesOfSlot(key: string): readonly StoredEntryLike[];
  register(options: Record<string, unknown>, component: unknown): () => void;
  subscribe(key: string, listener: () => void): () => void;
  isLive(entry: StoredEntryLike): boolean;
  onEntryError(listener: (key: string, entry: StoredEntryLike, error: unknown) => void): () => void;
}

/** tab 类型注册表（只声明读取与注册）。 */
export interface TabsPort {
  /**
   * 某 kind 当前生效的类型定义。`id` 是接管的关键（座位按它找正文），
   * `title` 被我们继承过去，好让 chip 文案仍走官方那套本地化。
   */
  get(
    kind: string,
  ): { readonly id: string; readonly title?: (address: string) => string } | undefined;
  register(definition: {
    readonly id: string;
    readonly kind: string;
    readonly priority?: string;
    readonly title?: (address: string) => string;
  }): () => void;
}

/** uSES 观察源。`getSnapshot` 必须返回引用稳定的快照，否则每次渲染都会触发更新。 */
export interface ObservablePort<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** 读一次宿主绑定。失败返回 undefined（调用方保持上次成功态）。 */
export type ReadBinding = (
  sessionId: string,
) => Promise<{ revision: number; worktreePath: string | null } | undefined>;

/** 会话快照的最小形状：我们只改写 `byId[sessionId].cwd` 这一个字段，其余原样透传。 */
export interface SessionsSnapshotLike {
  readonly byId?: Record<string, unknown> | undefined;
}
