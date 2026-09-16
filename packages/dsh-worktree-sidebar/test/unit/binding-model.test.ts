/**
 * binding 域纯逻辑 —— 形状校验与 revision 规则。
 *
 * 为什么值得逐条断言：这三条规则每一条失效都对应一种「静默挂错目录」——
 * 损坏文件不回落空表、版本更高也照读、摘不存在的会话也涨 revision（客户端白刷）。
 * 它们都不抛异常，只让文件树指向错的地方。
 */
import { describe, expect, it } from "vitest";
import { BINDINGS_VERSION } from "../../src/server/binding/interface.ts";
import {
  dropBinding,
  emptyTable,
  parseTable,
  putBinding,
  serializeTable,
  validateRecord,
} from "../../src/server/binding/impl/model/index.ts";

const record = {
  repoRoot: "/repo",
  worktreeRoot: "/repo-wt",
  branch: "feature",
  createdAt: "2026-09-14T00:00:00.000Z",
  sessionCreatedAt: 1_700_000_000_000,
};

describe("emptyTable", () => {
  it("用当前契约版本，revision 从 0 起", () => {
    expect(emptyTable()).toEqual({ version: BINDINGS_VERSION, revision: 0, bindings: {} });
  });
});

describe("parseTable 的损坏回落", () => {
  it("非 JSON 回落空表", () => {
    expect(parseTable("{ not json")).toEqual(emptyTable());
  });

  it("JSON 但不是对象回落空表", () => {
    expect(parseTable("42")).toEqual(emptyTable());
    expect(parseTable("null")).toEqual(emptyTable());
    expect(parseTable('"x"')).toEqual(emptyTable());
  });

  it("版本号更高回落空表而不是猜着读", () => {
    const text = JSON.stringify({ version: BINDINGS_VERSION + 1, revision: 3, bindings: {} });
    expect(parseTable(text)).toEqual(emptyTable());
  });

  it("revision 缺失、负数或非有限值回落空表", () => {
    for (const bad of [undefined, -1, "3", null]) {
      const text = JSON.stringify({ version: BINDINGS_VERSION, revision: bad, bindings: {} });
      expect(parseTable(text)).toEqual(emptyTable());
    }
  });

  it("bindings 不是对象回落空表", () => {
    const text = JSON.stringify({ version: BINDINGS_VERSION, revision: 0, bindings: [] });
    expect(parseTable(text)).toEqual(emptyTable());
  });
});

describe("parseTable 的逐条校验", () => {
  it("丢弃形状不合格的记录但保留合格的", () => {
    const text = JSON.stringify({
      version: BINDINGS_VERSION,
      revision: 7,
      bindings: {
        good: record,
        missingRoot: { worktreeRoot: "/w", branch: "b", createdAt: "t" },
        emptyWorktree: { repoRoot: "/r", worktreeRoot: "", branch: "b", createdAt: "t" },
        wrongType: { repoRoot: "/r", worktreeRoot: "/w", branch: 5, createdAt: "t" },
        nope: null,
      },
    });
    const table = parseTable(text);
    expect(Object.keys(table.bindings)).toEqual(["good"]);
    expect(table.revision).toBe(7);
  });

  it("丢掉空 sessionId 的条目", () => {
    const text = JSON.stringify({
      version: BINDINGS_VERSION,
      revision: 1,
      bindings: { "": record, ok: record },
    });
    expect(Object.keys(parseTable(text).bindings)).toEqual(["ok"]);
  });
});

describe("validateRecord", () => {
  it("接受完整记录并原样返回字段", () => {
    expect(validateRecord(record)).toEqual(record);
  });

  it("拒绝空串路径", () => {
    expect(validateRecord({ ...record, repoRoot: "" })).toBeUndefined();
    expect(validateRecord({ ...record, worktreeRoot: "" })).toBeUndefined();
  });

  it("拒绝非字符串字段", () => {
    expect(validateRecord({ ...record, branch: undefined })).toBeUndefined();
    expect(validateRecord({ ...record, createdAt: 0 })).toBeUndefined();
  });

  it("拒绝没有会话身份凭据的记录（缺席、非数字、非有限值）", () => {
    // 这条是「会话 id 会被复用」的第一道闸门：凭据缺席的记录留着，就等于留着
    // 「重启后一个新会话继承了上一进程的登记」这条静默看错地方的路径。
    const { sessionCreatedAt: _omitted, ...withoutFingerprint } = record;
    expect(validateRecord(withoutFingerprint)).toBeUndefined();
    expect(validateRecord({ ...record, sessionCreatedAt: "1700000000000" })).toBeUndefined();
    expect(validateRecord({ ...record, sessionCreatedAt: Number.NaN })).toBeUndefined();
  });
});

describe("putBinding", () => {
  it("写入并递增 revision，且不改动入参", () => {
    const base = emptyTable();
    const next = putBinding(base, "s1", record);
    expect(next.revision).toBe(1);
    expect(next.bindings["s1"]).toEqual(record);
    expect(base.revision).toBe(0);
    expect(base.bindings).toEqual({});
  });

  it("覆盖同一会话仍递增 revision", () => {
    const once = putBinding(emptyTable(), "s1", record);
    const twice = putBinding(once, "s1", { ...record, branch: "other" });
    expect(twice.revision).toBe(2);
    expect(twice.bindings["s1"]?.branch).toBe("other");
  });
});

describe("dropBinding", () => {
  it("目标不存在时原样返回同一对象（不涨 revision）", () => {
    const base = putBinding(emptyTable(), "s1", record);
    expect(dropBinding(base, "absent")).toBe(base);
  });

  it("目标存在时摘掉并递增 revision", () => {
    const base = putBinding(emptyTable(), "s1", record);
    const next = dropBinding(base, "s1");
    expect(next.revision).toBe(2);
    expect(next.bindings["s1"]).toBeUndefined();
    expect(base.bindings["s1"]).toEqual(record);
  });
});

describe("serializeTable", () => {
  it("序列化后再解析回等价内容", () => {
    const base = putBinding(emptyTable(), "s1", record);
    expect(parseTable(serializeTable(base))).toEqual(base);
  });

  it("以换行结尾", () => {
    expect(serializeTable(emptyTable()).endsWith("\n")).toBe(true);
  });
});
