/**
 * middleware 单元测试的专属 support。
 *
 * 组合端口由各测试文件显式装卸；每个文件创建自己的 support 实例，按用例回收
 * middleware、池装载账本与临时目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandServerEnv } from "../../src/server/config/impl/env/index.ts";
import { withTimeout } from "../../src/server/pipeline/impl/timeout/index.ts";
import { OFFICIAL_MCP_CLIENT_SPECIFIER } from "../../src/server/shared/interface.ts";
import {
  installLifecycle,
  mountLedger,
  releaseLifecycle,
} from "../../src/server/servers/lifecycle/interface.ts";
import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import {
  fakeLoaderPort,
  fakeLogsPort,
  fakeToolsService,
  installCompositionPorts,
  releaseCompositionPorts,
  tempCatalogCache,
} from "../helpers.ts";
import type { FakeToolEntry, FakeToolsScript } from "../helpers.ts";
import type { LoaderPort, LogsPort } from "../../src/server/shared/interface.ts";
import type {
  ConnectionEntry,
  McpMiddleware as McpMiddlewareType,
  ProjectUnit,
} from "../../src/server/connection/runtime/interface.ts";
import type { ToolsRegistryPort } from "../../src/server/servers/lifecycle/deps.ts";
import type { ToolExecutionInput, ToolExecutionToken } from "@deepseek-ai/dsh-tools";
import type { ServerConfig } from "../../src/server/config/interface.ts";

export const MIDDLEWARE_SHAPE_ROOT = "/tmp/ws-root-a";
export const MIDDLEWARE_SHAPE_OFFICIAL_MODULE = { name: "test:official", apply: () => {} };

/** 显式装配 composition 外层端口；调用方负责在 beforeAll / afterAll 配对。 */
export function installMiddlewareShapeComposition() {
  installCompositionPorts();
}

export function releaseMiddlewareShapeComposition() {
  releaseCompositionPorts();
}

export interface SeedTool {
  description?: string;
  inputSchema?: unknown;
}

export type SeedCatalogMap = Map<string, { unavailable?: string; tools: Map<string, SeedTool> }>;

export interface DiskSeedEntry {
  discoveredAt: number;
  tools: Map<string, SeedTool>;
  unavailable?: string;
}

export interface MiddlewareShapeSupport {
  readonly root: string;
  makeHost(
    serversByRoot?: Map<string, ServerConfig[]>,
    toolsScript?: FakeToolsScript,
  ): ReturnType<typeof makeHostFactory>;
  installPoolLifecycle(): void;
  readonly poolLoader: ReturnType<typeof fakeLoaderPort>;
  readonly officialModule: typeof MIDDLEWARE_SHAPE_OFFICIAL_MODULE;
  ownTempDir(dir: string): string;
  remoteEntry(
    server: ServerConfig,
    id: string | undefined,
    overrides?: Record<string, unknown>,
  ): ConnectionEntry;
  identity(extra?: Record<string, unknown>): {
    agent?: unknown;
    callId: ToolExecutionInput["callId"];
    rootCallId?: ToolExecutionInput["rootCallId"];
    parent?: ToolExecutionToken;
  };
  trackMw(mw: McpMiddlewareType): McpMiddlewareType;
  seedRoot(root: string, entries: SeedCatalogMap): void;
  seedRootFromDisk(
    root: string,
    entries: Array<[string, DiskSeedEntry]>,
  ): ReturnType<typeof catalogDirectory.ensureRootLoaded>;
  makeUnit(options?: {
    root?: string;
    catalog?: SeedCatalogMap;
    userDisabled?: string[];
    connections?: Map<string, ConnectionEntry>;
  }): ProjectUnit;
  losslessViolation(value: unknown, path?: string): string | undefined;
  cleanup(): Promise<void>;
  readonly catalogCachePath: (root: string) => string;
}

function makeHostFactory(
  support: MiddlewareShapeState,
  serversByRoot: Map<string, ServerConfig[]> = new Map(),
  toolsScript: FakeToolsScript = {},
) {
  const log = { emits: 0, saved: 0 };
  const tools = fakeToolsService(toolsScript);
  support.poolToolsView = () => tools.schemas();
  support.installPoolLifecycle();
  const host = {
    ctx: { tools },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    projectServersFor: async (root: string) => serversByRoot.get(root),
    redactionServers: () => [...serversByRoot.values()].flat(),
    globalServers: () => [],
    normalizedProjectRoot: async (cwd: string | undefined) =>
      typeof cwd === "string" && cwd !== "" ? cwd : undefined,
    saveUserState: async () => {
      log.saved += 1;
    },
    emitStatus: () => {
      log.emits += 1;
    },
    catalogCachePath: support.catalogCachePath,
  };
  return { host, log, tools };
}

class MiddlewareShapeState implements MiddlewareShapeSupport {
  readonly root: string;
  readonly trackedMw: McpMiddlewareType[] = [];
  readonly tempDirs: string[] = [];
  poolToolsView: () => FakeToolEntry[] = () => [];
  private poolLoaderValue?: ReturnType<typeof fakeLoaderPort>;
  private lifecycleInstalled = false;
  private catalogCachePathValue: (root: string) => string;

  constructor(root: string) {
    this.root = root;
    this.catalogCachePathValue = tempCatalogCache((dir) => this.ownTempDir(dir));
  }

  ownTempDir(dir: string) {
    this.tempDirs.push(dir);
    return dir;
  }

