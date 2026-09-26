/**
 * dsh-mcp-manager — unit：#732 复杂度整改为 catalog 域新拆纯函数补的直接单测。
 * 直连被拆函数，锁住打分两路、盘点条目三态与摘要拼接三段。
 */
import { describe, expect, it } from "vitest";
import {
  buildListServerEntry,
  isToolDisabledForEntry,
  listOrderComparator,
  listOrderKey,
  matchesServerFilter,
  rootParticipates,
  safeToolLimit,
  scoreCjkSegments,
  scoreTerms,
  toolDetailMissError,
} from "../../src/server/catalog/search.ts";
import {
  collectToolSentences,
  dedupeToolSentences,
  entryTextFor,
  joinSentencesWithinBudget,
  truncatePerTool,
} from "../../src/server/catalog/impl/entries/index.ts";
import {
  CATALOG_SUMMARY_MAX_CHARS,
  CATALOG_SUMMARY_PER_TOOL_CHARS,
  CATALOG_ENTRY_MAX_CHARS,
} from "../../src/server/catalog/interface.ts";

const fullName = (root: string, server: string): string => `@${root}/${server}`;
const parseName = (full: string): { root: string; server: string } | undefined => {
  if (!full.startsWith("@")) return undefined;
  const slash = full.lastIndexOf("/");
  if (slash <= 1) return undefined;
  return { root: full.slice(1, slash), server: full.slice(slash + 1) };
};

describe("catalog/search：打分两路", () => {
  it("scoreCjkSegments：≥2 字命中记 2 分，单字与未命中都不计（全未命中返回 undefined）", () => {
    expect(scoreCjkSegments(["中文"], "工具：中文检索")).toEqual({
      score: 2,
      matchedTerms: ["中文"],
    });
    expect(scoreCjkSegments(["中"], "中文")).toBeUndefined();
    expect(scoreCjkSegments(["检索"], "abc")).toBeUndefined();
  });

  it("scoreTerms：≥2 字命中记 1 分，单字词元不计", () => {
    expect(scoreTerms(["ab", "c"], "xxabyy")).toEqual({ score: 1, matchedTerms: ["ab"] });
    expect(scoreTerms([], "x")).toEqual({ score: 0, matchedTerms: [] });
  });
});

describe("catalog/search：盘点范围与条目", () => {
  it("safeToolLimit：非正 / 非有限回落缺省，正数向下取整", () => {
    expect(safeToolLimit(2.7)).toBe(2);
    expect(safeToolLimit(0)).toBe(safeToolLimit(Number.NaN));
    expect(safeToolLimit(-3)).toBe(safeToolLimit(Number.NaN));
  });

  it("rootParticipates：无过滤集全参与，有过滤集只放行命中", () => {
    expect(rootParticipates("/r", undefined)).toBe(true);
    expect(rootParticipates("/r", new Set(["/r"]))).toBe(true);
    expect(rootParticipates("/x", new Set(["/r"]))).toBe(false);
  });

  it("matchesServerFilter：裸名或全名任一命中即收，无过滤全收", () => {
    expect(matchesServerFilter("a", "/r", undefined, fullName)).toBe(true);
    expect(matchesServerFilter("a", "/r", "a", fullName)).toBe(true);
    expect(matchesServerFilter("a", "/r", "@/r/a", fullName)).toBe(true);
    expect(matchesServerFilter("a", "/r", "b", fullName)).toBe(false);
  });

  it("isToolDisabledForEntry：本 root 段与 @global 段并集命中，@global 自身不重复继承", () => {
    const map = new Map([
      ["/r", new Map([["a", new Set(["t"])]])],
      ["@global", new Map([["a", new Set(["g"])]])],
    ]);
    expect(isToolDisabledForEntry(map, "/r", "a", "t")).toBe(true);
    expect(isToolDisabledForEntry(map, "/r", "a", "g")).toBe(true);
    expect(isToolDisabledForEntry(map, "@global", "a", "g")).toBe(true);
    expect(isToolDisabledForEntry(map, "/r", "a", "x")).toBe(false);
    expect(isToolDisabledForEntry(undefined, "/r", "a", "t")).toBe(false);
  });

  it("buildListServerEntry：用户禁用标注 + 目录失败原因 / 工具清单与截断", () => {
    const ok = buildListServerEntry(
      "a",
      "/r",
      { tools: new Map([["t1", { description: "d" }]]), unavailable: undefined } as never,
      new Set(["a"]),
      5,
      undefined,
      fullName,
    );
    expect(ok.entry.server).toBe("@/r/a");
    expect(ok.entry.disabled).toBe(true);
    expect(ok.toolCount).toBe(1);
    expect(ok.truncated).toBe(false);
    const down = buildListServerEntry(
      "a",
      "/r",
      { tools: new Map(), unavailable: "boom" } as never,
      new Set(),
      5,
      undefined,
      fullName,
    );
    expect(down.entry.unavailable).toBe("boom");
    expect(down.toolCount).toBe(0);
  });

  it("listOrderKey / listOrderComparator：root 出现序优先，同 root 内裸名升序", () => {
    const index = new Map([["/r", 0]]);
    expect(
      listOrderKey({ server: "@/r/a", tools: [], toolsTruncated: false }, index, parseName),
    ).toEqual({
      rootOrder: 0,
      server: "a",
    });
    const cmp = listOrderComparator(index, parseName);
    const rows = [
      { server: "@/r/b", tools: [], toolsTruncated: false },
      { server: "@/other/a", tools: [], toolsTruncated: false },
      { server: "@/r/a", tools: [], toolsTruncated: false },
    ];
    expect([...rows].sort(cmp).map((r) => r.server)).toEqual(["@/r/a", "@/r/b", "@/other/a"]);
  });

  it("toolDetailMissError：发现失败 > 用户禁用 > 未连接三归因", () => {
    expect(toolDetailMissError({ unavailable: "boom" } as never, "s", false).message).toContain(
      "发现失败",
    );
    expect(toolDetailMissError(undefined, "s", true).message).toContain("已被用户禁用");
    expect(toolDetailMissError(undefined, "s", false).message).toContain("未连接或未发现");
  });
});

