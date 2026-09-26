/** toHistoryEntry 归一契约直测（node 直跑，零 DOM、全离线）。
 *
 * 守的是「一条脏历史项 → 规整 DecisionHistoryEntry」的归一契约本身，逐字段断言：
 * 必填 14 键的兜底值（templateVersion 兜 1；originalLength/confidence/latencyMs 兜 0；
 * 六个串键兜 ""；truncated 兜 false）、tier/lang 两个字面量联合的归一、automation 三档回落，
 * 以及可缺失 6 键（choice/score/errorCode/presetTitle/sessionTitle/questions）的「键不存在」语义。
 * 兜底值改动打红具体字段断言；键集合增删打红键存在性断言；条件写入退化成无条件写，打红 `in` 断言。
 */
import { describe, expect, it } from "vitest";
import { toHistoryEntry } from "../../src/client/api/contract.ts";

/** 归一前的最小可接收项（ts/sessionId 是唯二准入门面，其余字段全缺即走兜底）。 */
const MINIMAL = { ts: 7, sessionId: "s-1" };

/** 全字段脏输入（形状各不相同：串/数/布尔/枚举/题面）。 */
const DIRTY = {
  ts: 1700000000000,
  sessionId: "s-dirty",
  rootHash: "rh",
  rootDisplay: "rd",
  presetId: "general",
  templateVersion: 3,
  stateHash: "sh",
  snippetRedacted: "snip",
  resultKind: "choice",
  tier: "high",
  lang: "zh",
  automation: "auto",
  truncated: true,
  originalLength: 120,
  confidence: 0.75,
  latencyMs: 42,
  choice: "opt-a",
  score: 4,
  errorCode: "E_X",
  presetTitle: "通用辅助",
  sessionTitle: "会话标题",
  questions: [{ id: "q1", text: "题干", kind: "choice" as const, options: ["a", "b"] }],
};

/** 收一条必收的条目：准入门面用例里返回 null 应当直接判红，而不是让断言静默跳过。 */
function accepted(payload: unknown): Record<string, unknown> {
  const e = toHistoryEntry(payload);
  if (e === null) throw new Error("该输入应收收成条目，实际返回 null");
  return e as unknown as Record<string, unknown>;
}

describe("toHistoryEntry 准入门面", () => {
  it("非对象、ts 非数、sessionId 非串一律整条丢弃（不返回半截条目）", () => {
    expect(toHistoryEntry(null)).toBe(null);
    expect(toHistoryEntry("x")).toBe(null);
    expect(toHistoryEntry([MINIMAL])).toBe(null);
    expect(toHistoryEntry({ sessionId: "s" })).toBe(null);
    expect(toHistoryEntry({ ts: "7", sessionId: "s" })).toBe(null);
    expect(toHistoryEntry({ ts: 7 })).toBe(null);
  });
  it("ts 为 NaN 仍收（准入门面只判 typeof，兜底面不覆盖 ts）", () => {
    expect(accepted({ ts: Number.NaN, sessionId: "s" })["ts"]).toBeNaN();
  });
});

describe("toHistoryEntry 必填键兜底", () => {
  it("templateVersion 缺字段/非法值兜 1，合法值原样（模板版本是 frozen 契约）", () => {
    expect(accepted(MINIMAL)["templateVersion"]).toBe(1);
    expect(accepted({ ...MINIMAL, templateVersion: "3" })["templateVersion"]).toBe(1);
    expect(accepted({ ...MINIMAL, templateVersion: Number.NaN })["templateVersion"]).toBe(1);
    expect(accepted({ ...MINIMAL, templateVersion: 2 })["templateVersion"]).toBe(2);
  });

  it("originalLength/confidence/latencyMs 缺字段与非法值一律兜 0，合法值原样", () => {
    for (const key of ["originalLength", "confidence", "latencyMs"]) {
      expect(accepted(MINIMAL)[key]).toBe(0);
      expect(accepted({ ...MINIMAL, [key]: "9" })[key]).toBe(0);
      expect(accepted({ ...MINIMAL, [key]: Number.NaN })[key]).toBe(0);
      expect(accepted({ ...MINIMAL, [key]: 5 })[key]).toBe(5);
    }
  });

  it("五个串键缺字段兜空串；非串（含数字/对象）同样兜空串", () => {
    for (const key of ["rootHash", "rootDisplay", "presetId", "stateHash", "snippetRedacted"]) {
      expect(accepted(MINIMAL)[key]).toBe("");
      expect(accepted({ ...MINIMAL, [key]: 12 })[key]).toBe("");
      expect(accepted({ ...MINIMAL, [key]: "v" })[key]).toBe("v");
    }
  });

  it("resultKind 缺字段兜空串（不留 undefined 洞）", () => {
    expect(accepted(MINIMAL)["resultKind"]).toBe("");
    expect(accepted({ ...MINIMAL, resultKind: "choice" })["resultKind"]).toBe("choice");
  });

  it("truncated 只有字面 true 才为真；truthy 非布尔（数字 1 / 字符串）一律归 false", () => {
    expect(accepted(MINIMAL)["truncated"]).toBe(false);
    expect(accepted({ ...MINIMAL, truncated: 1 })["truncated"]).toBe(false);
    expect(accepted({ ...MINIMAL, truncated: "true" })["truncated"]).toBe(false);
    expect(accepted({ ...MINIMAL, truncated: true })["truncated"]).toBe(true);
  });

  it("ts/sessionId 原样透传，provider 恒为 official 字面量（不采信入参 provider）", () => {
    const e = accepted(MINIMAL);
    expect(e["ts"]).toBe(7);
    expect(e["sessionId"]).toBe("s-1");
    expect(e["provider"]).toBe("official");
    expect(accepted({ ...MINIMAL, provider: "rogue" })["provider"]).toBe("official");
  });
});

