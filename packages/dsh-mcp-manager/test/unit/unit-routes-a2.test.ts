/**
 * dsh-mcp-manager — unit：路由统一错误边界脱敏（#770-A2）。
 *
 * 覆盖：
 * - 控制器错误经 helpers.handleError 收口时，含凭据明文的 error.message 被抹
 *   （400 body 无明文、有 [REDACTED]）；
 * - 400 校验类错误（无秘密）脱敏恒等无害（原文原样返回）；
 * - manager.redactError 缺省时回落原文（外部实现兼容，不抛）。
 *
 * 接线：真 McpManager（快照链实装）提供 redactError 实现；路由侧用摘要抛错的
 * 假 RoutesManager 触发 handleError（生产环境 makeRoutes 收到的即真 manager，
 * 其 redactError 与快照同源——A1 已锁正确性，此处锁"边界统一调用"）。
 * 凭据全为虚构测试串；落盘仅进 mkdtempSync 隔离目录。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import type { RoutesManager } from "../../src/server/connection/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configStoreApi from "../../src/server/store/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import {
  installOrchestrator,
  releaseOrchestrator,
  McpManager,
} from "../../src/server/connection/orchestrator/interface.ts";
import { installApi, releaseApi, makeRoutes, ROUTES } from "../../src/server/api/interface.ts";
import { callHandler, fakeManagerCtx, fakeRes } from "../helpers.ts";

const A2_SECRET = "a2-fake-route-secret-K8m2P5";

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  try {
    releaseOrchestrator();
  } catch {
    /* 未装配忽略 */
  }
  try {
    releaseApi();
  } catch {
    /* 未装配忽略 */
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function installAll(): void {
  installOrchestrator({
    catalog: catalogApi,
    configModel: configModelApi,
    configStore: configStoreApi,
    runtime: {} as never,
    lifecycle: {} as never,
    pipeline: pipelineApi,
    stats: statsApi,
    workspace: {} as never,
    upgrade: {} as never,
  });
  installApi({ workspace: workspaceApi, configModel: configModelApi });
}

/** 持秘密的真 manager（redactError 实现源）。 */
function secretManager(): InstanceType<typeof McpManager> {
  const dir = makeTempDir("dsh-mcp-a2-");
  const store = new McpStore(join(dir, "global.json"));
  const server = {
    name: "secret-srv",
    transport: "stdio",
    command: "echo",
    env: { HIDDEN_TOKEN: A2_SECRET },
  } as unknown as ServerConfig;
  store.data = { version: 1, servers: [server] } as unknown as McpStore["data"];
  return new McpManager(fakeManagerCtx(), store as never) as InstanceType<typeof McpManager>;
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  return {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "localhost:3080",
      origin: "http://localhost:3080",
      "sec-fetch-site": "same-origin",
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
    on: () => {},
  } as unknown as IncomingMessage;
}

/** 摘要抛错的假 manager：summary 按给定错抛，redactError 委托真 manager。 */
function throwingManager(thrown: unknown, redact: (error: unknown) => string): RoutesManager {
  return {
    summary: () => {
      throw thrown;
    },
    redactError: redact,
    setSession: async () => {},
    refreshFromDisk: async () => {},
    uiConfig: () => ({}) as never,
    updateUiConfig: async () => ({}) as never,
    add: async () => ({}) as never,
    update: async () => ({}) as never,
    remove: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    reconnect: async () => {},
    projectStoreOrThrow: async () => ({}) as never,
    store: {} as never,
    catalogCache: new Map(),
  } as unknown as RoutesManager;
}

describe("#770-A2 路由错误边界脱敏", () => {
  it("含凭据的控制器错误经 handleError 被抹（GET /servers 摘要抛错）", async () => {
    installAll();
    const real = secretManager();
    expect(typeof real.redactError).toBe("function");
    const manager = throwingManager(new Error("load failed: " + A2_SECRET), (error: unknown) =>
      real.redactError(error),
    );
    const routes = makeRoutes(manager);
    const servers = routes.find((r) => r.path === ROUTES.servers);
    expect(servers).toBeDefined();
    const res = fakeRes();
    const { status, payload } = await callHandler(servers!, fakeReq("GET", "/"), res);
    expect(status).toBe(400);
    const body = payload as { error?: string };
    expect(body.error).not.toContain(A2_SECRET);
    expect(body.error).toContain("[REDACTED]");
  });

  it("无秘密的 400 错误脱敏恒等无害（原文原样返回）", async () => {
    installAll();
    const real = secretManager();
    const plain = 'server "nope" not found in global scope';
    const manager = throwingManager(new Error(plain), (error: unknown) => real.redactError(error));
    const routes = makeRoutes(manager);
    const servers = routes.find((r) => r.path === ROUTES.servers);
    const res = fakeRes();
    const { status, payload } = await callHandler(servers!, fakeReq("GET", "/"), res);
    expect(status).toBe(400);
    expect((payload as { error?: string }).error).toBe(plain);
  });

  describe("#770-L3 POST/PATCH 响应 server 只读投影", () => {
    const L3_SECRET = "l3-fake-env-secret-T6y8U1";

    function emptyManager(): InstanceType<typeof McpManager> {
      const dir = makeTempDir("dsh-mcp-l3-");
      const store = new McpStore(join(dir, "global.json"));
      store.data = { version: 1, servers: [] } as unknown as McpStore["data"];
      return new McpManager(fakeManagerCtx(), store as never) as InstanceType<typeof McpManager>;
    }

    it("POST 201 的 server 字段无明文（env 省略 + hasSecrets），盘上仍存原文", async () => {
      installAll();
      const manager = emptyManager();
      const routes = makeRoutes(manager as unknown as RoutesManager);
      const servers = routes.find((r) => r.path === ROUTES.servers);
      expect(servers).toBeDefined();
      const res = fakeRes();
      const { status, payload } = await callHandler(
        servers!,
        fakeReq("POST", "/", {
          name: "l3-srv",
          transport: "stdio",
          command: "echo",
          env: { HIDDEN_TOKEN: L3_SECRET },
          enabled: false,
        }),
        res,
      );
      expect(status).toBe(201);
      const body = payload as { server?: Record<string, unknown> };
      expect(JSON.stringify(body.server)).not.toContain(L3_SECRET);
      expect(body.server?.env).toBeUndefined();
      expect(body.server?.hasSecrets).toBe(true);
      // 投影只影响响应：盘上仍是写路径原文（明文存储面不变）。
      expect((manager.store.find("l3-srv") as unknown as ServerConfig | undefined)?.env).toEqual({
        HIDDEN_TOKEN: L3_SECRET,
      });
    });

    it("PATCH 200 的 server 字段无明文（缺键沿用既有 env，响应仍省略）", async () => {
      installAll();
      const manager = emptyManager();
      await manager.add(
        {
          name: "l3-srv",
          transport: "stdio",
          command: "echo",
          env: { HIDDEN_TOKEN: L3_SECRET },
          enabled: false,
        },
        "global",
      );
      const routes = makeRoutes(manager as unknown as RoutesManager);
      const servers = routes.find((r) => r.path === ROUTES.servers);
      expect(servers).toBeDefined();
      const res = fakeRes();
      const { status, payload } = await callHandler(
        servers!,
        fakeReq("PATCH", "/?name=l3-srv", { command: "echo2" }),
        res,
      );
      expect(status).toBe(200);
      const body = payload as { server?: Record<string, unknown> };
      expect(JSON.stringify(body.server)).not.toContain(L3_SECRET);
      expect(body.server?.env).toBeUndefined();
      expect(body.server?.hasSecrets).toBe(true);
      expect(body.server?.command).toBe("echo2");
      // 缺键即沿用既有：盘上 env 未丢。
      expect((manager.store.find("l3-srv") as unknown as ServerConfig | undefined)?.env).toEqual({
        HIDDEN_TOKEN: L3_SECRET,
      });
    });
  });

  it("redactError 缺省时回落原文（外部实现兼容，不抛）", async () => {
    installAll();
    const manager = throwingManager(new Error("plain boom"), undefined as never);
    delete (manager as { redactError?: unknown }).redactError;
    const routes = makeRoutes(manager);
    const servers = routes.find((r) => r.path === ROUTES.servers);
    const res = fakeRes();
    const { status, payload } = await callHandler(servers!, fakeReq("GET", "/"), res);
    expect(status).toBe(400);
    expect((payload as { error?: string }).error).toBe("plain boom");
  });
});
