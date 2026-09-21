/**
 * 设置卡 UI v3 契约：kind id 事实源对齐 + 契约锚点 + 脏文案/路由摘要 key。
 * 纯源码扫描，不依赖 DOM 装配。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_KINDS } from "../../src/shared/kinds.ts";
import { dirtyStatusText, routeSummaryText } from "../../src/client/settings/parts/route-text.ts";

const pkgDir = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

function readClient(rel: string): string {
  return readFileSync(join(pkgDir, rel), "utf8");
}

describe("设置卡 UI v3 契约", () => {
  it("kind-icons 的分支键 ⊆ BUILTIN_KINDS（禁止对照开关键名自造 id）", () => {
    const src = readClient("src/client/settings/parts/kind-icons.tsx");
    const branchKinds = [...src.matchAll(/kind === "([^"]+)"/gu)].map((m) => m[1]!);
    expect(branchKinds.length).toBeGreaterThan(0);
    for (const k of branchKinds) {
      expect(BUILTIN_KINDS as readonly string[]).toContain(k);
    }
    // 复核曾打红的错误键不得再出现
    for (const bad of ["task_done", "subagent_done", "task_error", "turn_end"]) {
      expect(branchKinds).not.toContain(bad);
    }
  });

  it("内置 kind 每个都有专属 icon 分支（不得整表回落通用铃铛）", () => {
    const src = readClient("src/client/settings/parts/kind-icons.tsx");
    for (const kind of BUILTIN_KINDS) {
      expect(src, kind).toContain(`kind === "${kind}"`);
    }
  });

  it("契约锚点 class 在 style.css 与客户端源码双侧存在", () => {
    const css = readClient("src/client/style.css");
    const anchors = [
      "dn-set-tabs",
      "dn-set-tabActive",
      "dn-set-tabBadge",
      "dn-ch-perm",
      "dn-set-historyTools",
      "dn-set-allowDim",
      "dn-set-allowActions",
      "dn-evt-routeDisc",
      "dn-ico",
    ];
    for (const a of anchors) {
      expect(css, "css:" + a).toContain(a);
    }
    const index = readClient("src/client/index.tsx");
    for (const a of ["dn-set-tabs", "dn-set-tabActive", "dn-set-tabBadge", "dn-evt-routeDisc"]) {
      expect(index, "index:" + a).toContain(a);
    }
    // L5：其余锚点挂在 parts/panes 侧（删任一即红，不止 index 侧 4 个）。
    const partsAnchors: Array<[string, string]> = [
      ["src/client/settings/parts/diagnostics.tsx", "dn-ch-perm"],
      ["src/client/settings/panes/history.tsx", "dn-set-historyTools"],
      ["src/client/settings/panes/events.tsx", "dn-set-allowDim"],
      ["src/client/settings/panes/events.tsx", "dn-set-allowActions"],
    ];
    for (const [rel, a] of partsAnchors) {
      expect(readClient(rel), rel + ":" + a).toContain(a);
    }
  });

  it("脏状态与路由摘要文案 key 在 locales 与 index 接线", () => {
    const zh = readClient("src/client/locales.ts");
    const index = readClient("src/client/index.tsx");
    // 脏/摘要决策函数住在 parts/route-text.ts（M2 抽取），t("key") 字面量随之搬家——
    // 双侧一起扫，任一侧删 key 即红。
    const wired = index + "\n" + readClient("src/client/settings/parts/route-text.ts");
    for (const key of ["dirtyDomains", "dirtyChannels", "routeExpandHint"]) {
      expect(zh, "locale:" + key).toContain(key + ":");
      expect(wired, "wired:" + key).toContain(`t("${key}")`);
    }
  });

  it("客户端源码不 import ../server/（类型面也一样）", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/u.test(entry.name)) files.push(full);
      }
    };
    walk(join(pkgDir, "src/client"));
    const offenders = files
      .filter((file) => /from\s+["'][^"']*\/server\//u.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(pkgDir.length).replaceAll("\\", "/"));
    expect(offenders).toEqual([]);
  });

  it("style.css 无左侧竖线装饰、无斜体、含 tabular-nums 与壳层玻璃", () => {
    const css = readClient("src/client/style.css");
    // 仅允许 border-left: none 的显式清除
    const leftBorders = [...css.matchAll(/border-left\s*:\s*([^;]+);/gu)].map((m) => m[1]!.trim());
    for (const v of leftBorders) {
      expect(v === "none" || v === "0").toBe(true);
    }
    expect(css).not.toMatch(/font-style\s*:\s*italic/);
    expect(css).toContain("tabular-nums");
    expect(css).toContain("backdrop-filter");
  });
});

/**
 * M2：摘要/脏态三分支可执行断言（改逻辑即红——源码扫描测不到分支语义）。
 * 假 t 直吐 key + 参数，断言落在决策函数返回值上，不依赖 DOM/文案。
 */
describe("投递摘要 routeSummaryText", () => {
  function fakeT(key: string, params?: Record<string, unknown>): string {
    if (params !== undefined && "n" in params) return `${key}(${String(params.n)})`;
    return key;
  }
  it("点亮 1-2 个直接点名", () => {
    expect(routeSummaryText(["浏览器通知"], false, 1, fakeT)).toBe("浏览器通知");
    expect(routeSummaryText(["A", "B"], true, 2, fakeT)).toBe("A · B");
  });
  it("3 个及以上只列前二 + 余数", () => {
    expect(routeSummaryText(["A", "B", "C", "D"], false, 4, fakeT)).toBe("A · B · +2");
  });
  it("自定义但无点名 → 自定义态（N 由调用方剔除 stale）", () => {
    expect(routeSummaryText([], true, 3, fakeT)).toBe("routeCustomState(3)");
    expect(routeSummaryText([], true, 0, fakeT)).toBe("routeCustomState(0)");
  });
  it("跟随默认且无点名 → 默认态", () => {
    expect(routeSummaryText([], false, 0, fakeT)).toBe("routeDefaultState");
  });
});

describe("底栏脏文案 dirtyStatusText", () => {
  function fakeT(key: string, params?: Record<string, unknown>): string {
    if (params !== undefined && "n" in params) return `${key}(${String(params.n)})`;
    return key;
  }
  it("无脏 → null（不渲染）", () => {
    expect(dirtyStatusText(0, false, 0, fakeT)).toBeNull();
  });
  it("双域脏 → dirtyDomains", () => {
    expect(dirtyStatusText(2, true, 1, fakeT)).toBe("dirtyDomains");
  });
  it("仅频道域脏 → dirtyChannels（不数 N）", () => {
    expect(dirtyStatusText(1, true, 0, fakeT)).toBe("dirtyChannels");
  });
  it("仅事件域脏 → dirtySome(n)", () => {
    expect(dirtyStatusText(2, false, 2, fakeT)).toBe("dirtySome(2)");
  });
});
