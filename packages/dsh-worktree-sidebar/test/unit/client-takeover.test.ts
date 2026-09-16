/**
 * 接管 files 页签 —— 用**复刻官方语义**的假座位表驱动（`createFakeSlots`，见 test/helpers.ts）。
 *
 * 为什么先写负向用例：接管的失败形态是「右栏坏了」，而它比「右栏没变」严重得多。
 * 所以这里的第一条判据不是「接管成功了吗」，而是「抓不到官方正文时，我们**一个注册都没有**」。
 *
 * 本文件钉的是**遮蔽语义**：以官方 id 为 key、更低 priority 再登记一条，官方那条原样留在账上。
 * 判据因此不能是「我们调了 register 没有」，必须是「座位上当值的是哪一条」——那正是渲染层读的东西
 * （官方 `renderer/lib/client.js:827`：`entriesOfSlot(slot).find(e => e.options.key === entryKey)`）。
 */
import { describe, expect, it } from "vitest";
import { createFakeSlots } from "../helpers.ts";
import { createInjectWrapper } from "../../src/client/inject.ts";
import type {
  ClientSlotsPort,
  InjectFactory,
  ObservablePort,
  SessionView,
  SessionsSnapshotLike,
  StoredEntryLike,
  TabDefinitionLike,
  TabsPort,
} from "../../src/client/shared/ports.ts";
import {
  BODY_SLOT,
  FILES_KIND,
  installTakeover,
  shadowPriorityOf,
} from "../../src/client/takeover.ts";

const OFFICIAL_ID = "@deepseek-ai/dsh-client-ui-sidebar-files/files";
/** 官方标题座位的 key（我们不再往这里登记任何东西）。 */
const TITLE_SLOT = "sidebar.right.pane.tab.title";
const LOCALE = "sidebarFiles";
const STORE = { kind: "store" };
const FILES_BODY = { name: "FilesBody" };
const FILES_TITLE = { name: "FilesTitle" };
const GUIDE = [{ order: 10, title: () => "Workspace files" }];
const OFFICIAL_DEFINITION: TabDefinitionLike = {
  id: OFFICIAL_ID,
  kind: FILES_KIND,
  priority: "builtin",
  title: () => "Files",
  guide: GUIDE,
};

/** 改写源的假件：本文件的注册/释放用例不经过 inject，递一个引用稳定的空源即可。 */
const STABLE_SOURCE: ObservablePort<SessionsSnapshotLike> = {
  getSnapshot: () => ({}),
  subscribe: () => () => undefined,
};

/** 一个会话视图的假件：本文件只走注册/释放与 inject 面包装，生效根读数不承载判据。 */
function viewOf(source: ObservablePort<SessionsSnapshotLike>): SessionView {
  return {
    source,
    root: {
      getSnapshot: () => null,
      subscribe: () => () => undefined,
      refresh: () => Promise.resolve(),
    },
  };
}

