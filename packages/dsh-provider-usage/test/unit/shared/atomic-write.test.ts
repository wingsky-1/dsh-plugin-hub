/**
 * dsh-provider-usage — unit：包内原子写原语（temporaryNameFor / atomicWrite）。
 *
 * 为什么单独一份：`atomicWrite` 是 11 处 tmp+rename 的唯一实现（#P1-3 统一），
 * 它改一个字就同时改 11 个落点的落盘行为。统一之前那 6 处弱形态临时名（只有 Date.now()）
 * 从未有过任何针对**失败清理**路径的判据——catch 里的 `rm` 删掉不会有任何测试红。
 * 本文件把那条分支钉住。
 *
 * 失败注入不用 mock：`rename(tmp, <已存在的目录>)` 在 POSIX 下必以 EISDIR 失败，
 * 这是真实失败而非假装的异常，比 spyOn 更能证明清理路径真的走通。
 * 落盘一律进 `mkdtempSync` 的隔离目录（#218 产物零污染）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, temporaryNameFor } from "../../../src/shared/interface.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pu-atomic-write-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("temporaryNameFor：唯一性", () => {
  it("同一毫秒内两次调用不重名（旧形态只有 Date.now()，同毫秒必然撞）", () => {
    // 连续调用若干次，收集全部临时名。pid 与 Date.now() 在同一毫秒内都可能相同，
    // 唯一能区分的是 12 hex 随机后缀——它不存在时这组断言必红。
    const names = new Set<string>();
    for (let i = 0; i < 200; i += 1) names.add(temporaryNameFor("/x/y.jsonl"));
    expect(names.size).toBe(200);
  });

  it("临时名仍落在目标同目录（rename 才能保持原子性，跨设备 rename 会 EXDEV）", () => {
    const name = temporaryNameFor(join(root, "day.jsonl"));
    expect(name.startsWith(join(root, "day.jsonl") + ".")).toBe(true);
    expect(name.endsWith(".tmp")).toBe(true);
  });
});

describe("atomicWrite：成功路径", () => {
  it("写入内容并落成目标文件，权限 0600，且不留下 .tmp 残留", async () => {
    const file = join(root, "day.jsonl");
    await atomicWrite(file, "payload\n");

    expect(readdirSync(root)).toEqual(["day.jsonl"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(true);
  });

  it("覆盖既有目标文件（rename 语义替换，不追加）", async () => {
    const file = join(root, "day.jsonl");
    await atomicWrite(file, "first\n");
    await atomicWrite(file, "second\n");
    expect(readdirSync(root)).toEqual(["day.jsonl"]);
  });
});

/**
 * 本文件的核心判据。catch 里的 `rm(temporary, { force: true })` 是这 11 处落点
 * 「失败不留残留」承诺的唯一实现点，删掉它本用例即红。
 */
describe("atomicWrite：失败路径清理（catch 分支的判据）", () => {
  it("rename 失败（目标是已存在的目录 → EISDIR）时删除临时文件并把原错误上抛", async () => {
    const target = join(root, "day.jsonl");
    mkdirSync(target); // rename(tmp, <目录>) 在 POSIX 下以 EISDIR 失败——真实失败，非 mock

    await expect(atomicWrite(target, "payload\n")).rejects.toThrow();

    // 断言 1：临时文件已被清理。删掉 atomicWrite 里的 rm(...) 这一行，本断言即红。
    expect(readdirSync(root)).toEqual(["day.jsonl"]);
    expect(readdirSync(root).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("清理失败不覆盖原错误：调用方拿到的是写入失败的原因，不是清理失败的原因", async () => {
    const target = join(root, "day.jsonl");
    mkdirSync(target);

    // 原错误是 rename 的那个 EISDIR；若实现写成 await rm(...) 而不 catch，
    // 这里的 rejected 会变成 rm 的错误，断言即红。
    const error = await atomicWrite(target, "payload\n").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  it("连续两次失败各自清理，残留不累积（旧形态同毫秒共用 tmp 时会被自己截断）", async () => {
    const a = join(root, "a.jsonl");
    const b = join(root, "b.jsonl");
    mkdirSync(a);
    mkdirSync(b);

    await expect(atomicWrite(a, "1\n")).rejects.toThrow();
    await expect(atomicWrite(b, "2\n")).rejects.toThrow();

    expect(readdirSync(root).sort()).toEqual(["a.jsonl", "b.jsonl"]);
  });
});