  makeHost(
    serversByRoot: Map<string, ServerConfig[]> = new Map(),
    toolsScript: FakeToolsScript = {},
  ) {
    return makeHostFactory(this, serversByRoot, toolsScript);
  }

  installPoolLifecycle() {
    if (this.lifecycleInstalled) return;
    this.poolLoaderValue = fakeLoaderPort({
      modules: {
        [OFFICIAL_MCP_CLIENT_SPECIFIER]: MIDDLEWARE_SHAPE_OFFICIAL_MODULE,
      },
    });
    installLifecycle({
      loader: this.poolLoaderValue as unknown as LoaderPort,
      pipeline: { withTimeout },
      workspace: fakeIdTable(),
      config: { expandServerEnv },
      tools: { schemas: () => this.poolToolsView() } as unknown as ToolsRegistryPort,
      logs: fakeLogsPort() as unknown as LogsPort,
    });
    this.lifecycleInstalled = true;
  }

  get poolLoader() {
    if (this.poolLoaderValue === undefined) {
      throw new Error("middleware-shape pool loader has not been installed");
    }
    return this.poolLoaderValue;
  }

  readonly officialModule = MIDDLEWARE_SHAPE_OFFICIAL_MODULE;

  remoteEntry(
    server: ServerConfig,
    id: string | undefined,
    overrides: Record<string, unknown> = {},
  ): ConnectionEntry {
    return {
      server,
      id,
      handle: undefined,
      status: "connected",
      error: undefined,
      connectedAt: Date.now(),
      readySettled: true,
      everConnected: true,
      disposed: false,
      ...overrides,
    } as unknown as ConnectionEntry;
  }

  identity(extra: Record<string, unknown> = {}) {
    return { callId: "call-1" as unknown as ToolExecutionInput["callId"], ...extra };
  }

  trackMw(mw: McpMiddlewareType) {
    this.trackedMw.push(mw);
    return mw;
  }

  seedRoot(root: string, entries: SeedCatalogMap) {
    catalogDirectory.dropRoot(root);
    for (const [serverName, entry] of entries) {
      if (entry.unavailable !== undefined) {
        catalogDirectory.projectWrappedTools({ root, serverName, definitions: [] });
        catalogDirectory.markUnavailable(root, serverName, entry.unavailable);
        continue;
      }
      catalogDirectory.projectWrappedTools({
        root,
        serverName,
        definitions: [...entry.tools].map(([name, tool]) => ({
          name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      });
    }
  }

  seedRootFromDisk(root: string, entries: Array<[string, DiskSeedEntry]>) {
    const dir = this.ownTempDir(mkdtempSync(join(tmpdir(), "dsh-mcp-mw-seed-")));
    const cachePath = join(dir, `${root.replace(/[^a-z0-9]/gi, "_")}.json`);
    const payload: Record<
      string,
      {
        discoveredAt: number;
        tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      }
    > = {};
    for (const [serverName, entry] of entries) {
      payload[serverName] = {
        discoveredAt: entry.discoveredAt,
        tools: [...entry.tools].map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    }
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, root, entries: payload }, null, 2),
      "utf8",
    );
    catalogDirectory.dropRoot(root);
    return catalogDirectory.ensureRootLoaded(root, cachePath);
  }

  makeUnit({
    root = this.root,
    catalog = new Map(),
    userDisabled = [],
    connections,
  }: {
    root?: string;
    catalog?: SeedCatalogMap;
    userDisabled?: string[];
    connections?: Map<string, ConnectionEntry>;
  } = {}): ProjectUnit {
    if (catalog.size > 0) this.seedRoot(root, catalog);
    return {
      root,
      connections: connections ?? new Map(),
      userDisabled: new Set(userDisabled),
      lastTouchedAt: Date.now(),
      inFlight: new Map(),
    };
  }

  losslessViolation(value: unknown, path = "$"): string | undefined {
    if (value === undefined) return `${path} 为 undefined`;
    if (value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = this.losslessViolation(value[i], `${path}[${i}]`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const [key, entry] of Object.entries(value)) {
      const found = this.losslessViolation(entry, `${path}.${key}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async cleanup() {
    for (const mw of this.trackedMw) {
      try {
        await mw.dispose();
      } catch {
        // 收口失败不掩盖用例结论
      }
    }
    this.trackedMw.length = 0;
    if (this.lifecycleInstalled) {
      releaseLifecycle();
      await mountLedger.flushDisposals();
      this.lifecycleInstalled = false;
    }
    for (const dir of this.tempDirs) rmSync(dir, { recursive: true, force: true });
    this.tempDirs.length = 0;
    this.catalogCachePathValue = tempCatalogCache((dir) => this.ownTempDir(dir));
  }

  get catalogCachePath() {
    return this.catalogCachePathValue;
  }
}

export function createMiddlewareShapeSupport(root = MIDDLEWARE_SHAPE_ROOT): MiddlewareShapeSupport {
  return new MiddlewareShapeState(root);
}

/** 假 id 表：按 (scope, name) 稳定返回并自增。 */
export function fakeIdTable() {
  const byKey = new Map<string, string>();
  let seq = 0;
  return {
    idFor(scope: string, name: string) {
      const key = scope + "\u0000" + name;
      let id = byKey.get(key);
      if (id === undefined) {
        seq += 1;
        id = "id-" + seq;
        byKey.set(key, id);
      }
      return id;
    },
  };
}
