// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project：变异面按拓扑派生的是
// 单 project node 环境配置，本层要进变异面就得自带环境。
/**
 * dsh-mcp-manager — 面板 aria-modal 同步 + Esc 让位 + 关还焦（#947）。
 *
 * 守的事实（一句话）：把 close() 的同步 removeAttribute 挪进 300ms finish、
 * 把 showPanel() 的重加删掉、把 Esc 的 defaultPrevented 前置删掉、把 opener
 * 记录/恢复删掉，任一改动必须红至少一条。
 *
 * 时间纪律：假时钟只钉 setTimeout/clearTimeout/Date（toFake 显式声明），不钉 rAF——
 * showPanel 的 armOpen 走 requestAnimationFrame，close 的 finish 走 setTimeout 300ms。
 * “同步即摘”断言必须在推进时钟前做；推进 300ms 后只断 hidden + aria，不碰动画类。
 * pollUntil 不用（无异步等待）；离线（fetch 手写假件），无落盘。
 *
 * 假件说明（testing skill §3 例外）：fetch 是 globalThis 上的手写假函数（只记调用、
 * 返回空快照，不实现任何服务端语义）；actions 是手写记录对象，不用任何 vi 替身；
 * 唯一允许的 vi 用法是假时钟。locale 用 bindLocale 假绑定（回落 key 本体）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createState } from "../../src/client/core/state.ts";
import type { UiActions } from "../../src/client/core/state.ts";
import { close, disposePanel, refresh, showPanel } from "../../src/client/float/panel.ts";
import { bindLocale } from "../../../../shared/client/i18n.js";

/** 空快照：refresh/首刷走同一 fetch 假件，返回零服务器。 */
function fakeServersPayload(): unknown {
  return { servers: [], counts: {}, projectRoot: "/tmp/proj" };
}

/** 手写 fetch 假件：只记录 url，不实现服务端语义。 */
class FetchLog {
  urls: string[] = [];
}

function installFetchFake(log: FetchLog, payload: unknown = fakeServersPayload()): () => void {
  const realFetch = globalThis.fetch;
  const fake = async (input: unknown): Promise<unknown> => {
    log.urls.push(String(input));
    return {
      ok: true,
      json: async (): Promise<unknown> => payload,
    };
  };
  globalThis.fetch = fake as unknown as typeof fetch;
  return (): void => {
    globalThis.fetch = realFetch;
  };
}

/** 手写 actions：全方法具全（满足 UiActions 类型），调用只记数。 */
function makeActions(): { actions: UiActions; calls: string[] } {
  const calls: string[] = [];
  const actions: UiActions = {
    refresh: async (): Promise<boolean> => {
      calls.push("refresh");
      return true;
    },
    resetForm: (): void => {
      calls.push("resetForm");
    },
    beginEdit: (): void => {
      calls.push("beginEdit");
    },
    switchTab: (): void => {
      calls.push("switchTab");
    },
    close: (): void => {
      calls.push("close");
    },
    showPanel: (): void => {
      calls.push("showPanel");
    },
    toggleFloat: (): void => {
      calls.push("toggleFloat");
    },
  };
  return { actions, calls };
}

function queryAriaModal(): Element | null {
  return document.querySelector('[aria-modal="true"]');
}

function queryAriaModalBare(): Element | null {
  return document.querySelector("[aria-modal]");
}

let restoreFetch: (() => void) | undefined;

beforeEach(() => {
  document.body.textContent = "";
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "mcpManager",
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  if (restoreFetch !== undefined) {
    restoreFetch();
    restoreFetch = undefined;
  }
  // 跨用例隔离：panel 模块用 WeakMap 登记 keydown 清理 + document.body 常驻 overlay，
  // 必须逐例清掉，否则上例残留的 hidden 卡会串进下例的“关后为空”断言。
  document.body.textContent = "";
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "mcpManager",
  );
});

