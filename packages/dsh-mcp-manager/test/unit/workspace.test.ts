/**
 * dsh-mcp-manager — unit：工作空间路由域（src/workspace/，#664 阶段 4）。
 *
 * 覆盖：
 * - makeResolveRoot 基本路由（agent-less → undefined / cwd 项目 root 优先）
 * - B3 红测：空 cwd 回落 @global 含 runtime 源（runtimeRegistry 并集）
 *
 * - normalizeScope 全分支（#767 S1-5c 自 unit-transport.test.ts 迁入：被测对象是 workspace
 *   域的纯函数，且是全仓唯一覆盖点——随自研连接栈退役，原宿主文件已删）
 *
 * 其余域函数（findProjectRoot/normalizedProjectRoot/full-name）由
 * unit-manager2 / unit-middleware 既有断言面覆盖（T1：经域门面 re-export 面）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as storeApi from "../../src/server/store/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import * as runtimeApi from "../../src/server/connection/runtime/interface.ts";
import * as lifecycleApi from "../../src/server/servers/lifecycle/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as upgradeApi from "../../src/server/upgrade/interface.ts";
import { fakeManagerCtx } from "../helpers.ts";

// I8①：单元层不得值引组合根 src/index.ts——本文件只取 workspace 域门面与 McpManager 门面，
// 编排子层端口表按组合根同实参在此手装（与 unit-call-timeout / unit-stats-a4 同一配方），
// 不经组合根求值装配。
const { installOrchestrator, releaseOrchestrator, McpManager } =
  await import("../../src/server/connection/orchestrator/interface.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const { makeResolveRoot, normalizeScope } = await import("../../src/server/workspace/interface.ts");
const { normalizeServer } = await import("../../src/server/config/interface.ts");
const { MIDDLEWARE_GLOBAL_ROOT, SCOPE_GLOBAL, SCOPE_PROJECT } =
  await import("../../src/shared/interface.ts");

/**
 * 编排子层端口表：九组实参与组合根 src/index.ts 顶层 installOrchestrator 调用逐项同源
 * （静态模块引用，无需宿主 ctx 或配置）。重复装配当场抛错，故本文件只装一次。
 */
function installOrchestratorPorts(): void {
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

installOrchestratorPorts();

afterAll(() => {
  releaseOrchestrator();
});

describe("normalizeScope（#767 S1-5c 自 unit-transport.test.ts 迁入）", () => {
  it("project → SCOPE_PROJECT", () => {
    expect(normalizeScope("project")).toBe(SCOPE_PROJECT);
  });

  it("global → SCOPE_GLOBAL", () => {
    expect(normalizeScope("global")).toBe(SCOPE_GLOBAL);
  });

  it("空串 → SCOPE_GLOBAL", () => {
    expect(normalizeScope("")).toBe(SCOPE_GLOBAL);
  });

  it("大小写敏感回落 global", () => {
    expect(normalizeScope("PROJECT")).toBe(SCOPE_GLOBAL);
  });

  it("未知值回落 global", () => {
    expect(normalizeScope("whatever")).toBe(SCOPE_GLOBAL);
  });
});

describe("makeResolveRoot 基本路由（迁移自 apply-runtime.ts，行为不变）", () => {
  let dir: string;
  let resolveRoot: (agent: unknown) => Promise<string | undefined>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-ws-"));
    const store = new McpStore(join(dir, "global.json"));
    store.data = { version: 1, servers: [] };
    const manager = new McpManager(fakeManagerCtx(), store);
    resolveRoot = makeResolveRoot(manager);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("agent-less 返回 undefined", async () => {
    expect(await resolveRoot(null)).toBeUndefined();
  });

  it("cwd 归一化项目根优先（不回落 @global）", async () => {
    expect(await resolveRoot({ session: { header: { cwd: "/proj" } } })).toBe("/proj");
  });
});

// B3 红测：空 cwd 回落 @global 含 runtime 源 ----
// 现状：makeResolveRoot 回落只查 globalServers()=store.data.servers（manager.ts
// L269），不含 runtimeRegistry 注入服务器 → 仅 runtime 服务器（codegraph 等）时
// 回落 undefined（「无法确定工作空间」）；修复（requirements 8.1 纠偏）：改查
// projectServersFor("@global")（含 runtime 并集）。
// #767 笔 1a：这道回落**去掉了 all 条件**（可达性三件套之二）——本组判据与模式无关。
describe("B3 / #767 笔 1a：空 cwd 无条件回落 @global（含 runtime 源）", () => {
  let dir: string;
  let resolveRoot: (agent: unknown) => Promise<string | undefined>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mcp-ws-b3-"));
    const store = new McpStore(join(dir, "global.json"));
    store.data = { version: 1, servers: [] }; // 无 store 全局服务器（仅 runtime 注入）
    const manager = new McpManager(fakeManagerCtx(), store);
    // codegraph 等 runtime 注入服务器不落 store，只进 runtimeRegistry（#413）。
    manager.runtimeRegistry.set(
      "cg",
      normalizeServer({ name: "cg", transport: "stdio", command: "dsh-noop-cmd" }),
    );
    resolveRoot = makeResolveRoot(manager);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("B3：空 cwd 回落 @global 含 runtime 源", async () => {
    // 会话无 cwd（空 cwd）→ 回落应含 runtime 源 → @global（无条件，不再看模式）。
    const root = await resolveRoot({ session: { header: {} } });
    expect(root).toBe(MIDDLEWARE_GLOBAL_ROOT);
  });
});
