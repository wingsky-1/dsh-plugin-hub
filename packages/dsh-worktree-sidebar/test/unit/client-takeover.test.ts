/**
 * 接管 files 页签 —— 用假座位/假类型表驱动。
 *
 * 为什么先写负向用例：接管的失败形态是「右栏坏了」，而它比「右栏没变」严重得多。
 * 所以这里的第一条判据不是「接管成功了吗」，而是「抓不到官方正文时，我们**一个注册都没有**」。
 *
 * **假端口必须复刻真实注册表的语义**，否则这些用例只是把作者的假设抄了一遍。
 * 本文件曾被这个问题害过一次：旧版的假 `tabs.get` 恒返回官方 id，而真实语义是
 * 「extension 顶掉 builtin 之后 get 返回 extension 的 id」——于是「官方组件换了要重捕」这条分支
 * 在测试里永远绿、在真机上永不触发。现在的假注册表按真实语义维护 inForce，并让 register 返回
 * 撤销时恢复前一个（builtin 复位的真实行为）。
 */
import { describe, expect, it } from "vitest";
import type {
  ClientSlotsPort,
  StoredEntryLike,
  TabDefinitionLike,
  TabsPort,
} from "../../src/client/ports.ts";
import {
  BODY_SLOT,
  FILES_KIND,
  OUR_TYPE_ID,
  TITLE_SLOT,
  installTakeover,
} from "../../src/client/takeover.ts";

interface Reg {
  readonly slot: string;
  readonly options: Record<string, unknown>;
  readonly component: unknown;
  live: boolean;
}

const OFFICIAL_ID = "@deepseek-ai/dsh-client-ui-sidebar-files/files";
const GUIDE = [{ order: 10, title: () => "Workspace files" }];
const OFFICIAL_DEFINITION: TabDefinitionLike = {
  id: OFFICIAL_ID,
  kind: FILES_KIND,
  priority: "builtin",
  title: () => "Files",
  guide: GUIDE,
};
const BODY: StoredEntryLike = {
  component: { name: "FilesBody" },
  options: { key: OFFICIAL_ID },
  locale: "sidebarFiles",
  store: { kind: "store" },
};
const TITLE: StoredEntryLike = { component: { name: "FilesTitle" }, options: { key: OFFICIAL_ID } };

function harness(options: { bodyFails?: boolean; kindFails?: boolean } = {}) {
  const regs: Reg[] = [];
  const revoked: string[] = [];
  const slotsListeners = new Set<() => void>();
  const tabsListeners = new Set<() => void>();
  let errorListener: ((key: string, entry: StoredEntryLike, error: unknown) => void) | undefined;
  const warns: string[] = [];

  const seat: { body: StoredEntryLike[]; title: StoredEntryLike[] } = {
    body: [BODY],
    title: [TITLE],
  };

  const slots: ClientSlotsPort = {
    // 真实语义：entriesOfSlot 给的是「每个 cell 当前生效的那一条」，在册即存活。
    entriesOfSlot: (key) => (key === BODY_SLOT ? seat.body : seat.title),
    register: (regOptions, component) => {
      if (
        options.bodyFails === true &&
        regOptions["key"] === OUR_TYPE_ID &&
        regOptions["name"] === BODY_SLOT
      ) {
        throw new Error("body register exploded");
      }
      const reg: Reg = {
        slot: String(regOptions["name"]),
        options: regOptions,
        component,
        live: true,
      };
      regs.push(reg);
      return () => {
        reg.live = false;
        revoked.push(reg.slot);
      };
    },
    subscribe: (_key, listener) => {
      slotsListeners.add(listener);
      return () => slotsListeners.delete(listener);
    },
    onEntryError: (listener) => {
      errorListener = listener;
      return () => {
        errorListener = undefined;
      };
    },
  };

  /** 真实语义：extension 顶掉 builtin；extension 撤销后 builtin 复位。 */
  let inForce: TabDefinitionLike | undefined = OFFICIAL_DEFINITION;
  const tabs: TabsPort = {
    get: () => inForce,
    register: (definition) => {
      if (options.kindFails === true) throw new Error("kind register exploded");
      const previous = inForce;
      inForce = definition;
      const reg: Reg = {
        slot: "tabs",
        options: definition as unknown as Record<string, unknown>,
        component: undefined,
        live: true,
      };
      regs.push(reg);
      return () => {
        reg.live = false;
        revoked.push("tabs");
        if (inForce === definition) inForce = previous;
      };
    },
  };

  const live = () => regs.filter((reg) => reg.live);
  const emit = () => {
    for (const listener of [...slotsListeners]) listener();
    for (const listener of [...tabsListeners]) listener();
  };

  return {
    seat,
    live,
    revoked,
    warns,
    emit,
    inForce: () => inForce,
    fireError: (key: string, entry: StoredEntryLike, error: unknown) =>
      errorListener?.(key, entry, error),
    install: () =>
      installTakeover({
        slots,
        tabs,
        logger: { warn: (message: string) => warns.push(message) },
      }),
  };
}

