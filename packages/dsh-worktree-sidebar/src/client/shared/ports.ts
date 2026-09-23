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
import type { BindingResponse } from "../../shared/interface.ts";

/**
 * 官方座位上的一条已登记项（运行时形状即 `dsh-client-ui-slots` 的 `StoredEntry`）。
 *
 * 类型面在树内读得到：`dsh-client-ui-renderer/lib/types/client/registry.d.ts:15` 从该包 import
 * `StoredEntry`，`:154`/`:164` 是 `entries`/`entriesOfSlot` 的返回类型（实现包本身不在安装树里，
 * 可读副本的位置见 takeover.ts 头部注释）。
 */
export interface StoredEntryLike {
  readonly component: unknown;
  readonly options: {
    readonly key?: string;
    readonly id?: string;
    readonly order?: number;
    readonly priority?: number;
  };
  /** 官方组件的业务面工厂。我们整套保留它的产物，只在外面把 `hooks.sessions` 换成改写源。 */
  readonly inject?: InjectFactory | undefined;
  readonly store?: unknown;
  readonly locale?: string | undefined;
}

/**
 * tab 类型定义，语义对齐官方 SidebarRightTabDefinition（只读，不改写类型表）。
 *
 * 这里**必须**把在册定义的判据字段列全（尤其 `guide`）：类型表用的是官方定义的那一份（本插件只遮蔽
 * 正文，从不改写类型表），官方注册表 refresh 后会用**在册定义**重算 guide 条目。丢掉 `guide` 的后果不是少一块文案，
 * 而是 guide 归零、所有会话（含从未登记的）默认页签从 Files 变成空的 Guide、文件树打不开。
 * `multiple`/`keepMounted` 仅作读面声明（本包不写类型表）：可选即双基线可编译；
 * 隐藏页签无 abort 时仍在册，binding 刷新仍需 reseed（见 inject keepMounted 用例）。
 */
export interface TabDefinitionLike {
  readonly id: string;
  readonly kind: string;
  readonly patterns?: readonly string[];
  readonly priority?: "extension" | "builtin" | "fallback";
  readonly multiple?: boolean;
  readonly keepMounted?: boolean;
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
  /**
   * 某座位的**原始账**（含被遮蔽的条目），与 {@link entriesOfSlot} 同源不同视图。
   *
   * 遮蔽生效之后「当值」恒为我们那条，官方那条只有这里看得见——官方文档原话：
   * the raw entries view stays the inspection surface（renderer/lib/client.js:1181-1191）。
   * 没有它就看不见官方组件被 HMR 换掉，会一直渲染旧模块的组件。
   */
  entries(key: string): readonly StoredEntryLike[];
  /** 某座位每 cell 当前当值的那一条（优先级最低的存活项）。 */
  entriesOfSlot(key: string): readonly StoredEntryLike[];
  register(options: Record<string, unknown>, component: unknown): () => void;
  subscribe(key: string, listener: () => void): () => void;
  onEntryError(listener: (key: string, entry: StoredEntryLike, error: unknown) => void): () => void;
}

/**
 * tab 类型注册表。**只读**：本包以「同 key 更低 priority 遮蔽正文」接管，不碰类型表，
 * 所以这里没有 `register`——官方定义（含 `guide`）保持原样，也就没有「搬定义搬丢了」的失败形态。
 */
export interface TabsPort {
  /** 某 kind 当前生效的类型定义；`id` 恒为官方 id（我们从不改写它）。 */
  get(kind: string): TabDefinitionLike | undefined;
}

/** uSES 观察源：`getSnapshot` 必须返回引用稳定的快照，否则每次渲染都会触发更新。 */
export interface ObservablePort<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** 官方 entry 的 inject 面工厂：吃渲染器传的参数（首个字符串是会话 id），返回业务面。 */
export type InjectFactory = (...args: unknown[]) => Record<string, unknown>;

/**
 * 一个会话的生效根读数：同步读 + 变化订阅 + 主动拉取。
 *
 * 与 `bindings.ts` 的 `BindingState` **同形**（那边直接当这个端口用），刻意不另造适配层：
 * 「宿主说生效根是哪个」与「改写源看到的是哪个」必须是同一个事实，多一层包装就多一次分叉。
 */
export interface RootReader {
  /** 同步读当前生效根；null 表示按真实 cwd 走。 */
  getSnapshot(): string | null;
  /** 变化订阅（只在实际变化时触发）。返回退订函数。 */
  subscribe(listener: () => void): () => void;
  /** 拉一次宿主；失败保持上次成功态。 */
  refresh(): Promise<void>;
}

/** 一个会话的整套视图：伪造快照源（供 `hooks.sessions`）+ 生效根读数（供树根播种）。 */
export interface SessionView {
  readonly source: ObservablePort<SessionsSnapshotLike>;
  readonly root: RootReader;
}

/** 按会话取视图；同一 id 恒回同一对象（渲染器按源缓存订阅，换了对象就会被当成「状态一直在变」）。 */
export type ViewFor = (sessionId: string) => SessionView;

/**
 * 官方 inject 面的改写器：吃官方工厂、吐同形状的新工厂。改写两件事——`hooks.sessions` 指向
 * 改写源（树读到的 cwd），以及 `start`/`load` 换成「以生效根播种」（官方只在首帧播种一次根）。
 *
 * 契约放在本文件而不是 `inject.ts`：块间零互引（ESLint `no-restricted-imports`）意味着
 * `takeover.ts` 连 `inject.ts` 的**类型**都引不到，跨块的形状只能由纯类型面承载。
 */
export type WrapInject = (official: InjectFactory | undefined) => InjectFactory;

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
 * 只声明真正读到的那一面：`ids` / `current` 曾经是「按会话剪枝」的证据面，剪枝随
 * 去轮询一起删掉后它们没有读取点，留着只会让人以为还有一条存活性推断。
 * `byId` 声明成可选：形态对不上时整体放弃改写，而不是凭空造出会话条目。
 */
export interface SessionsSnapshotLike {
  readonly byId?: Record<string, unknown> | undefined;
}
