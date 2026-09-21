/** 客户端路由回落 + 契约解析（直连 src/client 纯逻辑，node 环境，全离线）。
 *
 * 守的是 APP_ROUTES 回落共享 ROUTES 与 contract 解析的防御形态：
 * 把路由改成手写字面量、解析放宽任一改动，本文件必红。
 * 注：宿主已删 CLIENT_ROUTES，本文件对应断言随之移除（仅 APP_ROUTES 回落）。
 */
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../../src/client/api/routes.ts";
import {
  capLabel,
  clamp01,
  failureCategory,
  normalizeCap,
  parseConfigPayload,
  parseHistoryPayload,
  parsePresetsPayload,
  validApiKeyRef,
} from "../../src/client/api/contract.ts";
import { API_KEY_REF_RE, ROUTES } from "../../src/shared/contract.ts";

describe("两端路由一致性", () => {
  it("APP_ROUTES 无注入时逐键回落共享 ROUTES（打红点：fallback 串键）", () => {
    expect(APP_ROUTES.health).toBe(ROUTES.health);
    expect(APP_ROUTES.config).toBe(ROUTES.config);
    expect(APP_ROUTES.presets).toBe(ROUTES.presets);
    expect(APP_ROUTES.history).toBe(ROUTES.history);
    expect(APP_ROUTES.testConnection).toBe(ROUTES.testConnection);
  });
  it("validApiKeyRef 与共享正则同判定", () => {
    for (const good of ["JEV_API_KEY", "A1"]) {
      expect(validApiKeyRef(good)).toBe(true);
      expect(API_KEY_REF_RE.test(good)).toBe(true);
    }
    for (const bad of ["lower", "", "1ABC"]) {
      expect(validApiKeyRef(bad)).toBe(false);
      expect(API_KEY_REF_RE.test(bad)).toBe(false);
    }
  });
});

