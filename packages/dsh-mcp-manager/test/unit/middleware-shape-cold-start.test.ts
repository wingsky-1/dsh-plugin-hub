/**
 * dsh-mcp-manager middleware unit：cold-start 职责分片。
 *
 * 组合端口在本文件显式装卸；fixture、池清理与临时资源由 middleware-shape-support.ts 收口。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import {
  McpMiddleware,
  coldStartShape,
  gate,
  makeHost,
  makeUnit,
  registeredTools,
  remoteEntry,
  trackMw,
  virtualServer,
} from "./middleware-shape-cold-start-fixture.ts";
import { registerColdStartLatestConfigCases } from "./middleware-shape-cold-start-latest-config.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
import type { ServerConfig } from "../../src/server/config/interface.ts";

beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");

afterEach(async () => {
  await coldStartShape.cleanup();
});

function registerColdStartInFlightConfigReadCases() {
  it("连接配置读取在途时 inFlight 已登记，list/search/detail 等待后返回完整目录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-cold-read-"));
    const root = join(dir, "project");
    const server = virtualServer("cold-start ping");
    const connectionConfigGate = gate();
    let rootConfigReads = 0;
    let entered!: () => void;
    const enteredConnectionRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { host } = makeHost(new Map([[root, [server]]]));
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      rootConfigReads += 1;
      if (rootConfigReads === 2) {
        entered();
        await connectionConfigGate.promise;
      }
      return [server];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const definitions = registeredTools(mw, host, root);
    const list = definitions.find((definition) => definition.name === "ws_mcp_list")!;
    const search = definitions.find((definition) => definition.name === "ws_mcp_search")!;
    const detail = definitions.find((definition) => definition.name === "ws_mcp_detail")!;
    const exec = {
      agent: {},
      signal: new AbortController().signal,
    } as unknown as ToolRunContext;
    const fullName = fullServerName(root, "echo");
    let pendingReads: Array<Promise<unknown>> = [];

    try {
      const unit = await mw.projectUnitFor(root);
      await enteredConnectionRead;
      expect(unit).toBeDefined();
      expect([...unit!.inFlight.keys()]).toEqual(["echo"]);

      pendingReads = [
        list.execute({ perServerLimit: 50 }, exec),
        search.execute({ query: "ping", limit: 10 }, exec),
        detail.execute({ server: fullName, tool: "ping" }, exec),
      ];
      let settled = 0;
      for (const pending of pendingReads) {
        void pending.then(
          () => {
            settled += 1;
          },
          () => {
            settled += 1;
          },
        );
      }
      await Promise.resolve();
      expect(settled).toBe(0);

      connectionConfigGate.release();
      const [listed, searched, detailed] = await Promise.all(pendingReads);
      expect(
        (listed as { servers: Array<{ server: string }> }).servers.map((item) => item.server),
      ).toEqual([fullName]);
      expect(
        (searched as { results: Array<{ server: string; tool: string }> }).results.map(
          (item) => `${item.server}/${item.tool}`,
        ),
      ).toEqual([`${fullName}/ping`]);
      expect(detailed).toMatchObject({ server: fullName, tool: "ping" });
    } finally {
      connectionConfigGate.release();
      await Promise.allSettled(pendingReads);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartSharedInitializationCases() {
  it("同根并发首次初始化共享一次配置读取和同一 unit/connections 所有权", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-shared-init-"));
    const root = join(dir, "project");
    const configGate = gate();
    let reads = 0;
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      reads += 1;
      entered();
      await configGate.promise;
      return [];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    let first: Promise<ProjectUnit | undefined> | undefined;
    let second: Promise<ProjectUnit | undefined> | undefined;

    try {
      first = mw.projectUnitFor(root);
      second = mw.projectUnitFor(root);
      await enteredRead;
      configGate.release();
      const [firstUnit, secondUnit] = await Promise.all([first, second]);

      expect(reads).toBe(1);
      expect(firstUnit).toBeDefined();
      expect(secondUnit).toBe(firstUnit);
      expect(mw.units.get(root)).toBe(firstUnit);
      expect(secondUnit!.connections).toBe(firstUnit!.connections);
    } finally {
      configGate.release();
      await Promise.allSettled([first, second].filter((item) => item !== undefined));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录缓存仍在载入时第二个调用者不能绕过等待，完成后共享同一 unit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-cache-publish-"));
    const root = join(dir, "project");
    const cacheGate = gate();
    let cacheCalls = 0;
    let entered!: () => void;
    const enteredCache = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalEnsureRootLoaded = catalogDirectory.ensureRootLoaded;
    let capturedLoad: Promise<void> | undefined;
    catalogDirectory.ensureRootLoaded = async (cacheRoot, cachePath) => {
      cacheCalls += 1;
      capturedLoad = originalEnsureRootLoaded.call(catalogDirectory, cacheRoot, cachePath);
      entered();
      await cacheGate.promise;
      await capturedLoad;
    };
    let first: Promise<ProjectUnit | undefined> | undefined;
    let second: Promise<ProjectUnit | undefined> | undefined;
    try {
      const { host } = makeHost();
      host.projectServersFor = async (requestedRoot: string) => (requestedRoot === root ? [] : []);
      const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));

      first = mw.projectUnitFor(root);
      await enteredCache;
      let secondSettled = false;
      second = mw.projectUnitFor(root).then((unit) => {
        secondSettled = true;
        return unit;
      });
      await Promise.resolve();
      expect(secondSettled).toBe(false);

      cacheGate.release();
      const [firstUnit, secondUnit] = await Promise.all([first, second]);
      expect(cacheCalls).toBe(1);
      expect(secondUnit).toBe(firstUnit);
      expect(secondSettled).toBe(true);
    } finally {
      cacheGate.release();
      await Promise.allSettled([first, second].filter((item) => item !== undefined));
      if (capturedLoad !== undefined) await capturedLoad;
      catalogDirectory.ensureRootLoaded = originalEnsureRootLoaded;
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartRetryCases() {
  it("初始化配置读取拒绝后清理在途登记，下一次调用可重试成功", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-init-retry-"));
    const root = join(dir, "project");
    const firstFailure = new Error("cold-start config read failed");
    let reads = 0;
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      reads += 1;
      if (reads === 1) throw firstFailure;
      return [];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));

    try {
      await expect(mw.projectUnitFor(root)).rejects.toBe(firstFailure);
      expect(mw.units.has(root)).toBe(false);
      const retried = await mw.projectUnitFor(root);
      expect(retried).toBeDefined();
      expect(mw.units.get(root)).toBe(retried);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录缓存载入拒绝后清理半发布单元，下一次调用可重试成功", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-cache-retry-"));
    const root = join(dir, "project");
    const firstFailure = new Error("catalog cache load failed");
    let cacheCalls = 0;
    const originalEnsureRootLoaded = catalogDirectory.ensureRootLoaded;
    catalogDirectory.ensureRootLoaded = async (cacheRoot, cachePath) => {
      cacheCalls += 1;
      await originalEnsureRootLoaded.call(catalogDirectory, cacheRoot, cachePath);
      if (cacheCalls === 1) throw firstFailure;
    };
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => (requestedRoot === root ? [] : []);
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    let first: Promise<ProjectUnit | undefined> | undefined;

    try {
      first = mw.projectUnitFor(root);
      await expect(first).rejects.toBe(firstFailure);
      expect(mw.units.has(root)).toBe(false);
      expect(catalogDirectory.serversFor(root)).toBeUndefined();

      const retried = await mw.projectUnitFor(root);
      expect(retried).toBeDefined();
      expect(mw.units.get(root)).toBe(retried);
      expect(catalogDirectory.serversFor(root)).toBeDefined();
      expect(cacheCalls).toBe(2);
    } finally {
      await Promise.allSettled(first === undefined ? [] : [first]);
      catalogDirectory.ensureRootLoaded = originalEnsureRootLoaded;
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartTeardownGenerationCases() {
  it("配置读取在途时 teardownUnit 不会让迟到的初始化复活单元", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-teardown-config-"));
    const root = join(dir, "project");
    const configGate = gate();
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      entered();
      await configGate.promise;
      return [];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    let pending: Promise<ProjectUnit | undefined> | undefined;

    try {
      pending = mw.projectUnitFor(root);
      await enteredRead;
      mw.teardownUnit(root);
      configGate.release();

      await expect(pending).resolves.toBeUndefined();
      expect(mw.units.has(root)).toBe(false);
      expect(catalogDirectory.serversFor(root)).toBeUndefined();
      expect(mw.disabledByRoot.has(root)).toBe(false);
    } finally {
      configGate.release();
      await Promise.allSettled(pending === undefined ? [] : [pending]);
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("旧配置在途 teardown 后立即重建，旧任务 finalizer 不摘新登记", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-init-generation-"));
    const root = join(dir, "project");
    const oldConfigGate = gate();
    const newConfigGate = gate();
    let reads = 0;
    let oldEntered!: () => void;
    let newEntered!: () => void;
    const oldReadEntered = new Promise<void>((resolve) => {
      oldEntered = resolve;
    });
    const newReadEntered = new Promise<void>((resolve) => {
      newEntered = resolve;
    });
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      reads += 1;
      if (reads === 1) {
        oldEntered();
        await oldConfigGate.promise;
        return [];
      }
      newEntered();
      await newConfigGate.promise;
      return [];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    let oldInit: Promise<ProjectUnit | undefined> | undefined;
    let replacementInit: Promise<ProjectUnit | undefined> | undefined;
    let thirdInit: Promise<ProjectUnit | undefined> | undefined;

    try {
      oldInit = mw.projectUnitFor(root);
      await oldReadEntered;
      mw.teardownUnit(root);
      replacementInit = mw.projectUnitFor(root);
      await newReadEntered;

      // 旧任务先结算；其 finalizer 不得摘掉已登记的新一代任务。
      oldConfigGate.release();
      await expect(oldInit).resolves.toBeUndefined();
      thirdInit = mw.projectUnitFor(root);
      await Promise.resolve();
      expect(reads).toBe(2);

      newConfigGate.release();
      const [replacementUnit, thirdUnit] = await Promise.all([replacementInit, thirdInit]);
      expect(replacementUnit).toBeDefined();
      expect(thirdUnit).toBe(replacementUnit);
      expect(mw.units.get(root)).toBe(replacementUnit);
      expect(reads).toBe(2);
    } finally {
      oldConfigGate.release();
      newConfigGate.release();
      await Promise.allSettled(
        [oldInit, replacementInit, thirdInit].filter((item) => item !== undefined),
      );
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartDisposeDuringLoadCases() {
  it("目录缓存载入在途时 dispose 不会让迟到的初始化复活单元或目录根", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-dispose-cache-"));
    const root = join(dir, "project");
    const cacheGate = gate();
    let entered!: () => void;
    const enteredCache = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalEnsureRootLoaded = catalogDirectory.ensureRootLoaded;
    let capturedLoad: Promise<void> | undefined;
    catalogDirectory.ensureRootLoaded = async (cacheRoot, cachePath) => {
      // 真实方法在首个 await 前同步登记 root；先启动它再卡住其结算，避免夹具伪造「迟到登记」。
      capturedLoad = originalEnsureRootLoaded.call(catalogDirectory, cacheRoot, cachePath);
      entered();
      await cacheGate.promise;
      await capturedLoad;
    };
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => (requestedRoot === root ? [] : []);
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    let pending: Promise<ProjectUnit | undefined> | undefined;

    try {
      pending = mw.projectUnitFor(root);
      await enteredCache;
      await mw.dispose();
      cacheGate.release();

      await expect(pending).resolves.toBeUndefined();
      expect(mw.units.has(root)).toBe(false);
      expect(catalogDirectory.serversFor(root)).toBeUndefined();
    } finally {
      cacheGate.release();
      await Promise.allSettled(pending === undefined ? [] : [pending]);
      if (capturedLoad !== undefined) await capturedLoad;
      catalogDirectory.ensureRootLoaded = originalEnsureRootLoaded;
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartReplacementCases() {
  it("已废弃的旧配置在替换完成后不能覆盖新连接", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-replacement-"));
    const root = join(dir, "project");
    const staleServer = virtualServer("stale ensure generation");
    const replacementServer = virtualServer("replacement ensure generation");
    const staleConfigGate = gate();
    let configReads = 0;
    let enteredStaleRead!: () => void;
    const staleReadEntered = new Promise<void>((resolve) => {
      enteredStaleRead = resolve;
    });
    let currentServers: ServerConfig[] = [];
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      configReads += 1;
      if (configReads === 1) {
        enteredStaleRead();
        await staleConfigGate.promise;
        return [staleServer];
      }
      return currentServers;
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit({ root });
    mw.units.set(root, unit);
    let staleEnsure: Promise<void> | undefined;
    let replacementEnsure: Promise<void> | undefined;

    try {
      staleEnsure = mw.ensureConnected(root, "echo");
      await staleReadEntered;
      expect([...unit.inFlight.keys()]).toEqual(["echo"]);

      currentServers = [replacementServer];
      mw.abandonInFlight("echo");
      replacementEnsure = mw.ensureConnected(root, "echo", { force: true });
      await replacementEnsure;
      expect(unit.connections.get("echo")?.server).toBe(replacementServer);

      staleConfigGate.release();
      await staleEnsure;
      expect(unit.connections.get("echo")?.server).toBe(replacementServer);
      expect(unit.inFlight.has("echo")).toBe(false);
    } finally {
      staleConfigGate.release();
      await Promise.allSettled(
        [staleEnsure, replacementEnsure].filter((item) => item !== undefined),
      );
      await mw.dispose();
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("单元替换后旧 ensure 晚到不能把连接挂到新单元", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-unit-replacement-"));
    const root = join(dir, "project");
    const staleServer = virtualServer("stale unit generation");
    const configGate = gate();
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      entered();
      await configGate.promise;
      return [staleServer];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const oldUnit = makeUnit({ root });
    const replacementUnit = makeUnit({ root });
    mw.units.set(root, oldUnit);
    let staleEnsure: Promise<void> | undefined;

    try {
      staleEnsure = mw.ensureConnected(root, "echo");
      await enteredRead;
      mw.abandonInFlight("echo");
      mw.units.set(root, replacementUnit);
      configGate.release();

      await staleEnsure;
      expect(mw.units.get(root)).toBe(replacementUnit);
      expect(replacementUnit.connections.has("echo")).toBe(false);
      expect(catalogDirectory.serverNamesFor(root)).toEqual([]);
    } finally {
      configGate.release();
      await Promise.allSettled(staleEnsure === undefined ? [] : [staleEnsure]);
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartDisabledGenerationCases() {
  it("已废弃的旧配置在用户禁用后不能建立连接", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-disable-"));
    const root = join(dir, "project");
    const server = virtualServer("stale disabled generation");
    const configGate = gate();
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      entered();
      await configGate.promise;
      return [server];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const unit = makeUnit({ root });
    mw.units.set(root, unit);
    let staleEnsure: Promise<void> | undefined;

    try {
      staleEnsure = mw.ensureConnected(root, "echo");
      await enteredRead;
      unit.userDisabled.add("echo");
      mw.abandonInFlight("echo");
      configGate.release();

      await staleEnsure;
      expect(unit.connections.has("echo")).toBe(false);
      expect(catalogDirectory.serverNamesFor(root)).toEqual([]);
    } finally {
      configGate.release();
      await Promise.allSettled(staleEnsure === undefined ? [] : [staleEnsure]);
      await mw.dispose();
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function registerColdStartValidationBeforeDisposeCases() {
  it("配置无效时 force 重建先校验再处置旧代际", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-1168-validate-before-dispose-"));
    const root = join(dir, "project");
    const configGate = gate();
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const disabledServer: ServerConfig = {
      name: "echo",
      transport: "stdio",
      command: "node",
      enabled: false,
    };
    const { host } = makeHost();
    host.projectServersFor = async (requestedRoot: string) => {
      if (requestedRoot !== root) return [];
      entered();
      await configGate.promise;
      return [disabledServer];
    };
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    const existing = remoteEntry(disabledServer, "id-existing");
    const unit = makeUnit({ root, connections: new Map([["echo", existing]]) });
    mw.units.set(root, unit);
    const poolLoader = coldStartShape.poolLoader;
    const callsBefore = poolLoader.calls.length;
    let pending: Promise<void> | undefined;

    try {
      pending = mw.ensureConnected(root, "echo", { force: true });
      await enteredRead;
      expect(existing.disposed).toBe(false);
      expect(poolLoader.calls.slice(callsBefore).filter((call) => call[0] === "dispose")).toEqual(
        [],
      );

      configGate.release();
      await pending;
      expect(unit.connections.get("echo")).toBe(existing);
      expect(existing.disposed).toBe(false);
      expect(poolLoader.calls.slice(callsBefore).filter((call) => call[0] === "dispose")).toEqual(
        [],
      );
    } finally {
      configGate.release();
      await Promise.allSettled(pending === undefined ? [] : [pending]);
      await mw.dispose();
      catalogDirectory.dropRoot(root);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
describe("#1168 冷启动初始化与读工具屏障", () => {
  registerColdStartInFlightConfigReadCases();
  registerColdStartSharedInitializationCases();
  registerColdStartRetryCases();
  registerColdStartTeardownGenerationCases();
  registerColdStartDisposeDuringLoadCases();
  registerColdStartReplacementCases();
  registerColdStartDisabledGenerationCases();
  registerColdStartValidationBeforeDisposeCases();
  registerColdStartLatestConfigCases();
});
