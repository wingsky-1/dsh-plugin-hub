/**
 * 客户端契约解析器的归一契约直测（node 直跑，零 DOM、全离线）。
 *
 * 覆盖 #732 阶段 2 从 contract.ts 拆出的四组归一器：类别提取（pickCategory
 * 背后的 firstNonEmptyStr 键表）、automationCap 三档（capFromString/capFromNumber）、
 * GET /config 载体解包与三段形状门、GET /presets 载体解包与逐项归一。
 *
 * 验的是归一契约（值与缺席语义），不是内部形状：任一归一器、键表或载体判定被改，
 * 本文件按字段判红。putFailureCategory 的 ?? 口径不在此文件（它刻意不同于
 * failureCategory，见 test/client-dom/pane-helpers.test.ts）。
 */
import { describe, expect, it } from "vitest";
import {
  failureCategory,
  normalizeCap,
  parseConfigPayload,
  parsePresetsPayload,
} from "../../src/client/api/contract.ts";

/** 合法的 v1 配置骨架（三段齐备，逐项覆盖只需改这一处）。 */
function v1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    connection: { hasPlaintextKey: false, timeoutMs: 8000, maxConcurrency: 4, truncBudget: 32000 },
    presets: [],
    history: { perSession: 200, totalSessions: 50 },
    ...over,
  };
}

describe("failureCategory 类别键优先级", () => {
  it("嵌套 error 面优先于顶层：嵌套命中即用嵌套", () => {
    expect(
      failureCategory(400, {
        error: { category: "from-nested" },
        category: "from-top",
        errorCode: "from-top-code",
      }),
    ).toBe("from-nested");
  });
  it("嵌套面按 category > errorCode > code 取首个非空串（空串不算命中）", () => {
    expect(failureCategory(400, { error: { category: "", errorCode: "E2" } })).toBe("E2");
    // 判定是 length>0 而非 trim：全空白串仍是「非空串」，原样当类别回传。
    expect(failureCategory(400, { error: { category: "  ", code: "E3" } })).toBe("  ");
  });
  it("嵌套面无命中回落顶层：category > errorCode > error > code", () => {
    expect(failureCategory(400, { error: {}, category: "T1", errorCode: "T2" })).toBe("T1");
    expect(failureCategory(400, { error: {}, errorCode: "T2" })).toBe("T2");
    expect(failureCategory(400, { error: "str-error" })).toBe("str-error");
    expect(failureCategory(400, { code: "T4" })).toBe("T4");
  });
  it("类别与 code 皆无才回落 message；message 也无则回状态码类别", () => {
    expect(failureCategory(400, { message: "boom" })).toBe("boom");
    expect(failureCategory(500, {})).toBe("http-500");
  });
  it("非对象体（null/数组/串）一律按状态码归类", () => {
    expect(failureCategory(403, null)).toBe("forbidden-non-loopback");
    expect(failureCategory(403, [1, 2])).toBe("forbidden-non-loopback");
    expect(failureCategory(400, "text")).toBe("bad-request");
  });
  it("状态码兜底：403 先于 405 先于 400，其余 http-<status>", () => {
    expect(failureCategory(403, {})).toBe("forbidden-non-loopback");
    expect(failureCategory(405, {})).toBe("method-not-allowed");
    expect(failureCategory(400, {})).toBe("bad-request");
    expect(failureCategory(418, {})).toBe("http-418");
  });
});

