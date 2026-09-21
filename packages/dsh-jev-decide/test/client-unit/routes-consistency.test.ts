/** 两端路由一致性 + 客户端契约解析（直连 src/client 纯逻辑，node 环境，全离线）。
 *
 * 守的是 client/api/routes.CLIENT_ROUTES/APP_ROUTES 与 shared ROUTES 的同值关系，
 * 以及 contract 解析的防御形态：把客户端路由改成手写字面量、解析放宽任一改动，本文件必红。
 */
import { describe, expect, it } from "vitest";
import { APP_ROUTES, CLIENT_ROUTES } from "../../src/client/api/routes.ts";
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
  it("CLIENT_ROUTES 与共享 ROUTES 逐项同值", () => {
    expect(CLIENT_ROUTES.health).toBe(ROUTES.health);
    expect(CLIENT_ROUTES.config).toBe(ROUTES.config);
    expect(CLIENT_ROUTES.presets).toBe(ROUTES.presets);
    expect(CLIENT_ROUTES.history).toBe(ROUTES.history);
    expect(CLIENT_ROUTES.testConnection).toBe(ROUTES.testConnection);
  });
  it("APP_ROUTES 无注入时回落共享 ROUTES", () => {
    expect(APP_ROUTES.health).toBe("/api/dsh-jev-decide/health");
    expect(APP_ROUTES.config).toBe("/api/dsh-jev-decide/config");
    expect(APP_ROUTES.presets).toBe("/api/dsh-jev-decide/presets");
    expect(APP_ROUTES.history).toBe("/api/dsh-jev-decide/history");
    expect(APP_ROUTES.testConnection).toBe("/api/dsh-jev-decide/test-connection");
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
