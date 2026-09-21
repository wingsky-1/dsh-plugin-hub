/** 历史硬化：脱敏无原文 + 轮转 200/50 + root 三形态 + 单会话清空（mkdtemp 隔离，全离线）。
 *
 * 守的是 history/redact+hash+entry+service：把掩码删一项、轮转改大、basename 误存全路径、
 * 删除放宽到整库任一改动，本文件必红。落盘仅 mkdtempSync 目录。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../src/shared/interface.ts";
import type { HistoryDeps } from "../../src/server/history/deps.ts";
import { assembleEntry } from "../../src/server/history/impl/entry.ts";
import { resolveRootHash, rootDisplayOf, rootHashOf } from "../../src/server/history/impl/hash.ts";
import { redactSnippet } from "../../src/server/history/impl/redact.ts";
import {
  appendEntry,
  deleteSession,
  historyFile,
  queryEntries,
} from "../../src/server/history/impl/service.ts";
import {
  atomicWrite0600Sync,
  ensureDir0700,
  listFilesSync,
  mtimeMs,
  readTextSync,
  removeFileSync,
} from "../../src/server/store/impl/io.ts";

function deps(): HistoryDeps {
  return {
    io: {
      readTextSync,
      atomicWrite0600Sync,
      listFilesSync,
      mtimeMs,
      removeFileSync,
      ensureDir0700,
    },
    logger: { warn: () => {} },
  };
}
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "jev-hist-hard-"));
}
function entry(sessionId: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: Date.now(),
    rootHash: rootHashOf("/work/proj"),
    rootDisplay: "proj",
    sessionId,
    presetId: "general",
    templateVersion: 1,
    stateHash: "abc",
    snippetRedacted: "hello",
    lang: "en",
    truncated: false,
    originalLength: 5,
    resultKind: "choice",
    choice: "A",
    confidence: 0.5,
    tier: "high",
    automation: "auto",
    provider: "official",
    latencyMs: 3,
    ...extra,
  };
}

describe("脱敏无密钥原文", () => {
  it.each([
    "key sk-Abcdef12345678 end",
    "token AKIAIOSFODNN7EXAMPLE here",
    "ghp_abcdefgh12345678 leak",
    "xoxb-1234-abcd token",
    "xoxp-secret-value here",
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    "api_key: hunter2-value",
    "password=hunter2",
    "secret: topsecret123",
  ])("掩码 %s 无原文且 ≤200 字", (raw) => {
    const out = redactSnippet(raw);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("topsecret123");
    expect(Array.from(out).length).toBeLessThanOrEqual(200);
    // 具体掩码标记：至少原文被替换（长度变化或含 ***)。
    expect(out === raw).toBe(false);
  });
  it("超长先脱敏后截断：掩码不断半", () => {
    const raw = "prefix sk-Abcdef12345678 " + "x".repeat(500);
    const out = redactSnippet(raw);
    expect(out).not.toContain("sk-Abcdef12345678");
    expect(Array.from(out).length).toBeLessThanOrEqual(200);
  });
  it("长 PEM 整体掩码：超 200 字密钥体无残留", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(20);
    const raw = "-----BEGIN PRIVATE KEY-----\n" + body + "\n-----END PRIVATE KEY-----";
    expect(raw.length).toBeGreaterThan(600);
    const out = redactSnippet(raw);
    expect(out).not.toContain("MIIEvQ");
    expect(out).not.toContain("PRIVATE KEY");
    expect(Array.from(out).length).toBeLessThanOrEqual(200);
  });
  it("assembleEntry 永不带密钥字段：原文不出境存证", () => {
    const secret = "sk-Abcdef12345678";
    const e = assembleEntry(
      "/work/proj",
      "s-1",
      {
        presetId: "general",
        text: secret,
        lang: "en",
        truncated: false,
        originalLength: 17,
        resultKind: "choice",
        questions: [{ id: "q1", text: "Pick one.", kind: "choice", options: ["A", secret] }],
        choice: "A",
        confidence: 1,
        tier: "high",
        automation: "auto",
        latencyMs: 1,
        precheckHit: false,
      },
      7,
    );
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(e).toMatchObject({ provider: "official", templateVersion: 1, sessionId: "s-1", ts: 7 });
    expect(e.questions).toHaveLength(1);
    expect(e.questions?.[0]?.options?.[1]).toBe("***");
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(e.rootDisplay).toBe("proj");
    expect(e.rootHash).toBe(rootHashOf("/work/proj"));
  });
  it("precheck 命中即 snippet 全掩码（S1-A）", () => {
    const e = assembleEntry(
      "/work/proj",
      "s-1",
      {
        presetId: "general",
        text: "x".repeat(500),
        lang: "en",
        truncated: true,
        originalLength: 500,
        resultKind: "local-precheck",
        questions: [],
        choice: "human",
        confidence: 1,
        tier: "none",
        automation: "manual",
        latencyMs: 0,
        precheckHit: true,
      },
      9,
    );
    expect(e.snippetRedacted).toBe("***");
  });
});

describe("轮转 200/50 精确", () => {
  it("每会话只留末尾 200 条（204 为首）", () => {
    const home = tempHome();
    for (let i = 0; i < 205; i += 1)
      appendEntry(home, entry("s-1", { ts: i }), { perSession: 200, totalSessions: 50 }, deps());
    const got = queryEntries(home, { sessionId: "s-1", limit: 500 }, deps());
    expect(got).toHaveLength(200);
    expect(got[0]?.ts).toBe(204);
    expect(got[got.length - 1]?.ts).toBe(5);
  });
  it("总会话超 50 按 mtime 淘汰最旧（手写假 io 确定性）", () => {
    const files = new Map<string, string>();
    const mtimes = new Map<string, number>();
    let clock = 1000;
    const fake: HistoryDeps = {
      logger: { warn: () => {} },
      io: {
        readTextSync: (f: string) =>
          files.has(f)
            ? { ok: true as const, text: files.get(f) as string }
            : { ok: false as const },
        atomicWrite0600Sync: (f: string, t: string) => {
          files.set(f, t);
          mtimes.set(f, (clock += 10));
        },
        listFilesSync: (dir: string) => {
          const prefix = dir.endsWith("/") ? dir : dir + "/";
          const children = new Set<string>();
          for (const f of files.keys()) {
            if (f.startsWith(prefix)) {
              const rest = f.slice(prefix.length);
              const slash = rest.indexOf("/");
              children.add(slash === -1 ? rest : rest.slice(0, slash));
            }
          }
          return [...children];
        },
        mtimeMs: (f: string) => mtimes.get(f) ?? -1,
        removeFileSync: (f: string) => {
          files.delete(f);
          mtimes.delete(f);
        },
        ensureDir0700: () => {},
      },
    };
    const home = "/fake-home";
    for (let i = 0; i < 52; i += 1)
      appendEntry(
        home,
        entry("s-" + String(i), { ts: i }),
        { perSession: 200, totalSessions: 50 },
        fake,
      );
    const got = queryEntries(home, {}, fake);
    const sessions = new Set(got.map((e) => e.sessionId));
    expect(sessions.size).toBe(50);
    expect(sessions.has("s-0")).toBe(false);
    expect(sessions.has("s-1")).toBe(false);
    expect(sessions.has("s-51")).toBe(true);
  });
});

describe("root 三形态过滤 + 单会话清空", () => {
  it("路径/hash/basename 三形态同命中；空即全量", () => {
    const home = tempHome();
    appendEntry(home, entry("s-9"), { perSession: 200, totalSessions: 50 }, deps());
    expect(queryEntries(home, { root: "/work/proj" }, deps())).toHaveLength(1);
    expect(queryEntries(home, { root: rootHashOf("/work/proj") }, deps())).toHaveLength(1);
    expect(queryEntries(home, { root: "proj" }, deps())).toHaveLength(1);
    expect(queryEntries(home, {}, deps())).toHaveLength(1);
    expect(queryEntries(home, { root: "/other" }, deps())).toHaveLength(0);
  });
  it("limit 钳制 1..500", () => {
    const home = tempHome();
    for (let i = 0; i < 5; i += 1)
      appendEntry(home, entry("s-l", { ts: i }), { perSession: 200, totalSessions: 50 }, deps());
    expect(queryEntries(home, { sessionId: "s-l", limit: 2 }, deps())).toHaveLength(2);
    expect(queryEntries(home, { sessionId: "s-l", limit: 9999 }, deps())).toHaveLength(5);
  });
  it("删除仅单会话：缺 root/sessionId 即 400；异会话不受影响", () => {
    const home = tempHome();
    appendEntry(home, entry("s-a"), { perSession: 200, totalSessions: 50 }, deps());
    appendEntry(home, entry("s-b"), { perSession: 200, totalSessions: 50 }, deps());
    expect(() => deleteSession(home, { root: "/work/proj" }, deps())).toThrow();
    expect(() => deleteSession(home, { sessionId: "s-a" }, deps())).toThrow();
    expect(() => deleteSession(home, { root: "", sessionId: "" }, deps())).toThrow();
    expect(deleteSession(home, { root: "/work/proj", sessionId: "s-a" }, deps())).toMatchObject({
      deleted: true,
    });
    expect(queryEntries(home, { sessionId: "s-a" }, deps())).toHaveLength(0);
    expect(queryEntries(home, { sessionId: "s-b" }, deps())).toHaveLength(1);
    expect(deleteSession(home, { root: "/work/proj", sessionId: "nope" }, deps())).toMatchObject({
      deleted: false,
    });
  });
  it("非法 sessionId 形状即抛（含路径穿越）", () => {
    expect(() => historyFile("/tmp/h", rootHashOf("/a"), "../evil")).toThrow();
    expect(() => historyFile("/tmp/h", "zzz", "s-1")).toThrow();
    expect(rootDisplayOf("/a/b/proj")).toBe("proj");
    expect(resolveRootHash(rootHashOf("/a/b"))).toBe(rootHashOf("/a/b"));
  });
});
