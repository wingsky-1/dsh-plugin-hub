/** BaseURL 防篡改：写死常量 + 退役键拒收 + 迁移剥离 + 出境 URL 精确（全离线）。
 *
 * 守的是 shared/contract.JEV_BASE_URL 与 config 退役键面：把基址改掉、PUT 放行 baseUrl、
 * 迁移漏剥任一改动，本文件必红。fetch 经注入捕获 URL，不触网。
 */
import { describe, expect, it } from "vitest";
import { normalizeLoadedConfig, validatePutBody } from "../../src/server/config/impl/model.ts";
import { decide } from "../../src/server/tools/impl/service.ts";
import type { DecideDeps } from "../../src/server/tools/deps.ts";
import { JEV_BASE_URL, JEV_MODEL } from "../../src/shared/contract.ts";

const EXPECTED_BASE = "https://api.typesafe.ai/v1/systemone";
const CONNECTION = {
  timeoutMs: 8000,
  maxConcurrency: 4,
  truncBudget: 32000,
  hasPlaintextKey: false,
} as const;

describe("BaseURL 写死", () => {
  it("常量即官方基址字面量（第二事实源手写）", () => {
    expect(JEV_BASE_URL).toBe(EXPECTED_BASE);
  });
  it("模型即冻结别名 jev-latest（与基址同等 pin 待遇）", () => {
    expect(JEV_MODEL).toBe("jev-latest");
  });
  // 注：退役键表成员由下条 PUT 逐键拒收断言覆盖（删表项即 UNKNOWN_KEY 而非 RETIRED_KEY），不另立表断言（去装饰）。
  it("PUT 遇退役键一律 RETIRED_KEY（顶层/connection/history 均拒）", () => {
    for (const key of ["baseUrl", "apiBaseUrl", "endpoint", "apiEndpoint", "url"]) {
      const r = validatePutBody({ [key]: "https://evil.example" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.errorCode).toBe("RETIRED_KEY");
    }
    const nested = validatePutBody({ history: { perSession: 200, totalSessions: 50 } });
    expect(nested.ok).toBe(true);
  });
  it("加载迁移剥离退役键并告警名单", () => {
    const { config, retired } = normalizeLoadedConfig({
      connection: { baseUrl: "https://evil.example" },
      presets: [],
      history: {},
    });
    expect(retired).toContain("baseUrl");
    expect(config.version).toBe(1);
    expect(JSON.stringify(config)).not.toContain("evil.example");
  });
  it("出境 URL 精确等于基址（篡改即红）", async () => {
    let seenUrl = "";
    const deps: DecideDeps = {
      logger: { warn: () => {} },
      connection: { ...CONNECTION },
      isEnabled: () => true,
      capOf: () => 2,
      resolveKey: () => ({ key: "Abcdefgh12345678", source: "env" as const }),
      root: "/tmp/proj",
      sessionId: "sess-1",
      signal: new AbortController().signal,
      fetchImpl: async (url) => {
        seenUrl = url;
        return {
          status: 200,
          text: JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              q1: {
                type: "choice",
                choice: "A",
                confidence: 0.9,
                probabilities: { A: 0.9, B: 0.1 },
              },
            },
            usage: { input_tokens: 9, output_tokens: 3 },
          }),
        };
      },
    };
    const out = await decide(
      {
        preset_id: "general",
        state: { text: "hi", lang: "en" },
        questions_override: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", "B"] }],
      },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(seenUrl).toBe(EXPECTED_BASE);
    expect(seenUrl).toBe(JEV_BASE_URL);
  });
});
