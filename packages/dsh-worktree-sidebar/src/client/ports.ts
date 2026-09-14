/**
 * 客户端依赖面：全部是窄接口，浏览器对象与官方组件只出现在 `index.ts` 的适配层里。
 *
 * **这些窄接口必须逐条对着运行时的真实服务面写，不能对着某个类型包的声明写。**
 * 本项目踩过一次：`ctx.slots` 的运行时实现是 `dsh-client-ui-renderer` 的 `SlotRegistry`
 * （registry.d.ts:46 的 `class SlotRegistry extends Service`，:84 的 `register = SlotCore['register']`），
 * 而另一个同名类型包声明了一个 `isLive` 方法。照后者写出来的端口在真机上第一次求值就
 * `TypeError: slots.isLive is not a function`，而这个错误在自造端口的单测里永远看不见——
 * 假端口只证明「代码与我的假设一致」，不证明「假设与运行时一致」。
 */

/** 官方座位上的一条已登记项（运行时形状即 dsh-client-ui-slots 的 StoredEntry）。 */
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

/**
 * tab 类型定义，逐字对齐官方 SidebarRightTabDefinition。
 *
 * 这里**必须**把所有字段都列全（尤其 `guide`）：我们注册的是「顶掉官方类型」的那一份，
 * 官方注册表 refresh 后会用**在册定义**重算 guide 条目。丢掉 `guide` 的后果不是少一块文案，
 * 而是 guide 归零、所有会话（含从未登记的）默认页签从 Files 变成空的 Guide、文件树打不开。
 */
export interface TabDefinitionLike {
  readonly id: string;
  readonly kind: string;
  readonly patterns?: readonly string[];
  readonly priority?: string;
  readonly canOpen?: (address: string) => boolean;
  readonly title: (address: string) => string;
  readonly guide?: readonly unknown[];
}

/**
 * 官方座位登记表（只声明本包用到的方法）。
 *
 * `isLive` 刻意**不在**这里：官方公开面没有它。存活性判据就是 `entriesOfSlot` 的返回集合本身——
 * 它给的是「每个 cell 当前生效（非 abdicated）的那一条」，在册即存活。
 */
export interface ClientSlotsPort {
  entriesOfSlot(key: string): readonly StoredEntryLike[];
  register(options: Record<string, unknown>, component: unknown): () => void;
  subscribe(key: string, listener: () => void): () => void;
  onEntryError(listener: (key: string, entry: StoredEntryLike, error: unknown) => void): () => void;
}

/** tab 类型注册表。 */
export interface TabsPort {
  /**
   * 某 kind 当前生效的类型定义。
   *
   * `id` 只在**接管之前**等于官方 id：我们以 `priority: "extension"` 顶掉 builtin 之后，
   * 这里返回的就是我们自己的 id。所以调用方必须把首次读到的官方 id 记下来——
   * 每次重新 `get` 会让「官方条目还在不在」这个问题永远问的是我们自己。
   */
  get(kind: string): TabDefinitionLike | undefined;
  register(definition: TabDefinitionLike): () => void;
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
