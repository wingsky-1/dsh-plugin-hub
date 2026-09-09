// @ts-nocheck
/**
 * dsh-provider-usage — unit：StatsService 缓存面（D7 阶段一）
 *
 * L1 层内 + L2 契约（refactor-implementation-plan.md §2.1）：
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
import { assert, pollUntil } from "./helpers.ts";
import { normalizeConfig } from "../src/shared/config.ts";
import { makeAdapterRegistry } from "../src/domain1/registry/registry.ts";
import { HistoryStore } from "../src/domain1/history/history.ts";
import { panelCacheKey } from "../src/domain1/pipeline/v2.ts";
import { StatsService } from "../src/domain1/pipeline/stats-service.ts";

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

// ---- getPanelResult：命中 / miss / 失败不写（L2 契约四段语义）
{
  const { service, registry, spy } = makeService();
  const entry = entryOf(registry);
  const key = panelCacheKey("pv", entry.name, range);

  const first = await service.getPanelResult("pv", entry, range);
  assert.equal(first.error, undefined, "首次 miss：管道产出无 error");
  assert.equal(spy.panelCalls, 1, "首次 miss 执行 formatPanel 一次");
  assert.ok(service.panelCache.has(key), "成功结果写缓存");

  const second = await service.getPanelResult("pv", entry, range);
  assert.equal(second.panelHtml, "<table/>", "命中返回缓存结果");
  assert.equal(spy.panelCalls, 1, "命中不再执行 formatPanel");
}

// ---- getPanelResult：失败不写缓存（下次仍 miss 重跑）
{
  const { service, registry, spy } = makeService({ spy: { failPanel: true } });
  const entry = entryOf(registry);
  const key = panelCacheKey("pv", entry.name, range);

  const f1 = await service.getPanelResult("pv", entry, range);
  assert.ok(f1.error !== undefined && f1.error.includes("panel-boom"), "formatPanel 抛错透传 error");
  assert.ok(!service.panelCache.has(key), "失败结果不写缓存（AC 语义）");

  const f2 = await service.getPanelResult("pv", entry, range);
  assert.equal(spy.panelCalls, 2, "失败后同 key 仍 miss，formatPanel 再执行");
}

// ---- getPanelResult：跨自然日不同 key、同日漂移同 key（S0 归一语义走服务方法）
{
  const { service, registry, spy } = makeService();
  const entry = entryOf(registry);
  const t1 = new Date(2026, 1, 10, 9, 0).getTime();
  const t2 = new Date(2026, 1, 10, 21, 0).getTime();
  const nextDay = new Date(2026, 1, 11, 0, 0).getTime();

  await service.getPanelResult("pv", entry, { start: t1, end: t2 });
  assert.equal(spy.panelCalls, 1, "首次执行");
  const inDay = await service.getPanelResult("pv", entry, { start: t1 + 5000, end: t2 + 1500 });
  assert.equal(inDay.error, undefined, "同日漂移命中缓存");
  assert.equal(spy.panelCalls, 1, "同日漂移不重跑");
  await service.getPanelResult("pv", entry, { start: t1, end: nextDay });
  assert.equal(spy.panelCalls, 2, "跨自然日不同 key 重跑");
}

// ---- per-key 单飞：同 key 并发 miss 不双跑 formatPanel（评审 M2）
{
  let release;
  const gate = new Promise((res) => { release = res; });
  const { service, registry, spy } = makeService({ spy: { panelGate: gate } });
  const entry = entryOf(registry);

  const p1 = service.getPanelResult("pv", entry, range);
  const p2 = service.getPanelResult("pv", entry, range);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.panelHtml, "<table/>", "并发共享同一结果");
  assert.equal(r2.panelHtml, "<table/>", "并发共享同一结果");
  assert.equal(spy.panelCalls, 1, "同 key 并发 miss 只执行一次 formatPanel（in-flight 去重）");
}

// ---- purgeAllCaches：清 cache+panelCache，后续重新 miss（评审 M1 收口面）
{
  const { service, registry, spy } = makeService();
  const entry = entryOf(registry);

  await service.getStats("pv");
  assert.equal(service.cacheSize(), 1, "getStats 写 cache");
  await service.getPanelResult("pv", entry, range);
  assert.ok(service.panelCache.size >= 1, "getPanelResult 写 panelCache");
  const callsBeforePurge = spy.panelCalls;

  service.purgeAllCaches();
  assert.equal(service.cacheSize(), 0, "purgeAllCaches 清空 cache");
  assert.equal(service.panelCache.size, 0, "purgeAllCaches 清空 panelCache");

  await service.getPanelResult("pv", entry, range);
  assert.equal(spy.panelCalls, callsBeforePurge + 1, "purge 后再次 miss 重跑");
}

// ---- generation 失效：在途 getStats 期间 purgeAllCaches → 旧结果不污染新缓存（评审 M1）
{
  let release;
  const gate = new Promise((res) => { release = res; });
  const { service, spy } = makeService({ spy: { fetchGate: gate } });

  const inflight = service.getStats("pv");
  await pollUntil(() => spy.fetchEntered); // 等待 fetchData 进入挂起（gen 快照已取）
  service.purgeAllCaches(); // 在途取数挂起期间清缓存 + 递增 generation
  release();
  const result = await inflight;
  assert.equal(result.ok, true, "在途取数完成不失败");
  assert.equal(spy.fetchCalls, 1, "取数执行一次");
  assert.equal(service.cacheSize(), 0, "generation 失效：在途旧结果不写回新缓存");

  await service.getStats("pv");
  assert.equal(spy.fetchCalls, 2, "重新取数");
  assert.equal(service.cacheSize(), 1, "新取数结果正常入缓存");
}