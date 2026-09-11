// @ts-nocheck
/**
 * dsh-provider-usage — unit：StatsService 缓存面（D7）
 *
 * L1 层内 + L2 契约（refactor-implementation-plan.md §2）：
 * - getPanelResult 四段语义：key 归一（panelCacheKey）→ isPanelCacheStale 命中判定
 *   → miss 删除 → runV2PanelPipeline → 失败不写缓存
 * - per-key 单飞：同 key 并发 miss 共享 in-flight，不双跑 formatPanel
 * - purgeAllCaches：清 cache+panelCache，generation 失效防在途旧结果污染（评审 M1）
 * - cacheSize()：只读观测口（响应字段名 cacheSize 不变，smoke:498-502 依赖）
 * 行为等价：不改变 /stats /history 响应形状（smoke 既有断言归位）
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { pollUntil } from "../../helpers.ts";
import { normalizeConfig } from "../../../src/shared/config.ts";
import { makeAdapterRegistry } from "../../../src/domain1/registry/registry.ts";
import { HistoryStore } from "../../../src/domain1/history/history.ts";
import { panelCacheKey } from "../../../src/domain1/pipeline/v2.ts";
import { StatsService } from "../../../src/domain1/pipeline/stats-service.ts";

function makeService(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "u-usage-stats-"));
  const config = normalizeConfig({
    apiKey: "sk-test",
    apiEndpoint: "http://127.0.0.1:9",
  });
  const registry = makeAdapterRegistry();
  const spy = {
    fetchCalls: 0,
    panelCalls: 0,
    failPanel: false,
    fetchGate: null,
    panelGate: null,
    fetchEntered: false,
    ...(overrides.spy ?? {}),
  };
  registry.register(
    {
      version: 2,
      name: "spy",
      providers: ["pv"],
      async fetchData() {
        spy.fetchCalls += 1;
        spy.fetchEntered = true;
        if (spy.fetchGate !== null) await spy.fetchGate;
        return { v: 1 };
      },
      formatCapsule() {
        return "<b>1</b>";
      },
      async formatPanel() {
        spy.panelCalls += 1;
        if (spy.panelGate !== null) await spy.panelGate;
        if (spy.failPanel) throw new Error("panel-boom");
        return "<table/>";
      },
    },
    "builtin",
  );
  const history = new HistoryStore({
    root: dir,
    maxAgeMs: 30 * 86400000,
    maxSizeBytes: 20 * 1024 * 1024,
  });
  const service = new StatsService({
    ctx: {},
    config,
    historyRoot: dir,
    registry,
    history,
    sanitizeDiagnostic: (s) => s,
    recordAdapterStateDiagnostic: () => {},
  });
  return { service, registry, history, spy, dir, config };
}

const range = { start: 0, end: Date.now() };
const entryOf = (registry) => registry.getEntry("pv");

// 说明：各 describe 的 beforeAll 复现原脚本块的动作序列，并把「每条断言当时读到的
// 观测值」快照下来；每个 it 只负责核对其中一个快照——断言强度与原脚本逐条一致。

describe("getPanelResult：命中 / miss / 失败不写（L2 契约四段语义）", () => {
  let service, spy, key, first, second, panelCallsAfterFirst, cacheHasKeyAfterFirst;

  beforeAll(async () => {
    const h = makeService();
    service = h.service;
    spy = h.spy;
    const entry = entryOf(h.registry);
    key = panelCacheKey("pv", entry.name, range);

    first = await service.getPanelResult("pv", entry, range);
    panelCallsAfterFirst = spy.panelCalls;
    cacheHasKeyAfterFirst = service.panelCache.has(key);
    second = await service.getPanelResult("pv", entry, range);
  });

  it("首次 miss：管道产出无 error", () => {
    expect(first.error).toBe(undefined);
  });

  it("首次 miss 执行 formatPanel 一次", () => {
    expect(panelCallsAfterFirst).toBe(1);
  });

  it("成功结果写缓存", () => {
    expect(cacheHasKeyAfterFirst).toBeTruthy();
  });

  it("命中返回缓存结果", () => {
    expect(second.panelHtml).toBe("<table/>");
  });

  it("命中不再执行 formatPanel", () => {
    expect(spy.panelCalls).toBe(1);
  });
});

describe("getPanelResult：失败不写缓存（下次仍 miss 重跑）", () => {
  let service, spy, key, f1, cacheHasKeyAfterFirstFail;

  beforeAll(async () => {
    const h = makeService({ spy: { failPanel: true } });
    service = h.service;
    spy = h.spy;
    const entry = entryOf(h.registry);
    key = panelCacheKey("pv", entry.name, range);

    f1 = await service.getPanelResult("pv", entry, range);
    cacheHasKeyAfterFirstFail = service.panelCache.has(key);
    await service.getPanelResult("pv", entry, range);
  });

  it("formatPanel 抛错透传 error", () => {
    expect(f1.error !== undefined && f1.error.includes("panel-boom")).toBeTruthy();
  });

  it("失败结果不写缓存（AC 语义）", () => {
    expect(cacheHasKeyAfterFirstFail).toBe(false);
  });

  it("失败后同 key 仍 miss，formatPanel 再执行", () => {
    expect(spy.panelCalls).toBe(2);
  });
});

// ---- getPanelResult：跨自然日不同 key、同日漂移同 key（S0 归一语义走服务方法）
describe("getPanelResult：跨自然日不同 key、同日漂移同 key（S0 归一语义走服务方法）", () => {
  let spy, callsAfterFirst, inDayError, callsAfterInDay, callsAfterNextDay;

  beforeAll(async () => {
    const h = makeService();
    spy = h.spy;
    const entry = entryOf(h.registry);
    const t1 = new Date(2026, 1, 10, 9, 0).getTime();
    const t2 = new Date(2026, 1, 10, 21, 0).getTime();
    const nextDay = new Date(2026, 1, 11, 0, 0).getTime();

    await h.service.getPanelResult("pv", entry, { start: t1, end: t2 });
    callsAfterFirst = spy.panelCalls;

    const inDay = await h.service.getPanelResult("pv", entry, { start: t1 + 5000, end: t2 + 1500 });
    inDayError = inDay.error;
    callsAfterInDay = spy.panelCalls;

    await h.service.getPanelResult("pv", entry, { start: t1, end: nextDay });
    callsAfterNextDay = spy.panelCalls;
  });

  it("首次执行", () => {
    expect(callsAfterFirst).toBe(1);
  });

  it("同日漂移命中缓存", () => {
    expect(inDayError).toBe(undefined);
  });

  it("同日漂移不重跑", () => {
    expect(callsAfterInDay).toBe(1);
  });

  it("跨自然日不同 key 重跑", () => {
    expect(callsAfterNextDay).toBe(2);
  });
});

describe("per-key 单飞：同 key 并发 miss 不双跑 formatPanel（评审 M2）", () => {
  let spy, r1, r2;

  beforeAll(async () => {
    let release;
    const gate = new Promise((res) => { release = res; });
    const h = makeService({ spy: { panelGate: gate } });
    spy = h.spy;
    const entry = entryOf(h.registry);

    const p1 = h.service.getPanelResult("pv", entry, range);
    const p2 = h.service.getPanelResult("pv", entry, range);
    release();
    const both = await Promise.all([p1, p2]);
    r1 = both[0];
    r2 = both[1];
  });

  it("并发共享同一结果", () => {
    expect(r1.panelHtml).toBe("<table/>");
  });

  it("并发共享同一结果", () => {
    expect(r2.panelHtml).toBe("<table/>");
  });

  it("同 key 并发 miss 只执行一次 formatPanel（in-flight 去重）", () => {
    expect(spy.panelCalls).toBe(1);
  });
});

describe("purgeAllCaches：清 cache+panelCache，后续重新 miss（评审 M1 收口面）", () => {
  let spy, callsBeforePurge, cacheSizeAfterStats, panelCacheSizeAfterPanel;
  let cacheSizeAfterPurge, panelCacheSizeAfterPurge, panelCallsAfterPurge;

  beforeAll(async () => {
    const h = makeService();
    spy = h.spy;
    const entry = entryOf(h.registry);

    await h.service.getStats("pv");
    cacheSizeAfterStats = h.service.cacheSize();

    await h.service.getPanelResult("pv", entry, range);
    panelCacheSizeAfterPanel = h.service.panelCache.size;
    callsBeforePurge = spy.panelCalls;

    h.service.purgeAllCaches();
    cacheSizeAfterPurge = h.service.cacheSize();
    panelCacheSizeAfterPurge = h.service.panelCache.size;

    await h.service.getPanelResult("pv", entry, range);
    panelCallsAfterPurge = spy.panelCalls;
  });

  it("getStats 写 cache", () => {
    expect(cacheSizeAfterStats).toBe(1);
  });

  it("getPanelResult 写 panelCache", () => {
    expect(panelCacheSizeAfterPanel >= 1).toBeTruthy();
  });

  it("purgeAllCaches 清空 cache", () => {
    expect(cacheSizeAfterPurge).toBe(0);
  });

  it("purgeAllCaches 清空 panelCache", () => {
    expect(panelCacheSizeAfterPurge).toBe(0);
  });

  it("purge 后再次 miss 重跑", () => {
    expect(panelCallsAfterPurge).toBe(callsBeforePurge + 1);
  });
});

describe("generation 失效：在途 getStats 期间 purgeAllCaches → 旧结果不污染新缓存（评审 M1）", () => {
  let spy, resultOk, fetchCallsAfterInflight, cacheSizeAfterInflight;
  let fetchCallsAfterRefetch, cacheSizeAfterRefetch;

  beforeAll(async () => {
    let release;
    const gate = new Promise((res) => { release = res; });
    const h = makeService({ spy: { fetchGate: gate } });
    spy = h.spy;

    const inflight = h.service.getStats("pv");
    await pollUntil(() => spy.fetchEntered); // 等待 fetchData 进入挂起（gen 快照已取）
    h.service.purgeAllCaches(); // 在途取数挂起期间清缓存 + 递增 generation
    release();
    const result = await inflight;
    resultOk = result.ok;
    fetchCallsAfterInflight = spy.fetchCalls;
    cacheSizeAfterInflight = h.service.cacheSize();

    await h.service.getStats("pv");
    fetchCallsAfterRefetch = spy.fetchCalls;
    cacheSizeAfterRefetch = h.service.cacheSize();
  });

  it("在途取数完成不失败", () => {
    expect(resultOk).toBe(true);
  });

  it("取数执行一次", () => {
    expect(fetchCallsAfterInflight).toBe(1);
  });

  it("generation 失效：在途旧结果不写回新缓存", () => {
    expect(cacheSizeAfterInflight).toBe(0);
  });

  it("重新取数", () => {
    expect(fetchCallsAfterRefetch).toBe(2);
  });

  it("新取数结果正常入缓存", () => {
    expect(cacheSizeAfterRefetch).toBe(1);
  });
});