describe("catalog/entries：目录摘要三段", () => {
  it("collectToolSentences：首句为空的工具不贡献", () => {
    const out = collectToolSentences(
      new Map([
        ["a", { description: "One. Two." }],
        ["b", { description: 5 }],
      ]),
    );
    expect(out).toEqual([["a", "One."]]);
  });

  it("dedupeToolSentences：按工具名排序后精确去重（同名句只留一条）", () => {
    const out = dedupeToolSentences([
      ["b", "Same."],
      ["a", "Same."],
      ["c", "Other."],
    ]);
    expect(out).toEqual(["Same.", "Other."]);
  });

  it("truncatePerTool：超单句上限留一位给省略号", () => {
    const long = "x".repeat(CATALOG_SUMMARY_PER_TOOL_CHARS + 50);
    const out = truncatePerTool(long);
    expect(out.length).toBe(CATALOG_SUMMARY_PER_TOOL_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(truncatePerTool("short")).toBe("short");
  });

  it("joinSentencesWithinBudget：分号拼接；超总长按整句回退补省略号", () => {
    expect(joinSentencesWithinBudget(["a", "b"], "")).toBe("a; b");
    expect(joinSentencesWithinBudget([], "2 tools: ")).toBe("2 tools: ");
    const huge = "y".repeat(CATALOG_SUMMARY_MAX_CHARS);
    expect(joinSentencesWithinBudget([huge, "tail"], "")).toBe(
      `${huge.slice(0, CATALOG_SUMMARY_MAX_CHARS - 1)}…`,
    );
  });

  it("entryTextFor：用户描述优先（首句）、其次缓存摘要、都没有则 undefined", () => {
    expect(
      entryTextFor(
        "a",
        { name: "a", transport: "stdio", description: "First. Second." },
        undefined,
      ),
    ).toBe("First.");
    expect(
      entryTextFor("a", { name: "a", transport: "stdio" }, new Map([["a", { summary: "cached" }]])),
    ).toBe("cached");
    expect(
      entryTextFor("a", { name: "a", transport: "stdio" }, new Map([["a", { summary: "" }]])),
    ).toBeUndefined();
    const long = "z".repeat(CATALOG_ENTRY_MAX_CHARS + 10);
    // 返回 string | undefined：先判存在再取长度（截断分支必返回字符串）。
    const truncated = entryTextFor(
      "a",
      { name: "a", transport: "stdio", description: long },
      undefined,
    );
    expect(truncated).toBeDefined();
    expect(truncated?.length).toBe(CATALOG_ENTRY_MAX_CHARS);
  });
});
