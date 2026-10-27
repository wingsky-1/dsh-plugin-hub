/** HTTP 连接受理相关用例注册；测试生命周期由调用方提供。 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callHandler, fakeRes, pollUntil } from "../helpers.ts";
import type { FakeToolEntry } from "../helpers.ts";
import { makeEventsRoute, makeRoutes, ROUTES } from "../../src/server/api/interface.ts";
import { sseData } from "../../../../shared/host-utils.js";
import { lifecyclePorts } from "../../src/server/servers/lifecycle/impl/service/index.ts";
import { mountLedger } from "../../src/server/servers/lifecycle/interface.ts";
import { orchestratorPorts } from "../../src/server/connection/orchestrator/impl/service/index.ts";
import { unitShapeFakeReq } from "./unit-shape-routes-support.ts";
import {
  managerFixture,
  loaderScript,
  poolLoader,
  summaryView,
  McpStore,
  normalizeServer,
  quietServer,
} from "./manager-shape-support.ts";

async function pendingServer() {
  const fixture = managerFixture("dsh-mcp-1187-");
  fixture.manager.userStatePath = join(fixture.dir, "user-state.json");
  loaderScript.ready = "deferred";
  fixture.store.upsert(normalizeServer(quietServer("pending")));
  await fixture.manager.initMiddleware();
  return fixture;
}

export function registerHttpConnectionTests(): void {
  registerCase0();
  registerCase1();
  registerCase2();
  registerCase3();
  registerCase4();
  registerCase5();
  registerCase6();
  registerCase7();
  registerCase8();
  registerCase9();
  registerCase10();
  registerCase11();
  registerCase12();
  registerCase13();
  registerCase14();
}

function registerCase0(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("路由在 SDK ready 前返回 202 和 connecting，重复请求复用同一连接", async () => {
      const { manager } = await pendingServer();
      const route = makeRoutes(manager).find((item) => item.path === ROUTES.connect)!;
      const req = () => unitShapeFakeReq("POST", `${ROUTES.connect}?name=pending&scope=global`);
      const first = await callHandler(route, req());
      expect(first.status).toBe(202);
      expect(
        (first.payload as { summary: { servers: Array<{ status: string }> } }).summary.servers[0]
          .status,
      ).toBe("connecting");
      await pollUntil("SDK mount 已发起", () => poolLoader!.handles.length === 1);
      const second = await callHandler(route, req());
      expect(second.status).toBe(202);
      expect(poolLoader!.handles.length).toBe(1);
      poolLoader!.settleReady();
    });
  });
}

function registerCase1(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("挂起期间断开不等 ready，旧连接迟到后不能复活", async () => {
      const { manager } = await pendingServer();
      const routes = makeRoutes(manager);
      const connect = routes.find((item) => item.path === ROUTES.connect)!;
      const disconnect = routes.find((item) => item.path === ROUTES.disconnect)!;
      const query = "?name=pending&scope=global";
      expect(
        (await callHandler(connect, unitShapeFakeReq("POST", ROUTES.connect + query))).status,
      ).toBe(202);
      await pollUntil("SDK mount 已发起", () => poolLoader!.handles.length === 1);
      expect(
        (await callHandler(disconnect, unitShapeFakeReq("POST", ROUTES.disconnect + query))).status,
      ).toBe(202);
      expect(manager.middleware!.units.get("@global")!.connections.has("pending")).toBe(false);
      poolLoader!.settleReady();
      await poolLoader!.handles[0].ready;
      await pollUntil("旧挂载已释放", () => poolLoader!.handles[0].state.disposed);
      expect(manager.middleware!.units.get("@global")!.connections.has("pending")).toBe(false);
      expect(summaryView(manager).servers[0].status).not.toBe("connecting");
    });
  });
}

function registerCase2(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("连接挂起时 PATCH 禁用，迟到的 ready 不能覆盖禁用状态", async () => {
      const { manager } = await pendingServer();
      const routes = makeRoutes(manager);
      const connect = routes.find((item) => item.path === ROUTES.connect)!;
      const servers = routes.find((item) => item.path === ROUTES.servers)!;
      const query = "?name=pending&scope=global";
      expect(
        (await callHandler(connect, unitShapeFakeReq("POST", ROUTES.connect + query))).status,
      ).toBe(202);
      await pollUntil("SDK mount 已发起", () => poolLoader!.handles.length === 1);
      const patched = await callHandler(
        servers,
        unitShapeFakeReq("PATCH", ROUTES.servers + query, { enabled: false }),
      );
      expect(patched.status).toBe(202);
      expect((patched.payload as { server: { status: string } }).server.status).toBe("disabled");
      expect(summaryView(manager).servers[0].status).toBe("disabled");
      poolLoader!.settleReady();
      await poolLoader!.handles[0].ready;
      await pollUntil("旧挂载已释放", () => poolLoader!.handles[0].state.disposed);
      expect(summaryView(manager).servers[0].status).toBe("disabled");
      expect(manager.middleware!.units.get("@global")!.connections.has("pending")).toBe(false);
      const retry = await callHandler(connect, unitShapeFakeReq("POST", ROUTES.connect + query));
      expect(retry.status).toBe(400);
      expect(poolLoader!.handles.length).toBe(1);
    });
  });
}

function registerCase3(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("连接挂起时 PATCH 启用创建新代连接，不复用旧 job", async () => {
      const { manager } = await pendingServer();
      const routes = makeRoutes(manager);
      const connect = routes.find((item) => item.path === ROUTES.connect)!;
      const servers = routes.find((item) => item.path === ROUTES.servers)!;
      const query = "?name=pending&scope=global";
      expect(
        (await callHandler(connect, unitShapeFakeReq("POST", ROUTES.connect + query))).status,
      ).toBe(202);
      await pollUntil("旧连接 mount", () => poolLoader!.handles.length === 1);
      const oldHandle = poolLoader!.handles[0];
      const oldEntry = manager.middleware!.units.get("@global")!.connections.get("pending");
      const response = await callHandler(
        servers,
        unitShapeFakeReq("PATCH", ROUTES.servers + query, { enabled: true }),
      );
      expect(response.status).toBe(202);
      expect((response.payload as { server: { status: string } }).server.status).toBe("connecting");
      await pollUntil("新连接 mount", () => poolLoader!.handles.length === 2);
      const newEntry = manager.middleware!.units.get("@global")!.connections.get("pending");
      expect(newEntry).toBeDefined();
      expect(newEntry).not.toBe(oldEntry);
      expect(oldHandle.state.disposed).toBe(true);
      poolLoader!.settleReady();
      await Promise.all(poolLoader!.handles.map((handle) => handle.ready));
      await pollUntil("新连接完成", () => newEntry?.id !== undefined);
      expect(manager.middleware!.units.get("@global")!.connections.get("pending")).toBe(newEntry);
      expect(poolLoader!.handles[1].state.disposed).toBe(false);
    });
  });
}

function registerCase4(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("GET 带 cwd 在加载期间切会话仍读取请求 root，不改变会话", async () => {
      const { dir, manager } = await pendingServer();
      const [requestedRoot, otherRoot] = [join(dir, "requested"), join(dir, "other")];
      for (const [index, root] of [requestedRoot, otherRoot].entries()) {
        mkdirSync(join(root, ".git"), { recursive: true });
        const store = new McpStore(join(root, "project.json"));
        store.upsert(
          normalizeServer(quietServer(index === 0 ? "requested-server" : "other-server")),
        );
        manager.projectStores.set(root, store);
      }
      manager.projectRoot = requestedRoot;
      manager.projectStore = manager.projectStores.get(requestedRoot);
      const original = manager.projectStoreFor.bind(manager);
      let release: () => void = () => {};
      let started = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      manager.projectStoreFor = async (root) => {
        if (root === requestedRoot) {
          started = true;
          await gate;
        }
        return original(root);
      };
      const route = makeRoutes(manager).find((item) => item.path === ROUTES.servers)!;
      const request = callHandler(
        route,
        unitShapeFakeReq("GET", `${ROUTES.servers}?cwd=${encodeURIComponent(requestedRoot)}`),
      );
      try {
        await pollUntil("GET 项目读取已挂起", () => started);
        await manager.setSession(otherRoot);
        release();
        const response = await request;
        expect(response.status).toBe(200);
        const body = response.payload as {
          cwd: string;
          servers: Array<{ name: string; scope: string }>;
        };
        expect(body.cwd).toBe(requestedRoot);
        expect(
          body.servers.filter((server) => server.scope === "project").map((server) => server.name),
        ).toEqual(["requested-server"]);
        expect(manager.projectRoot).toBe(otherRoot);
      } finally {
        release();
        manager.projectStoreFor = original;
      }
    });
  });
}

function registerCase5(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("删除并重加同名禁用服务器后，旧 job 的迟到 ready 不覆盖新配置", async () => {
      const { manager, store } = await pendingServer();
      await manager.acceptConnection("pending", "global");
      await pollUntil("旧 SDK mount 已发起", () => poolLoader!.handles.length === 1);
      const oldHandle = poolLoader!.handles[0];
      await manager.remove("pending", "global");
      await manager.add(
        quietServer("pending", { command: "new-command", enabled: false }),
        "global",
      );
      expect(store.find("pending")?.command).toBe("new-command");
      expect(summaryView(manager).servers[0].status).toBe("disabled");
      poolLoader!.settleReady();
      await oldHandle.ready;
      await pollUntil("旧挂载已释放", () => oldHandle.state.disposed);
      expect(store.find("pending")?.command).toBe("new-command");
      expect(summaryView(manager).servers[0].status).toBe("disabled");
      expect(manager.middleware!.units.get("@global")!.connections.has("pending")).toBe(false);
      expect(poolLoader!.handles.length).toBe(1);
    });
  });
}

function registerCase6(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("项目 PATCH 保存期间切换会话，响应和写入仍属于原请求 root", async () => {
      const { dir, manager } = await pendingServer();
      const [firstRoot, secondRoot] = [join(dir, "first"), join(dir, "second")];
      const stores = [firstRoot, secondRoot].map((root, index) => {
        mkdirSync(join(root, ".git"), { recursive: true });
        const store = new McpStore(join(root, "project.json"));
        store.upsert(normalizeServer(quietServer("shared", { command: `command-${index}` })));
        manager.projectStores.set(root, store);
        return store;
      });
      manager.projectRoot = firstRoot;
      manager.projectStore = stores[0];
      const originalSave = stores[0].save.bind(stores[0]);
      let release: () => void = () => {};
      let saveStarted = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      stores[0].save = async () => {
        saveStarted = true;
        await gate;
        await originalSave();
      };
      const route = makeRoutes(manager).find((item) => item.path === ROUTES.servers)!;
      const url = `${ROUTES.servers}?name=shared&scope=project&cwd=${encodeURIComponent(firstRoot)}`;
      const pending = callHandler(route, unitShapeFakeReq("PATCH", url, { enabled: false }));
      try {
        await pollUntil("项目 PATCH 已到保存闸门", () => saveStarted);
        await manager.setSession(secondRoot);
        release();
        const response = await pending;
        expect(response.status).toBe(202);
        const body = response.payload as {
          server: { command: string; status: string };
          summary: {
            cwd: string;
            servers: Array<{ name: string; scope: string; command: string; status: string }>;
          };
        };
        expect(body.server.command).toBe("command-0");
        expect(body.server.status).toBe("disabled");
        expect(body.summary.cwd).toBe(firstRoot);
        expect(
          body.summary.servers
            .filter((server) => server.scope === "project")
            .map((server) => [server.name, server.command, server.status]),
        ).toEqual([["shared", "command-0", "disabled"]]);
        expect(stores[0].find("shared")?.enabled).toBe(false);
        expect(stores[1].find("shared")?.enabled).toBe(true);
        expect(manager.projectRoot).toBe(secondRoot);
      } finally {
        release();
        stores[0].save = originalSave;
      }
    });
  });
}

function registerCase7(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("宿主 connect 等待 SDK ready", async () => {
      const { manager } = await pendingServer();
      let settled = false;
      const connecting = manager.connect("pending", "global").then(() => {
        settled = true;
      });
      await pollUntil("SDK mount 已发起", () => poolLoader!.handles.length === 1);
      expect(settled).toBe(false);
      poolLoader!.settleReady();
      await connecting;
      expect(settled).toBe(true);
    });
  });
}

function registerCase8(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("连接与断开写状态交错后重启仍保持停止", async () => {
      const { manager } = await pendingServer();
      const deps = orchestratorPorts.get();
      const originalStore = deps.configStore;
      let firstStarted = false;
      let secondStarted = false;
      let releaseFirst: () => void = () => {};
      let finishFirst: () => void = () => {};
      let finishSecond: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstDone = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      const secondDone = new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      deps.configStore = {
        ...originalStore,
        async saveUserState(file, units) {
          const snapshot = new Map(
            [...units].map(([root, unit]) => [
              root,
              { ...unit, userDisabled: new Set(unit.userDisabled) },
            ]),
          );
          if (!firstStarted) {
            firstStarted = true;
            await firstGate;
            try {
              await originalStore.saveUserState(file, snapshot);
            } finally {
              finishFirst();
            }
          } else {
            secondStarted = true;
            try {
              await originalStore.saveUserState(file, snapshot);
            } finally {
              finishSecond();
            }
          }
        },
      };
      try {
        await manager.acceptConnection("pending", "global");
        await pollUntil("连接状态写入已挂起", () => firstStarted);
        const disconnect = manager.disconnectForRequest("pending", "global");
        await pollUntil(
          "断开已标记",
          () => manager.middleware!.disabledByRoot.get("@global")?.has("pending") === true,
        );
        if (secondStarted) await secondDone;
        releaseFirst();
        await disconnect;
        await firstDone;
        await pollUntil("磁盘反映断开", () => secondStarted);
        await secondDone;
        const restarted = managerFixture("dsh-mcp-1187-restart-");
        restarted.manager.userStatePath = manager.userStatePath;
        restarted.store.upsert(normalizeServer(quietServer("pending")));
        await restarted.manager.initMiddleware();
        expect(restarted.manager.middleware!.disabledByRoot.get("@global")?.has("pending")).toBe(
          true,
        );
        expect(summaryView(restarted.manager).servers[0].status).toBe("stopped");
      } finally {
        releaseFirst();
        deps.configStore = originalStore;
      }
    });
  });
}

function registerCase9(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("ledger 挂载后日志捕获失败，重试先释放旧实例再成功", async () => {
      const { manager } = await pendingServer();
      const logs = lifecyclePorts.get().logs;
      const capture = logs.capture;
      logs.capture = () => {
        throw new Error("fixture capture failed");
      };
      try {
        await manager.acceptConnection("pending", "global");
        await pollUntil("日志捕获失败", () => summaryView(manager).servers[0].status === "failed");
        expect(poolLoader!.handles.length).toBe(2);
        const oldHandle = poolLoader!.handles[1];
        logs.capture = capture;
        await manager.acceptConnection("pending", "global");
        await pollUntil("重试挂载新实例", () => poolLoader!.handles.length === 3);
        expect(oldHandle.state.disposed).toBe(true);
        const id = (poolLoader!.handles[2].config as { serverName: string }).serverName;
        (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
          { name: `mcp__${id}__tool` },
        ];
        poolLoader!.settleReady();
        await pollUntil(
          "重试的 id 已回填",
          () =>
            manager.middleware!.units.get("@global")?.connections.get("pending")?.id !== undefined,
        );
        const entry = manager.middleware!.units.get("@global")!.connections.get("pending")!;
        expect(mountLedger.get(entry.id!)).toBeDefined();
        expect(poolLoader!.handles[2].state.disposed).toBe(false);
        expect(entry.error).toBeUndefined();
        expect(entry.status).toBe("connected");
      } finally {
        logs.capture = capture;
        poolLoader!.settleReady();
      }
    });
  });
}

function registerCase10(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("宿主 disconnect 取消仍在项目配置校验中的 HTTP 连接", async () => {
      const { dir, manager } = await pendingServer();
      mkdirSync(join(dir, ".git"), { recursive: true });
      const store = new McpStore(join(dir, "project.json"));
      store.upsert(normalizeServer(quietServer("pending")));
      manager.projectRoot = dir;
      manager.projectStore = store;
      manager.projectStores.set(dir, store);
      const original = manager.projectStoreFor.bind(manager);
      let release: () => void = () => {};
      let started = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      manager.projectStoreFor = async (root) => {
        started = true;
        await gate;
        return original(root);
      };
      const accepted = manager.acceptConnection("pending", "project", dir);
      const result = accepted.then(
        () => "accepted",
        () => "cancelled",
      );
      await pollUntil("项目校验开始", () => started);
      await manager.disconnect("pending", "project");
      release();
      expect(await result).toBe("cancelled");
      expect(poolLoader!.handles.length).toBe(0);
    });
  });
}

function registerCase11(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("项目请求的空 cwd 不回落到其他会话", async () => {
      const { dir, manager } = await pendingServer();
      const store = new McpStore(join(dir, "project.json"));
      store.upsert(normalizeServer(quietServer("pending")));
      manager.projectRoot = dir;
      manager.projectStore = store;
      manager.projectStores.set(dir, store);
      await expect(manager.acceptConnection("pending", "project", "")).rejects.toThrow();
      expect(poolLoader!.handles.length).toBe(0);
    });
  });
}

function registerCase12(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("失败后 SSE 通知可读取脱敏摘要", async () => {
      const { manager, store } = await pendingServer();
      const secret = "fixture-private-value-1187";
      store.upsert(normalizeServer(quietServer("pending", { env: { TOKEN: secret } })));
      const originalLoad = poolLoader!.load;
      let rejectLoad: (error: Error) => void = () => {};
      let loadStarted = false;
      poolLoader!.load = () => {
        loadStarted = true;
        return new Promise((_, reject) => {
          rejectLoad = reject;
        });
      };
      const res = fakeRes();
      makeEventsRoute(manager).handler(unitShapeFakeReq("GET", ROUTES.events), res);
      const observed: unknown[] = [];
      const off = manager.onStatus(() => {
        observed.push(summaryView(manager).servers[0].status);
        manager.sseHub?.broadcast(sseData({ type: "summary" }));
      });
      try {
        const route = makeRoutes(manager).find((item) => item.path === ROUTES.connect)!;
        expect(
          (
            await callHandler(
              route,
              unitShapeFakeReq("POST", `${ROUTES.connect}?name=pending&scope=global`),
            )
          ).status,
        ).toBe(202);
        await pollUntil("SDK load 已发起", () => loadStarted);
        await pollUntil("连接中 SSE 状态广播", () => observed.includes("connecting"));
        const beforeFailure = res.state.body;
        rejectLoad(new Error(`SDK failed ${secret}`));
        await pollUntil("失败状态 SSE 广播", () => observed.includes("failed"));
        expect(res.state.body.slice(beforeFailure.length)).toContain('"type":"summary"');
        const summary = JSON.stringify(manager.summary());
        expect(summary).toContain("SDK failed");
        expect(summary).toContain("[REDACTED]");
        expect(summary).not.toContain(secret);
        expect(res.state.body).not.toContain(secret);
      } finally {
        off();
        manager.sseHub?.dispose();
        poolLoader!.load = originalLoad;
      }
    });
  });
}

function registerCase13(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("HTTP 失败后宿主成功连接不保留失败覆盖状态", async () => {
      const { manager } = await pendingServer();
      const originalLoad = poolLoader!.load;
      poolLoader!.load = async () => {
        throw new Error("fixture load failed");
      };
      await manager.acceptConnection("pending", "global");
      await pollUntil(
        "HTTP 失败状态可读",
        () => summaryView(manager).servers[0].status === "failed",
      );
      poolLoader!.load = originalLoad;
      const connecting = manager.connect("pending", "global");
      await pollUntil("宿主重新挂载", () => poolLoader!.handles.length === 1);
      poolLoader!.settleReady();
      await connecting;
      const id = manager.middleware!.units.get("@global")!.connections.get("pending")!.id;
      expect(id).toBeDefined();
      (manager.ctx.tools as unknown as { entries: FakeToolEntry[] }).entries = [
        { name: `mcp__${id}__tool` },
      ];
      expect(summaryView(manager).servers[0].status).toBe("connected");
      expect(JSON.stringify(manager.summary())).not.toContain("fixture load failed");
    });
  });
}

function registerCase14(): void {
  describe("HTTP 连接受理与宿主连接", () => {
    it("同名项目连接按请求 root 隔离，切换会话不改变在途连接", async () => {
      const { dir, manager } = await pendingServer();
      const roots = [join(dir, "one"), join(dir, "two")];
      for (const root of roots) {
        mkdirSync(join(root, ".git"), { recursive: true });
        const store = new McpStore(join(root, "project.json"));
        store.upsert(normalizeServer(quietServer("pending")));
        manager.projectStores.set(root, store);
      }
      await manager.setSession(roots[0]);
      await manager.acceptConnection("pending", "project", roots[0]);
      await manager.setSession(roots[1]);
      await manager.acceptConnection("pending", "project", roots[1]);
      await pollUntil("两个 root 均已挂载", () => poolLoader!.handles.length === 2);
      expect(manager.middleware!.units.get(roots[0])!.connections.has("pending")).toBe(true);
      expect(manager.middleware!.units.get(roots[1])!.connections.has("pending")).toBe(true);
      await manager.disconnectForRequest("pending", "project", roots[0]);
      expect(manager.middleware!.units.get(roots[0])!.connections.has("pending")).toBe(false);
      expect(manager.middleware!.units.get(roots[1])!.connections.has("pending")).toBe(true);
      poolLoader!.settleReady();
    });
  });
}
