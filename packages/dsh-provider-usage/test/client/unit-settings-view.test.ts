/**
 * dsh-provider-usage — 设置页纯视图层单测（#732 客户端面拆解）。
 *
 * 被测对象为 src/client/settings/settings-view.ts 真实源码（esbuild 即时打包，
 * 同 unit-float-view 先例）。虚拟入口把 shared/client/i18n.js 的 bindLocale 与
 * settings-view 的导出打进同一份模块实例，才能在用例里把 t 绑成可断言的假翻译。
 * 离线纪律：无网络、无 DOM、无真实时钟（fake timers 固定 Date.now()）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const i18nPath = join(pkgDir, "..", "..", "shared", "client", "i18n.js");
const viewPath = join(pkgDir, "src", "client", "settings", "settings-view.ts");

const bundle = await esbuildBuild({
  stdin: {
    contents: [
      `export { bindLocale } from ${JSON.stringify(i18nPath)};`,
      `export * from ${JSON.stringify(viewPath)};`,
    ].join("\n"),
    resolveDir: pkgDir,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const {
  bindLocale,
  candidatesByProviderOf,
  errorIndexOf,
  ioTotalsOf,
  deltaOf,
  peakValueOf,
  topShareOf,
  statusLabel,
  providerStatusMeta,
} = mod;

function bindFakeLocale(): void {
  bindLocale(
    {
      bind:
        () =>
        (key: string, params?: Record<string, unknown>): string => {
          if (params === undefined) return key;
          const parts = Object.keys(params)
            .sort()
            .map((k) => `${k}=${String(params[k])}`);
          return `${key}[${parts.join(",")}]`;
        },
    },
    "providerUsage",
  );
}

const bucket = (key: string, total: number | null): Record<string, unknown> => ({
  key,
  total,
  parts: [],
});

const trendDay = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  series: [],
  summary: {
    total: 100,
    calls: 7,
    peakKey: null,
    prevTotal: 50,
    prevComplete: true,
  },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
  bindFakeLocale();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settings-view：candidatesByProviderOf", () => {
  it("meta 为 null → 空映射（不抛）", () => {
    expect(candidatesByProviderOf(null).size).toBe(0);
  });

  it("一条 host 覆盖多 provider → 每个 provider 各得一条候选", () => {
    const m = candidatesByProviderOf({
      host: [{ name: "a1", label: "A1", providers: ["x", "y"], source: "builtin" }],
    });
    expect([...m.keys()].sort()).toEqual(["x", "y"]);
    expect(m.get("x")).toEqual([{ name: "a1", label: "A1", source: "builtin" }]);
  });

  it("同一 provider 被多条 host 覆盖 → 候选按遍历顺序累积（不覆盖）", () => {
    const m = candidatesByProviderOf({
      host: [
        { name: "a1", label: "A1", providers: ["x"], source: "builtin" },
        { name: "u1", label: "U1", providers: ["x"], source: "user-file", file: "/p/u1.mjs" },
      ],
    });
    expect(m.get("x")).toEqual([
      { name: "a1", label: "A1", source: "builtin" },
      { name: "u1", label: "U1", source: "user-file", file: "/p/u1.mjs" },
    ]);
  });

  it("file 为 null 时不落 file 键（缺省即「无源文件」）", () => {
    const m = candidatesByProviderOf({
      host: [{ name: "u1", label: "U1", providers: ["x"], source: "user-file", file: null }],
    });
    expect(Object.keys(m.get("x")[0]).sort()).toEqual(["label", "name", "source"]);
  });
});

describe("settings-view：errorIndexOf", () => {
  it("meta 为 null → 空索引、无 file 错误", () => {
    const idx = errorIndexOf(null);
    expect(idx.errorByKey.size).toBe(0);
    expect(idx.fileErrors).toEqual([]);
  });

  it("key 以 file: 开头的错误进 fileErrors，其余只进索引", () => {
    const idx = errorIndexOf({
      errors: [
        { key: "file:broken.mjs", at: 1, kind: "load", message: "syntax" },
        { key: "vendor-a:a1", at: 2, kind: "run", message: "boom" },
      ],
    });
    expect(idx.errorByKey.size).toBe(2);
    expect(idx.fileErrors.length).toBe(1);
    expect(idx.fileErrors[0][0]).toBe("file:broken.mjs");
    expect(idx.errorByKey.get("file:broken.mjs")?.message).toBe("syntax");
  });

  it("同名 key 后写覆盖前写（Map 语义）", () => {
    const idx = errorIndexOf({
      errors: [
        { key: "k", at: 1, kind: "a", message: "first" },
        { key: "k", at: 2, kind: "b", message: "second" },
      ],
    });
    expect(idx.errorByKey.get("k")?.message).toBe("second");
  });
});

describe("settings-view：ioTotalsOf", () => {
  it("ioDay 为 null → 三项补 0、未就绪、合计 0", () => {
    expect(ioTotalsOf(null)).toEqual({ vals: [0, 0, 0], ready: false, dayTotal: 0 });
  });

  it("null 分项补 0（未知与 0 同形）", () => {
    expect(ioTotalsOf({ input: 5, output: null, cache: null })).toEqual({
      vals: [5, 0, 0],
      ready: true,
      dayTotal: 5,
    });
  });

  it("全 0（已到达但无 token）→ 未就绪（环图中心不出 0）", () => {
    expect(ioTotalsOf({ input: 0, output: 0, cache: 0 }).ready).toBe(false);
  });

  it("三项齐全 → 就绪且合计为三者之和", () => {
    expect(ioTotalsOf({ input: 1, output: 2, cache: 4 })).toEqual({
      vals: [1, 2, 4],
      ready: true,
      dayTotal: 7,
    });
  });
});

describe("settings-view：deltaOf", () => {
  it("overview 未就绪 → null（无环比）", () => {
    expect(deltaOf(null)).toBeNull();
  });

  it("已就绪 → 经 trendDelta 投影（此处只锁「非 null 且带 text」这一层接线）", () => {
    const d = deltaOf(trendDay());
    expect(d).not.toBeNull();
    expect(typeof d.text).toBe("string");
  });
});

describe("settings-view：peakValueOf", () => {
  it("overview 未就绪或 peakKey 为 null → null", () => {
    expect(peakValueOf(null, [])).toBeNull();
    expect(peakValueOf(trendDay(), [])).toBeNull();
  });

  it("peakKey 命中窗口桶 → 该桶 total", () => {
    const series = [bucket("2026-01-01", 10), bucket("2026-01-02", 42)];
    const ov = trendDay({
      series,
      summary: { total: 52, calls: 2, peakKey: "2026-01-02", prevTotal: 0, prevComplete: true },
    });
    expect(peakValueOf(ov, series)).toBe(42);
  });

  it("peakKey 不在窗口内 → null（不误取别的桶）", () => {
    const series = [bucket("2026-01-01", 10)];
    const ov = trendDay({
      series,
      summary: { total: 10, calls: 1, peakKey: "2026-01-09", prevTotal: 0, prevComplete: true },
    });
    expect(peakValueOf(ov, series)).toBeNull();
  });

  it("命中的桶 total 为 null（未知）→ null 而非 0", () => {
    const series = [bucket("2026-01-01", null)];
    const ov = trendDay({
      series,
      summary: { total: 0, calls: 0, peakKey: "2026-01-01", prevTotal: 0, prevComplete: true },
    });
    expect(peakValueOf(ov, series)).toBeNull();
  });
});

describe("settings-view：topShareOf", () => {
  it('无分项或窗口总量为 0 → "-"（不出 NaN%）', () => {
    expect(topShareOf([], 0)).toBe("-");
    expect(topShareOf([{ provider: "a", value: 5 }], 0)).toBe("-");
  });

  it("正常态 → 首位 provider 占比（向下取整到整数百分比）", () => {
    expect(
      topShareOf(
        [
          { provider: "a", value: 1 },
          { provider: "b", value: 2 },
        ],
        4,
      ),
    ).toBe("25%");
  });
});

describe("settings-view：statusLabel", () => {
  it("fresh / cached / stale 各出自己的文案", () => {
    expect(statusLabel("fresh")).toBe("statusFresh");
    expect(statusLabel("cached")).toBe("statusCached");
    expect(statusLabel("stale")).toBe("statusStale");
  });

  it("未配置（undefined）→ statusUnconfigured", () => {
    expect(statusLabel(undefined)).toBe("statusUnconfigured");
  });
});

describe("settings-view：providerStatusMeta", () => {
  it("无快照 → 只有状态标签（无适配器名、无时间戳）", () => {
    expect(providerStatusMeta(null, "vendor-a")).toBe("statusUnconfigured");
  });

  it("适配器名与 provider 同名 → 省略前缀（防「rjkrjk」式连读）", () => {
    expect(providerStatusMeta({ adapterName: "vendor-a", status: "fresh" }, "vendor-a")).toBe(
      "statusFresh",
    );
  });

  it("适配器名不同 → 保留前缀", () => {
    expect(providerStatusMeta({ adapterName: "adapter-x", status: "cached" }, "vendor-a")).toBe(
      "adapter-x · statusCached",
    );
  });

  it("有 fetchedAt → 尾部追加本地时刻（hh:mm:ss，zh-CN 24 小时制）", () => {
    const at = Date.now();
    const meta = providerStatusMeta({ status: "fresh", fetchedAt: at }, "vendor-a");
    expect(meta).toBe(
      `statusFresh · updatedAt[t=${new Date(at).toLocaleTimeString("zh-CN", { hour12: false })}]`,
    );
  });
});
