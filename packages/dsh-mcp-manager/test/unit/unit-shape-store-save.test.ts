/**
 * dsh-mcp-manager — unit：store 落盘域（save / tmp 残留 / 串行冲突 / Windows rename 重试）。
 *
 * 自然职责拆分（#1174 阶段 2 形状清债）：落盘与 rename 重试是**独立职责**——只碰文件写面与
 * fs.promises 接缝，与构造器/load/CRUD/条目清洗域无共享断言面。原与那些域同处一个 887 行
 * 文件（挂账 max-lines + max-lines-per-function 两条），故整块迁到本文件；describe 标题沿用
 * 原名，fullName 不变。
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { unitShapeErrno, unitShapeWithRenamePort } from "./unit-shape-store-support.ts";

// I8 导入面收窄：store 域门面直引，不经包根组合根。
const { McpStore } = await import("../../src/server/store/interface.ts");

let tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("B17：save 失败时 tmp 残留必须清理", () => {
  function victimFixture() {
    const dir = tempDir();
    // rename 目标为已存在目录 → EISDIR，注入写入失败路径
    const victimPath = join(dir, "victim");
    mkdirSync(victimPath);
    const store = new McpStore(victimPath);
    store.data = {
      version: 1,
      servers: [{ name: "s1", transport: "stdio", command: "echo", enabled: true }],
    };
    return { victimPath, store };
  }

  it("save 失败应上抛", async () => {
    const { store } = victimFixture();
    await expect(store.save()).rejects.toThrow(/EISDIR|ENOTEMPTY|EEXIST|EPERM|ENOTDIR/);
  });

  it("B17：save 失败后真名 tmp 残留应清理（#903 M-store：旧断言查从未创建过的名字，空转）", async () => {
    const { victimPath, store } = victimFixture();
    const dir = victimPath.slice(0, victimPath.lastIndexOf("/"));
    await store.save().catch(() => {});
    // 真残留名前缀 = <path>.tmp.（pid.时间戳[.随机].tmp）：目录枚举断言，而非查固定名。
    const leftovers = readdirSync(dir).filter((name) => name.startsWith("victim.tmp."));
    expect(leftovers).toEqual([]);
  });
});

describe("save 串行与冲突（#903）", () => {
  function twoStoresSamePath() {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "a", transport: "stdio", command: "echo" }] }),
    );
    return { dir, path };
  }

  it("同实例并发双 save 都成功且内容正确", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    store.upsert({ name: "b", transport: "stdio", command: "x" });
    await Promise.all([store.save(), store.save()]);
    expect(
      JSON.parse(await readFile(path, "utf8"))
        .servers.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("同毫秒改内容 → changedOnDisk true（全文快照第二道锁）", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    const base = statSync(path);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "c", transport: "stdio", command: "y" }] }),
    );
    // 把 mtime 压回基线：纯 mtime 口径会漏检，快照必须兜住。
    utimesSync(path, base.atime, base.mtime);
    expect(await store.changedOnDisk()).toBe(true);
  });

  it("外部变更后 save fail-closed 抛错（不静默覆盖）", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "ext", transport: "stdio", command: "z" }] }),
    );
    store.upsert({ name: "mine", transport: "stdio", command: "m" });
    await expect(store.save()).rejects.toThrow(/外部被修改/);
    // 外部内容原样保留：
    expect(JSON.parse(await readFile(path, "utf8")).servers[0].name).toBe("ext");
  });

  it("reload 后 save 不再冲突", async () => {
    const { path } = twoStoresSamePath();
    const store = new McpStore(path);
    await store.load();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, servers: [{ name: "ext", transport: "stdio", command: "z" }] }),
    );
    await store.reloadIfChanged();
    store.upsert({ name: "mine", transport: "stdio", command: "m" });
    await store.save();
    expect(
      JSON.parse(await readFile(path, "utf8"))
        .servers.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["ext", "mine"]);
  });
});

function registerWindowsRenameRetryCases() {
  it.each(["EPERM", "EBUSY"] as const)(
    "%s 后复用同一 tmp 成功替换，真实磁盘与基线同步",
    async (code) => {
      const dir = tempDir();
      const path = join(dir, "mcp.json");
      const store = new McpStore(path);
      store.upsert({ name: "saved", transport: "stdio", command: "echo" });
      const expected = JSON.stringify(store.data, null, 2);
      let calls = 0;
      const tmpPaths: Parameters<typeof fs.promises.rename>[0][] = [];
      let firstFailure!: () => void;
      const failedOnce = new Promise<void>((resolve) => {
        firstFailure = resolve;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await unitShapeWithRenamePort(
        "win32",
        async (from, to, original) => {
          calls += 1;
          tmpPaths.push(from);
          if (calls === 1) {
            firstFailure();
            throw unitShapeErrno(code);
          }
          await original(from, to);
        },
        async () => {
          const saving = store.save();
          await failedOnce;
          const staged = readdirSync(dir).filter((name) => name.startsWith("mcp.json.tmp."));
          expect(staged.length).toBe(1);
          await vi.advanceTimersByTimeAsync(50);
          await saving;
          expect(calls).toBe(2);
          expect(tmpPaths[0]).toBe(tmpPaths[1]);
          expect(await readFile(path, "utf8")).toBe(expected);
          expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(store.snapshot).toBe(expected);
          expect(store.mtimeMs).toBe(statSync(path).mtimeMs);
          expect(readdirSync(dir).filter((name) => name.startsWith("mcp.json.tmp."))).toEqual([]);
        },
      );
    },
  );

  it("最多重试五次后抛出最后一个原始 EPERM 并清理 tmp", async () => {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    const store = new McpStore(path);
    const errors: Error[] = [];
    let calls = 0;
    let firstFailure!: () => void;
    const failedOnce = new Promise<void>((resolve) => {
      firstFailure = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await unitShapeWithRenamePort(
      "win32",
      async () => {
        calls += 1;
        const error = unitShapeErrno("EPERM", `attempt ${calls}`);
        errors.push(error);
        if (calls === 1) firstFailure();
        throw error;
      },
      async () => {
        const saving = store.save().catch((error: unknown) => error);
        await failedOnce;
        for (let retry = 0; retry < 5; retry += 1) {
          const delay = [50, 100, 150, 200, 250][retry];
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(calls).toBe(retry + 1);
          await vi.advanceTimersByTimeAsync(1);
          expect(calls).toBe(retry + 2);
        }
        const error = await saving;
        expect(error).toBe(errors[5]);
        expect(calls).toBe(6);
        expect(readdirSync(dir).filter((name) => name.startsWith("mcp.json.tmp."))).toEqual([]);
      },
    );
  });

  it.each([
    ["linux", "EPERM"],
    ["darwin", "EBUSY"],
    ["win32", "EACCES"],
  ] as const)("%s 的 %s 立即原样失败", async (platform, code) => {
    const dir = tempDir();
    const store = new McpStore(join(dir, "mcp.json"));
    const originalError = unitShapeErrno(code);
    let calls = 0;
    await unitShapeWithRenamePort(
      platform,
      async () => {
        calls += 1;
        throw originalError;
      },
      async () => {
        await expect(store.save()).rejects.toBe(originalError);
        expect(calls).toBe(1);
        expect(readdirSync(dir).filter((name) => name.startsWith("mcp.json.tmp."))).toEqual([]);
      },
    );
  });
}

function registerWindowsRenameTerminalErrorCases() {
  it("终端 rename 错误与 tmp 清理错误并发时仍上抛原 rename 错误对象", async () => {
    const dir = tempDir();
    const store = new McpStore(join(dir, "mcp.json"));
    const renameError = unitShapeErrno("EACCES", "terminal rename error");
    const cleanupError = unitShapeErrno("EPERM", "temporary cleanup error");
    let tmpPath: Parameters<typeof fs.promises.rename>[0] | undefined;
    let rmCalls = 0;
    const originalRm = fs.promises.rm;
    const originalPlatform = process.platform;
    await unitShapeWithRenamePort(
      "linux",
      async (from) => {
        tmpPath = from;
        throw renameError;
      },
      async () => {
        await expect(store.save()).rejects.toBe(renameError);
        expect(rmCalls).toBe(1);
      },
      async (_path, _options) => {
        rmCalls += 1;
        throw cleanupError;
      },
    );
    expect(fs.promises.rm).toBe(originalRm);
    expect(process.platform).toBe(originalPlatform);
    if (tmpPath === undefined) throw new Error("rename port did not receive a tmp path");
    await fs.promises.rm(tmpPath, { force: true });
    mkdirSync(store.path);
    await expect(store.save()).rejects.toThrow();
    expect(readdirSync(dir).filter((name) => name.startsWith("mcp.json.tmp."))).toEqual([]);
  });

  it("等待期间同实例 reload 更新基线也不能让重试覆盖外部全文", async () => {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    const baselineTimeSeconds = 1_700_000_000;
    writeFileSync(path, JSON.stringify({ version: 1, servers: [{ name: "before" }] }));
    utimesSync(path, baselineTimeSeconds, baselineTimeSeconds);
    const store = new McpStore(path);
    await store.load();
    const baseline = statSync(path);
    expect(store.mtimeMs).toBe(baseline.mtimeMs);
    const external = JSON.stringify({ version: 1, servers: [{ name: "external" }] });
    store.upsert({ name: "mine", transport: "stdio", command: "mine" });
    let renameCalls = 0;
    let firstFailure!: () => void;
    const failedOnce = new Promise<void>((resolve) => {
      firstFailure = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await unitShapeWithRenamePort(
      "win32",
      async (from, to, original) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          firstFailure();
          throw unitShapeErrno("EBUSY");
        }
        await original(from, to);
      },
      async () => {
        const saving = store.save();
        await failedOnce;
        writeFileSync(path, external);
        utimesSync(path, baselineTimeSeconds, baselineTimeSeconds);
        expect(statSync(path).mtimeMs).toBe(store.mtimeMs);
        await expect(store.reloadIfChanged()).resolves.toBe(true);
        expect(store.data.servers.map((server) => server.name)).toEqual(["external"]);
        expect(store.snapshot).toBe(external);
        await vi.advanceTimersByTimeAsync(50);
        await expect(saving).rejects.toThrow(/外部被修改/);
        expect(renameCalls).toBe(1);
        expect(await readFile(path, "utf8")).toBe(external);
        expect(store.data.servers.map((server) => server.name)).toEqual(["external"]);
        expect(store.snapshot).toBe(external);
        expect(store.mtimeMs).toBe(statSync(path).mtimeMs);
        expect(readdirSync(dir).filter((name) => name.startsWith("mcp.json.tmp."))).toEqual([]);
      },
    );
  });
}

function registerWindowsRenameQueueRecoveryCases() {
  it("重试等待期间同路径后续 save 排队；前次失败后队列可恢复", async () => {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    const store = new McpStore(path);
    store.upsert({ name: "first", transport: "stdio", command: "1" });
    const firstPayload = JSON.stringify(store.data, null, 2);
    let calls = 0;
    let firstFailure!: () => void;
    let thirdAttempt!: () => void;
    const thirdAttemptStarted = new Promise<void>((resolve) => {
      thirdAttempt = resolve;
    });
    const failedOnce = new Promise<void>((resolve) => {
      firstFailure = resolve;
    });
    const attemptedPayloads: string[] = [];
    const events: string[] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await unitShapeWithRenamePort(
      "win32",
      async (from, to, original) => {
        calls += 1;
        attemptedPayloads.push(await readFile(from, "utf8"));
        if (calls === 1) {
          firstFailure();
          throw unitShapeErrno("EPERM");
        }
        if (calls === 3) {
          events.push("second-save-started");
          thirdAttempt();
        }
        await original(from, to);
        if (calls === 2) events.push("first-save-renamed");
      },
      async () => {
        const firstSave = store.save();
        await failedOnce;
        store.upsert({ name: "second", transport: "stdio", command: "2" });
        const secondPayload = JSON.stringify(store.data, null, 2);
        const secondSave = store.save();
        await vi.advanceTimersByTimeAsync(50);
        await thirdAttemptStarted;
        await Promise.all([firstSave, secondSave]);
        expect(calls).toBe(3);
        expect(attemptedPayloads).toEqual([firstPayload, firstPayload, secondPayload]);
        expect(events).toEqual(["first-save-renamed", "second-save-started"]);
        expect(
          JSON.parse(await readFile(path, "utf8")).servers.map(
            (item: { name: string }) => item.name,
          ),
        ).toEqual(["first", "second"]);
      },
    );
  });

  it("非重试失败后，同路径下一次 save 仍可执行", async () => {
    const dir = tempDir();
    const path = join(dir, "mcp.json");
    const store = new McpStore(path);
    let calls = 0;
    await unitShapeWithRenamePort(
      "linux",
      async (from, to, original) => {
        calls += 1;
        if (calls === 1) throw unitShapeErrno("EACCES");
        await original(from, to);
      },
      async () => {
        await expect(store.save()).rejects.toThrow(/injected EACCES/);
        store.upsert({ name: "recovered", transport: "stdio", command: "echo" });
        await store.save();
        expect(calls).toBe(2);
        expect(JSON.parse(await readFile(path, "utf8")).servers[0].name).toBe("recovered");
      },
    );
  });
}
describe("Windows rename 暂时占用重试", () => {
  registerWindowsRenameRetryCases();
  registerWindowsRenameTerminalErrorCases();
  registerWindowsRenameQueueRecoveryCases();
});

describe("S2-b：save 取 mode 表 + 显式路径回落", () => {
  it("显式任意路径 save 照常写盘且 mode 0o600（锁住回落兼容）", async () => {
    const dir = tempDir();
    // 不在 mode 登记表的任意路径（用户 storePath 显式接管）：回落既有 0o600。
    const path = join(dir, "custom-arbitrary.json");
    const store = new McpStore(path);
    store.upsert({ name: "s", transport: "stdio", command: "echo" });
    await store.save();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).servers[0].name).toBe("s");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("项目级新形态路径 save 落 null 口径（file-io 层已覆盖 null 写面，此处只锁登记 + 落盘成功）", async () => {
    const { projectConfigFile, fileMode } = await import("../../src/server/shared/interface.ts");
    const dir = tempDir();
    const projPath = projectConfigFile(join(dir, "proj"));
    expect(fileMode(projPath)).toBeNull();
    const store = new McpStore(projPath);
    store.upsert({ name: "p", transport: "stdio", command: "echo" });
    await store.save();
    expect(existsSync(projPath)).toBe(true);
    expect(JSON.parse(await readFile(projPath, "utf8")).servers[0].name).toBe("p");
  });
});
