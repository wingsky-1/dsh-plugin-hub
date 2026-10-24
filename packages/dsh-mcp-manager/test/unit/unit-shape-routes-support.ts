/**
 * dsh-mcp-manager — unit：路由域的专属测试支撑（#1174 阶段 2 形状清债）。
 *
 * 随「配置/导入路由面」迁出后，路由夹具（假 req/res、管理器装配、临时根回收链）被原
 * 文件与新文件共用，故提到本支撑文件（专属前缀 unit-shape-，不进 runner、不进变异分母）。
 * 语义逐字沿用原 routes-sse.test.ts 的实现：假件只实现 handler 实际读取的面，
 * 清理链顺序不变（先 dispose 心跳 hub，再删临时根）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";
import type { FakeResponseState } from "../helpers.ts";
import { fakeManagerCtx } from "../helpers.ts";

// I8①：单元层不得值引组合根 src/index.ts——路由工厂与管理器改经各自域门面直取。
const { makeRoutes, ROUTES } = await import("../../src/server/api/interface.ts");
const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const { normalizeServer } = await import("../../src/server/config/interface.ts");

/** 本支撑的临时根与管理器登记（每个测试文件一份自己的实例，文件间隔离）。 */
export interface UnitShapeRoutesFixture {
  tempDirs: string[];
  managers: McpManagerType[];
}

/** 新建一份路由夹具登记：临时根与待清理管理器。 */
export function unitShapeRoutesFixture(): UnitShapeRoutesFixture {
  return { tempDirs: [], managers: [] };
}

// 伪造 req/res：只实现 handler 实际读取的面，其余按接缝收窄（`as unknown as`）。
export const unitShapeFakeReq = (
  method: string,
  url: string,
  body?: unknown,
  opts: { remote?: string } = {},
): IncomingMessage =>
  ({
    method,
    url,
    socket: { remoteAddress: opts.remote ?? "127.0.0.1" },
    headers: {
      host: "localhost:3080",
      origin: "http://localhost:3080",
      "sec-fetch-site": "same-origin",
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined)
        yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    },
    on: () => {},
  }) as unknown as IncomingMessage;

export const unitShapeFakeRes = (): ServerResponse & { state: FakeResponseState } => {
  const state: FakeResponseState = {
    status: 200,
    body: "",
    headers: {},
    destroyed: false,
    writableEnded: false,
  };
  return {
    state,
    // routes.ts 心跳回调读 res.destroyed / res.writableEnded 判定自愈清理。
    get destroyed() {
      return state.destroyed;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    writeHead: (s: number, h?: Record<string, string>) => {
      state.status = s;
      state.headers = h ?? {};
    },
    write: (chunk: { toString(): string }) => {
      state.body += chunk.toString();
    },
    end: (chunk?: { toString(): string }) => {
      if (chunk) state.body += chunk.toString();
      state.writableEnded = true;
    },
    setHeader: () => {},
    on: (event: string, cb: () => void) => {
      if (event === "close") state.onClose = cb;
    },
    destroy: () => {
      state.destroyed = true;
    },
  } as unknown as ServerResponse & { state: FakeResponseState };
};

/** 装配一个带假服务器与目录缓存的管理器。 */
export function unitShapeSetupRoutes(fixture: UnitShapeRoutesFixture) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-sse-"));
  fixture.tempDirs.push(dir);
  const store = new McpStore(join(dir, "mcp.json"));
  store.data = { version: 1, servers: [] };
  store.upsert(normalizeServer({ name: "dup-a", transport: "stdio", command: "echo" }));
  const manager = new McpManager(fakeManagerCtx(), store);
  manager.catalogCache.set("cached", { summary: "s" });
  fixture.managers.push(manager);
  return { dir, store, manager };
}

/** 清理链：先 dispose 心跳 hub（失败不掩盖用例结论），再删临时根。 */
export function unitShapeCleanupRoutes(fixture: UnitShapeRoutesFixture) {
  for (const manager of fixture.managers) {
    try {
      manager.sseHub?.dispose();
    } catch {
      // 心跳清理失败不掩盖用例结论
    }
  }
  fixture.managers = [];
  for (const dir of fixture.tempDirs) rmSync(dir, { recursive: true, force: true });
  fixture.tempDirs = [];
}

export { makeRoutes, ROUTES };