describe("R1 状态同翻：aria-modal 与 open 同步", () => {
  it("开后存在，关后同步即无（不等 300ms），推钟后仍无", () => {
    const log = new FetchLog();
    restoreFetch = installFetchFake(log);
    const state = createState();
    const { actions } = makeActions();
    showPanel(state, actions);
    // 先决条件：防空断言——show 后必须先为真，否则后续“关后为空”恒真假绿。
    expect(queryAriaModal() === null).toBe(false);
    expect(queryAriaModalBare() === null).toBe(false);
    expect(state.open).toBe(true);

    close(state);
    // 同步即摘：推进时钟前就断，不经过 finish()。
    expect(queryAriaModal()).toBe(null);
    expect(queryAriaModalBare()).toBe(null);
    expect(state.open).toBe(false);

    // 推过 300ms 动画回调后仍无（finish 只管 hidden，不管语义标记）。
    vi.advanceTimersByTime(400);
    expect(queryAriaModal()).toBe(null);
    expect(queryAriaModalBare()).toBe(null);
    disposePanel(state);
  });

  it("重开恢复 true（覆盖 close→300ms 内重开竞态）", () => {
    const log = new FetchLog();
    restoreFetch = installFetchFake(log);
    const state = createState();
    const { actions } = makeActions();
    showPanel(state, actions);
    expect(queryAriaModal() === null).toBe(false);

    close(state);
    expect(queryAriaModal()).toBe(null);
    // 竞态：finish 未跑就重开，finish 的 state.open 门控必须让位，重加必须生效。
    showPanel(state, actions);
    expect(state.open).toBe(true);
    expect(queryAriaModal() === null).toBe(false);
    vi.advanceTimersByTime(400);
    // finish 跑过后（旧 close 的回调因 open=true 直接返回）仍为真。
    expect(queryAriaModal() === null).toBe(false);
    disposePanel(state);
  });

  it("双 close 幂等：第二次不抛且仍无标记", () => {
    const log = new FetchLog();
    restoreFetch = installFetchFake(log);
    const state = createState();
    const { actions } = makeActions();
    showPanel(state, actions);
    expect(queryAriaModal() === null).toBe(false);
    close(state);
    close(state);
    expect(queryAriaModal()).toBe(null);
    vi.advanceTimersByTime(400);
    expect(queryAriaModal()).toBe(null);
    disposePanel(state);
  });
});

describe("R4 Esc 让位：defaultPrevented 即不关", () => {
  it("未被处理的 Esc 关闭，已被处理的 Esc 让位", () => {
    const log = new FetchLog();
    restoreFetch = installFetchFake(log);
    const state = createState();
    const { actions } = makeActions();
    showPanel(state, actions);
    expect(state.open).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(state.open).toBe(false);
    expect(queryAriaModal()).toBe(null);

    // 重开后，用捕获期先 preventDefault 模拟“他人已处理”，面板必须让位。
    showPanel(state, actions);
    expect(state.open).toBe(true);
    const preventer = (event: Event): void => {
      event.preventDefault();
    };
    document.addEventListener("keydown", preventer, { capture: true });
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    } finally {
      document.removeEventListener("keydown", preventer, { capture: true });
    }
    expect(state.open).toBe(true);
    expect(queryAriaModal() === null).toBe(false);
    disposePanel(state);
  });
});

describe("R6 关还焦：焦点回到打开者", () => {
  it("show 记录 opener，close 恢复且 opener 已卸载时跳过不抛", () => {
    const log = new FetchLog();
    restoreFetch = installFetchFake(log);
    const opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement === opener).toBe(true);

    const state = createState();
    const { actions } = makeActions();
    showPanel(state, actions);
    // 面板按 R6 不进焦（不抢文本输入），只记 opener。
    expect(state.panelOpener === opener).toBe(true);

    close(state);
    expect(document.activeElement === opener).toBe(true);
    expect(queryAriaModal()).toBe(null);

    // opener 已卸载路径：重开→卸载 opener→关，不抛且无标记。
    showPanel(state, actions);
    opener.remove();
    close(state);
    expect(queryAriaModal()).toBe(null);
    disposePanel(state);
  });
});

