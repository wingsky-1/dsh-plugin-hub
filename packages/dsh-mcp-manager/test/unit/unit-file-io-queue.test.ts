/**
 * dsh-mcp-manager — unit：同路径写串行（R11 的指定用例）。
 *
 * 并发同路径的可判定判据只有「后写者的内容留在盘上」，而两次 rename 的先后在真实文件系统上
 * 由调度决定。这里只拦 `writeFile` 的**一拍**：第一次写挂起不返回，第二次写若越过队列就会
 * 自己跑完 writeFile + rename。挂起放行后，盘上留下的即后写者（有队列）/ 先写者（无队列）
 * ——去掉队列这条用例必然判红，不是装饰。除这一拍外，mkdir / writeFile / rename / 读取都是
 * 真实文件系统。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFile, writeFileAtomic } from "../../src/server/shared/interface.ts";

/** 挂起闸门：state.held 为真时，下一次 writeFile 等 release() 放行。 */
const gate = vi.hoisted(() => {
  const state = { calls: 0, held: false, release: (): void => {} };
  const released = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  return { state, released };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      gate.state.calls += 1;
      if (gate.state.held) {
        gate.state.held = false;
        await gate.released;
      }
      return actual.writeFile(...args);
    },
  };
});

/** 轮询直到谓词为真；用于等「第一次 writeFile 已被调用」。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待 writeFile 调用超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** 谁先到算谁：写已完成，或等待窗口耗尽。 */
async function settleOrWait(pending: Promise<void>, ms: number): Promise<void> {
  await Promise.race([
    pending.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

describe("同路径并发写", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dsh-mcp-queue-"));
    previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    gate.state.calls = 0;
    gate.state.held = false;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("两次并发写同一路径，盘上留下的是后写者", async () => {
    const target = configFile();
    gate.state.held = true;
    const first = writeFileAtomic(target, "first");
    await waitFor(() => gate.state.calls === 1);
    const second = writeFileAtomic(target, "second");
    // 有队列：second 排在 first 之后，这里只会等满窗口；无队列：second 当场写完 rename。
    await settleOrWait(second, 300);
    gate.state.release();
    await Promise.all([first, second]);
    expect(readFileSync(target, "utf8")).toBe("second");
  });
});
