/**
 * dsh-mcp-manager — unit：脱敏秘密源三处同调（#770-8）。
 *
 * 覆盖：
 * - manager.getRedactionServers 全集：全局 store + 全部 projectStores 缓存 +
 *   runtimeRegistry，含 disabled/unconnected（不过滤 enabled）。
 * - manager 私有 redactError 经同一快照脱敏（项目侧 disabled/unconnected 秘密不泄漏；
 *   缺口存在时（仅 store + runtime）项目秘密原文残留，本用例失败）。
 * - middleware 私有 redact 经宿主 redactionServers 快照脱敏（单元子集外的 disabled/
 *   unconnected 秘密不泄漏；缺口存在时（仅 units.connections）原文残留，本用例失败）。
 * - middleware.callTool 转供同一快照给 dispatch：远端失败文案中 disabled/unconnected
 *   秘密被抹掉（端到端证明 dispatch 与前两者同源；缺口存在时原文残留，本用例失败）。
 *
 * 底层同 pipeline.createRedactor；凭据全为虚构测试串，无真实凭据；落盘仅进 mkdtempSync
 * 隔离目录（store 路径与目录缓存路径均为临时路径）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { McpStore } from "../../src/server/store/interface.ts";
import { fakeManagerCtx, fakeToolsService } from "../helpers.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as storeApi from "../../src/server/store/interface.ts";
import * as runtimeApi from "../../src/server/connection/runtime/interface.ts";
import * as lifecycleApi from "../../src/server/servers/lifecycle/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import * as dispatchApi from "../../src/server/servers/dispatch/interface.ts";
import * as upgradeApi from "../../src/server/upgrade/interface.ts";
import {
  installOrchestrator,
  releaseOrchestrator,
  McpManager,
} from "../../src/server/connection/orchestrator/interface.ts";
import {
  installRuntime,
  releaseRuntime,
  McpMiddleware,
} from "../../src/server/connection/runtime/interface.ts";
import { McpStore as McpStoreImpl } from "../../src/server/store/interface.ts";
import { fullServerName } from "../../src/server/workspace/interface.ts";

// I8①：unit 层不得值引组合根 src/index.ts——本文件经域门面直引
// McpManager/McpMiddleware/McpStore/fullServerName，并手装两组端口
// （orchestrator：manager 快照链；runtime：middleware redact/callTool 壳），
// 不经组合根求值装配。实参与 src/index.ts 同源（静态模块引用）。
function installAll(): void {
  pipelineApi.installPipeline({ workspace: workspaceApi });
  installRuntime({
    catalog: catalogApi,
    configEnv: configModelApi,
    dispatch: dispatchApi,
    lifecycle: lifecycleApi,
    pipeline: pipelineApi,
    workspace: workspaceApi,
  });
  installOrchestrator({
    catalog: catalogApi,
    configModel: configModelApi,
    configStore: storeApi,
    runtime: runtimeApi,
    lifecycle: lifecycleApi,
    pipeline: pipelineApi,
    stats: statsApi,
    workspace: workspaceApi,
    upgrade: upgradeApi,
  });
}

const SECRET_GLOBAL = "7708-fake-global-secret-A1b2C3";
const SECRET_PROJECT_DISABLED = "7708-fake-project-disabled-secret-D4e5F6";
const SECRET_PROJECT_IDLE = "7708-fake-project-idle-secret-G7h8I9";
const SECRET_RUNTIME = "7708-fake-runtime-secret-J1k2L3";
const SECRET_MW_DISABLED = "7708-fake-mw-disabled-secret-M4n5O6";
const SECRET_MW_IDLE = "7708-fake-mw-idle-secret-P7q8R9";

let tempDirs: string[] = [];
let disposables: Array<{ dispose?: () => unknown }> = [];

afterEach(async () => {
  try {
    releaseOrchestrator();
  } catch {
    // 未装配忽略
  }
  try {
    releaseRuntime();
  } catch {
    // 未装配忽略
  }
  try {
    pipelineApi.releasePipeline();
  } catch {
    // 未装配忽略
  }
  for (const item of disposables) {
    try {
      await item.dispose?.();
    } catch {
      // 清理失败不掩盖用例结论
    }
  }
  disposables = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function stdioServer(
  name: string,
  secret: string,
  extra: Record<string, unknown> = {},
): ServerConfig {
  return {
    name,
    transport: "stdio",
    command: "echo",
    env: { HIDDEN_TEST_TOKEN: secret },
    ...extra,
  } as unknown as ServerConfig;
}

function makeManagerWithFullSet(): { manager: InstanceType<typeof McpManager>; store: McpStore } {
  installAll();
  const dir = makeTempDir("dsh-mcp-redact-7708-");
  const store = new McpStoreImpl(join(dir, "global.json")) as unknown as McpStore;
  store.data = {
    version: 1,
    servers: [stdioServer("global-srv", SECRET_GLOBAL, { enabled: true })],
  } as unknown as McpStore["data"];
  const manager = new McpManager(fakeManagerCtx(), store) as InstanceType<typeof McpManager>;
  disposables.push(manager as unknown as { dispose?: () => unknown });

  // 项目侧缓存：disabled 与未连接 enabled 各一条（本用例不建中间层单元，故均为未连接）。
  const projDir = makeTempDir("dsh-mcp-redact-proj-7708-");
  const projStore = new McpStoreImpl(join(projDir, "mcp.json")) as unknown as McpStore;
  projStore.data = {
    version: 1,
    servers: [
      stdioServer("proj-disabled", SECRET_PROJECT_DISABLED, { enabled: false }),
      stdioServer("proj-idle", SECRET_PROJECT_IDLE, { enabled: true }),
    ],
  } as unknown as McpStore["data"];
  manager.projectStores.set(projDir, projStore as never);
  manager.projectStore = projStore as never;
  manager.projectRoot = projDir;

  // 运行时注入（内存态，不落盘）。
  manager.runtimeRegistry.set("rt-srv", stdioServer("rt-srv", SECRET_RUNTIME, { enabled: true }));
  return { manager, store: store as unknown as McpStore };
}

describe("getRedactionServers 全集（含 disabled/unconnected）", () => {
  it("含全局 + 项目缓存 + runtime 四条，不按 enabled 过滤", () => {
    const { manager } = makeManagerWithFullSet();
    const snapshot = manager.getRedactionServers();
    const names = snapshot.map((server) => server.name).sort();
    expect(names).toEqual(["global-srv", "proj-disabled", "proj-idle", "rt-srv"]);
    // disabled 条目仍在快照内（脱敏源不得过滤 enabled）。
    expect(snapshot.find((server) => server.name === "proj-disabled")?.enabled).toBe(false);
  });
});

describe("manager.redactError 与快照同源", () => {
  it("项目侧 disabled/unconnected 与 runtime 秘密均被抹掉", () => {
    const { manager } = makeManagerWithFullSet();
    const redacted = (manager as unknown as { redactError(error: unknown): string }).redactError(
      new Error(
        `leak ${SECRET_GLOBAL} ${SECRET_PROJECT_DISABLED} ${SECRET_PROJECT_IDLE} ${SECRET_RUNTIME}`,
      ),
    );
    expect(redacted).not.toContain(SECRET_GLOBAL);
    expect(redacted).not.toContain(SECRET_PROJECT_DISABLED);
    expect(redacted).not.toContain(SECRET_PROJECT_IDLE);
    expect(redacted).not.toContain(SECRET_RUNTIME);
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("middleware 与 dispatch 同一秘密源", () => {
  function middlewareFixture() {
    installAll();
    const cacheDir = makeTempDir("dsh-mcp-redact-mw-7708-");
    const root = makeTempDir("dsh-mcp-redact-root-7708-");
    const connected: ServerConfig = {
      name: "connected-srv",
      transport: "stdio",
      command: "echo",
      enabled: true,
    } as unknown as ServerConfig;
    const disabled = stdioServer("disabled-srv", SECRET_MW_DISABLED, { enabled: false });
    const idle = stdioServer("idle-srv", SECRET_MW_IDLE, { enabled: true });
    const fullSet = [connected, disabled, idle];
    const tools = fakeToolsService({
      execute: async () => {
        throw new Error(`remote boom ${SECRET_MW_DISABLED} ${SECRET_MW_IDLE}`);
      },
    });
    const host = {
      ctx: { tools },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      projectServersFor: async () => [connected],
      redactionServers: () => fullSet,
      globalServers: () => [],
      normalizedProjectRoot: async () => root,
      saveUserState: async () => {},
      emitStatus: () => {},
      catalogCachePath: () => join(cacheDir, "catalog.json"),
      isGlobalServer: () => false,
      isRuntimeServer: () => false,
    } as unknown as MiddlewareHost;
    const mw = new McpMiddleware(host) as InstanceType<typeof McpMiddleware>;
    disposables.push(mw as unknown as { dispose?: () => unknown });
    mw.units.set(
      root as never,
      {
        root,
        connections: new Map([
          [
            "connected-srv",
            {
              server: connected,
              id: "id-connected-7708",
              handle: undefined,
              status: "connected",
              error: undefined,
              connectedAt: Date.now(),
              readySettled: true,
              everConnected: true,
              disposed: false,
            },
          ],
        ]),
        userDisabled: new Set(),
        lastTouchedAt: Date.now(),
        inFlight: new Map(),
      } as never,
    );
    return { mw, root, connected };
  }

  it("私有 redact 抹掉单元外的 disabled/unconnected 秘密", () => {
    const { mw } = middlewareFixture();
    const out = (mw as unknown as { redact(error: unknown): string }).redact(
      new Error(`fail ${SECRET_MW_DISABLED} ${SECRET_MW_IDLE}`),
    );
    expect(out).not.toContain(SECRET_MW_DISABLED);
    expect(out).not.toContain(SECRET_MW_IDLE);
    expect(out).toContain("[REDACTED]");
  });

  it("callTool 远端失败文案抹掉 disabled/unconnected 秘密（dispatch 同源）", async () => {
    const { mw, root } = middlewareFixture();
    let message = "";
    try {
      await mw.callTool(fullServerName(root, "connected-srv"), "someTool", {}, undefined, {
        callId: "call-7708" as unknown as ToolExecutionInput["callId"],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("调用失败");
    expect(message).not.toContain(SECRET_MW_DISABLED);
    expect(message).not.toContain(SECRET_MW_IDLE);
    expect(message).toContain("[REDACTED]");
  });
});
