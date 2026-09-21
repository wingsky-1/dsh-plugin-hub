/** 本地预检不离境：全密形命中即 local-precheck 且 fetch 零调用（全离线；全局 fetch 桩为例外，直连默认 fetch 旁路验证）。
 *
 * 守的是 tools/precheck.localPrecheckHit + service.decide 的预检短路：把任一密形删掉、
 * 短路移到密钥之后、忘记计数 fetch，本文件必红。fetch 经注入计数，落盘无。
 */
import { describe, expect, it } from "vitest";
import { decide } from "../../src/server/tools/impl/service.ts";
import { localPrecheckHit } from "../../src/server/tools/impl/precheck.ts";
import type { DecideDeps } from "../../src/server/tools/deps.ts";

const CONNECTION = {
  timeoutMs: 8000,
  maxConcurrency: 4,
  truncBudget: 32000,
  hasPlaintextKey: false,
} as const;

function baseDeps(over: Partial<DecideDeps> = {}): DecideDeps {
  return {
    logger: { warn: () => {} },
    connection: { ...CONNECTION },
    isEnabled: () => true,
    capOf: () => 2,
    resolveKey: () => ({ key: "Abcdefgh12345678", source: "env" as const }),
    root: "/tmp/proj",
    sessionId: "sess-1",
    ...over,
  };
}

const SECRETS: readonly string[] = [
  "key sk-Abcdef12345678 here",
  "token AKIAIOSFODNN7EXAMPLE here",
  "ghp_abcdefgh12345678 leak",
  "xoxb-1234-abcd token",
  "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
  "api_key: hunter2-value",
  "password=hunter2",
  "secret: topsecret123",
];

describe("secret-leak 本地预检命中不离境", () => {
  it("残缺不命中、残头命中（打红点：{8,}/{16}/+/[:=] 量词）", () => {
    for (const frag of [
      "sk-",
      "sk-Abc12",
      "AKIA",
      "ghp_",
      "xoxb-",
      "password",
      "password=",
      "api_key: ",
    ]) {
      expect(localPrecheckHit(frag)).toBe(false);
    }
    expect(localPrecheckHit("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(localPrecheckHit("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });
  it("全密形命中；干净文本不命中", () => {
    for (const raw of SECRETS) expect(localPrecheckHit(raw)).toBe(true);
    expect(localPrecheckHit("today is sunny")).toBe(false);
    expect(localPrecheckHit("hello world")).toBe(false);
  });
  it.each(SECRETS)("命中 %s 即 local-precheck 且 fetch 零调用", async (secretText) => {
    let calls = 0;
    const events: unknown[] = [];
    const out = await decide(
      { preset_id: "general", state: { text: "prefix " + secretText + " suffix", lang: "en" } },
      baseDeps({
        fetchImpl: async () => {
          calls += 1;
          return { status: 200, text: "{}" };
        },
        recordEvent: (e) => {
          events.push(e);
        },
      }),
    );
    expect(calls).toBe(0);
    expect(out).toMatchObject({
      ok: true,
      provider: "official",
      appliedSource: "local-precheck",
      tier: "none",
      automation: "manual",
    });
    expect(events).toHaveLength(1);
  });
  it("禁用预设优先于预检：secret-leak 关闭即 PRESET_DISABLED（不走 local-precheck）", async () => {
    let calls = 0;
    const out = await decide(
      { preset_id: "secret-leak", state: { text: "my sk-Abcdef12345678 leak", lang: "en" } },
      baseDeps({
        isEnabled: (id) => id !== "secret-leak",
        fetchImpl: async () => {
          calls += 1;
          return { status: 200, text: "{}" };
        },
      }),
    );
    expect(calls).toBe(0);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.errorCode).toBe("PRESET_DISABLED");
  });
  it("全局 fetch 桩亦零调用：预检短路不经过默认 fetch", async () => {
    const prev = (globalThis as unknown as { fetch?: unknown }).fetch;
    let globalCalls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      globalCalls += 1;
      throw new Error("must not egress");
    };
    try {
      let calls = 0;
      const out = await decide(
        { preset_id: "general", state: { text: "leak sk-Abcdef12345678", lang: "en" } },
        baseDeps({
          fetchImpl: async () => {
            calls += 1;
            return { status: 200, text: "{}" };
          },
        }),
      );
      expect(calls).toBe(0);
      expect(globalCalls).toBe(0);
      expect(out).toMatchObject({ ok: true, appliedSource: "local-precheck" });
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
      else (globalThis as unknown as { fetch: unknown }).fetch = prev;
    }
  });
  it("无 key 与禁用同样不触网且包络结构化", async () => {
    let calls = 0;
    const noKey = await decide(
      { preset_id: "general", state: { text: "hi", lang: "en" } },
      baseDeps({
        resolveKey: () => ({ key: undefined, source: "none" as const }),
        fetchImpl: async () => {
          calls += 1;
          return { status: 200, text: "{}" };
        },
      }),
    );
    expect(calls).toBe(0);
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) {
      expect(noKey.error.errorCode).toBe("NO_KEY");
      expect(typeof noKey.error.category).toBe("string");
    }
  });
});