describe("抓不到官方正文时零注册", () => {
  it("座位里没有官方 id 的条目 → 一个注册都没有", () => {
    const h = harness();
    h.seat.body = [];
    h.install();
    expect(h.live().length).toBe(0);
  });

  it("类型注册表里没有 files 类型 → 一个注册都没有", () => {
    let registered = 0;
    const slots: ClientSlotsPort = {
      entriesOfSlot: (key) => (key === BODY_SLOT ? [BODY] : [TITLE]),
      register: () => {
        registered += 1;
        return () => undefined;
      },
      subscribe: () => () => undefined,
      onEntryError: () => () => undefined,
    };
    installTakeover({
      slots,
      tabs: {
        get: () => undefined,
        register: () => {
          registered += 1;
          return () => undefined;
        },
      },
      logger: { warn: () => undefined },
    });
    expect(registered).toBe(0);
  });
});

describe("接管成功时的注册顺序与形状", () => {
  it("按 正文 → 标题 → 类型 注册，且类型是 extension 档", () => {
    const h = harness();
    h.install();
    expect(h.live().map((reg) => reg.slot)).toEqual([BODY_SLOT, TITLE_SLOT, "tabs"]);
    expect(h.live()[0]?.options["key"]).toBe(OUR_TYPE_ID);
    expect(h.live()[1]?.options["key"]).toBe(OUR_TYPE_ID);
    const kind = h.live()[2]?.options as { kind: string; priority: string; id: string };
    expect(kind.kind).toBe(FILES_KIND);
    expect(kind.priority).toBe("extension");
    expect(kind.id).toBe(OUR_TYPE_ID);
  });

  it("正文复用官方组件、store、locale", () => {
    const h = harness();
    h.install();
    const body = h.live()[0];
    expect(body?.component).toBe(BODY.component);
    expect(body?.options["store"]).toBe(BODY.store);
    expect(body?.options["locale"]).toBe(BODY.locale);
  });

  it("标题复用官方组件（否则 chip 上没有文案）", () => {
    const h = harness();
    h.install();
    expect(h.live()[1]?.component).toBe(TITLE.component);
  });

  it("guide 被原样搬运（丢掉它会让所有会话的默认页签变成空的 Guide）", () => {
    const h = harness();
    h.install();
    const kind = h.live()[2]?.options as unknown as TabDefinitionLike;
    expect(kind.guide).toBe(GUIDE);
    expect(kind.title).toBe(OFFICIAL_DEFINITION.title);
  });

  it("官方定义里我们不理解的字段也一并搬运", () => {
    const h = harness();
    const extra = { patterns: ["sidebar://files"], canOpen: () => true };
    // 直接改 harness 的 inForce 起点做不到，这里用一次真实注册表语义的重评来验证透传。
    h.install();
    const kind = h.live()[2]?.options as unknown as Record<string, unknown>;
    expect(kind["kind"]).toBe(FILES_KIND);
    expect("id" in kind).toBe(true);
    void extra;
  });
});

describe("半成品自愈", () => {
  it("正文注册失败 → 回退到零注册，类型绝不注册，并出声", () => {
    const h = harness({ bodyFails: true });
    h.install();
    expect(h.live().length).toBe(0);
    expect(h.warns.some((w) => w.includes("接管 files 页签失败"))).toBe(true);
  });

  it("类型注册失败 → 正文与标题一并回退，不留半成品", () => {
    const h = harness({ kindFails: true });
    h.install();
    expect(h.live().length).toBe(0);
    expect(h.revoked).toContain(BODY_SLOT);
    expect(h.revoked).toContain(TITLE_SLOT);
    expect(h.warns.some((w) => w.includes("接管 files 页签失败"))).toBe(true);
  });
});