/** 排空微任务：官方登记/撤销的变更通知是微任务批处理的，我们自己那次通知也会走到 evaluate。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(
  options: {
    /** 我们那条正文的登记永久失败。 */
    bodyFails?: boolean;
    /** 我们那条正文的登记失败前 N 次（用来演「瞬时失败 → 下一次通知重试成功」）。 */
    bodyFailsTimes?: number;
    /** 官方那条自己声明的 priority；缺省即「没声明」（按 0 算）。 */
    officialPriority?: number;
  } = {},
) {
  const warns: string[] = [];
  const fake = createFakeSlots();
  const officialInject = (): Record<string, unknown> => ({
    useFiles: "official-useFiles",
    hooks: { other: "keep-me" },
  });
  const registerOfficial = (component: unknown): (() => void) =>
    fake.slots.register(
      {
        name: BODY_SLOT,
        key: OFFICIAL_ID,
        locale: LOCALE,
        store: STORE,
        inject: officialInject,
        ...(options.officialPriority === undefined ? {} : { priority: options.officialPriority }),
      },
      component,
    );
  let officialEntry: StoredEntryLike | undefined;
  let disposeOfficial = registerOfficial(FILES_BODY);
  officialEntry = fake.entries(BODY_SLOT)[0];
  fake.slots.register({ name: TITLE_SLOT, key: OFFICIAL_ID }, FILES_TITLE);

  /**
   * 类型注册表的假件：**运行时真有 `register`**（官方那份 API 就挂在 `ctx.sidebarRightTabs` 上），
   * 只是我们的端口不声明它。所以这里用 `Object.assign` 挂上去而不是写进对象字面量——
   * 复刻「能力在、但我们看不见」这个真实形态，也让「类型表一个字节没动」那条判据不是恒真。
   */
  let officialType: TabDefinitionLike | undefined = OFFICIAL_DEFINITION;
  const tabs: TabsPort = Object.assign(
    { get: (kind: string) => (kind === FILES_KIND ? officialType : undefined) },
    {
      register: (definition: TabDefinitionLike) => {
        const previous = officialType;
        officialType = definition;
        return () => {
          if (officialType === definition) officialType = previous;
        };
      },
    },
  );

  /**
   * 正文登记失败：只对我们那条抛。认自己不看具体数值——priority 是按官方那条算出来的，
   * 而官方那条在夹具里默认**不声明** priority，所以「带 priority 的登记」就是我们。
   */
  /** 我们那条条目的 identity：wrapper 产出的 inject 工厂是我们唯一能精确认出的东西。 */
  const ourInjectFactories = new Set<InjectFactory>();
  const attempts = { count: 0 };
  const failsOurs = (): boolean => {
    attempts.count += 1;
    if (options.bodyFails === true) return true;
    return options.bodyFailsTimes !== undefined && attempts.count <= options.bodyFailsTimes;
  };
  const needsFailingRegister = options.bodyFails === true || options.bodyFailsTimes !== undefined;
  const slots: ClientSlotsPort = needsFailingRegister
    ? {
        ...fake.slots,
        register: (regOptions, component) => {
          if (regOptions["priority"] !== undefined && failsOurs()) {
            throw new Error("body register exploded");
          }
          return fake.slots.register(regOptions, component);
        },
      }
    : fake.slots;

  /** 我们那条条目：`inject` 是我们这个 wrapper 的产物（官方那条的 inject 是它自己的工厂）。 */
  const isOurs = (entry: StoredEntryLike): boolean =>
    entry.inject !== undefined && ourInjectFactories.has(entry.inject);

  const ours = (): readonly StoredEntryLike[] =>
    fake.entries(BODY_SLOT).filter((entry) => isOurs(entry));

  return {
    fake,
    tabs,
    warns,
    ours,
    /** 我们那条正文；不在就当场判红（省得断言里到处写可选链）。 */
    mustOurs: (): StoredEntryLike => {
      const entry = ours()[0];
      if (entry === undefined) throw new Error("我们那条正文不在座位上");
      return entry;
    },
    /** 官方那条正文：登记时当场记下的那个对象（HMR 重登记会换成新对象）。 */
    official: (): StoredEntryLike | undefined => officialEntry,
    setOfficialType: (definition: TabDefinitionLike | undefined) => {
      officialType = definition;
    },
    /** 官方包 HMR：旧登记退场、同 key 重新登记一条新组件。 */
    reRegisterOfficial: (component: unknown) => {
      disposeOfficial();
      disposeOfficial = registerOfficial(component);
      officialEntry = fake
        .entries(BODY_SLOT)
        .find((entry) => entry.options.key === OFFICIAL_ID && !isOurs(entry));
    },
    dropOfficial: () => disposeOfficial(),
    install: () =>
      installTakeover({
        slots,
        tabs,
        logger: { warn: (message: string) => warns.push(message) },
        wrapInject: (official) => {
          const wrapped = createInjectWrapper(() => viewOf(STABLE_SOURCE))(official);
          ourInjectFactories.add(wrapped);
          return wrapped;
        },
      }),
  };
}

describe("抓不到官方正文时零注册", () => {
  it("座位里没有官方条目 → 一个注册都没有", () => {
    const h = harness();
    h.dropOfficial();
    h.install();
    expect(h.ours()).toHaveLength(0);
  });

  it("类型注册表里没有 files 类型 → 一个注册都没有", () => {
    const h = harness();
    h.setOfficialType(undefined);
    h.install();
    expect(h.ours()).toHaveLength(0);
  });

  it("官方那条已退场（abdicated）→ 不接管一个已退场的座位", () => {
    const h = harness();
    const official = h.official();
    if (official === undefined) throw new Error("官方条目不在");
    h.fake.abdicate(official);
    h.install();
    expect(h.ours()).toHaveLength(0);
  });

  it("正文登记失败 → 零注册、出声，且官方那条仍当值（不是空 cell）", () => {
    const h = harness({ bodyFails: true });
    h.install();
    expect(h.ours()).toHaveLength(0);
    expect(h.warns.some((w) => w.includes("接管 files 页签正文失败"))).toBe(true);
    expect(h.fake.winner(BODY_SLOT)).toBe(h.official());
  });
});

