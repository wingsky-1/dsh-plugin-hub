/** Manager 方法面的自然职责测试与专属fixture。 */
import { createHash } from "node:crypto";

import { mkdirSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import type { McpManager as McpManagerType } from "../../src/server/connection/orchestrator/interface.ts";

import type { ServerConfig } from "../../src/server/config/interface.ts";

import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import { makeManager, makeTempDir } from "./manager-shape-support.ts";

let prevHome: string | undefined;

let homeDir: string;

const catalogFileFor = (root: string) =>
  join(
    homeDir,
    "@wingsky-1",
    "dsh-mcp-manager",
    "catalog",
    `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`,
  );

/** 单元夹具 + 目录登记：目录内存态归 catalog 域（#767 S1-3b），单元只留连接/禁用面。 */
const unitFor = (
  root: string,
  catalogEntries: Record<
    string,
    {
      tools: Map<string, { description?: string; inputSchema?: unknown }>;
      unavailable?: string;
      discoveredAt: number;
    }
  >,
) => {
  catalogDirectory.dropRoot(root);
  for (const [serverName, entry] of Object.entries(catalogEntries)) {
    catalogDirectory.projectWrappedTools({
      root,
      serverName,
      definitions: [...entry.tools].map(([name, tool]) => ({
        name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    });
    if (entry.unavailable !== undefined) {
      catalogDirectory.markUnavailable(root, serverName, entry.unavailable);
      continue;
    }
    // 夹具要的是显式时间戳（1 = 很久以前），投影写口恒写 now，故就地校正。
    // 刚投影的条目恒存在，此处断言存在。
    catalogDirectory.serversFor(root)!.get(serverName)!.discoveredAt = entry.discoveredAt;
  }
  return {
    root,
    connections: new Map(),
    userDisabled: new Set(),
    lastTouchedAt: Date.now(),
    inFlight: new Map(),
  };
};

// 目录视图输入面（只读 server.name/scope）：条目按读取面收窄，容器按被测签名收窄。
const serversWith = (entries: Record<string, { server: { name: string }; scope: string }>) =>
  new Map(Object.entries(entries)) as unknown as Map<
    string,
    { server: ServerConfig; scope: string }
  >;

async function catalogViewFixture() {
  // 项目 root 夹具用真实目录 + .git 标记：findProjectRoot 从该目录起步必然原样
  // 返回（跨平台确定，POSIX 字符串 "/proj" 在 Windows resolve 后形态不一致）。
  const projDir = join(homeDir, "proj");
  mkdirSync(join(projDir, ".git"), { recursive: true });
  const { manager } = makeManager(homeDir);
  const mw = { units: new Map() };
  // B 缓存基底：supervisor 路径旧摘要（应被中间层覆盖 / 保留兜底）。
  manager.catalogCache.set("g1", { summary: "B-global-g1" });
  manager.catalogCache.set("g2", { summary: "B-global-g2" });
  manager.catalogCache.set("p1", { summary: "B-project-p1" });
  manager.catalogCache.set("p2", { summary: "B-project-p2" });
  // 只有 units 面的池替身（目录视图不读池内条目）：按接缝收窄。
  manager.middleware = mw as unknown as McpManagerType["middleware"];
  // 目录内存态是域内单例（跨用例留存），每个场景从这里重新开始。
  catalogDirectory.dropRoot("@global");
  catalogDirectory.dropRoot(projDir);
  return { manager, mw, projDir };
}

/** 场景 1：无中间层单元 → 纯 B 视图（磁盘/摘要兜底；单池 #767 后与模式无关）。 */
async function noUnitView() {
  const { manager, projDir } = await catalogViewFixture();
  const servers = serversWith({
    g1: { server: { name: "g1" }, scope: "global" },
    p1: { server: { name: "p1" }, scope: "project" },
  });
  return { view: await manager.catalogViewFor(projDir, servers) };
}

/** 场景 2：@global 单元含 g1（内存目录）→ 覆盖 B；p1 项目单元覆盖。 */
async function unitView() {
  const { manager, mw, projDir } = await catalogViewFixture();
  mw.units.set(
    "@global",
    unitFor("@global", {
      g1: {
        discoveredAt: 1,
        tools: new Map([["g_search", { description: "Global search the web for facts." }]]),
      },
    }),
  );
  mw.units.set(
    projDir,
    unitFor(projDir, {
      p1: {
        discoveredAt: 1,
        tools: new Map([["p_read", { description: "Project read files." }]]),
      },
    }),
  );
  const servers = serversWith({
    g1: { server: { name: "g1" }, scope: "global" },
    g2: { server: { name: "g2" }, scope: "global" },
    p1: { server: { name: "p1" }, scope: "project" },
  });
  return { view: await manager.catalogViewFor(projDir, servers) };
}

/** 场景 3：project scope → 项目单元；global scope 无 @global 单元 → B；
 *  场景 4：中间层有 unavailable → 视为无 → 磁盘兜底/保留 B。 */
async function projectView() {
  const { manager, mw, projDir } = await catalogViewFixture();
  mw.units.clear();
  mw.units.set(
    projDir,
    unitFor(projDir, {
      p1: {
        discoveredAt: 1,
        tools: new Map([["p_read", { description: "Project read files." }]]),
      },
      p2: { discoveredAt: 1, tools: new Map(), unavailable: "discovery failed" },
    }),
  );
  const servers = serversWith({
    g1: { server: { name: "g1" }, scope: "global" },
    p1: { server: { name: "p1" }, scope: "project" },
    p2: { server: { name: "p2" }, scope: "project" },
  });
  return { view: await manager.catalogViewFor(projDir, servers) };
}

/** 场景 5：磁盘 last-good 兜底（单元缺失但 A 文件有该服务器）。 */
async function diskView() {
  const { manager, mw } = await catalogViewFixture();
  mw.units.clear(); // 单元全部缺失
  const diskRoot = "@global";
  const file = catalogFileFor(diskRoot);
  mkdirSync(join(homeDir, "@wingsky-1", "dsh-mcp-manager", "catalog"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      root: diskRoot,
      entries: {
        g1: {
          discoveredAt: 1,
          tools: [{ name: "g_search", description: "Disk cached global search." }],
        },
      },
    }),
  );
  const servers = serversWith({
    g1: { server: { name: "g1" }, scope: "global" },
    g2: { server: { name: "g2" }, scope: "global" },
  });
  return { view: await manager.catalogViewFor(undefined, servers) };
}
export {
  catalogFileFor,
  catalogViewFixture,
  diskView,
  homeDir,
  noUnitView,
  prevHome,
  projectView,
  serversWith,
  unitFor,
  unitView,
};
export function registerCatalogViewHooks() {
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-catview-");
    process.env.DSH_HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
}
