/**
 * 客户端面板纯函数直测（#732 阶段 2 拆出的具名纯函数；happy-dom 环境直连 src）。
 *
 * 守三份契约：
 * - putFailureCategory：保存路径的类别提取口径（按 ?? 逐级取、命中非串即停、
 *   不回落 message）。它与 api/contract 的 failureCategory 刻意不同——后者取第一个
 *   非空串并回落 message。两条口径并存是有意为之，任一条被改成另一条即判红。
 * - buildPutBody：PUT 体的键面（互斥时清 apiKeyRef、未知键永不发送、数值下标映射）。
 * - mergeRows：目录面与配置面的合并（行序以目录面为准，缺席处回可见占位）。
 *
 * 验的是键值契约不是 JSX 形状：任一条件展开、占位回落或键表被改，本文件按字段判红。
 */
import { describe, expect, it } from "vitest";
import { buildPutBody, putFailureCategory } from "../../src/client/settings/connection.tsx";
import { mergeRows } from "../../src/client/settings/presets.tsx";
import { entryMeta } from "../../src/client/settings/history.tsx";
import type { DecisionConfigV1 } from "../../src/client/api/interface.ts";

describe("putFailureCategory 保存路径口径（?? 链，非 failureCategory 口径）", () => {
  it("嵌套 error 面取 category；空串同样占位（?? 链不停），故回退到状态码类别", () => {
    expect(putFailureCategory(400, { error: { category: "shape" } })).toBe("shape");
    // 空串是「已定义」而非「未定义」：?? 链停在空串上，再判非空失败 → 回状态码类别。
    // failureCategory 在同一输入下会跳过空串取到 errorCode，这正是两条口径的差异。
    expect(putFailureCategory(400, { error: { category: "", errorCode: "E2" } })).toBe("http-400");
  });
  it("嵌套面命中非串即停：不下探 errorCode（与 failureCategory 的关键差异）", () => {
    expect(putFailureCategory(400, { error: { category: 7, errorCode: "E2" } })).toBe("http-400");
    expect(putFailureCategory(400, { error: { errorCode: "" } })).toBe("http-400");
  });
  it("嵌套面不认 code 键（只有 category/errorCode 两个候选）", () => {
    expect(putFailureCategory(400, { error: { code: "E3" } })).toBe("http-400");
  });
  it("顶层链：category > errorCode > error > code，逐级 ?? 取", () => {
    expect(putFailureCategory(400, { category: "C" })).toBe("C");
    expect(putFailureCategory(400, { errorCode: "E" })).toBe("E");
    expect(putFailureCategory(400, { error: "str" })).toBe("str");
    expect(putFailureCategory(400, { code: "K" })).toBe("K");
  });
  it("顶层命中非串即停，同样不下探", () => {
    expect(putFailureCategory(400, { category: 0, errorCode: "E" })).toBe("http-400");
  });
  it("不回落 message（与 failureCategory 的另一处差异）", () => {
    expect(putFailureCategory(500, { message: "boom" })).toBe("http-500");
  });
  it("error 面是串时按顶层链判（不当作嵌套对象）", () => {
    expect(putFailureCategory(400, { error: "str" })).toBe("str");
  });
  it("非对象体一律回状态码类别", () => {
    expect(putFailureCategory(403, null)).toBe("http-403");
    expect(putFailureCategory(405, [1])).toBe("http-405");
  });
});

describe("buildPutBody PUT 键面", () => {
  const snapshot: DecisionConfigV1 = {
    version: 1,
    connection: {
      apiKeyRef: "OLD_KEY",
      hasPlaintextKey: false,
      timeoutMs: 8000,
      maxConcurrency: 4,
      truncBudget: 32000,
    },
    presets: [{ id: "general", enabled: true, automationCap: 2 }],
    history: { perSession: 200, totalSessions: 50 },
  };
  const nums = [1, 2, 3, 4, 5];

  it("数值下标映射：0..2 进 connection，3..4 进 history", () => {
    const body = buildPutBody(snapshot, nums, "", "");
    expect(body["connection"]).toEqual({ timeoutMs: 1, maxConcurrency: 2, truncBudget: 3 });
    expect(body["history"]).toEqual({ perSession: 4, totalSessions: 5 });
  });
  it("ENV 轨：带引用名才发 apiKeyRef，键集合不含 apiKeyPlaintext", () => {
    const body = buildPutBody(snapshot, nums, "NEW_KEY", "");
    expect((body["connection"] as Record<string, unknown>)["apiKeyRef"]).toBe("NEW_KEY");
    expect("apiKeyPlaintext" in body).toBe(false);
  });
  it("明文轨：发 apiKeyPlaintext，且清掉已存 apiKeyRef（否则服务端互斥 400）", () => {
    const body = buildPutBody(snapshot, nums, "", "secret");
    expect(body["apiKeyPlaintext"]).toBe("secret");
    expect(body["apiKeyRef"]).toBe(null);
  });
  it("明文轨且存量本就无引用时，不发多余的 apiKeyRef:null", () => {
    const noRef: DecisionConfigV1 = {
      ...snapshot,
      connection: { hasPlaintextKey: false, timeoutMs: 1, maxConcurrency: 1, truncBudget: 1 },
    };
    expect("apiKeyRef" in buildPutBody(noRef, nums, "", "secret")).toBe(false);
  });
  it("两轨都空：既不发明文也不发引用（键面最小）", () => {
    const body = buildPutBody(snapshot, nums, "", "");
    expect("apiKeyPlaintext" in body).toBe(false);
    expect("apiKeyRef" in body).toBe(false);
  });
  it("presets 列按 id/enabled/automationCap 投影，不外泄其它字段", () => {
    expect(body(buildPutBody(snapshot, nums, "", ""))["presets"]).toEqual([
      { id: "general", enabled: true, automationCap: 2 },
    ]);
    function body(b: Record<string, unknown>): Record<string, unknown> {
      return b;
    }
  });
  it("version 恒为 1", () => {
    expect(buildPutBody(snapshot, nums, "", "")["version"]).toBe(1);
  });
});