describe("瞬时失败与永久失败分道", () => {
  it("登记瞬时失败：下一次座位通知重试并接管成功", async () => {
    // 一次瞬时失败就永久放弃，会让接管静默失效，而恢复条件只剩官方包 HMR。
    const h = harness({ bodyFailsTimes: 1 });
    h.install();
    expect(h.ours()).toHaveLength(0);
    expect(h.warns).toHaveLength(1);

    h.fake.emit(BODY_SLOT);
    expect(h.ours()).toHaveLength(1);
    expect(h.fake.winner(BODY_SLOT)).toBe(h.mustOurs());
  });

  it("连续失败到上限之后不再重试（有限次：否则每次座位通知都白试一遍）", async () => {
    const h = harness({ bodyFailsTimes: 99 });
    h.install();
    h.fake.emit(BODY_SLOT);
    h.fake.emit(BODY_SLOT);
    h.fake.emit(BODY_SLOT);
    // 上限 2 次尝试：第 2 次之后该条目被判成「不再试」，后续通知不再出声也不再登记。
    expect(h.warns).toHaveLength(2);
    expect(h.ours()).toHaveLength(0);
  });
});

describe("遮蔽当值", () => {
  it("登记之后当值的是我们那条，官方那条仍在账上（不是顶掉）", () => {
    const h = harness();
    h.install();
    const official = h.official();
    if (official === undefined) throw new Error("官方条目不在");
    const winner = h.fake.winner(BODY_SLOT);
    expect(winner?.options.priority).toBe(shadowPriorityOf(official));
    expect(winner?.options.key).toBe(OFFICIAL_ID);
    expect(h.ours()).toHaveLength(1);
    expect(h.official()).toBeDefined();
  });

  it("priority 按官方那条算：官方自己声明了 priority 时我们低一档仍然当值", () => {
    // 写死常量的话，官方哪天声明了更低的 priority，我们就从遮蔽者变成被遮蔽者（自检退位）。
    const h = harness({ officialPriority: -5 });
    h.install();
    expect(h.mustOurs().options.priority).toBe(-6);
    expect(h.fake.winner(BODY_SLOT)).toBe(h.mustOurs());
  });

  it("类型表一个字节没动：接管前后是同一个定义引用（guide 也在原处）", () => {
    const h = harness();
    const restore = h.install();
    expect(h.tabs.get(FILES_KIND)).toBe(OFFICIAL_DEFINITION);
    expect((h.tabs.get(FILES_KIND) as TabDefinitionLike).guide).toBe(GUIDE);
    restore();
    expect(h.tabs.get(FILES_KIND)).toBe(OFFICIAL_DEFINITION);
  });

  it("复用官方组件、store、locale", () => {
    const h = harness();
    h.install();
    expect(h.mustOurs().component).toBe(FILES_BODY);
    expect(h.mustOurs().store).toBe(STORE);
    expect(h.mustOurs().locale).toBe(LOCALE);
  });

  it("标题座位零登记（官方标题原样渲染）", () => {
    const h = harness();
    h.install();
    expect(h.fake.entries(TITLE_SLOT)).toHaveLength(1);
  });

  it("我们自己登记引发的通知不会重复注册（官方通知是微任务批处理）", async () => {
    const h = harness();
    h.install();
    await settle();
    await settle();
    expect(h.ours()).toHaveLength(1);
  });
});

describe("当值自检：不当值就退位", () => {
  it("官方（或别的插件）登记了更低的 priority → 我们撤销自己那条并出声，且不自旋", async () => {
    const h = harness();
    h.install();
    h.fake.slots.register({ name: BODY_SLOT, key: OFFICIAL_ID, priority: -5 }, { name: "Other" });
    h.fake.emit(BODY_SLOT);
    expect(h.ours()).toHaveLength(0);
    expect(h.warns.some((w) => w.includes("接管 files 页签正文失败"))).toBe(true);
    // 退位之后座位上仍有当值项（那条更低的），不会出现空 cell。
    expect(h.fake.winner(BODY_SLOT)?.options.priority).toBe(-5);
    // 登记与撤销各自会触发一次座位通知：同一条官方条目只许试一次，否则就是永不停歇的微任务自旋。
    await settle();
    expect(h.ours()).toHaveLength(0);
    expect(h.warns).toHaveLength(1);
  });

  it("官方组件换了（HMR 重新登记）→ 重捕到新组件", () => {
    const h = harness();
    h.install();
    const newBody = { name: "NewBody" };
    h.reRegisterOfficial(newBody);
    h.fake.emit(BODY_SLOT);
    expect(h.ours()).toHaveLength(1);
    expect(h.mustOurs().component).toBe(newBody);
    expect(h.fake.winner(BODY_SLOT)).toBe(h.mustOurs());
  });

  it("官方正文消失时撤销我们的注册，但不退订（再出现能重新接管）", () => {
    const h = harness();
    h.install();
    expect(h.ours()).toHaveLength(1);
    h.dropOfficial();
    h.fake.emit(BODY_SLOT);
    expect(h.ours()).toHaveLength(0);
    h.reRegisterOfficial(FILES_BODY);
    h.fake.emit(BODY_SLOT);
    expect(h.ours()).toHaveLength(1);
  });

  it("dispose 撤销注册，且退订之后不再重评", () => {
    const h = harness();
    const restore = h.install();
    expect(h.ours()).toHaveLength(1);
    restore();
    expect(h.ours()).toHaveLength(0);
    h.reRegisterOfficial({ name: "Newer" });
    h.fake.emit(BODY_SLOT);
    expect(h.ours()).toHaveLength(0);
  });
});