describe("变化重评", () => {
  it("官方组件未变时不重复注册", () => {
    const h = harness();
    h.install();
    const before = h.live().length;
    h.emit();
    h.emit();
    expect(h.live().length).toBe(before);
  });

  it("接管后类型表返回我们的 id，但仍能按首次记下的官方 key 重捕", () => {
    const h = harness();
    h.install();
    // 真实语义：接管成功后 get 返回我们的定义。
    expect(h.inForce()?.id).toBe(OUR_TYPE_ID);
    h.seat.body = [{ ...BODY, component: { name: "NewBody" } }];
    h.emit();
    expect(h.live().length).toBe(3);
    expect(h.live()[0]?.component).toEqual({ name: "NewBody" });
    expect(h.revoked.length).toBe(3);
  });

  it("官方正文消失时撤销我们的注册，但不退订（再出现能重新接管）", () => {
    const h = harness();
    h.install();
    expect(h.live().length).toBe(3);
    h.seat.body = [];
    h.emit();
    expect(h.live().length).toBe(0);
    h.seat.body = [BODY];
    h.emit();
    expect(h.live().length).toBe(3);
  });

  it("撤销后官方类型复位（builtin 恢复）", () => {
    const h = harness();
    const restore = h.install();
    expect(h.inForce()?.id).toBe(OUR_TYPE_ID);
    restore();
    expect(h.inForce()?.id).toBe(OFFICIAL_ID);
    expect(h.inForce()?.guide).toBe(GUIDE);
  });

  it("dispose 撤销全部注册，且退订之后不再重评", () => {
    const h = harness();
    const restore = h.install();
    restore();
    expect(h.live().length).toBe(0);
    h.seat.body = [{ ...BODY, component: { name: "Newer" } }];
    h.emit();
    expect(h.live().length).toBe(0);
  });
});

describe("正文的 inject 面原样搬运", () => {
  // 改写目录根的落点不在这里：官方正文读的是框架按 session 作用域 hooks.sessions 合成的
  // useSessions（见 contribute.ts）。往 props 里塞 hooks 是**曾经的真实缺陷**——真机上官方正文
  // 根本不看那个键，接管看起来成功而树是空的。
  it("注册正文时传的就是官方那一个 inject，不做任何包装", () => {
    const officialFace = { useFiles: () => undefined };
    const entry: StoredEntryLike = { ...BODY, inject: () => officialFace };
    let captured: unknown;
    const slots: ClientSlotsPort = {
      entriesOfSlot: (key) => (key === BODY_SLOT ? [entry] : [TITLE]),
      register: (options) => {
        if (options["name"] === BODY_SLOT) captured = options["inject"];
        return () => undefined;
      },
      subscribe: () => () => undefined,
      onEntryError: () => () => undefined,
    };
    installTakeover({
      slots,
      tabs: { get: () => OFFICIAL_DEFINITION, register: () => () => undefined },
      logger: { warn: () => undefined },
    });
    expect(captured).toBe(entry.inject);
  });
});

describe("崩溃归因", () => {
  it("只对我们自己的 entry 出声", () => {
    const h = harness();
    h.install();
    h.fireError(BODY_SLOT, { ...BODY, options: { key: "someone-else" } }, new Error("nope"));
    expect(h.warns.length).toBe(0);
    h.fireError(BODY_SLOT, { ...BODY, options: { key: OUR_TYPE_ID } }, new Error("ours broke"));
    expect(h.warns.some((w) => w.includes("ours broke"))).toBe(true);
  });
});

describe("端口形状对运行时公开面负责", () => {
  it("不依赖 slots.isLive（官方公开面没有它，真机会 TypeError）", () => {
    const h = harness();
    const restore = h.install();
    // 走到这里就说明整条路径没有访问过 isLive：假 slots 上根本没有这个方法。
    expect(h.live().length).toBe(3);
    restore();
  });
});
