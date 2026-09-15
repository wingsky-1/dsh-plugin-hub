/**
 * 接管 files 页签：把官方组件的**目录根**换掉，不重写树 UI。
 *
 * 接管只做一件事：以**官方 id** 为 key、**更低的 priority** 再登记一条正文，组件 / store /
 * locale 全部复用官方那条（inject 面由 `inject.ts` 包一层）。官方 ui-slots 的每个 cell 取
 * 「优先级最低的那条存活项」——它的注册表原话是 register at a different priority to shadow it
 * (lowest renders)（`@deepseek-ai/dsh-client-ui-slots` 的 `lib/index.js:77`；排序 `:130`；取当值项 `:187-200`）。
 *
 * **那个包不在 dsh 安装树里**：它在构建期被内联进 `dsh-web-frontend/dist/assets/index-*.js`，
 * 所以要照注释去读原文时，可读副本在同仓 catalog 锁版处
 * （`node_modules/.pnpm/@deepseek-ai+dsh-client-ui-slots@0.1.5-rc.1_...` 下的
 * `node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js`）。
 * 树内可读的两处是类型面与运行时入口：`dsh-client-ui-renderer/lib/types/client/registry.d.ts:46/84/154/164`
 * （`class SlotRegistry`、`register`、`entries`、`entriesOfSlot`）与同一包 `lib/client.js:953/1191-1198/1388`。
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
 * 我们那条正文的 priority：比官方那条**低一档**。
 *
 * 官方当前那条没声明 priority（它的 register options 只有 name/key/locale/store/inject，
 * 见界面包里那处注册），所以实际取值仍是 -1；但「官方是 0」不是契约，写死常量意味着
 * 官方哪天声明了 0 以下的 priority，我们就从遮蔽者变成被遮蔽者（自检会当场退位，接管静默失效）。
 * 取值的唯一约束是「比官方低且与官方不同」——同 key 同 priority 的登记会当场抛。
 */
export function shadowPriorityOf(official: StoredEntryLike): number {
  return (official.options.priority ?? 0) - 1;
}

/**
 * 登记本身抛错时的重试上限（含首次）。优先级冲突不在此列——那是终态，重试只会自旋。
 */
const TRANSIENT_ATTEMPTS = 2;

interface TakeoverDeps {
  readonly slots: ClientSlotsPort;
  readonly tabs: TabsPort;
  readonly logger: { warn(message: string): void };
  /** 官方 inject 面的改写器：由装配根从 `inject.ts` 接进来（块间零互引）。 */
  readonly wrapInject: WrapInject;
}

