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
 * 任一步失败都把已做的部分回退掉（G2）。半成品态比零注册难查得多：零注册时用户看到的是官方行为，
 * 半成品时看到的是坏掉的官方行为。
 */
import type {
  ClientSlotsPort,
  ObservablePort,
  SessionsSnapshotLike,
  StoredEntryLike,
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

export interface TakeoverDeps {
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

  const teardown = (): void => {
    const current = live;
    live = null;
    if (current === null) return;
    // 逆序：先撤 kind、再撤标题与正文。虽然官方文档说座位 disposer 幂等，
    // 顺序仍按「撤注册的逆序」走，免得在撤 kind 的那一瞬座位仍指向我们的正文。
    for (const dispose of [...current.disposers].reverse()) {
      try {
        dispose();
      } catch {
        // 释放失败不阻断其余，也不上报：卸载阶段出声只会掩盖首个异常。
      }
    }
  };

  const tryTakeOver = (officialId: string, body: StoredEntryLike): void => {
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
      const title = findEntry(deps.slots, TITLE_SLOT, officialId);
      if (title !== undefined) {
        disposers.push(
          deps.slots.register({ name: TITLE_SLOT, key: OUR_TYPE_ID }, title.component),
        );
      }
      const officialType = deps.tabs.get(FILES_KIND);
      disposers.push(
        deps.tabs.register({
          id: OUR_TYPE_ID,
          kind: FILES_KIND,
          // extension 是唯一能顶掉 builtin 的档位；不写就默认 extension，但显式写出来是为了让评审看得见。
          priority: "extension",
          title: officialType?.title ?? (() => "Files"),
        }),
      );
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
   * 官方正文不在时不注册（G1），但**不退订**——它可能只是 HMR 的中间态：
   * 退订会让「官方包确实还在、只是重载了一下」被误判成永久退场。
   */
  const evaluate = (): void => {
    const officialId = deps.tabs.get(FILES_KIND)?.id;
    if (officialId === undefined) {
      teardown();
      return;
    }
    const body = findEntry(deps.slots, BODY_SLOT, officialId);
    if (body === undefined || !deps.slots.isLive(body)) {
      teardown();
      return;
    }
    // 官方组件没换就什么都不用做；换了才重捕（G3 的重捕分支）。
    if (live !== null && live.component === body.component) return;
    teardown();
    tryTakeOver(officialId, body);
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
function findEntry(slots: ClientSlotsPort, slot: string, key: string): StoredEntryLike | undefined {
  return slots.entriesOfSlot(slot).find((entry) => entry.options.key === key);
}

/**
 * 把官方组件的业务面工厂包一层：保留官方的一切，只把 `sessions` 这个 hook 源换成改写过的。
 *
 * 取不到会话 id 时**原样返回**：宁可让树显示真实 cwd（用户能看出来不对），也不指向一个猜出来的目录。
 * renderer 的展开顺序是 `{...kit, ...injected, ...}`，所以我们放进 injected 的 hooks 会覆盖框架注入——这正是机制。
 */
function wrapInject(deps: TakeoverDeps, official: StoredEntryLike["inject"]) {
  return (...args: unknown[]): Record<string, unknown> => {
    const face = official === undefined ? {} : official(...args);
    const sessionId = args.find((arg): arg is string => typeof arg === "string");
    if (sessionId === undefined) return face;
    const existing = face["hooks"];
    const hooks =
      typeof existing === "object" && existing !== null
        ? { ...(existing as Record<string, unknown>) }
        : {};
    hooks["sessions"] = deps.sourceFor(sessionId);
    return { ...face, hooks };
  };
}
