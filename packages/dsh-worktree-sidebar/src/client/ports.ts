/**
 * 客户端依赖面：全部是窄接口，浏览器对象与官方组件只出现在 `index.ts` 的适配层里。
 *
 * **这些窄接口必须逐条对着运行时的真实服务面写，不能对着某个类型包的声明写。**
 * 本项目踩过两次，形态完全一样（照假设写的端口在真机上第一次求值就 TypeError，而假端口单测全绿）：
 * 1. `ctx.slots` 的运行时实现是 `dsh-client-ui-renderer` 的 `SlotRegistry`
 *    （registry.d.ts:46 的 `class SlotRegistry extends Service`，:84 的 `register = SlotCore[%27register%27]`），
 *    而另一个同名类型包声明了一个 `isLive` 方法。
 * 2. `ctx.sessions` 是 `ISessions`（客户端的会话服务），快照数据在它的 `.list` 上
 *    （`ObservableSnapshot<SessionListState>`），服务对象自己**没有** `getSnapshot`。
 * 两次的教训是同一条：假端口只证明「代码与我的假设一致」，不证明「假设与运行时一致」。
 *
 * 同一个教训的第三份副本在本文件另一类注释里：曾把「往组件 props 里塞 `hooks.sessions` 不被读」
 * 写成事实，并据此把接缝换成 session 作用域。官方 `bindInjectSources` 恰恰会把 entry inject 面的
 * `hooks.<name>` 变成 `use<Name>` props——被读，且覆盖框架注入。所以本包用 entry 级接缝。
 */
import type { BindingResponse } from "../contract.ts";

/** 官方座位上的一条已登记项（运行时形状即 dsh-client-ui-slots 的 StoredEntry）。 */
export interface StoredEntryLike {
  readonly component: unknown;
  readonly options: {
    readonly key?: string;
    readonly id?: string;
    readonly order?: number;
    readonly priority?: number;
  };
  /** 官方组件的业务面工厂。我们整套保留它的产物，只在外面把 `hooks.sessions` 换成改写源。 */
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

/** uSES 观察源：`getSnapshot` 必须返回引用稳定的快照，否则每次渲染都会触发更新。 */
export interface ObservablePort<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * 一份注入面里的 hook 源表，键是 hook 名。
 *
 * 这正是官方 `bindInjectSources` 读的那个 `face["hooks"]`：它把每个 `hooks.<name>`
 * 经 `standardHookPropName` 合成为 `use<Name>` props
 * （`dsh-client-ui-renderer/lib/client.js:342-357`），而展开序 `{...kit, ...injected, ...}`
 * （`:644-650` 与 `:653-658`）让 injected 覆盖框架注入——这就是改写 `useSessions` 的机制。
 */
export interface SessionContribution {
  readonly hooks: Readonly<Record<string, ObservablePort<unknown>>>;
}

/** 读一次宿主绑定。失败返回 undefined（调用方保持上次成功态）。 */
export type ReadBinding = (sessionId: string) => Promise<BindingResponse | undefined>;

/**
 * 会话快照的最小形状：我们只改写 `byId[sessionId].cwd` 这一个字段，其余原样透传。
 *
 * `ids` / `byId` / `current` 同时是装配根判断「这个会话还在不在」的三个证据面
 * （`index.ts` 的剪枝）。三项都声明成可选：宿主快照的形态与这份假设不一致时，
 * 剪枝整体放弃，而不是把读不到的字段当成「已消失」。
 */
export interface SessionsSnapshotLike {
  readonly ids?: readonly string[] | undefined;
  readonly byId?: Record<string, unknown> | undefined;
  readonly current?: string | undefined;
}