/** 接管入口。返回值是完整释放函数；调用方把它放进 `ctx.effect` 的 disposer。 */
export function installTakeover(deps: TakeoverDeps): () => void {
  /** 当前这次接管：我们的释放函数、被遮蔽的官方条目（HMR 后是另一个对象），以及我们用的 priority。 */
  let live: { dispose: () => void; shadowed: StoredEntryLike; priority: number } | null = null;
  /**
   * 我们用过的 priority 值。key 已经是官方 id，认自己**只能**认 priority，
   * 而 priority 现在是按官方那条算出来的，所以不能再拿一个常量当身份。
   */
  const ours = new Set<number>();
  /** 每条官方条目登记失败的次数：瞬时失败允许再来一次，连续失败才退成「这条不再试」。 */
  const attempts = new WeakMap<StoredEntryLike, number>();
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
  const isOurs = (entry: StoredEntryLike): boolean =>
    entry.options.priority !== undefined && ours.has(entry.options.priority);

  /**
   * 要遮蔽的那条官方正文。
   *
   * 取「不是我们的条目里 priority **最高**的那条」而不是「第一条」：遮蔽者的优先级总是低于它要遮蔽的
   * 那条，所以别人（另一个插件）留下的条目都排在官方之下——把官方的原条目认成「第一条不是我们的」
   * 会让我们的 priority 跟着别人一起往下走，变成一场谁更低的自旋。
   * 别人已经更具体时正确的行为是**退位并出声**（渲染层只画最低的那条，我们的包装不会生效），
   * 那一步由 `evaluate` 的当值复检负责。
   */
  const findOfficial = (id: string): StoredEntryLike | undefined => {
    let best: StoredEntryLike | undefined;
    for (const entry of deps.slots.entries(BODY_SLOT)) {
      if (entry.options.key !== id || isOurs(entry)) continue;
      if (best === undefined || (entry.options.priority ?? 0) > (best.options.priority ?? 0)) {
        best = entry;
      }
    }
    return best;
  };

  /** 座位上当值的那条是不是我们（官方对 keyed 座位的判定就是「同 cell 取首条存活项」）。 */
  const isWinner = (id: string, priority: number): boolean =>
    deps.slots
      .entriesOfSlot(BODY_SLOT)
      .some((entry) => entry.options.key === id && entry.options.priority === priority);

  const teardown = (): void => {
    const current = live;
    live = null;
    if (current === null) return;
    ours.delete(current.priority);
    try {
      current.dispose();
    } catch {
      // 释放失败不上报：卸载阶段出声只会掩盖首个异常。
    }
  };

  /** 自检失败：登记上了但当值项不是我们——优先级冲突，重试无意义。 */
  class ShadowRefused extends Error {}

  const tryTakeOver = (official: StoredEntryLike, id: string): void => {
    const priority = shadowPriorityOf(official);
    let dispose: (() => void) | undefined;
    try {
      dispose = deps.slots.register(
        {
          name: BODY_SLOT,
          key: id,
          priority,
          locale: official.locale,
          store: official.store,
          inject: deps.wrapInject(official.inject),
        },
        official.component,
      );
      // 自检：登记成功不等于当值（官方可能换了更低的优先级）。不当值就退位，不留一条死条目。
      if (!isWinner(id, priority)) {
        throw new ShadowRefused("遮蔽未生效：当值项不是我们这条（priority 更低者才渲染）");
      }
    } catch (cause) {
      try {
        dispose?.();
      } catch {
        // 同上。
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      deps.logger.warn(
        "dsh-worktree-sidebar: 接管 files 页签正文失败，已退位（保持官方行为）— " + reason,
      );
      if (cause instanceof ShadowRefused) {
        // 优先级冲突是终态：官方（或别人）占了更低的 priority，再试还是同一条。
        refused = official;
        return;
      }
      // 登记本身抛错可能只是这一刻的座位变更抖动。一次瞬时失败就永久放弃，会让接管静默失效，
      // 而恢复条件只剩官方包 HMR——所以允许再来一次，连续失败才退成「这条不再试」。
      const tries = (attempts.get(official) ?? 0) + 1;
      attempts.set(official, tries);
      if (tries >= TRANSIENT_ATTEMPTS) refused = official;
      return;
    }
    attempts.delete(official);
    refused = null;
    ours.add(priority);
    live = { dispose, shadowed: official, priority };
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
      if (live.shadowed === official) {
        // 官方组件没换：只有当值也还是我们时才算无事可做。别人登记了更低的 priority 之后，
        // 我们的条目还在座位上但已经不渲染了——那必须当场退位并出声，不能静默留一条死条目。
        if (isWinner(id, live.priority)) return;
        teardown();
        deps.logger.warn(
          "dsh-worktree-sidebar: 接管 files 页签正文失败，已退位（当值项被更低的 priority 夺走，" +
            "我们的包装不会渲染）",
        );
        refused = official;
        return;
      }
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
  let unsubscribeErrors: (() => void) | undefined;
  try {
    // 崩溃归因：静态组合下 owner 索引为空，我们自己 entry 的异常只会进 console。
    // 这条订阅是本包唯一能知道「ours 崩了」的地方；key 已经是官方 id，认自己只能认 priority。
    unsubscribeErrors = deps.slots.onEntryError((key, entry, error) => {
      if (key !== BODY_SLOT || !isOurs(entry)) return;
      deps.logger.warn(
        "dsh-worktree-sidebar: 接管入口出现异常（" +
          key +
          "）— " +
          (error instanceof Error ? error.message : String(error)),
      );
    });
    evaluate();
  } catch (cause) {
    // 两条订阅建立在 evaluate 之前。evaluate 抛错时如果不在这里撤销，订阅会留在单例座位注册表上
    // 永不释放——disposer 根本没生成，卸载时没人收（index.ts 的兜底 catch 只会吞掉这次异常）。
    try {
      unsubscribeErrors?.();
    } catch {
      // 同上。
    }
    try {
      unsubscribeSlot();
    } catch {
      // 同上。
    }
    throw cause;
  }

  return () => {
    teardown();
    try {
      unsubscribeSlot();
    } catch {
      // 同上。
    }
    try {
      unsubscribeErrors?.();
    } catch {
      // 同上。
    }
  };
}
