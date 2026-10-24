// dsh-mcp-manager — e2e 工作区族共享夹具（#1174 shape 拆分产物）。
//
// 原 e2e/smoke.test.ts 的「外部配置变更自动重读（refreshFromDisk / reconcileServers）」describe
// 内 beforeAll 装配段：真 store + mkdtemp 隔离目录 + 项目级配置文件直写 + 最小池替身
// （只回答「释放了哪条连接」「确保连接了哪条」）。提成具名工厂后，describe 回调只剩
// it + afterAll，fullName 与断言逐字保留。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeServer } from "../../lib/index.js";
import { McpManager } from "../../src/server/connection/orchestrator/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import { fakeManagerCtx } from "../helpers.ts";

/** 池替身的可观测面（原 describe 内 let 变量的同一集合）。 */
export interface ReloadFixture {
  base: string;
  proj: string;
  cfg: string;
  gstore: McpStore;
  manager: McpManager;
  poolUnit: {
    root: string;
    connections: Map<string, Record<string, unknown>>;
    userDisabled: Set<string>;
    lastTouchedAt: number;
    inFlight: Map<string, Promise<unknown>>;
  };
  released: string[];
  ensured: string[];
}

/** 往池替身里塞一条「已连接」的 ghost 条目（不 spawn 真实连接）。 */
export function seedGhost(fixture: ReloadFixture) {
  fixture.poolUnit.connections.set("ghost", {
    server: normalizeServer({ name: "ghost", transport: "stdio", command: "true" }),
    id: undefined,
    handle: undefined,
    status: "connected",
    error: undefined,
    connectedAt: Date.now(),
    readySettled: true,
    everConnected: true,
    disposed: false,
  });
}

/** 原 describe 内 beforeAll 的装配段（逐字保留）。 */
export async function makeReloadFixture(): Promise<ReloadFixture> {
  const base = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-reload-"));
  const proj = join(base, "proj");
  // S2-b：项目级新形态直写（经 setSession→projectStoreFor 直读；旧扁平只走迁移）。
  const cfg = join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager", "mcp.json");
  mkdirSync(join(proj, ".dsh", "@wingsky-1", "dsh-mcp-manager"), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ version: 1, servers: [] }));
  const gstore = new McpStore(join(base, "dsh-mcp.json"));
  // 全局 disabled 服务器：验证 reconcile 不会为其 spawn 进程。
  gstore.data.servers = [
    normalizeServer({ name: "g1", transport: "stdio", command: "true", enabled: false }),
  ];
  await gstore.save();
  const manager = new McpManager(fakeManagerCtx(), gstore);
  await manager.setSession(proj);
  // 单池（#767 笔 1a）：连接唯一账本是中间层单元表。这里挂一个最小池替身，只回答
  // 「释放了哪条连接」「确保连接了哪条」——真正的装载/拆除语义（releaseServer 的调用序）
  // 由 unit-manager2 的真装载用例（假 loader）钉住。旧直连账本（manager.supervisors）
  // 已整体退役。
  const released: string[] = [];
  const ensured: string[] = [];
  const poolUnit = {
    root: proj,
    connections: new Map<string, Record<string, unknown>>(),
    userDisabled: new Set<string>(),
    lastTouchedAt: Date.now(),
    inFlight: new Map<string, Promise<unknown>>(),
  };
  manager.middleware = {
    units: new Map([[proj, poolUnit]]),
    releaseConnection: (root: string, name: string) => {
      released.push(root + "\u0000" + name);
      return poolUnit.connections.delete(name);
    },
    projectUnitFor: async () => undefined,
    ensureConnected: async (root: string, name: string) => {
      ensured.push(root + "\u0000" + name);
    },
    abandonInFlight: () => {},
    statusOf: () => undefined,
    toolCountOf: () => 0,
    dispose: async () => {},
  } as unknown as McpManager["middleware"];
  const fixture: ReloadFixture = { base, proj, cfg, gstore, manager, poolUnit, released, ensured };
  seedGhost(fixture);
  return fixture;
}