describe("toHistoryEntry 枚举归一", () => {
  it("tier 只认 high/low，其余（含大写/空串/数字）归 none", () => {
    for (const [input, want] of [
      ["high", "high"],
      ["low", "low"],
      ["none", "none"],
      ["HIGH", "none"],
      ["", "none"],
      [7, "none"],
    ] as const) {
      expect(accepted({ ...MINIMAL, tier: input })["tier"]).toBe(want);
    }
    expect(accepted(MINIMAL)["tier"]).toBe("none");
  });

  it("lang 只认 en/zh，其余（含 fr/空串）归 unknown", () => {
    for (const [input, want] of [
      ["en", "en"],
      ["zh", "zh"],
      ["unknown", "unknown"],
      ["fr", "unknown"],
      ["", "unknown"],
      [1, "unknown"],
    ] as const) {
      expect(accepted({ ...MINIMAL, lang: input })["lang"]).toBe(want);
    }
    expect(accepted(MINIMAL)["lang"]).toBe("unknown");
  });

  it("automation 三档原样，非法值回落 manual", () => {
    for (const [input, want] of [
      ["manual", "manual"],
      ["assisted", "assisted"],
      ["auto", "auto"],
      ["suggest-only", "manual"],
      ["", "manual"],
      [2, "manual"],
    ] as const) {
      expect(accepted({ ...MINIMAL, automation: input })["automation"]).toBe(want);
    }
    expect(accepted(MINIMAL)["automation"]).toBe("manual");
  });
});

describe("toHistoryEntry 可缺失键（键存在性契约）", () => {
  it("choice/score/errorCode 缺失时键不存在（不是「存在且为 undefined」）", () => {
    const e = accepted(MINIMAL);
    expect("choice" in e).toBe(false);
    expect("score" in e).toBe(false);
    expect("errorCode" in e).toBe(false);
    expect(e["choice"]).toBeUndefined();
  });

  it("presetTitle 缺失或非串时不写键——条件写入，不得退化成无条件写", () => {
    expect("presetTitle" in accepted(MINIMAL)).toBe(false);
    expect("presetTitle" in accepted({ ...MINIMAL, presetTitle: 42 })).toBe(false);
    expect(accepted({ ...MINIMAL, presetTitle: "" })["presetTitle"]).toBe("");
  });

  it("sessionTitle 缺失与空串都不写键（非空串才写）", () => {
    expect("sessionTitle" in accepted(MINIMAL)).toBe(false);
    expect("sessionTitle" in accepted({ ...MINIMAL, sessionTitle: "" })).toBe(false);
    expect("sessionTitle" in accepted({ ...MINIMAL, sessionTitle: 42 })).toBe(false);
    expect(accepted({ ...MINIMAL, sessionTitle: "会话" })["sessionTitle"]).toBe("会话");
  });

  it("questions 非数组或题目形状不对时丢整列、不写键，也不阻断条目", () => {
    for (const bad of ["q", 7, null, [{ id: "q1" }], [{ id: "q1", text: "t", kind: "open" }]]) {
      const e = accepted({ ...MINIMAL, questions: bad });
      expect("questions" in e).toBe(false);
      expect(e["sessionId"]).toBe("s-1");
    }
  });

  it("choice/score/errorCode 形状不对即不写键（数字 choice、非有限 score 不收）", () => {
    const e = accepted({ ...MINIMAL, choice: 5, score: Number.NaN, errorCode: [] });
    expect("choice" in e).toBe(false);
    expect("score" in e).toBe(false);
    expect("errorCode" in e).toBe(false);
  });

  it("有值时六个可缺失键全部写到位", () => {
    const e = accepted(DIRTY);
    expect(e["choice"]).toBe("opt-a");
    expect(e["score"]).toBe(4);
    expect(e["errorCode"]).toBe("E_X");
    expect(e["presetTitle"]).toBe("通用辅助");
    expect(e["sessionTitle"]).toBe("会话标题");
    expect(e["questions"]).toEqual([
      { id: "q1", text: "题干", kind: "choice", options: ["a", "b"] },
    ]);
  });
});

describe("toHistoryEntry 全字段透传", () => {
  it("脏输入的每个必填键都按归一器取值，无一被兜底覆盖", () => {
    const e = accepted(DIRTY);
    expect(e["ts"]).toBe(1700000000000);
    expect(e["sessionId"]).toBe("s-dirty");
    expect(e["rootHash"]).toBe("rh");
    expect(e["rootDisplay"]).toBe("rd");
    expect(e["presetId"]).toBe("general");
    expect(e["templateVersion"]).toBe(3);
    expect(e["stateHash"]).toBe("sh");
    expect(e["snippetRedacted"]).toBe("snip");
    expect(e["resultKind"]).toBe("choice");
    expect(e["tier"]).toBe("high");
    expect(e["lang"]).toBe("zh");
    expect(e["automation"]).toBe("auto");
    expect(e["truncated"]).toBe(true);
    expect(e["originalLength"]).toBe(120);
    expect(e["confidence"]).toBe(0.75);
    expect(e["latencyMs"]).toBe(42);
    expect(e["provider"]).toBe("official");
  });

  it("JSON 往返后缺失键不复活成 null（归一不引入 undefined→null 转换）", () => {
    const back = JSON.parse(JSON.stringify(accepted(MINIMAL))) as Record<string, unknown>;
    expect("choice" in back).toBe(false);
    expect("presetTitle" in back).toBe(false);
    expect(back["templateVersion"]).toBe(1);
    expect(back["confidence"]).toBe(0);
  });
});