describe("mergeRows 目录面 × 配置面", () => {
  const cfg: DecisionConfigV1 = {
    version: 1,
    connection: { hasPlaintextKey: false, timeoutMs: 8000, maxConcurrency: 4, truncBudget: 32000 },
    presets: [
      { id: "plan-review", enabled: true, automationCap: 1 },
      { id: "general", enabled: false, automationCap: 2 },
    ],
    history: { perSession: 200, totalSessions: 50 },
  };

  it("行序以目录面为准，配置面不决定出现顺序", () => {
    const rows = mergeRows([{ id: "general" }, { id: "plan-review" }], cfg);
    expect(rows.map((r) => r.id)).toEqual(["general", "plan-review"]);
  });
  it("目录面为空时回落配置面行序", () => {
    const rows = mergeRows([], cfg);
    expect(rows.map((r) => r.id)).toEqual(["plan-review", "general"]);
  });
  it("两侧都空即空列表", () => {
    const empty: DecisionConfigV1 = { ...cfg, presets: [] };
    expect(mergeRows([], empty)).toHaveLength(0);
  });
  it("开关与档位取配置面，缺项回关闭 + none 档", () => {
    const rows = mergeRows([{ id: "general" }, { id: "unknown-preset" }], cfg);
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.cap).toBe(2);
    expect(rows[1]?.enabled).toBe(false);
    expect(rows[1]?.cap).toBe(0);
  });
  it("label 缺席回落可见 id，desc 回落 label，custom 只认字面 true", () => {
    const rows = mergeRows(
      [
        { id: "a" },
        { id: "b", label: "B" },
        { id: "c", label: "C", description: "D", custom: true },
      ],
      cfg,
    );
    expect(rows[0]?.label).toBe("a");
    expect(rows[0]?.desc).toBeUndefined();
    expect(rows[0]?.custom).toBe(false);
    expect(rows[1]?.label).toBe("B");
    expect(rows[1]?.desc).toBe("B");
    expect(rows[2]?.desc).toBe("D");
    expect(rows[2]?.custom).toBe(true);
    expect(rows[2]?.templateVersion).toBeUndefined();
  });
  it("templateVersion 只在目录面给出时透传", () => {
    const rows = mergeRows([{ id: "a", templateVersion: 1 }], cfg);
    expect(rows[0]?.templateVersion).toBe(1);
  });
});

describe("entryMeta 历史条目摘要行", () => {
  const base = {
    ts: 0,
    rootHash: "h",
    rootDisplay: "d",
    sessionId: "s",
    presetId: "general",
    templateVersion: 1,
    stateHash: "sh",
    snippetRedacted: "",
    lang: "en" as const,
    truncated: false,
    originalLength: 12,
    resultKind: "choice",
    confidence: 0.5,
    tier: "low" as const,
    automation: "assisted" as const,
    provider: "official" as const,
    latencyMs: 30,
  };

  it("缺席信息不占位：resultKind 空串不出现在行首，choice 缺失整段略去", () => {
    expect(entryMeta({ ...base, resultKind: "", choice: undefined })).toEqual([
      "orig=12",
      "assisted",
      "official",
      "30ms",
    ]);
  });
  it("resultKind 非空即行首；choice 非空串即带 choice= 前缀", () => {
    expect(entryMeta({ ...base, resultKind: "score", choice: "4" })).toEqual([
      "score",
      "choice=4",
      "orig=12",
      "assisted",
      "official",
      "30ms",
    ]);
  });
  it("choice 空串等同缺席（不写 choice=）", () => {
    expect(entryMeta({ ...base, choice: "" })[1]).toBe("orig=12");
  });
  it("固定尾段恒为 原文长度 / automation / provider / 时延，且顺序不变", () => {
    const meta = entryMeta(base);
    expect(meta.slice(-4)).toEqual(["orig=12", "assisted", "official", "30ms"]);
  });
});
