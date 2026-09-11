// @ts-nocheck
/**
 * dsh-mcp-manager — unit：McpStatsCollector 全形态 + 配置域接线。
 *
 * 本文件原为 node:test 零执行孤儿（unit-call-stats.test.ts 不在 smoke import、
 * 不在任何 stryker testFiles、不在 mutation-topology.json——B2 未被发现的直接
 * 原因之一）。issue #664 阶段 1 改造为与其余 unit 一致的形态，并登记进
 * mutation-topology testFiles（#690 S2 起 smoke import 聚合已移除，单份断言服务
 * 包内 runner 与 stryker tap-runner）。
 *
 * 覆盖：
 * - 默认关闭：完全无 I/O、零写盘、快照零服务器
 * - 开启：聚合（total/success/failed + 每工具指标）+ 渐进式披露漏斗 + 原子落盘
 *   + 进程重启恢复（从已存在文件加载）
 * - 配置守护：updateUiConfig 不抹除既有 debug 配置
 * - B2（修复红测）：configure({enabled:false}) 关闭前最后一批脏数据必须刷盘
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { McpStatsCollector, McpManager, McpStore, resolveDebugConfig } = await import("../../src/index.ts");

let tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-stats-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("默认关闭时完全无 I/O，不写盘", () => {
  function disabledFixture() {
    const dir = tempDir();
    const statsFile = join(dir, "stats.json");
    const collector = new McpStatsCollector({ enabled: false, filePath: statsFile });
    collector.recordCall("codegraph", "codegraph_search", 150, true);
    collector.recordSearch("search query");
    collector.recordList();
    collector.recordDetail("codegraph", "codegraph_search");
    collector.flushSync();
    return { dir, statsFile, collector };
  }

  it("默认关闭时 isEnabled() 为 false", () => {
    const { collector } = disabledFixture();
    expect(collector.isEnabled()).toBe(false);
  });

  it("关闭时不应生成统计文件", () => {
    const { statsFile } = disabledFixture();
    expect(existsSync(statsFile)).toBe(false);
  });

  it("关闭时快照服务器数为 0", () => {
    const { collector } = disabledFixture();
    const snap = collector.snapshot();
    expect(Object.keys(snap.servers).length).toBe(0);
  });
});

describe("开启时正确聚合调用与渐进式披露指标并原子落盘", () => {
  function enabledFixture() {
    const dir = tempDir();
    const statsFile = join(dir, "stats.json");
    const collector = new McpStatsCollector({ enabled: true, filePath: statsFile });

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
    return { statsFile, collector };
  }

  function rawOf(statsFile) {
    return JSON.parse(readFileSync(statsFile, "utf8"));
  }

  it("开启时 isEnabled() 为 true", () => {
    const { collector } = enabledFixture();
    expect(collector.isEnabled()).toBe(true);
  });

  it("开启后必须生成统计文件", () => {
    const { statsFile } = enabledFixture();
    expect(existsSync(statsFile)).toBe(true);
  });

  it("codegraph totalCalls 聚合为 3", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.totalCalls).toBe(3);
  });

  it("codegraph successCalls 聚合为 2", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.successCalls).toBe(2);
  });

  it("codegraph failedCalls 聚合为 1", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.failedCalls).toBe(1);
  });

  it("codegraph_search calls 聚合为 2", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_search.calls).toBe(2);
  });

  it("codegraph_search success 聚合为 2", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_search.success).toBe(2);
  });

  it("codegraph_search errors 聚合为 0", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_search.errors).toBe(0);
  });

  it("codegraph_search avgDurationMs 聚合为 150", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_search.avgDurationMs).toBe(150);
  });

  it("codegraph_search maxDurationMs 聚合为 200", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_search.maxDurationMs).toBe(200);
  });

  it("codegraph_explore calls 聚合为 1", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_explore.calls).toBe(1);
  });

  it("codegraph_explore success 聚合为 0", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_explore.success).toBe(0);
  });

  it("codegraph_explore errors 聚合为 1", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_explore.errors).toBe(1);
  });

  it("codegraph_explore lastError 记录原文", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.codegraph.tools.codegraph_explore.lastError).toBe("timeout error");
  });

  it("mem0 totalCalls 聚合为 1", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.mem0.totalCalls).toBe(1);
  });

  it("mem0 memory_search calls 聚合为 1", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).servers.mem0.tools.memory_search.calls).toBe(1);
  });

  it("disclosure searches 非空查询计 2 次", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).disclosure.searches["find symbol"]).toBe(2);
  });

  it("disclosure searches 空查询归入 <empty>", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).disclosure.searches["<empty>"]).toBe(1);
  });

  it("disclosure lists 带 scope 键计 1 次", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).disclosure.lists["@global/codegraph"]).toBe(1);
  });

  it("disclosure lists 无 scope 归入 <all>", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).disclosure.lists["<all>"]).toBe(1);
  });

  it("disclosure details 以 server/tool 计 1 次", () => {
    const { statsFile } = enabledFixture();
    expect(rawOf(statsFile).disclosure.details["codegraph/codegraph_search"]).toBe(1);
  });

  it("重启恢复：新实例读回 codegraph totalCalls 3", () => {
    // 测试重启恢复能力（从已存在的文件加载）
    const { statsFile } = enabledFixture();
    const collector2 = new McpStatsCollector({ enabled: true, filePath: statsFile });
    const snap2 = collector2.snapshot();
    expect(snap2.servers.codegraph.totalCalls).toBe(3);
  });

  it("重启恢复：新实例读回 disclosure searches 2", () => {
    const { statsFile } = enabledFixture();
    const collector2 = new McpStatsCollector({ enabled: true, filePath: statsFile });
    const snap2 = collector2.snapshot();
    expect(snap2.disclosure.searches["find symbol"]).toBe(2);
  });
});

// McpManager & routes: 前端 POST /config 不会覆盖抹除已有的 debug 配置 ----
describe("前端 POST /config 不会覆盖抹除已有的 debug 配置", () => {
  async function updateUiOnly() {
    const dir = tempDir();
    const store = new McpStore(join(dir, "mcp.json"));
    const manager = new McpManager({ logger: { info: () => {}, warn: () => {} } }, store);

    let persistedSettings = {
      ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 }, zIndexBase: 10 },
      debug: { callStats: true, statsFile: "/tmp/custom.json" },
    };

    manager.uiConfigSource = () => persistedSettings;
    manager.uiUpdate = async (patch) => {
      // 模拟 settings.update 行为：合并 patch，不抹除不在 patch 中的字段
      persistedSettings = { ...persistedSettings, ...patch };
      return persistedSettings;
    };

    // 前端更新 UI（只提交扁平 UI 参数）
    await manager.updateUiConfig({ position: "bottom-left", offsetX: 10, offsetY: 20 });
    return {
      persisted: () => persistedSettings,
      debugCfg: () => resolveDebugConfig(undefined, persistedSettings),
    };
  }

  it("更新 UI 后 debug.callStats 未被抹除", async () => {
    const { persisted } = await updateUiOnly();
    expect(persisted().debug?.callStats).toBe(true);
  });

  it("更新 UI 后 debug.statsFile 未被抹除", async () => {
    const { persisted } = await updateUiOnly();
    expect(persisted().debug?.statsFile).toBe("/tmp/custom.json");
  });

  it("debug 解析依然生效（callStats）", async () => {
    const { debugCfg } = await updateUiOnly();
    expect(debugCfg().callStats).toBe(true);
  });

  it("debug 解析依然生效（statsFile）", async () => {
    const { debugCfg } = await updateUiOnly();
    expect(debugCfg().statsFile).toBe("/tmp/custom.json");
  });
});

// B2 红测：configure({enabled:false}) 关闭前最后一批脏数据必须刷盘 ----
describe("B2：configure({enabled:false}) 关闭前最后一批脏数据必须刷盘", () => {
  function configureOffFixture() {
    const dir = tempDir();
    const statsFile = join(dir, "stats.json");
    const collector = new McpStatsCollector({ enabled: true, filePath: statsFile });
    collector.recordCall("codegraph", "codegraph_search", 120, true); // 置脏（防抖 1s 未到）

    // 关闭统计：注释承诺「关闭时 flush」，最后一批不得丢
    collector.configure({ enabled: false });
    return { statsFile, collector };
  }

  it("configure({enabled:false}) 后 isEnabled() 为 false", () => {
    const { collector } = configureOffFixture();
    expect(collector.isEnabled()).toBe(false);
  });

  it("B2：configure 关闭前应刷盘最后一批脏数据（现状 flushSync 因 enabled=false 短路）", () => {
    const { statsFile } = configureOffFixture();
    expect(existsSync(statsFile)).toBe(true);
  });

  it("B2：关闭时最后一批调用计入文件", () => {
    const { statsFile } = configureOffFixture();
    const raw = JSON.parse(readFileSync(statsFile, "utf8"));
    expect(raw.servers.codegraph.totalCalls).toBe(1);
  });
});
