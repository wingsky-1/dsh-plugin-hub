/**
 * 接管 files 页签：把官方组件的**目录根**换掉，不重写树 UI。
 *
 * 官方在座位 `sidebar.right.pane.tab` 上按**当值类型的 id** 找正文（不是按 kind），
 * 所以接管的完整动作是三步，且次序是硬的：
 *   1. 以**我们自己的 id** 为 key 注册正文（复用官方组件 + 官方 store + 官方 locale）；
 *   2. 同样以我们的 id 注册标题（否则 chip 上是一段 fallback 文案）；
 *   3. 最后才在类型注册表上用 `kind: "files"` + `priority: "extension"` 顶掉官方类型——
 *      前两步没成，第三步就绝不做：座位没有我们的正文时，顶掉类型只会让页签显示「不可用」。
 *
 * 第 3 步注册的是 `{...官方定义, id: 我们的 id, priority: "extension"}`——**整个定义原样搬运**。
 * 这不是「顺手多带几个字段」：官方注册表 refresh 后会用**在册定义**重算 guide 条目，
 * 丢掉 `guide` 会让所有会话（含从未登记的）默认页签从 Files 变成空的 Guide。
 *
 * 正文的 `inject` 面**包一层**：官方 `bindInjectSources` 会把 entry inject 面里的 `hooks.<name>`
 * 经 `standardHookPropName` 变成 `use<Name>` props（`dsh-client-ui-renderer/lib/client.js:342-357`），
 * 而展开序 `{...kit, ...injected, ...}`（`:644-650` 与 `:653-658`）让 injected 覆盖框架注入——
 * 这就是把官方正文读的 `useSessions` 换成改写源的机制（计划 §4.2 第 4 条指定的形态）。
 * 作用域因此限定在**本 entry**：其它 `useSessions` 消费方仍拿真实 cwd（计划 §6 的非目标）。
 */
import type {
  ClientSlotsPort,
  ObservablePort,
  SessionContribution,
  SessionsSnapshotLike,
  StoredEntryLike,
  TabDefinitionLike,
  TabsPort,
} from "./ports.ts";

/** 我们接管的 kind。 */
export const FILES_KIND = "files";
/** 正文座位。 */
export const BODY_SLOT = "sidebar.right.pane.tab";
/** 标题座位。 */
export const TITLE_SLOT = "sidebar.right.pane.tab.title";
/** 我们自己的类型 id（也是正文与标题在座位上的 key）。 */
export const OUR_TYPE_ID = "@wingsky-1/dsh-worktree-sidebar/files";

interface TakeoverDeps {
  readonly slots: ClientSlotsPort;
  readonly tabs: TabsPort;
  readonly logger: { warn(message: string): void };
  /** 某个会话的改写源；注入而不是在域内造，接管逻辑因此不需要认识会话存储。 */
  readonly sourceFor: (sessionId: string) => ObservablePort<SessionsSnapshotLike>;
}

