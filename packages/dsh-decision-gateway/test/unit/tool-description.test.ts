/** 工具描述面单测（全离线；锁模型可见契约的名实一致）。
 *
 * 守的是 buildToolDefinitions 产出的 name/description/parameters（DSH 只把这三面送给模型）：
 * 描述退化成一句话、参数缺 enum/items 说明、必填项丢失，任一改动本文件必红。
 * 不锁逐字文案，只锁契约名词与结构（改措辞不红，删含义才红）。
 */
import { describe, expect, it } from "vitest";
import { buildToolDefinitions } from "../../src/server/tools/impl/define.ts";
import type { DecideDeps } from "../../src/server/tools/deps.ts";

function deps(): DecideDeps {
  return {
    logger: { warn: () => {} },
    connection: { timeoutMs: 8000, maxConcurrency: 4, truncBudget: 32000, hasPlaintextKey: false },
    isEnabled: () => true,
    capOf: () => 2,
    resolveKey: () => ({ key: "Abcdefgh12345678", source: "env" as const }),
    root: "/tmp/proj",
    sessionId: "sess-1",
    signal: new AbortController().signal,
  };
}

function definitions() {
  return buildToolDefinitions({
    depsFor: () => deps(),
    snapshot: () => ({ isEnabled: () => true, capOf: () => 2 }),
  });
}

function paramsOf(name: string): Record<string, unknown> {
  const tool = definitions().find((d) => d.name === name);
  expect(tool).toBeDefined();
  return (tool as unknown as { parameters: Record<string, unknown> }).parameters;
}

describe("decide 描述覆盖契约", () => {
  it("讲清何时用、何时不用、必带题目与失败语义", () => {
    const tool = definitions().find((d) => d.name === "ws_request_verdict");
    expect(tool).toBeDefined();
    const text = (tool as unknown as { description: string }).description;
    for (const noun of [
      "questions_override",
      "PRESET_DISABLED",
      "ws_list_verdict_guides",
      "suggest-only",
      "NO_KEY",
      "English",
      "DO NOT use",
    ]) {
      expect(text).toContain(noun);
    }
  });
  it("描述非一句话：长度下限锁详细度", () => {
    const tool = definitions().find((d) => d.name === "ws_request_verdict");
    const text = (tool as unknown as { description: string }).description;
    expect(text.length).toBeGreaterThanOrEqual(500);
  });
});

describe("decide 参数面自描述", () => {
  it("三件必填 + preset 纯 string（去 enum，描述诚实）", () => {
    const params = paramsOf("ws_request_verdict");
    expect(params["required"]).toEqual(["preset_id", "state", "questions_override"]);
    const preset = (params["properties"] as Record<string, Record<string, unknown>>)["preset_id"];
    expect(preset["type"]).toBe("string");
    expect(preset["enum"]).toBeUndefined();
    const desc = preset["description"] as string;
    for (const noun of [
      "general",
      "secret-leak",
      "plan-review",
      "risk-check",
      "custom",
      "ws_list_verdict_guides",
    ]) {
      expect(desc).toContain(noun);
    }
  });
  it("state 与题目 items 的约束落在 schema 里", () => {
    const params = paramsOf("ws_request_verdict");
    const props = params["properties"] as Record<string, Record<string, unknown>>;
    const state = props["state"];
    expect(state["required"]).toEqual(["text"]);
    const lang = (state["properties"] as Record<string, Record<string, unknown>>)["lang"];
    expect(lang["enum"]).toEqual(["en", "zh", "unknown"]);
    expect(lang["default"]).toBe("unknown");
    const override = props["questions_override"];
    const items = override["items"] as Record<string, unknown>;
    expect(items["required"]).toEqual(["id", "text", "kind"]);
    const kind = (items["properties"] as Record<string, Record<string, unknown>>)["kind"];
    expect(kind["enum"]).toEqual(["choice", "score"]);
  });
  it("每级属性都有非空说明（顶层 + state + 题目 items）", () => {
    const params = paramsOf("ws_request_verdict");
    const top = params["properties"] as Record<string, Record<string, unknown>>;
    for (const key of ["preset_id", "state", "questions_override"]) {
      expect(typeof top[key]["description"]).toBe("string");
      expect((top[key]["description"] as string).length).toBeGreaterThan(0);
    }
    const stateProps = top["state"]["properties"] as Record<string, Record<string, unknown>>;
    for (const key of ["text", "lang"]) {
      expect((stateProps[key]["description"] as string).length).toBeGreaterThan(0);
    }
    const itemProps = (top["questions_override"]["items"] as Record<string, unknown>)[
      "properties"
    ] as Record<string, Record<string, unknown>>;
    for (const key of ["id", "text", "kind", "options"]) {
      expect((itemProps[key]["description"] as string).length).toBeGreaterThan(0);
    }
  });
});

describe("list 描述指回 decide", () => {
  it("只读语义 + 前置调用指引", () => {
    const tool = definitions().find((d) => d.name === "ws_list_verdict_guides");
    expect(tool).toBeDefined();
    const text = (tool as unknown as { description: string }).description;
    expect(text).toContain("read-only");
    expect(text).toContain("ws_request_verdict");
    expect(text).toContain("automationCap");
  });
});
