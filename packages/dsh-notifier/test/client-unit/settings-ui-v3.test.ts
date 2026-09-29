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

/**
 * 设置页的**删除手势方向**（#1016 S2）。
 *
 * 三处手势都表达「不要这个键了」，但**方向相反**，改错任何一处都不会在类型层或渲染层出声——
 * 只会让服务端按字段合并后读成另一种意思，或者被顶层值域直接拒掉。故按源码锚住方向。
 *
 * 为什么不跑组件：这三段是 `apply()` 内部的闭包，node 侧引不到（index.tsx import 了 react 与
 * style.css）。本仓对 index.tsx 内部的既有做法就是源码扫描（同本文件另两处），这里沿用同一形态。
 */
describe("删除手势的方向：频道条目发 null，顶层键保持 delete（#1016 S2）", () => {
  const index = readClient("src/client/index.tsx");

  it("chLevelsSet 两个分支方向相反：删单个 kind 删键、清空整个 levels 发 null", () => {
    // 删单个 kind：levels 是一个键、值是整张映射，删一项走不到「删键」那一层。
    expect(index).toContain("else delete levels[kind];");
    // 清空整个 levels：必须发 null——键缺席会被服务端读成「不动」，磁盘上那张旧映射会留下来。
    expect(index).toContain("if (Object.keys(levels).length === 0) ch.levels = null;");
    // 旧写法（删键）不得复活。
    expect(index).not.toContain("delete ch.levels");
  });

  // 话术随 P2-1 变过一次：空串在客户端的空串剥除清单里，提交前变成键缺席，于是新建频道缺必填键是
  // 「缺少 url / baseUrl」而不是「必填键，不能删除」。**不预置空串占位**这条纪律本身不变——预置空串
  // 只会让新建的条目带着一个「看起来填过」的键，而它的下场与「没填」完全一样。
  it("chAdd 不预置 url / baseUrl 的空串占位：必填键只能是「缺席」（= 未填）", () => {
    const body = index.slice(
      index.indexOf("function chAdd("),
      index.indexOf("function chAdd(") + 1200,
    );
    expect(body).not.toContain('url: ""');
    expect(body).not.toContain('baseUrl: ""');
    // 必填键只能是「缺席」（= 未填，由服务端以「缺少 url」拒），不是空串、不是 null。
    expect(body).toContain('type: "webhook"');
    expect(body).toContain('type: "bark"');
  });

  it("routeSetKind 保持 delete：顶层键整值替换，没有按键合并，写 null 会被值域拒", () => {
    const body = index.slice(
      index.indexOf("function routeSetKind("),
      index.indexOf("function routeSetKind(") + 600,
    );
    expect(body).toContain("delete routes[kind]");
    expect(body).not.toContain("routes[kind] = null");
  });
});