// 健康摘要徽标（.dm-counts，面板头内）：摘要文案按 counts 逐档拼装，失败计数就地标红。
// 文案与标红是两件不同的事（countsSummaryText / renderCountsBadge），两条都锁：
// 删掉标红那一句只打红标红用例，文案用例照绿。
describe("健康摘要徽标：文案与失败标红", () => {
  /** 按真实 zh 文案绑 locale：标红靠 failedText 是 summary 的子串，key 形态绑不出来。 */
  function bindRealisticLocale(): void {
    bindLocale(
      {
        bind: (): ((key: string, params?: Record<string, unknown>) => string) => (key, params) => {
          const n = String(params?.n ?? "");
          if (key === "countsConnected") return `运行中 ${n}`;
          if (key === "countsConnecting") return `连接中 ${n}`;
          if (key === "countsFailed") return `失败 ${n}`;
          if (key === "countsSummary") return `共 ${n} 台 · ${String(params?.parts ?? "")}`;
          if (key === "countsSummaryOnly") return `共 ${n} 台`;
          return key;
        },
      },
      "mcpManager",
    );
  }

  // 徽标节点由 showPanel 建面板头时创建；随后 refresh 单飞复用同一次拉取把文案画上去。
  async function paintBadge(counts: Record<string, number>, serverCount: number): Promise<void> {
    const log = new FetchLog();
    restoreFetch = installFetchFake(log, {
      servers: Array.from({ length: serverCount }, (_, i) => ({ name: "s" + i })),
      counts,
      projectRoot: "/tmp/proj",
    });
    const state = createState();
    const { actions } = makeActions();
    showPanel(state, actions);
    await refresh(state, actions);
    vi.advanceTimersByTime(400);
  }

  it("三档齐全：文案按 running/connecting/failed 顺序拼接", async () => {
    bindRealisticLocale();
    await paintBadge({ connected: 2, connecting: 1, reconnecting: 2, failed: 1 }, 3);
    expect(document.querySelector(".dm-counts")?.textContent).toBe(
      "共 3 台 · 运行中 2 · 连接中 3 · 失败 1",
    );
  });

  it("connecting 与 reconnecting 合并为一段（连接中取两者之和）", async () => {
    bindRealisticLocale();
    await paintBadge({ reconnecting: 2 }, 3);
    expect(document.querySelector(".dm-counts")?.textContent).toBe("共 3 台 · 连接中 2");
  });

  it("无任何计数档位 → 退到「共 N 台」单段", async () => {
    bindRealisticLocale();
    await paintBadge({}, 3);
    expect(document.querySelector(".dm-counts")?.textContent).toBe("共 3 台");
  });

  it("缺档位按 0 读（不产生 0 值文案段）", async () => {
    bindRealisticLocale();
    await paintBadge({ connected: 0, failed: 0 }, 3);
    expect(document.querySelector(".dm-counts")?.textContent).toBe("共 3 台");
  });

  it("失败计数标红：失败段被 .dm-health-bad 拆出，其余原样可读", async () => {
    bindRealisticLocale();
    await paintBadge({ connected: 2, failed: 1 }, 3);
    const badge = document.querySelector(".dm-counts")!;
    const bad = badge.querySelectorAll(".dm-health-bad");
    expect(bad.length).toBe(1);
    expect(bad[0]!.textContent).toBe("失败 1");
    expect(badge.textContent).toBe("共 3 台 · 运行中 2 · 失败 1");
  });

  it("无失败计数 → 不产生 .dm-health-bad（不误标）", async () => {
    bindRealisticLocale();
    await paintBadge({ connected: 2, connecting: 1 }, 3);
    expect(document.querySelectorAll(".dm-health-bad").length).toBe(0);
  });

  it("面板头未建（徽标缺席）→ 静默跳过，不抛", async () => {
    bindRealisticLocale();
    const log = new FetchLog();
    restoreFetch = installFetchFake(log, {
      servers: [{ name: "a" }],
      counts: { connected: 1, failed: 1 },
      projectRoot: "/tmp/proj",
    });
    const state = createState();
    const ok = await refresh(state, makeActions().actions);
    expect(ok).toBe(true);
    expect(document.querySelector(".dm-counts")).toBeNull();
  });
});
