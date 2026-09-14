/**
 * 接管 files 页签 —— 用假座位/假类型表驱动。
 *
 * 为什么先写负向用例：接管的失败形态是「右栏坏了」，而它比「右栏没变」严重得多。
 * 所以这里的第一条判据不是「接管成功了吗」，而是「抓不到官方正文时，我们**一个注册都没有**」。
 */
import { describe, expect, it } from "vitest";
import type { ClientSlotsPort, StoredEntryLike, TabsPort } from "../../src/client/ports.ts";
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
const BODY = {
  component: { name: "FilesBody" },
  options: { key: OFFICIAL_ID },
  locale: "sidebarFiles",
  store: { kind: "store" },
};
const TITLE = { component: { name: "FilesTitle" }, options: { key: OFFICIAL_ID } };

function harness(options: { bodyFails?: boolean; kindFails?: boolean } = {}) {
  const regs: Reg[] = [];
  const revoked: string[] = [];
  const slotsListeners = new Set<() => void>();
  let errorListener: ((key: string, entry: StoredEntryLike, error: unknown) => void) | undefined;
  const warns: string[] = [];

  const seat: { body: StoredEntryLike[]; title: StoredEntryLike[] } = {
    body: [BODY],
    title: [TITLE],
  };

  const slots: ClientSlotsPort = {
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
    isLive: () => true,
    onEntryError: (listener) => {
      errorListener = listener;
      return () => {
        errorListener = undefined;
      };
    },
  };

  const tabs: TabsPort = {
    get: (kind) => (kind === FILES_KIND ? { id: OFFICIAL_ID, title: () => "Files" } : undefined),
    register: (definition) => {
      if (options.kindFails === true) throw new Error("kind register exploded");
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
      };
    },
  };

  const live = () => regs.filter((reg) => reg.live);
  const emit = () => {
    for (const listener of [...slotsListeners]) listener();
  };

  return {
    seat,
    live,
    revoked,
    warns,
    emit,
    fireError: (key: string, entry: StoredEntryLike, error: unknown) =>
      errorListener?.(key, entry, error),
    install: () =>
      installTakeover({
        slots,
        tabs,
        logger: { warn: (message: string) => warns.push(message) },
        sourceFor: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }),
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

  it("官方条目存在但已不 live → 一个注册都没有", () => {
    let registered = 0;
    const slots: ClientSlotsPort = {
      entriesOfSlot: (key) => (key === BODY_SLOT ? [BODY] : [TITLE]),
      register: () => {
        registered += 1;
        return () => undefined;
      },
      subscribe: () => () => undefined,
      isLive: () => false,
      onEntryError: () => () => undefined,
    };
    installTakeover({
      slots,
      tabs: {
        get: () => ({ id: OFFICIAL_ID }),
        register: () => {
          registered += 1;
          return () => undefined;
        },
      },
      logger: { warn: () => undefined },
      sourceFor: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }),
    });
    expect(registered).toBe(0);
  });

  it("类型注册表里没有 files 类型 → 一个注册都没有", () => {
    const slots: ClientSlotsPort = {
      entriesOfSlot: (key) => (key === BODY_SLOT ? [BODY] : [TITLE]),
      register: () => {
        throw new Error("不该注册");
      },
      subscribe: () => () => undefined,
      isLive: () => true,
      onEntryError: () => () => undefined,
    };
    const restore = installTakeover({
      slots,
      tabs: { get: () => undefined, register: () => () => undefined },
      logger: { warn: () => undefined },
      sourceFor: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }),
    });
    expect(typeof restore).toBe("function");
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

  it("官方组件换掉时重捕：旧的撤销、新的建立", () => {
    const h = harness();
    h.install();
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

describe("业务面的 hooks 改写", () => {
  it("保留官方 face 的其余字段，只替换 sessions", () => {
    const officialFace = { useFiles: () => undefined, hooks: { other: "keep-me" } };
    const source = { getSnapshot: () => ({}), subscribe: () => () => undefined };
    let captured: ((...args: unknown[]) => Record<string, unknown>) | undefined;
    const slots: ClientSlotsPort = {
      entriesOfSlot: (key) =>
        key === BODY_SLOT ? [{ ...BODY, inject: () => officialFace }] : [TITLE],
      // 只有正文那次注册带 inject；标题那次的 options 里没有 inject，
      // 不按座位过滤就会把 captured 覆盖成 undefined（这正是本用例第一次写错的地方）。
      register: (options) => {
        if (options["name"] === BODY_SLOT) captured = options["inject"] as typeof captured;
        return () => undefined;
      },
      subscribe: () => () => undefined,
      isLive: () => true,
      onEntryError: () => () => undefined,
    };
    installTakeover({
      slots,
      tabs: { get: () => ({ id: OFFICIAL_ID }), register: () => () => undefined },
      logger: { warn: () => undefined },
      sourceFor: () => source,
    });
    const face = captured?.("session-1", { actions: true });
    expect(face?.["useFiles"]).toEqual(officialFace.useFiles);
    expect(face?.["hooks"]).toEqual({ other: "keep-me", sessions: source });
  });

  it("取不到会话 id 时原样返回官方 face（不猜会话）", () => {
    const officialFace = { hooks: { other: "keep-me" } };
    let captured: ((...args: unknown[]) => Record<string, unknown>) | undefined;
    const slots: ClientSlotsPort = {
      entriesOfSlot: (key) =>
        key === BODY_SLOT ? [{ ...BODY, inject: () => officialFace }] : [TITLE],
      register: (options) => {
        if (options["name"] === BODY_SLOT) captured = options["inject"] as typeof captured;
        return () => undefined;
      },
      subscribe: () => () => undefined,
      isLive: () => true,
      onEntryError: () => () => undefined,
    };
    installTakeover({
      slots,
      tabs: { get: () => ({ id: OFFICIAL_ID }), register: () => () => undefined },
      logger: { warn: () => undefined },
      sourceFor: () => ({ getSnapshot: () => ({}), subscribe: () => () => undefined }),
    });
    expect(captured?.(42, { actions: true })).toBe(officialFace);
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
