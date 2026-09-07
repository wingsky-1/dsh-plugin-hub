import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpStatsCollector } from "../src/call-stats.ts";

test("McpStatsCollector: 默认关闭时完全无 I/O，不写盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-stats-test-"));
  const statsFile = join(dir, "stats.json");
  try {
    const collector = new McpStatsCollector({ enabled: false, filePath: statsFile });
    assert.equal(collector.isEnabled(), false);

    collector.recordCall("codegraph", "codegraph_search", 150, true);
    collector.recordSearch("search query");
    collector.recordList();
    collector.recordDetail("codegraph", "codegraph_search");
    collector.flushSync();

    assert.equal(existsSync(statsFile), false, "关闭时不应生成统计文件");
    const snap = collector.snapshot();
    assert.equal(Object.keys(snap.servers).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("McpStatsCollector: 开启时正确聚合调用与渐进式披露指标并原子落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-stats-test-"));
  const statsFile = join(dir, "stats.json");
  try {
    const collector = new McpStatsCollector({ enabled: true, filePath: statsFile });
    assert.equal(collector.isEnabled(), true);

    // 记录工具调用
    collector.recordCall("codegraph", "codegraph_search", 100, true);
    collector.recordCall("codegraph", "codegraph_search", 200, true);
    collector.recordCall("codegraph", "codegraph_explore", 500, false, "timeout error");
    collector.recordCall("mem0", "memory_search", 50, true);

    // 记录渐进式披露漏斗
    collector.recordSearch("find symbol");
    collector.recordSearch("find symbol");
    collector.recordSearch("");
    collector.recordList("@global/codegraph");
    collector.recordList();
    collector.recordDetail("codegraph", "codegraph_search");

    collector.flushSync();

    assert.equal(existsSync(statsFile), true, "开启后必须生成统计文件");
    const raw = JSON.parse(readFileSync(statsFile, "utf8"));

    // 断言 servers 聚合数据
    assert.equal(raw.servers.codegraph.totalCalls, 3);
    assert.equal(raw.servers.codegraph.successCalls, 2);
    assert.equal(raw.servers.codegraph.failedCalls, 1);

    const searchTool = raw.servers.codegraph.tools.codegraph_search;
    assert.equal(searchTool.calls, 2);
    assert.equal(searchTool.success, 2);
    assert.equal(searchTool.errors, 0);
    assert.equal(searchTool.avgDurationMs, 150);
    assert.equal(searchTool.maxDurationMs, 200);

    const exploreTool = raw.servers.codegraph.tools.codegraph_explore;
    assert.equal(exploreTool.calls, 1);
    assert.equal(exploreTool.success, 0);
    assert.equal(exploreTool.errors, 1);
    assert.equal(exploreTool.lastError, "timeout error");

    assert.equal(raw.servers.mem0.totalCalls, 1);
    assert.equal(raw.servers.mem0.tools.memory_search.calls, 1);

    // 断言 disclosure 渐进式披露漏斗
    assert.equal(raw.disclosure.searches["find symbol"], 2);
    assert.equal(raw.disclosure.searches["<empty>"], 1);
    assert.equal(raw.disclosure.lists["@global/codegraph"], 1);
    assert.equal(raw.disclosure.lists["<all>"], 1);
    assert.equal(raw.disclosure.details["codegraph/codegraph_search"], 1);

    // 测试重启恢复能力（从已存在的文件加载）
    const collector2 = new McpStatsCollector({ enabled: true, filePath: statsFile });
    const snap2 = collector2.snapshot();
    assert.equal(snap2.servers.codegraph.totalCalls, 3);
    assert.equal(snap2.disclosure.searches["find symbol"], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("McpManager & routes: 前端 POST /config 不会覆盖抹除已有的 debug 配置", async () => {
  const { McpManager, McpStore, resolveDebugConfig } = await import("../lib/index.js");
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-guard-"));
  try {
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager({ logger: { info: () => {}, warn: () => {} } } as any, store);

    let persistedSettings: Record<string, unknown> = {
      ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 }, zIndexBase: 10 },
      debug: { callStats: true, statsFile: "/tmp/custom.json" },
    };

    manager.uiConfigSource = () => persistedSettings;
    manager.uiUpdate = async (patch: Record<string, unknown>) => {
      // 模拟 settings.update 行为：合并 patch，不抹除不在 patch 中的字段
      persistedSettings = { ...persistedSettings, ...patch };
      return persistedSettings;
    };

    // 前端更新 UI（只提交扁平 UI 参数）
    await manager.updateUiConfig({ position: "bottom-left", offsetX: 10, offsetY: 20 });

    // 验证 debug 没有被抹除
    assert.equal((persistedSettings.debug as any)?.callStats, true);
    assert.equal((persistedSettings.debug as any)?.statsFile, "/tmp/custom.json");

    // 验证 debug 解析依然生效
    const debugCfg = resolveDebugConfig(undefined, persistedSettings);
    assert.equal(debugCfg.callStats, true);
    assert.equal(debugCfg.statsFile, "/tmp/custom.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

