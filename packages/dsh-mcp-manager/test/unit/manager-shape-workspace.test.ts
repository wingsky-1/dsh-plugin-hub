/** Manager 方法面的自然职责测试与专属fixture。 */

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { fakeToolsService } from "../helpers.ts";

import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";

import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  findProjectRoot,
  inRootSandbox,
  installPoolLifecycle,
  makeTempDir,
  managerFixture,
  McpMiddleware,
  normalizedProjectRoot,
  setPoolToolsView,
  setupManagerTestLifecycle,
} from "./manager-shape-support.ts";

setupManagerTestLifecycle();

describe("findProjectRoot", () => {
  /** 沙箱顶棚：dir/.git 必先命中，防止向上逸出到真实仓库/真实家目录。 */
  async function withSandbox(body: (dir: string, fakeHome: string) => unknown) {
    return inRootSandbox(async (dir: string) => {
      mkdirSync(join(dir, ".git"), { recursive: true });
      const fakeHome = join(dir, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      return body(dir, fakeHome);
    });
  }

  it(".git 标记命中", async () => {
    await withSandbox(async (dir: string) => {
      const gitProj = join(dir, "git-proj");
      mkdirSync(join(gitProj, ".git"), { recursive: true });
      expect(await findProjectRoot(gitProj)).toBe(gitProj);
    });
  });

  it(".mcp.json 标记命中", async () => {
    await withSandbox(async (dir: string) => {
      const mcpProj = join(dir, "mcp-proj");
      mkdirSync(mcpProj, { recursive: true });
      writeFileSync(join(mcpProj, ".mcp.json"), "{}");
      expect(await findProjectRoot(mcpProj)).toBe(mcpProj);
    });
  });

  it(".dsh 非 home 标记命中", async () => {
    await withSandbox(async (dir: string) => {
      const dshProj = join(dir, "dsh-proj");
      mkdirSync(join(dshProj, ".dsh"), { recursive: true });
      expect(await findProjectRoot(dshProj)).toBe(dshProj);
    });
  });

  it("全局家不算项目标记", async () => {
    // 全局家排除：模拟 ~ 下含 .dsh（= DSH_HOME），其子目录向上命中家级 .dsh 应跳过，
    // 继续向上命中顶棚 dir/.git（若误判家级 .dsh 为项目标记则返回 fake-user-home）。
    await withSandbox(async (dir: string) => {
      const fakeUserHome = join(dir, "fake-user-home");
      const fakeDshHome = join(fakeUserHome, ".dsh");
      mkdirSync(fakeDshHome, { recursive: true });
      process.env.DSH_HOME = fakeDshHome;
      const inHome = join(fakeUserHome, "sub");
      mkdirSync(inHome, { recursive: true });
      expect(await findProjectRoot(inHome)).toBe(dir);
    });
  });

  it("家目录自身不算项目标记", async () => {
    // cwd 恰为家目录本身：家级 .dsh 不算自身标记 → 越过它命中顶棚。
    await withSandbox(async (dir: string) => {
      const fakeUserHome = join(dir, "fake-user-home");
      const fakeDshHome = join(fakeUserHome, ".dsh");
      mkdirSync(fakeDshHome, { recursive: true });
      process.env.DSH_HOME = fakeDshHome;
      expect(await findProjectRoot(fakeDshHome)).toBe(dir);
    });
  });

  it("无标记普通目录向上命中顶棚", async () => {
    await withSandbox(async (dir: string) => {
      const plain = join(dir, "plain");
      mkdirSync(plain, { recursive: true });
      expect(await findProjectRoot(plain)).toBe(dir);
    });
  });

  it("16 级窗口内无标记 → 回落 cwd", async () => {
    // 回落 cwd：输入嵌套 16 级，向上窗口（16 层）不出沙箱、够不到任何标记 → 原样返回。
    await withSandbox(async (dir: string) => {
      let deep = dir;
      for (let i = 0; i < 16; i += 1) deep = join(deep, `d${i}`);
      mkdirSync(deep, { recursive: true });
      expect(await findProjectRoot(deep)).toBe(deep);
    });
  });

  it("undefined cwd → process.cwd() 兜底", async () => {
    await withSandbox(async () => {
      const fallback = await findProjectRoot(undefined);
      expect(typeof fallback).toBe("string");
    });
  });
});

// #770 B2：symlink 双拼写收敛到同一项目根 ----
describe("#770 B2：symlink 双拼写收敛到同一项目根", () => {
  /** 双拼写夹具：real-proj（.git 真实标记）+ link-proj（目录 symlink）。
   *  落盘全在 mkdtemp 内，afterEach 经 rmSync 收口，不留产物。 */
  async function symlinkFixture(
    body: (args: {
      base: string;
      realProj: string;
      linkProj: string;
      realCwd: string;
      linkCwd: string;
    }) => unknown,
  ) {
    const prevHome = process.env.DSH_HOME;
    const base = makeTempDir("dsh-mcp-symlink-");
    try {
      const fakeHome = join(base, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      const realProj = join(base, "real-proj");
      mkdirSync(join(realProj, ".git"), { recursive: true });
      mkdirSync(join(realProj, "sub"), { recursive: true });
      const linkProj = join(base, "link-proj");
      symlinkSync(realProj, linkProj, "dir");
      return await body({
        base,
        realProj,
        linkProj,
        realCwd: join(realProj, "sub"),
        linkCwd: join(linkProj, "sub"),
      });
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  }

  it("symlink 拼写仍发现同一项目", async () => {
    await symlinkFixture(async ({ realProj, linkCwd }) => {
      // 两侧 realpath 对比：发现透过 symlink 不丢标记，只拼写不同。
      expect(realpathSync(await findProjectRoot(linkCwd))).toBe(realpathSync(realProj));
    });
  });

  it("双拼写 normalizedProjectRoot 相等且为 real 路径", async () => {
    await symlinkFixture(async ({ realProj, realCwd, linkCwd }) => {
      const fromReal = await normalizedProjectRoot(realCwd);
      const fromLink = await normalizedProjectRoot(linkCwd);
      expect(fromLink).toBe(fromReal);
      expect(fromLink).toBe(realpathSync(realProj));
    });
  });

  it("双拼写 projectStoreFor 同一实例", async () => {
    await symlinkFixture(async ({ realCwd, linkCwd }) => {
      const { manager } = managerFixture("dsh-mcp-symlink-store-");
      const rootA = await normalizedProjectRoot(realCwd);
      const rootB = await normalizedProjectRoot(linkCwd);
      const first = await manager.projectStoreFor(rootA);
      const second = await manager.projectStoreFor(rootB);
      // 反证：realpath 换回 resolve 则两侧键不同，toBe 红。
      expect(second).toBe(first);
    });
  });

  it("双拼写 projectUnitFor 只建一个单元", async () => {
    await symlinkFixture(async ({ realCwd, linkCwd }) => {
      installPoolLifecycle();
      const tools = fakeToolsService({});
      setPoolToolsView(() => tools.schemas());
      const host = {
        ctx: { tools },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        projectServersFor: async () => [],
        globalServers: () => [],
        normalizedProjectRoot: async (cwd: string | undefined) =>
          typeof cwd === "string" && cwd !== "" ? cwd : undefined,
        saveUserState: async () => {},
        emitStatus: () => {},
        catalogCachePath: (root: string) => join(root, ".dsh-mcp-symlink-test.json"),
      };
      const rootA = await normalizedProjectRoot(realCwd);
      const rootB = await normalizedProjectRoot(linkCwd);
      const mw = new McpMiddleware(host as unknown as MiddlewareHost);
      try {
        const unitA = await mw.projectUnitFor(rootA);
        const unitB = await mw.projectUnitFor(rootB);
        // 反证：realpath 换回 resolve 则建出两个单元，size 红。
        expect(unitB).toBe(unitA);
        expect(mw.units.size).toBe(1);
      } finally {
        if (rootA !== undefined) catalogDirectory.dropRoot(rootA);
        try {
          await mw.dispose();
        } catch {
          // 收口失败不掩盖用例结论
        }
      }
    });
  });

  it("不存在 cwd 回退不抛", async () => {
    const prevHome = process.env.DSH_HOME;
    const base = makeTempDir("dsh-mcp-symlink-missing-");
    try {
      const fakeHome = join(base, "fake-home");
      mkdirSync(join(fakeHome, ".dsh"), { recursive: true });
      process.env.DSH_HOME = fakeHome;
      // 16 级窗口内无标记：findProjectRoot 回落不存在路径，realpath 抛错由 catch 接住。
      let missing = base;
      for (let i = 0; i < 16; i += 1) missing = join(missing, `d${i}`);
      // 反证：catch 删掉则此处抛 ENOENT 红。
      await expect(normalizedProjectRoot(missing)).resolves.toBe(resolve(missing));
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });
});
