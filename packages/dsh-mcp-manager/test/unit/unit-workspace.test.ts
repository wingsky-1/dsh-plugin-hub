// @ts-nocheck
/**
 * dsh-mcp-manager — unit：工作空间路由域（src/workspace/，#664 阶段 4）。
 *
 * 覆盖：
 * - makeResolveRoot 基本路由（agent-less → undefined / cwd 项目 root 优先）
 * - B3 红测：all 模式空 cwd 回落 @global 含 runtime 源（runtimeRegistry 并集）
 *
 * 其余域函数（findProjectRoot/normalizedProjectRoot/full-name/scope/
 * middleware-mode）由 unit-manager2 / unit-middleware / unit-transport
 * 既有断言面覆盖（T1：经 lib/index.js 公共 re-export 面）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  McpManager,
  McpStore,
  makeResolveRoot,
  normalizeServer,
  MIDDLEWARE_GLOBAL_ROOT,
} = await import("../../lib/index.js");

// ---- makeResolveRoot 基本路由（迁移自 apply-runtime.ts，行为不变） ----

{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-ws-"));
  try {
    const store = new McpStore(join(dir, "global.json"));
    store.data = { version: 1, servers: [] };
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
    manager.middlewareMode = "project";
    const resolveRoot = makeResolveRoot(manager);

    // agent-less → undefined（不回落）。
    assert.equal(await resolveRoot(null), undefined, "agent-less 返回 undefined");
    assert.equal(await resolveRoot({ session: { header: { cwd: "/proj" } } }), "/proj", "project 模式 cwd 归一化项目根优先");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- B3 红测：all 模式空 cwd 回落 @global 含 runtime 源 ----
// 现状：makeResolveRoot 回落只查 globalServers()=store.data.servers（manager.ts
// L269），不含 runtimeRegistry 注入服务器 → 仅 runtime 服务器（codegraph 等）时
// 回落 undefined（「无法确定工作空间」）；修复（requirements 8.1 纠偏）：改查
// projectServersFor("@global")（含 runtime 并集）。
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-ws-b3-"));
  try {
    const store = new McpStore(join(dir, "global.json"));
    store.data = { version: 1, servers: [] }; // 无 store 全局服务器（仅 runtime 注入）
    const manager = new McpManager({ logger: { warn: () => {}, info: () => {} } }, store);
    manager.middlewareMode = "all";
    // codegraph 等 runtime 注入服务器不落 store，只进 runtimeRegistry（#413）。
    manager.runtimeRegistry.set("cg", normalizeServer({ name: "cg", transport: "stdio", command: "dsh-noop-cmd" }));
    const resolveRoot = makeResolveRoot(manager);

    // 会话无 cwd（空 cwd）→ all 模式回落应含 runtime 源 → @global。
    const root = await resolveRoot({ session: { header: {} } });
    assert.equal(root, MIDDLEWARE_GLOBAL_ROOT, "B3：all 模式空 cwd 回落 @global 含 runtime 源");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
