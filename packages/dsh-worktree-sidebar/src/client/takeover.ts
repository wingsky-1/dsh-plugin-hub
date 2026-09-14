/**
 * 接管 files 页签：把官方组件的**目录根**换掉，不重写树 UI。
 *
 * 接管只做一件事：以**官方 id** 为 key、**更低的 priority** 再登记一条正文，组件 / store /
 * locale 全部复用官方那条（inject 面由 `inject.ts` 包一层）。官方 ui-slots 的每个 cell 取
 * 「优先级最低的那条存活项」——它的注册表原话是 register at a different priority to shadow it
 * (lowest renders)（`dsh-client-ui-slots/lib/index.js:77`，排序见 `:129-131`，取当值项见 `:187-202`）。
 *
 * **为什么不再顶掉类型表**：顶掉就得把官方定义整份搬运（`guide` / `patterns` / `canOpen` 以及
 * 将来新增的字段），官方注册表 refresh 后还会用**在册定义**重算 guide 条目——搬丢 `guide` 的后果
 * 是所有会话的默认页签变成空的 Guide。遮蔽正文让类型表、标题、guide 全部保持原样，这份搬运消失。
 *
 * **当值判定**：登记之后座位上当值的那条必须带我们的 priority，否则说明遮蔽没生效（官方换了更低的
 * 优先级，或我们的条目已被退场）。判定失败当场撤掉自己那条并出声：可感知地什么都不做，好过静默
 * 显示错的地方。
 *
 * 本文件只经 `TakeoverDeps.wrapInject` 拿到改写器——接管块与改写块零互引，装配由 `index.ts` 完成。
 */
import type { ClientSlotsPort, StoredEntryLike, TabsPort, WrapInject } from "./shared/ports.ts";

/** 我们接管的 kind。 */
export const FILES_KIND = "files";
/** 正文座位。 */
export const BODY_SLOT = "sidebar.right.pane.tab";
/**
 * 我们那条正文的 priority。
 *
 * 官方自己那条没声明 priority（按 0 算），所以只要严格小于 0 就当值。取值的唯一约束是
 * 「比官方低且与官方不同」——同 key 同 priority 会当场抛（`lib/index.js:84-88`）。
 * 这个常量同时是**我们那条条目的唯一标识**：key 已经是官方 id，认自己只能认 priority。
 */
export const SHADOW_PRIORITY = -1;

interface TakeoverDeps {
  readonly slots: ClientSlotsPort;
  readonly tabs: TabsPort;
  readonly logger: { warn(message: string): void };
  /** 官方 inject 面的改写器：由装配根从 `inject.ts` 接进来（块间零互引）。 */
  readonly wrapInject: WrapInject;
}

/** 接管入口。返回值是完整释放函数；调用方把它放进 `ctx.effect` 的 disposer。 */
export function installTakeover(deps: TakeoverDeps): () => void {
  /** 当前这次接管：我们的释放函数，以及我们遮蔽的那条官方条目（HMR 后是另一个对象）。 */
  let live: { dispose: () => void; shadowed: StoredEntryLike } | null = null;
  /**
   * 自检失败过的那条官方条目。
   *
   * 没有它就会**自旋**：登记与撤销各自会触发一次座位通知（官方是微任务批处理），我们于是
   * 「再试一次 → 再失败 → 再撤销」，把渲染层拖进永不停歇的微任务循环。同一条试过一次就不再试，
   * 直到官方那条换了对象（HMR 重新登记）或换了一条别人才重新评估。
   */
  let refused: StoredEntryLike | null = null;

  /**
   * 官方文件页签的类型 id。**每次重新读**：类型表我们从不改写，所以 `get` 恒回官方那份定义。
   */
  const officialId = (): string | undefined => deps.tabs.get(FILES_KIND)?.id;

  /**
   * 原始账里官方那条正文。
   *
   * 不能用 `entriesOfSlot`：遮蔽生效后它回的是我们自己那条，于是「官方组件换了没有」永远问的是我们，
   * 官方包 HMR 之后会一直渲染旧模块的组件（这是原实现必须把首次读到的 key 记下来的同一个坑）。
   */
  const findOfficial = (id: string): StoredEntryLike | undefined =>
    deps.slots
      .entries(BODY_SLOT)
      .find((entry) => entry.options.key === id && entry.options.priority !== SHADOW_PRIORITY);

  /** 座位上当值的那条是不是我们（官方对 keyed 座位的判定就是「同 cell 取首条存活项」）。 */
  const isWinner = (id: string): boolean =>
    deps.slots
      .entriesOfSlot(BODY_SLOT)
      .some((entry) => entry.options.key === id && entry.options.priority === SHADOW_PRIORITY);

  const teardown = (): void => {
    const current = live;
    live = null;
    if (current === null) return;
    try {
      current.dispose();
    } catch {
      // 释放失败不上报：卸载阶段出声只会掩盖首个异常。
    }
  };

  const tryTakeOver = (official: StoredEntryLike, id: string): void => {
    let dispose: (() => void) | undefined;
    try {
      dispose = deps.slots.register(
        {
          name: BODY_SLOT,
          key: id,
          priority: SHADOW_PRIORITY,
          locale: official.locale,
          store: official.store,
          inject: deps.wrapInject(official.inject),
        },
        official.component,
      );
      // 自检：登记成功不等于当值（官方可能换了更低的优先级）。不当值就退位，不留一条死条目。
      if (!isWinner(id)) {
        throw new Error("遮蔽未生效：当值项不是我们这条（priority 更低者才渲染）");
      }
    } catch (cause) {
      try {
        dispose?.();
      } catch {
        // 同上。
      }
      deps.logger.warn(
        "dsh-worktree-sidebar: 接管 files 页签正文失败，已退位（保持官方行为）— " +
          (cause instanceof Error ? cause.message : String(cause)),
      );
      refused = official;
      return;
    }
    refused = null;
    live = { dispose, shadowed: official };
  };

  /**
   * 重新评估。正文座位的任何变化都会走到这里。
   *
   * 官方正文不在时不登记，但**不退订**——它可能只是 HMR 的中间态：
   * 退订会让「官方包确实还在、只是重载了一下」被误判成永久退场。
   */
  const evaluate = (): void => {
    const id = officialId();
    if (id === undefined) {
      teardown();
      return;
    }
    const official = findOfficial(id);
    if (official === undefined) {
      teardown();
      return;
    }
    if (live !== null) {
      // 官方组件没换就什么都不用做；换了（HMR 重新登记）才重捕。
      if (live.shadowed === official) return;
      teardown();
    } else if (official === refused) {
      // 这一条已经试过且不当值（官方/别人优先级更低）：不自旋，等它换人再说。
      return;
    } else if (!deps.slots.entriesOfSlot(BODY_SLOT).some((e) => e.options.key === id)) {
      // 还没接管，而该 cell 已经没有当值项（官方那条被 abdicate 退场）——不接管一个已退场的座位。
      return;
    }
    tryTakeOver(official, id);
  };

  const unsubscribeSlot = deps.slots.subscribe(BODY_SLOT, evaluate);
  // 崩溃归因：静态组合下 owner 索引为空，我们自己 entry 的异常只会进 console。
  // 这条订阅是本包唯一能知道「ours 崩了」的地方；key 已经是官方 id，认自己只能认 priority。
  const unsubscribeErrors = deps.slots.onEntryError((key, entry, error) => {
    if (key !== BODY_SLOT || entry.options.priority !== SHADOW_PRIORITY) return;
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
