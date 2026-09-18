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
 * unit-manager2 / unit-middleware 既有断言面覆盖（T1：经 src/index.ts 公共 re-export 面）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeManagerCtx } from "../helpers.ts";

// I8 判定（S6 实测回退）：本文件构造 McpManager，而编排子层端口表只在包根组合根
// （src/index.ts 顶层 installOrchestrator）装配、且重复装配当场抛错——直引域门面会跳过装配、
// 构造即红（实测 exit 1）。故保留包根导入（基线 unitImportFaceViolations 条目保留）；
// 把组合根装配搬进门面属运行时改动，越界（见遗留）。
// S6-B2：McpManager 构造是装配依赖，留包根（理由见上）；其余纯符号改道域门面。
const { McpManager } = await import("../../src/index.ts");
const { McpStore } = await import("../../src/server/store/interface.ts");
const { makeResolveRoot, normalizeScope } = await import("../../src/server/workspace/interface.ts");
const { normalizeServer } = await import("../../src/server/config/interface.ts");
const { MIDDLEWARE_GLOBAL_ROOT, SCOPE_GLOBAL, SCOPE_PROJECT } =
  await import("../../src/shared/interface.ts");

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