describe("客户端契约解析", () => {
  it("parseConfigPayload 裸体与包装均接受；错版拒收", () => {
    const bare = {
      version: 1,
      connection: {
        hasPlaintextKey: false,
        timeoutMs: 8000,
        maxConcurrency: 4,
        truncBudget: 32000,
      },
      presets: [{ id: "general", enabled: true, automationCap: 2 }],
      history: { perSession: 200, totalSessions: 50 },
    };
    expect(parseConfigPayload(bare)?.version).toBe(1);
    expect(parseConfigPayload({ config: bare })?.version).toBe(1);
    expect(parseConfigPayload({ data: bare })?.version).toBe(1);
    expect(parseConfigPayload({ version: 2, connection: {}, history: {}, presets: [] })).toBe(null);
    expect(parseConfigPayload(null)).toBe(null);
  });
  it("parsePresetsPayload 裸数组与 {presets} 包装均接受", () => {
    expect(parsePresetsPayload([{ id: "general" }])).toHaveLength(1);
    expect(parsePresetsPayload({ presets: [{ id: "general" }] })).toHaveLength(1);
    expect(parsePresetsPayload({ presets: [{ no: 1 }] })).toHaveLength(0);
  });
  it("parseHistoryPayload {entries} 包装接受并归一 tier/lang", () => {
    const got = parseHistoryPayload({
      entries: [
        {
          ts: 7,
          sessionId: "s-1",
          tier: "high",
          lang: "en",
          rootHash: "h",
          rootDisplay: "d",
          presetId: "general",
          templateVersion: 1,
          stateHash: "s",
          snippetRedacted: "t",
          truncated: false,
          originalLength: 1,
          resultKind: "choice",
          confidence: 0.5,
          automation: "auto",
          provider: "official",
          latencyMs: 1,
        },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.tier).toBe("high");
    const badTier = parseHistoryPayload({
      entries: [{ ts: 1, sessionId: "s", tier: "ultra", lang: "fr" }],
    });
    expect(badTier[0]?.tier).toBe("none");
    expect(badTier[0]?.lang).toBe("unknown");
  });
  it("failureCategory 优先 error.category/errorCode；403/405/400 回落", () => {
    expect(failureCategory(400, { error: { category: "shape", errorCode: "INVALID_REF" } })).toBe(
      "shape",
    );
    expect(failureCategory(403, {})).toBe("forbidden-non-loopback");
    expect(failureCategory(405, {})).toBe("method-not-allowed");
    expect(failureCategory(400, {})).toBe("bad-request");
  });
  it("normalizeCap/capLabel/clamp01 三档精确", () => {
    expect(normalizeCap(2)).toBe(2);
    expect(normalizeCap(1)).toBe(1);
    expect(normalizeCap(0)).toBe(0);
    expect(normalizeCap(99)).toBe(2);
    expect(normalizeCap("high")).toBe(2);
    expect(capLabel(2)).toBe("high");
    expect(capLabel(0)).toContain("none");
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01("x")).toBe(0);
  });
});

describe("契约解析分支补杀", () => {
  it("failureCategory 嵌套 code 与顶层键回落", () => {
    expect(failureCategory(400, { error: { code: "E_CODE" } })).toBe("E_CODE");
    expect(failureCategory(400, { error: {} })).toBe("bad-request");
    expect(failureCategory(500, { error: "oops" })).toBe("oops");
    expect(failureCategory(500, { message: "m" })).toBe("m");
    expect(failureCategory(500, {})).toBe("http-500");
  });
  it("normalizeCap 字符串与小数档", () => {
    expect(normalizeCap("1")).toBe(1);
    expect(normalizeCap("2")).toBe(2);
    expect(normalizeCap("low")).toBe(1);
    expect(normalizeCap(1.5)).toBe(1);
    expect(normalizeCap(0.5)).toBe(0);
    expect(normalizeCap(-1)).toBe(0);
    expect(normalizeCap(undefined)).toBe(0);
    expect(capLabel(1)).toBe("low");
  });
  it("parseConfigPayload 缺 connection/presets 即 null；非法预设项跳过", () => {
    const noConn = {
      version: 1,
      connection: null,
      presets: [{ id: "general", enabled: true, automationCap: 2 }],
      history: { perSession: 200, totalSessions: 50 },
    };
    expect(parseConfigPayload(noConn)).toBe(null);
    const noPresets = {
      version: 1,
      connection: { hasPlaintextKey: false, timeoutMs: 1, maxConcurrency: 1, truncBudget: 1 },
      presets: null,
      history: { perSession: 1, totalSessions: 1 },
    };
    expect(parseConfigPayload(noPresets)).toBe(null);
    const mixed = {
      version: 1,
      connection: { hasPlaintextKey: false, timeoutMs: 1, maxConcurrency: 1, truncBudget: 1 },
      presets: [{ no: 1 }, { id: "general", enabled: 1, automationCap: 9 }],
      history: { perSession: 1, totalSessions: 1 },
    };
    const got = parseConfigPayload(mixed);
    expect(got?.presets).toHaveLength(1);
    expect(got?.presets[0]).toMatchObject({ id: "general", enabled: false, automationCap: 2 });
  });
  it("parsePresetsPayload 非数组 presets 与 data 包装", () => {
    expect(parsePresetsPayload({ presets: "x" })).toHaveLength(0);
    const viaData = parsePresetsPayload({ data: [{ id: "g", templateVersion: "1", label: 1 }] });
    expect(viaData).toHaveLength(1);
    expect(viaData[0]?.templateVersion).toBe(undefined);
    expect(viaData[0]?.label).toBe(undefined);
  });
  it("parseHistoryPayload 非法条目跳过；字段归一", () => {
    const got = parseHistoryPayload({
      entries: [
        { ts: "7", sessionId: "s" },
        { ts: 1 },
        {
          ts: 2,
          sessionId: "s2",
          score: Number.NaN,
          choice: 42,
          errorCode: 7,
          truncated: 1,
          automation: "assisted",
        },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.score).toBe(undefined);
    expect(got[0]?.choice).toBe(undefined);
    expect(got[0]?.errorCode).toBe(undefined);
    expect(got[0]?.truncated).toBe(false);
    expect(got[0]?.automation).toBe("assisted");
  });
  it("validApiKeyRef 尾随符号拒收（锚定 $）", () => {
    expect(validApiKeyRef("JEV_KEY!")).toBe(false);
    expect(validApiKeyRef("JEV_KEY")).toBe(true);
  });
});
