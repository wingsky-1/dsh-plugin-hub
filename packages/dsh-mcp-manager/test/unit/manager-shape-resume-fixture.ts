/** Manager 方法面的自然职责测试与专属fixture。 */

import { afterEach, beforeEach, expect } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { FakeToolEntry } from "../helpers.ts";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import {
  makeTempDir,
  managerFixture,
  normalizeServer,
  poolLoader,
  quietServer,
} from "./manager-shape-support.ts";

let prevHome: string | undefined;

let homeDir: string;

/** 真实 manager + 真实中间层：全局 store 含单台，中间层已装配。 */
async function liveGlobal(name: string, extra: Record<string, unknown> = {}) {
  const fixture = managerFixture("dsh-mcp-mgr2live-");
  fixture.store.upsert(normalizeServer(quietServer(name, extra)));
  await fixture.manager.initMiddleware();
  return fixture;
}

/** 经 reconcile 把全局服务器真装进 @global 单元，等 id 回填（#1091：不等 has() 窗口）。 */
async function connectGlobal(manager: McpManagerType, name: string) {
  manager.reconcileServers();
  await pollUntil(`${name} 真装进池且 id 回填`, () => {
    const entry = manager.middleware!.units.get("@global")?.connections.get(name);
    return entry !== undefined && entry.id !== undefined;
  });
  return manager.middleware!.units.get("@global")!;
}

/** 注册面补前缀（与装载窗口同源的那一份工具服务）：条目投影为 connected。 */
function prefixFor(manager: McpManagerType, root: string, name: string) {
  const entry = manager.middleware!.units.get(root)!.connections.get(name)!;
  const tools = manager.ctx.tools as unknown as { entries: FakeToolEntry[] };
  tools.entries = [{ name: `mcp__${entry.id}__t` }];
  expect(manager.middleware!.statusOf(root, name)).toBe("connected");
  return entry;
}

const mountCount = () => poolLoader!.calls.filter((call) => call[0] === "mount").length;

const disposeCount = () => poolLoader!.calls.filter((call) => call[0] === "dispose").length;
export { connectGlobal, disposeCount, homeDir, liveGlobal, mountCount, prefixFor, prevHome };
export function registerResumeHooks() {
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2live-home-");
    process.env.DSH_HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
}