/** 接管入口。返回值是完整释放函数；调用方把它放进 `ctx.effect` 的 disposer。 */
export function installTakeover(deps: TakeoverDeps): () => void {
  /** 当前这次接管的三步释放函数（逆序调用）。未接管时为 null。 */
  let live: { disposers: Array<() => void>; component: unknown } | null = null;

  /**
   * 官方条目在座位上的 key，**首次发现时记下**。
   *
   * 不能在每次求值时重新 `deps.tabs.get(FILES_KIND)?.id`：接管成功后它返回的是我们自己的 id，
   * 于是「官方条目还在不在」这个问题会变成「我们自己还在不在」，重捕分支恒不触发
   * （HMR 之后会继续渲染旧模块的组件与旧 inject 闭包）。
   */
  let officialKey: string | undefined;

  const teardown = (): void => {
    const current = live;
    live = null;
    if (current === null) return;
    // 逆序：先撤 kind、再撤标题与正文。
    for (const dispose of [...current.disposers].reverse()) {
      try {
        dispose();
      } catch {
        // 释放失败不阻断其余，也不上报：卸载阶段出声只会掩盖首个异常。
      }
    }
  };

  const tryTakeOver = (
    officialType: TabDefinitionLike | undefined,
    body: StoredEntryLike,
  ): void => {
    const disposers: Array<() => void> = [];
    try {
      disposers.push(
        deps.slots.register(
          {
            name: BODY_SLOT,
            key: OUR_TYPE_ID,
            locale: body.locale,
            store: body.store,
            inject: wrapInject(deps, body.inject),
          },
          body.component,
        ),
      );
      const title = findEntry(deps.slots, TITLE_SLOT, officialKey);
      if (title !== undefined) {
        disposers.push(
          deps.slots.register({ name: TITLE_SLOT, key: OUR_TYPE_ID }, title.component),
        );
      }
      // 官方定义整份搬运：只换 id 与 priority。guide / patterns / canOpen 以及将来新增的字段
      // 都随 {...officialType} 一起过去——我们不需要理解它们，只需要不把它们弄丢。
      const definition: TabDefinitionLike =
        officialType === undefined
          ? { id: OUR_TYPE_ID, kind: FILES_KIND, priority: "extension", title: () => "Files" }
          : { ...officialType, id: OUR_TYPE_ID, priority: "extension" };
      disposers.push(deps.tabs.register(definition));
    } catch (cause) {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {
          // 同上。
        }
      }
      deps.logger.warn(
        "dsh-worktree-sidebar: 接管 files 页签失败，已回退（保持官方行为）— " +
          (cause instanceof Error ? cause.message : String(cause)),
      );
      return;
    }
    live = { disposers, component: body.component };
  };

  /**
   * 重新评估。座位与类型注册表的任何变化都会走到这里。
   *
   * 官方正文不在时不注册，但**不退订**——它可能只是 HMR 的中间态：
   * 退订会让「官方包确实还在、只是重载了一下」被误判成永久退场。
   */
  const evaluate = (): void => {
    if (officialKey === undefined) officialKey = deps.tabs.get(FILES_KIND)?.id;
    if (officialKey === undefined) {
      teardown();
      return;
    }
    // entriesOfSlot 给的是「每个 cell 当前生效的那一条」，在册即存活（官方公开面没有 isLive）。
    const body = findEntry(deps.slots, BODY_SLOT, officialKey);
    if (body === undefined) {
      teardown();
      return;
    }
    // 官方组件没换就什么都不用做；换了才重捕。
    if (live !== null && live.component === body.component) return;
    const officialType = deps.tabs.get(FILES_KIND);
    teardown();
    tryTakeOver(officialType, body);
  };

  const unsubscribeSlot = deps.slots.subscribe(BODY_SLOT, evaluate);
  // 崩溃归因：静态组合下 owner 索引为空，我们自己 entry 的异常只会进 console。
  // 这条订阅是本包唯一能知道「ours 崩了」的地方。
  const unsubscribeErrors = deps.slots.onEntryError((key, entry, error) => {
    if (entry.options.key !== OUR_TYPE_ID) return;
    deps.logger.warn(
      "dsh-worktree-sidebar: 接管入口出现异常（" +
        key +
        "）— " +
        (error instanceof Error ? error.message : String(error)),
    );
  });

  evaluate();

  return () => {
    teardown();
    try {
      unsubscribeSlot();
    } catch {
      // 同上。
    }
    try {
      unsubscribeErrors();
    } catch {
      // 同上。
    }
  };
}

/** 在某个座位的登记项里按 key 找一条。 */
function findEntry(
  slots: ClientSlotsPort,
  slot: string,
  key: string | undefined,
): StoredEntryLike | undefined {
  if (key === undefined) return undefined;
  return slots.entriesOfSlot(slot).find((entry) => entry.options.key === key);
}

/**
 * 把官方组件的业务面工厂包一层：保留官方产出的一切，只把 `sessions` 这个 hook 源换成改写过的。
 *
 * 取不到会话 id 时**原样返回**：宁可让树显示真实 cwd（用户能看出来不对），也不指向一个猜出来的目录。
 * 官方 renderer 的展开序是 `{...kit, ...injected, ...}`，所以我们放进 injected 的 hooks 会覆盖框架注入。
 */
function wrapInject(
  deps: TakeoverDeps,
  official: StoredEntryLike["inject"],
): (...args: unknown[]) => Record<string, unknown> {
  return (...args: unknown[]): Record<string, unknown> => {
    const face: Record<string, unknown> = official === undefined ? {} : official(...args);
    // 渲染器把 binding.key 作为第一个参数传进来（renderer 的 runInject）；非字符串一律原样返回。
    const sessionId = args.find((arg): arg is string => typeof arg === "string");
    if (sessionId === undefined) return face;
    const existing = face["hooks"];
    // 官方 face 里已有的 hooks 源要保留：我们只覆盖 sessions 一项。
    const hooks =
      typeof existing === "object" && existing !== null
        ? (existing as SessionContribution["hooks"])
        : {};
    return { ...face, hooks: { ...hooks, sessions: deps.sourceFor(sessionId) } };
  };
}
