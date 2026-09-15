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
import * as bindingApi from "../../src/server/binding/interface.ts";
import { BINDINGS_VERSION, type BindingRecord } from "../../src/server/binding/interface.ts";
import { cleanup, tempDir } from "../helpers.ts";

const record: BindingRecord = {
  repoRoot: "/repo",
  worktreeRoot: "/wt",
  branch: "feature",
  createdAt: "2026-09-14T00:00:00.000Z",
  sessionCreatedAt: 1_700_000_000_000,
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
    },
  };
}

afterEach(async () => {
  // 先释放再删目录：release 会等在飞的写盘落定，反过来的话那次写会把刚删掉的目录又建回来。
  await bindingApi.releaseBinding();
  for (const dir of dirs.splice(0)) cleanup(dir);
  warns.splice(0);
});

describe("installBinding", () => {
  it("文件不存在时从空表起（首次使用不该报错）", () => {
    const { deps } = makeDeps();
    bindingApi.installBinding(deps);
    expect(bindingApi.revision()).toBe(0);
    expect(bindingApi.get("s1")).toBeUndefined();
  });

  it("损坏文件回落空表而不是抛异常", () => {
    const { deps, file } = makeDeps();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ 半个 json", "utf8");
    bindingApi.installBinding(deps);
    expect(bindingApi.revision()).toBe(0);
    expect(bindingApi.get("s1")).toBeUndefined();
  });

  it("第二次装配当场抛错，不静默建成第二份状态", () => {
    bindingApi.installBinding(makeDeps().deps);
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => bindingApi.installBinding(makeDeps().deps)).toThrow(
      "dsh-worktree-sidebar: binding 域只能装配一次",
    );
  });

  it("release 等在飞的写盘落定，重新装配读到磁盘现状", async () => {
    const { deps, file } = makeDeps();
    bindingApi.installBinding(deps);
    const pending = bindingApi.put("s1", record);
    // release 是这一片的关键承诺：它在飞的那次写必须在它返回之前落盘。
    await bindingApi.releaseBinding();
    expect(JSON.parse(readFileSync(file, "utf8")).bindings["s1"]).toEqual(record);
    await pending;

    // 重新装配必须**重新读盘**：读到的是磁盘现状，不是上一代留下的内存快照。
    bindingApi.installBinding(deps);
    expect(bindingApi.get("s1")).toEqual(record);
    expect(bindingApi.revision()).toBe(1);
  });

  it("release 撞上下一代 install：上一代的尾部清理不许抹掉新代读回来的表", async () => {
    const { deps } = makeDeps();
    bindingApi.installBinding(deps);
    await bindingApi.put("s1", record);

    // 让写盘链有一条在飞的写，然后立刻 release：它要 await 的正是这条链。
    const writing = bindingApi.put("s2", { ...record, worktreeRoot: "/wt2" });
    const releasing = bindingApi.releaseBinding();
    // release 还挂在 await 上：这一代已经装上并从磁盘读回了表。尾部若无条件清表，就会把它抹成空表，
    // 随后一次 put 会把空表写回磁盘、丢掉所有会话的登记。
    bindingApi.installBinding(deps);
    await Promise.all([writing, releasing]);

    expect(bindingApi.get("s2")).toEqual({ ...record, worktreeRoot: "/wt2" });
  });

  it("release 之后能力面当场失败，不拿旧 deps 出结果", () => {
    bindingApi.installBinding(makeDeps().deps);
    bindingApi.releaseBinding();
    expect(() => bindingApi.revision()).toThrow("dsh-worktree-sidebar: binding 域尚未装配");
  });
});

describe("put / drop 的持久化", () => {
  it("put 会落盘，重新装配后读得回来", async () => {
    const { deps, file } = makeDeps();
    bindingApi.installBinding(deps);
    expect(await bindingApi.put("s1", record)).toEqual({ ok: true });
    expect(bindingApi.revision()).toBe(1);

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      revision: number;
      bindings: Record<string, BindingRecord>;
    };
    expect(onDisk.version).toBe(BINDINGS_VERSION);
    expect(onDisk.revision).toBe(1);
    expect(onDisk.bindings["s1"]).toEqual(record);

    // 释放后重新装配 = 重新读盘（没有跨装配共享的内存表需要先丢掉）。
    await bindingApi.releaseBinding();
    bindingApi.installBinding(deps);
    expect(bindingApi.get("s1")).toEqual(record);
    expect(bindingApi.revision()).toBe(1);
  });

  it("drop 摘掉绑定并落盘；摘不存在的会话不涨 revision 且不写盘", async () => {
    const { deps, file } = makeDeps();
    bindingApi.installBinding(deps);
    await bindingApi.put("s1", record);
    const before = readFileSync(file, "utf8");

    expect(await bindingApi.drop("absent")).toEqual({ ok: true });
    expect(bindingApi.revision()).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);

    expect(await bindingApi.drop("s1")).toEqual({ ok: true });
    expect(bindingApi.revision()).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).bindings).toEqual({});
  });

  it("put 空 sessionId 判失败且不落盘", async () => {
    const { deps, file } = makeDeps();
    bindingApi.installBinding(deps);
    const result = await bindingApi.put("", record);
    expect(result.ok).toBe(false);
    expect(bindingApi.revision()).toBe(0);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });

  it("并发 put 不丢更新（写盘串行化）", async () => {
    const { deps } = makeDeps();
    bindingApi.installBinding(deps);
    await Promise.all([
      bindingApi.put("s1", record),
      bindingApi.put("s2", record),
      bindingApi.put("s3", record),
    ]);
    expect(["s1", "s2", "s3"].map((id) => bindingApi.get(id))).toEqual([record, record, record]);
    expect(bindingApi.revision()).toBe(3);
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
    bindingApi.installBinding({
      logger: { warn: (message: string) => warns.push(message) },
      file,
    });
    const result = await bindingApi.put("s1", record);
    expect(result.ok).toBe(false);
    expect(bindingApi.revision()).toBe(0);
    expect(bindingApi.get("s1")).toBeUndefined();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("写盘失败");
  });
});
