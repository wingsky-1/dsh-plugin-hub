// dsh-mcp-manager — e2e 路由族共享夹具（#1174 shape 拆分产物）。
//
// 原 e2e/smoke.test.ts 的「路由（makeRoutes / events / health / tool-disable / resume）」describe
// 内 beforeAll 装配段：真 store（mkdtemp 隔离）+ 假 manager 替身（summary/uiConfig/updateUiConfig
// 可回读，add/update/remove 记录 scope 并写真 store，resumeReconnect 记录次数与透传 cwd）+
// makeRoutes 产物 + fakeReq / fakeFenceBroken。按自然族拆成五个文件后，这段装配只保留一份，
// 由各文件 describe 内以同名形状调用——语义与原 beforeAll 逐字相同。
import type { IncomingMessage } from "node:http";
import { makeRoutes, normalizeServer, normalizeUiConfig } from "../../lib/index.js";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { McpStore } from "../../src/server/store/interface.ts";
import { fakeLogger, fakeRes, tempStore } from "./remaining-smoke-support.ts";

// 路由族各文件统一从本模块取 fakeRes（形状见 remaining-smoke-support.ts 的同名件）。
export { fakeRes };

/** 路由族夹具的可回读面（原 describe 内 let 变量的同一集合）。 */
export interface RoutesFixture {
  store: McpStore;
  cleanup: () => void;
  managerState: {
    sessionCwd: string | undefined;
    lastScope: string | undefined;
    resumed: number;
    resumedCwds: Array<string | undefined>;
  };
  uiCfg: {
    position: string;
    offsetX: number;
    offsetY: number;
    blankY: number;
    zIndexBase?: number;
  };
  manager: Record<string, unknown>;
  routes: WebRoute[];
  find: (path: string) => WebRoute;
  fakeReq: (method: string, url: string, body?: unknown) => IncomingMessage;
  fakeFenceBroken: (method: string, url: string, body?: unknown) => IncomingMessage;
}

/** 原 describe 内 beforeAll 的装配段（逐字保留）：建 store / 假 manager / makeRoutes / 假请求。 */
export function makeRoutesFixture(): RoutesFixture {
  const { store, cleanup } = tempStore();
  const managerState = { sessionCwd: undefined, lastScope: undefined, resumed: 0, resumedCwds: [] };
  // 浮窗 UI 配置（可变，验证 config 读/写回传）。
  let uiCfg: RoutesFixture["uiCfg"] = { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40 };
  const manager = {
    store,
    logger: fakeLogger(),
    summary: () => ({ servers: [], counts: {} }),
    uiConfig: () => uiCfg,
    updateUiConfig: async (raw: unknown) => {
      uiCfg = normalizeUiConfig(raw) as unknown as RoutesFixture["uiCfg"];
      return uiCfg;
    },
    refreshFromDisk: async () => {},
    setSession: async (cwd: string | undefined) => {
      managerState.sessionCwd = cwd;
    },
    add: async (body: Record<string, unknown>, scope?: string) => {
      managerState.lastScope = scope;
      const server = normalizeServer(body);
      if (store.find(server.name) !== undefined) {
        throw new Error(`server "${server.name}" already exists`);
      }
      store.upsert(server);
      return server;
    },
    update: async (nm: string, patch: Record<string, unknown>, scope?: string) => {
      managerState.lastScope = scope;
      const server = normalizeServer({
        ...(store.find(nm) as unknown as Record<string, unknown>),
        ...patch,
        name: nm,
      });
      store.upsert(server);
      return server;
    },
    remove: async (nm: string, scope?: string) => {
      managerState.lastScope = scope;
      store.remove(nm);
    },
    connect: async () => {},
    disconnect: async () => {},
    reconnect: async () => {},
    // #1120 resume：切回前台可用性恢复（记录调用次数与透传 cwd 供路由断言）。
    resumeReconnect: async (cwd?: string) => {
      managerState.resumed += 1;
      managerState.resumedCwds.push(cwd);
    },
  };
  const routes = makeRoutes(manager as unknown as Parameters<typeof makeRoutes>[0], process.cwd());
  const find = (path: string) => routes.find((route) => route.path === path) as WebRoute;
  const fakeReq = (method: string, url: string, body?: unknown) =>
    ({
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
    }) as unknown as IncomingMessage;
  const fakeFenceBroken = (method: string, url: string, _body?: unknown) =>
    ({
      method,
      url,
      socket: { remoteAddress: "10.0.0.5" },
      headers: { host: "localhost:3080" },
      async *[Symbol.asyncIterator]() {},
    }) as unknown as IncomingMessage;
  return { store, cleanup, managerState, uiCfg, manager, routes, find, fakeReq, fakeFenceBroken };
}
