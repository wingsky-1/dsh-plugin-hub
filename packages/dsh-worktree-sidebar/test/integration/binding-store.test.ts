/**
 * binding 域装配 —— 真文件、真原子写、真损坏输入。
 *
 * 单测打的是纯逻辑，这里打的是**它有没有被接上**：损坏文件是否真的回落空表、
 * 写盘之后磁盘上是否真是新内容、写盘失败时内存是否真的没有前移。
 * 这几条只有经真实磁盘才可能被证伪。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBinding, releaseBinding } from "../../src/server/binding/interface.ts";
import { BINDINGS_VERSION, type BindingRecord } from "../../src/contract.ts";
import { cleanup, tempDir } from "../helpers.ts";

const record: BindingRecord = {
  repoRoot: "/repo",
  worktreeRoot: "/wt",
  branch: "feature",
  createdAt: "2026-09-14T00:00:00.000Z",
};

const dirs: string[] = [];
const warns: string[] = [];

function makeDeps() {
  const dir = tempDir("binding");
  dirs.push(dir);
  const file = join(dir, "nested", "bindings.json");
  return {
    file,
    deps: {
      logger: { warn: (message: string) => warns.push(message) },
      file,
      now: () => "2026-09-14T00:00:00.000Z",
    },
  };
}

afterEach(() => {
  releaseBinding();
  for (const dir of dirs.splice(0)) cleanup(dir);
  warns.splice(0);
});

describe("installBinding", () => {
  it("文件不存在时从空表起（首次使用不该报错）", () => {
    const { deps } = makeDeps();
    const api = installBinding(deps);
    expect(api.revision()).toBe(0);
    expect(api.get("s1")).toBeUndefined();
  });

  it("损坏文件回落空表而不是抛异常", () => {
    const { deps, file } = makeDeps();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ 半个 json", "utf8");
    const api = installBinding(deps);
    expect(api.revision()).toBe(0);
    expect(api.entries()).toEqual({});
  });

  it("重复装配抛错（装配错误不该被容忍）", () => {
    const { deps } = makeDeps();
    installBinding(deps);
    const second = makeDeps();
    expect(() => installBinding(second.deps)).toThrow(/已装配/);
  });

  it("release 后可重新装配", () => {
    const { deps } = makeDeps();
    installBinding(deps);
    releaseBinding();
    const again = makeDeps();
    expect(() => installBinding(again.deps)).not.toThrow();
  });
});

describe("put / drop 的持久化", () => {
  it("put 会落盘，重新装配后读得回来", async () => {
    const { deps, file } = makeDeps();
    const api = installBinding(deps);
    expect(await api.put("s1", record)).toEqual({ ok: true });
    expect(api.revision()).toBe(1);

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      revision: number;
      bindings: Record<string, BindingRecord>;
    };
    expect(onDisk.version).toBe(BINDINGS_VERSION);
    expect(onDisk.revision).toBe(1);
    expect(onDisk.bindings["s1"]).toEqual(record);

    releaseBinding();
    const reopened = installBinding(deps);
    expect(reopened.get("s1")).toEqual(record);
    expect(reopened.revision()).toBe(1);
  });

  it("drop 摘掉绑定并落盘；摘不存在的会话不涨 revision 且不写盘", async () => {
    const { deps, file } = makeDeps();
    const api = installBinding(deps);
    await api.put("s1", record);
    const before = readFileSync(file, "utf8");

    expect(await api.drop("absent")).toEqual({ ok: true });
    expect(api.revision()).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);

    expect(await api.drop("s1")).toEqual({ ok: true });
    expect(api.revision()).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).bindings).toEqual({});
  });

  it("put 空 sessionId 判失败且不落盘", async () => {
    const { deps, file } = makeDeps();
    const api = installBinding(deps);
    const result = await api.put("", record);
    expect(result.ok).toBe(false);
    expect(api.revision()).toBe(0);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });

  it("prune 剪掉不保留的会话", async () => {
    const { deps } = makeDeps();
    const api = installBinding(deps);
    await api.put("s1", record);
    await api.put("s2", record);
    expect(await api.prune((id) => id === "s1")).toEqual({ ok: true });
    expect(Object.keys(api.entries())).toEqual(["s1"]);
  });

  it("并发 put 不丢更新（写盘串行化）", async () => {
    const { deps } = makeDeps();
    const api = installBinding(deps);
    await Promise.all([api.put("s1", record), api.put("s2", record), api.put("s3", record)]);
    expect(Object.keys(api.entries()).sort()).toEqual(["s1", "s2", "s3"]);
    expect(api.revision()).toBe(3);
  });
});

describe("写盘失败", () => {
  it("目标路径不可写时回传原因、内存不前移、并出声", async () => {
    const dir = tempDir("binding");
    dirs.push(dir);
    // 把目标路径的父级做成一个**文件**：mkdir 会 ENOTDIR，原子写在第一步就失败。
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory", "utf8");
    const file = join(blocked, "child", "bindings.json");
    const api = installBinding({
      logger: { warn: (message: string) => warns.push(message) },
      file,
      now: () => "2026-09-14T00:00:00.000Z",
    });
    const result = await api.put("s1", record);
    expect(result.ok).toBe(false);
    expect(api.revision()).toBe(0);
    expect(api.get("s1")).toBeUndefined();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("写盘失败");
  });
});