describe("normalizeCap 三档归一", () => {
  it("字面 0|1|2 原样收（不夹不升）", () => {
    expect(normalizeCap(0)).toBe(0);
    expect(normalizeCap(1)).toBe(1);
    expect(normalizeCap(2)).toBe(2);
  });
  it("串别名：high/2 → 2，low/1 → 1；其余串（含 '0'/空串）归 0", () => {
    expect(normalizeCap("high")).toBe(2);
    expect(normalizeCap("2")).toBe(2);
    expect(normalizeCap("low")).toBe(1);
    expect(normalizeCap("1")).toBe(1);
    expect(normalizeCap("0")).toBe(0);
    expect(normalizeCap("")).toBe(0);
    expect(normalizeCap("HIGH")).toBe(0);
  });
  it("数值区间：≥2 封 2，≥1 封 1，其余 0（1.9 → 1，0.9 → 0，负数 → 0）", () => {
    expect(normalizeCap(99)).toBe(2);
    expect(normalizeCap(1.9)).toBe(1);
    expect(normalizeCap(0.9)).toBe(0);
    expect(normalizeCap(-5)).toBe(0);
  });
  it("非有限数与非数非串一律 0", () => {
    expect(normalizeCap(Number.NaN)).toBe(0);
    expect(normalizeCap(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeCap(null)).toBe(0);
    expect(normalizeCap(undefined)).toBe(0);
    expect(normalizeCap({})).toBe(0);
  });
});

describe("parseConfigPayload 载体解包与形状门", () => {
  it("裸 v1、{config} 包装、{data} 包装三种载体都收", () => {
    expect(parseConfigPayload(v1())?.version).toBe(1);
    expect(parseConfigPayload({ config: v1() })?.version).toBe(1);
    expect(parseConfigPayload({ data: v1() })?.version).toBe(1);
  });
  it("config 包装优先于 data 包装", () => {
    const both = { config: v1(), data: v1({ history: { perSession: 7, totalSessions: 7 } }) };
    expect(parseConfigPayload(both)?.history.perSession).toBe(200);
  });
  it("data 包装内层非对象即整份拒收（不回落裸体）", () => {
    expect(parseConfigPayload({ data: 5 })).toBe(null);
  });
  it("version 必须是字面 1；缺 version 同样拒收", () => {
    expect(parseConfigPayload(v1({ version: 2 }))).toBe(null);
    expect(parseConfigPayload({ ...v1(), version: undefined })).toBe(null);
  });
  it("三段任一形状不对即整份拒收（connection/history 非对象、presets 非数组）", () => {
    expect(parseConfigPayload(v1({ connection: 5 }))).toBe(null);
    expect(parseConfigPayload(v1({ history: [] }))).toBe(null);
    expect(parseConfigPayload(v1({ presets: {} }))).toBe(null);
  });
  it("connection 数值字段缺失/非法回默认（8000/4/32000），合法值原样", () => {
    const bare = parseConfigPayload(v1());
    expect(bare?.connection.timeoutMs).toBe(8000);
    expect(bare?.connection.maxConcurrency).toBe(4);
    expect(bare?.connection.truncBudget).toBe(32000);
    const given = parseConfigPayload(
      v1({
        connection: { timeoutMs: 1, maxConcurrency: 2, truncBudget: 3, hasPlaintextKey: true },
      }),
    );
    expect(given?.connection.timeoutMs).toBe(1);
    expect(given?.connection.maxConcurrency).toBe(2);
    expect(given?.connection.truncBudget).toBe(3);
    expect(given?.connection.hasPlaintextKey).toBe(true);
  });
  it("apiKeyRef 非串即 undefined（键仍在，值为 undefined）；hasPlaintextKey 只认字面 true", () => {
    // 注：connection 面是无条件写入的，缺席语义是「值为 undefined」而非「键不存在」——
    // 与 toHistoryEntry 的可缺失键条件展开刻意不同，此处照实现断言，不臆造键存在性。
    expect(parseConfigPayload(v1())?.connection.apiKeyRef).toBeUndefined();
    expect(parseConfigPayload(v1({ connection: { apiKeyRef: 7 } }))?.connection.apiKeyRef).toBe(
      undefined,
    );
    expect(
      parseConfigPayload(v1({ connection: { apiKeyRef: "MY_KEY" } }))?.connection.apiKeyRef,
    ).toBe("MY_KEY");
    expect(
      parseConfigPayload(v1({ connection: { hasPlaintextKey: "true" } }))?.connection
        .hasPlaintextKey,
    ).toBe(false);
  });
  it("history 两键缺失回 200/50，非数回默认", () => {
    expect(parseConfigPayload(v1())?.history).toEqual({ perSession: 200, totalSessions: 50 });
    expect(
      parseConfigPayload(v1({ history: { perSession: "x", totalSessions: Number.NaN } }))?.history,
    ).toEqual({ perSession: 200, totalSessions: 50 });
  });
  it("presets 逐项归一：缺 id / 非对象的整项丢弃，其余 enabled 与 cap 走归一", () => {
    const got = parseConfigPayload(
      v1({
        presets: [
          { id: "general", enabled: true, automationCap: "high" },
          { no: "id" },
          "not-a-record",
          { id: "plan-review", enabled: "yes", automationCap: 9 },
        ],
      }),
    );
    expect(got?.presets).toHaveLength(2);
    expect(got?.presets[0]).toEqual({ id: "general", enabled: true, automationCap: 2 });
    expect(got?.presets[1]).toEqual({ id: "plan-review", enabled: false, automationCap: 2 });
  });
  it("非对象载荷一律拒收", () => {
    expect(parseConfigPayload(null)).toBe(null);
    expect(parseConfigPayload([])).toBe(null);
    expect(parseConfigPayload("v1")).toBe(null);
  });
});

describe("parsePresetsPayload 载体解包与逐项归一", () => {
  it("裸数组、{presets} 包装、{data} 包装三种载体都收", () => {
    expect(parsePresetsPayload([{ id: "a" }])).toHaveLength(1);
    expect(parsePresetsPayload({ presets: [{ id: "a" }] })).toHaveLength(1);
    expect(parsePresetsPayload({ data: [{ id: "a" }] })).toHaveLength(1);
  });
  it("presets 包装优先于 data 包装", () => {
    expect(
      parsePresetsPayload({ presets: [{ id: "a" }], data: [{ id: "b" }, { id: "c" }] }),
    ).toHaveLength(1);
  });
  it("载体形状都不匹配即空列表（非空数组载荷优先判）", () => {
    expect(parsePresetsPayload({ presets: 5 })).toHaveLength(0);
    expect(parsePresetsPayload("nope")).toHaveLength(0);
    expect(parsePresetsPayload(null)).toHaveLength(0);
  });
  it("缺 id / 非对象的项整项丢弃，其余保留", () => {
    expect(parsePresetsPayload([{ id: "a" }, { no: 1 }, 7, null])).toHaveLength(1);
  });
  it("templateVersion 只认有限数，custom 只认字面 true，其余键缺席", () => {
    const got = parsePresetsPayload([
      { id: "a", templateVersion: 1, label: "L", description: "D", custom: true },
      { id: "b", templateVersion: "1", label: 5, description: null, custom: "yes" },
      { id: "c" },
    ]);
    expect(got[0]).toEqual({
      id: "a",
      templateVersion: 1,
      label: "L",
      description: "D",
      custom: true,
    });
    expect(got[1]?.templateVersion).toBeUndefined();
    expect(got[1]?.label).toBeUndefined();
    expect(got[1]?.description).toBeUndefined();
    expect(got[1]?.custom).toBeUndefined();
    expect(got[2]?.templateVersion).toBeUndefined();
    expect(got[2]?.custom).toBeUndefined();
  });
  it("空串标签与描述原样保留（不是缺席）", () => {
    const got = parsePresetsPayload([{ id: "a", label: "", description: "" }]);
    expect(got[0]?.label).toBe("");
    expect(got[0]?.description).toBe("");
  });
});
