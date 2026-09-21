/** history 域单测（mkdtempSync 隔离落盘，全程离线）。 */
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
  return mkdtempSync(join(tmpdir(), "jev-hist-"));
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

describe("命名与哈希", () => {
  it("按(rootHash,sessionId)分文件；rootDisplay 仅 basename", () => {
    expect(rootDisplayOf("/a/b/proj")).toBe("proj");
    expect(resolveRootHash(rootHashOf("/a/b"))).toBe(rootHashOf("/a/b"));
    expect(resolveRootHash("/a/b")).toBe(rootHashOf("/a/b"));
    const f = historyFile("/tmp/h", rootHashOf("/a"), "s-1");
    expect(f).toContain(".jsonl");
    expect(() => historyFile("/tmp/h", rootHashOf("/a"), "../evil")).toThrow();
  });
});

describe("脱敏截断", () => {
  it("密钥掩码且≤200 字", () => {
    const out = redactSnippet("key sk-Abcdef12345678 end password: hunter2");
    expect(out).not.toContain("sk-Abcdef12345678");
    expect(out).not.toContain("hunter2");
    expect(Array.from(redactSnippet("x".repeat(500))).length).toBeLessThanOrEqual(200);
  });
  it("assembleEntry 永不带密钥字段", () => {
    const e = assembleEntry(
      "/work/proj",
      "s-1",
      {
        presetId: "general",
        text: "sk-Abcdef12345678",
        lang: "en",
        truncated: false,
        originalLength: 17,
        resultKind: "choice",
        choice: "A",
        confidence: 1,
        tier: "high",
        automation: "auto",
        latencyMs: 1,
        precheckHit: false,
      },
      7,
    );
    expect(JSON.stringify(e)).not.toContain("sk-Abcdef12345678");
    expect(e).toMatchObject({ provider: "official", templateVersion: 1, sessionId: "s-1", ts: 7 });
  });
});

describe("轮转与总量", () => {
  it("每会话只留 200 条", () => {
    const home = tempHome();
    for (let i = 0; i < 205; i += 1)
      appendEntry(home, entry("s-1", { ts: i }), { perSession: 200, totalSessions: 50 }, deps());
    const got = queryEntries(home, { sessionId: "s-1", limit: 500 }, deps());
    expect(got).toHaveLength(200);
    expect(got[0]?.ts).toBe(204);
  });
  // 总会话 50 精确淘汰见 history-hardening.test.ts（手写假 io 确定性 mtime，被害者 s-0/s-1）；
  // 真盘 mtime 粒度致受害者不确定，此处不重复弱断言（D6）。
  it("root 路径与哈希双兼容查询；删除仅单会话", () => {
    const home = tempHome();
    appendEntry(home, entry("s-9"), { perSession: 200, totalSessions: 50 }, deps());
    expect(queryEntries(home, { root: "/work/proj" }, deps())).toHaveLength(1);
    expect(() => deleteSession(home, { root: "/work/proj" }, deps())).toThrow();
    expect(deleteSession(home, { root: "/work/proj", sessionId: "s-9" }, deps())).toMatchObject({
      deleted: true,
    });
    expect(queryEntries(home, { sessionId: "s-9" }, deps())).toHaveLength(0);
  });
});
