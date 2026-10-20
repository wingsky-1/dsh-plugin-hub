/**
 * dsh-mcp-manager — unit：活动目录读取面（组合根 `bindHost` 的 workingDirectory 端口）。
 *
 * 这一组锁的是 #1137 最容易被实现绕过的那条：官方 `WorkingDirectoryService.get()` 是
 * `stateOf(...) ?? defaultDirectory`，而 `defaultDirectory` 兜底 `process.cwd()`——
 * 直接用它会把「投影未记录」悄悄变成进程 cwd，正是语义 A 禁止的隐式退路（F01）。
 * 故组合根只读**原始可空投影**，本组逐条锁它的 fail-closed 判定。
 */
import { describe, expect, it } from "vitest";

const { bindHost } = await import("../../../src/server/shared/interface.ts");

/** 造一个只提供 `get` 的最小 ctx：bindHost 的 workingDirectory 面只经 `ctx.get` 取服务。 */
function ctxWith(service: unknown): Parameters<typeof bindHost>[0] {
  return {
    get: (name: string) => (name === "sessionProjections" ? service : undefined),
  } as unknown as Parameters<typeof bindHost>[0];
}

describe("bindHost().workingDirectory 活动目录读取面（#1137 F01）", () => {
  it("服务缺席 → 端口 undefined（调用方 fail-closed）", () => {
    expect(bindHost(ctxWith(undefined)).workingDirectory()).toBeUndefined();
    expect(bindHost(ctxWith(null)).workingDirectory()).toBeUndefined();
  });

  it("原始投影为绝对路径 → 原样返回（不回落任何默认目录）", () => {
    const face = bindHost(ctxWith({ stateOf: () => "/abs/project" })).workingDirectory();
    expect(face).toBeDefined();
    expect(face?.({ id: "any-session" })).toBe("/abs/project");
  });

  it("投影未记录（null）→ undefined，不回落 process.cwd", () => {
    // 这条是 F01 的核心：官方 get() 在此处会返回 defaultDirectory（兜底 process.cwd）。
    const face = bindHost(ctxWith({ stateOf: () => null })).workingDirectory();
    expect(face?.({ id: "s" })).toBeUndefined();
  });

  it("空白 / 相对路径 → undefined", () => {
    for (const raw of ["", "   ", "relative/path", "./x"]) {
      const face = bindHost(ctxWith({ stateOf: () => raw })).workingDirectory();
      expect(face?.({ id: "s" }), raw).toBeUndefined();
    }
  });

  it("非字符串投影 → undefined", () => {
    for (const raw of [42, true, {}, [], Symbol("x")]) {
      const face = bindHost(ctxWith({ stateOf: () => raw })).workingDirectory();
      expect(face?.({ id: "s" })).toBeUndefined();
    }
  });

  it("session 缺席 → undefined", () => {
    const face = bindHost(ctxWith({ stateOf: () => "/abs" })).workingDirectory();
    expect(face?.(undefined)).toBeUndefined();
    expect(face?.(null)).toBeUndefined();
  });

  it("stateOf 抛错（归属未知）→ undefined，不把异常带给调用方", () => {
    const face = bindHost(
      ctxWith({
        stateOf: () => {
          throw new Error("projection service down");
        },
      }),
    ).workingDirectory();
    expect(face?.({ id: "s" })).toBeUndefined();
  });

  it("按 session 归属取：不同 session 各自的值不串台", () => {
    const sessionA = { id: "A" };
    const sessionB = { id: "B" };
    const table = new Map<unknown, unknown>([
      [sessionA, "/abs/a"],
      [sessionB, "/abs/b"],
    ]);
    const face = bindHost(
      ctxWith({ stateOf: (session: unknown) => table.get(session) }),
    ).workingDirectory();
    expect(face?.(sessionA)).toBe("/abs/a");
    expect(face?.(sessionB)).toBe("/abs/b");
    expect(face?.({ id: "C" })).toBeUndefined();
  });

  it("查询键固定为 workingDirectory（与官方投影键同名）", () => {
    const keys: string[] = [];
    const face = bindHost(
      ctxWith({
        stateOf: (_session: unknown, key: string) => {
          keys.push(key);
          return "/abs";
        },
      }),
    ).workingDirectory();
    face?.({ id: "s" });
    expect(keys).toEqual(["workingDirectory"]);
  });
});