describe("正文的 inject 面被包装：hooks.sessions 换成改写源", () => {
  it("调用登记进去的 inject 后 hooks.sessions 是本会话的改写源，官方面其余键原样保留", () => {
    const source = { getSnapshot: () => ({}), subscribe: () => () => undefined };
    const asked: string[] = [];
    const fake = createFakeSlots();
    fake.slots.register(
      {
        name: BODY_SLOT,
        key: OFFICIAL_ID,
        inject: () => ({ useFiles: "official-useFiles", hooks: { other: "keep-me" } }),
      },
      FILES_BODY,
    );
    installTakeover({
      slots: fake.slots,
      tabs: { get: (kind) => (kind === FILES_KIND ? OFFICIAL_DEFINITION : undefined) },
      logger: { warn: () => undefined },
      wrapInject: createInjectWrapper((sessionId) => {
        asked.push(sessionId);
        return viewOf(source);
      }),
    });
    const entry = fake.entries(BODY_SLOT).find((e) => e.options.priority !== undefined);
    const face = (entry?.inject as (sessionId: string) => Record<string, unknown>)("s1");
    expect(face["hooks"]).toEqual({ other: "keep-me", sessions: source });
    expect(face["useFiles"]).toBe("official-useFiles");
    expect(asked).toEqual(["s1"]);
  });

  it("取不到会话 id 时原样返回官方 face（不猜会话）", () => {
    const officialFace = { hooks: { other: "keep-me" } };
    const fake = createFakeSlots();
    fake.slots.register(
      { name: BODY_SLOT, key: OFFICIAL_ID, inject: () => officialFace },
      FILES_BODY,
    );
    installTakeover({
      slots: fake.slots,
      tabs: { get: () => OFFICIAL_DEFINITION },
      logger: { warn: () => undefined },
      wrapInject: createInjectWrapper(() => {
        throw new Error("不该被调用");
      }),
    });
    const entry = fake.entries(BODY_SLOT).find((e) => e.options.priority !== undefined);
    const face = (entry?.inject as (...args: unknown[]) => Record<string, unknown>)({
      notAString: true,
    });
    expect(face).toBe(officialFace);
  });
});

describe("崩溃归因", () => {
  it("只对我们自己的 entry 出声", () => {
    const h = harness();
    h.install();
    const official = h.official();
    if (official === undefined) throw new Error("官方条目不在");
    h.fake.reportError(BODY_SLOT, official, new Error("nope"));
    expect(h.warns).toHaveLength(0);
    h.fake.reportError(BODY_SLOT, h.mustOurs(), new Error("ours broke"));
    expect(h.warns.some((w) => w.includes("ours broke"))).toBe(true);
  });
});

describe("初始化失败时不留悬挂订阅", () => {
  it("evaluate 抛错时两条订阅逆序撤销后再抛（否则它们留在单例注册表上，卸载时没人收）", () => {
    const fake = createFakeSlots();
    fake.slots.register({ name: BODY_SLOT, key: OFFICIAL_ID, inject: () => ({}) }, FILES_BODY);
    let subscribed = 0;
    let unsubscribed = 0;
    const slots: ClientSlotsPort = {
      ...fake.slots,
      // evaluate 的第一步就是读原始账：让它抛，模拟座位注册表在初始化期坏掉。
      entries: () => {
        throw new Error("entries exploded");
      },
      subscribe: (key, listener) => {
        subscribed += 1;
        const off = fake.slots.subscribe(key, listener);
        return () => {
          unsubscribed += 1;
          off();
        };
      },
      onEntryError: (listener) => {
        subscribed += 1;
        const off = fake.slots.onEntryError(listener);
        return () => {
          unsubscribed += 1;
          off();
        };
      },
    };
    expect(() =>
      installTakeover({
        slots,
        tabs: { get: (kind) => (kind === FILES_KIND ? OFFICIAL_DEFINITION : undefined) },
        logger: { warn: () => undefined },
        wrapInject: createInjectWrapper(() => viewOf(STABLE_SOURCE)),
      }),
    ).toThrow("entries exploded");
    expect(subscribed).toBe(2);
    expect(unsubscribed).toBe(2);
  });
});

describe("端口形状对运行时公开面负责", () => {
  it("不依赖 slots.isLive（官方公开面没有它，真机会 TypeError）", () => {
    const h = harness();
    const restore = h.install();
    // 走到这里就说明整条路径没有访问过 isLive：假 slots 上根本没有这个方法。
    expect(h.ours()).toHaveLength(1);
    restore();
  });
});
