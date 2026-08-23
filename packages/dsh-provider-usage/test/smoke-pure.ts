/**
 * dsh-provider-usage — 纯函数 smoke（v2 契约重构版）。
 *
 * 覆盖：esc / 契约校验 / 净化器 / HistoryStore（JSONL 分片）/ safe 守卫 /
 * normalizeConfig / provider-config 配置链 / opencode-go v2 解析 / 热更新加载校验。
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  ROUTES,
  DEFAULT_CONFIG,
  ADAPTER_CONTRACT_VERSION,
  esc,
  isUsageStatsAdapter,
  describeUsageStatsAdapterShape,
  sanitizeHtml,
  HistoryStore,
  parseJsonl,
  startOfDay,
  migrateLegacyV3,
  legacySampleToData,
  safeFetchData,
  safeFormat,
  normalizeConfig,
  resolveProviderConfig,
  credentialsFile,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  openCodeGoAdapter,
  parseUsageResponse,
  fetchOpenCodeGoV2,
  loadAndValidateAdapter,
  readStamp,
  stampEqual,
  makeAdapterRegistry,
} from "../lib/index.js";

// ---------------------------------------------------------------- esc

assert.equal(esc("<script>"), "&lt;script&gt;");
assert.equal(esc(`a"b'c&d`), "a&quot;b&#39;c&amp;d");
assert.equal(esc(null), "");
assert.equal(esc(undefined), "");
assert.equal(esc(123), "123");

// ---------------------------------------------------------------- v2 契约校验

const validAdapter = {
  version: 2,
  name: "my-stats",
  providers: ["p1"],
  fetchData: async () => ({}),
  formatCapsule: () => "<span>x</span>",
  formatPanel: () => "<table></table>",
};

assert.equal(ADAPTER_CONTRACT_VERSION, 2, "新契约版本必须是 2");
assert.equal(isUsageStatsAdapter(validAdapter), true);
assert.equal(isUsageStatsAdapter({ ...validAdapter, version: 1 }), false);
assert.equal(isUsageStatsAdapter({ ...validAdapter, name: "bad name!" }), false);
assert.equal(isUsageStatsAdapter({ ...validAdapter, name: "a" }), false); // 长度 < 2
assert.equal(isUsageStatsAdapter({ ...validAdapter, fetchData: "x" }), false);
assert.equal(isUsageStatsAdapter({ ...validAdapter, formatCapsule: undefined }), false);
assert.equal(isUsageStatsAdapter(null), false);

const shape = describeUsageStatsAdapterShape({ version: 1 });
assert.ok(shape !== null && shape.includes("version"), "形状诊断应包含 version 缺失");
assert.equal(describeUsageStatsAdapterShape(validAdapter), null);

// ---------------------------------------------------------------- sanitize

assert.equal(sanitizeHtml("<script>alert(1)</script><b>ok</b>"), "<b>ok</b>");
assert.equal(sanitizeHtml('<img src="x" onerror="alert(1)">'), '<img src="x">');
assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a href="alert(1)">x</a>');
assert.equal(sanitizeHtml('<iframe src="x"></iframe>y'), "y");

// ---------------------------------------------------------------- HistoryStore（JSONL 按天分片）

{
  const dir = mkdtempSync(join(tmpdir(), "dou-hist-"));
  const store = new HistoryStore({ root: dir, maxAgeMs: 30 * 86400000, maxSizeBytes: 1024 * 1024 });
  const now = Date.now();
  await store.append("prov", "adp", { time: now - 1000, data: { v: 1 } });
  await store.append("prov", "adp", { time: now, data: { v: 2 } });

  const last = await store.last("prov", "adp");
  assert.ok(last !== null && (last.data as Record<string, unknown>).v === 2, "last() 应返回最新一条");

  const q = await store.query("prov", "adp", { start: now - 2000, end: now + 1 });
  assert.equal(q.entries.length, 2, "全量返回不截断");
  assert.equal((q.entries[1].data as Record<string, unknown>).v, 2, "末条为最新采样");

  const none = await store.last("nope", "nope");
  assert.equal(none, null);

  // 坏行跳过
  const dayDir = join(dir, "prov", "adp");
  const files = await import("node:fs/promises").then((m) => m.readdir(dayDir));
  const fp = join(dayDir, files[0]);
  const raw = await import("node:fs/promises").then((m) => m.readFile(fp, "utf8"));
  await import("node:fs/promises").then((m) => m.writeFile(fp, "{broken\n" + raw, "utf8"));
  const afterRaw = await import("node:fs/promises").then((m) => m.readFile(fp, "utf8"));
  assert.equal(parseJsonl(afterRaw).length, 2, "坏行应被跳过不抛错");

  rmSync(dir, { recursive: true, force: true });
}

// startOfDay
{
  const t = new Date(2025, 0, 15, 13, 45).getTime();
  const s = new Date(startOfDay(t));
  assert.equal(s.getHours(), 0);
  assert.equal(s.getDate(), 15);
}

// ---------------------------------------------------------------- v3 旧格式迁移

{
  // legacySampleToData：余额型裸值 + 三窗口 percent
  const rjkData = legacySampleToData([{ key: "balance", name: "余额" }], [1787000000000, 10.1365]);
  assert.deepEqual(rjkData, { balance: 10.1365 }, "balance 列产出裸数值");
  const ogData = legacySampleToData(
    [{ key: "rolling" }, { key: "weekly" }, { key: "monthly" }],
    [1787000000000, 2, 1, 0],
  );
  assert.deepEqual(ogData, { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } }, "三窗口列产出 percent 对象");
  // 无列声明 → colNN 通用装配
  const generic = legacySampleToData(undefined, [1787000000000, 5, 6]);
  assert.deepEqual(generic, { col1: 5, col2: 6 }, "无列声明产出 colNN");

  // migrateLegacyV3：构造 v3 桶 → 迁移 → 校验 JSONL 与 .bak
  const dir = mkdtempSync(join(tmpdir(), "dou-legacy-"));
  const histDir = join(dir, "history", "prov1");
  await import("node:fs/promises").then((m) => m.mkdir(histDir, { recursive: true }));
  const ts = Date.now() - 3600000;
  await import("node:fs/promises").then((m) => m.writeFile(
    join(histDir, "adp1.json"),
    JSON.stringify({
      version: 3,
      provider: "prov1",
      adapterId: "adp1",
      columns: [{ key: "balance", name: "余额" }],
      samples: [[ts - 600000, 9.5], [ts, 9.2]],
    }),
  ));
  const store2 = new HistoryStore({ root: dir, maxAgeMs: 30 * 86400000, maxSizeBytes: 1024 * 1024 });
  const migratedCount = await migrateLegacyV3(dir, store2);
  assert.equal(migratedCount, 2, "迁移 2 个采样点");
  // 新格式可查询（balance 裸值）
  const q = await store2.query("prov1", "adp1", { start: ts - 600000, end: ts + 1 }, 10);
  assert.equal(q.entries.length, 2);
  assert.deepEqual(q.entries[0].data, { balance: 9.5 }, "迁移后 data 形态正确");
  // 旧文件已重命名 .bak
  const filesAfter = await import("node:fs/promises").then((m) => m.readdir(histDir));
  assert.ok(filesAfter.some((f) => f.endsWith(".v3.bak")), "旧桶重命名为 .bak");
  // 幂等：二次迁移不重复
  const again = await migrateLegacyV3(dir, store2);
  assert.equal(again, 0, "二次迁移幂等（.bak 不再扫描）");
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- safe 守卫

{
  // 正常路径
  const okR = await safeFetchData(async () => ({ a: 1 }), 2000);
  assert.deepEqual(okR.data, { a: 1 });

  // 抛错 → error 不外抛
  const errR = await safeFetchData(async () => { throw new Error("boom"); }, 2000);
  assert.ok(errR.error !== undefined && errR.error.includes("boom"));

  // 数组 → 校验失败（必须对象）
  const badR = await safeFetchData(async () => [1, 2], 2000);
  assert.ok(badR.error !== undefined && badR.error.includes("对象"));

  // 循环引用 → 序列化失败隔离
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  const cycR = await safeFetchData(async () => cyc, 2000);
  assert.ok(cycR.error !== undefined);

  // 超时（挂起 → 快速超时，不阻塞）
  const t0 = Date.now();
  const toR = await safeFetchData(() => new Promise(() => {}), 300);
  assert.ok(toR.error !== undefined && toR.error.includes("超时"));
  assert.ok(Date.now() - t0 < 1500, "超时应快速返回，不挂起");
}

{
  const okF = await safeFormat(() => "<b>x</b>", "formatCapsule", 2000);
  assert.equal(okF.html, "<b>x</b>");

  const errF = await safeFormat(() => { throw new Error("fmt-boom"); }, "formatCapsule", 2000);
  assert.ok(errF.error !== undefined && errF.error.includes("fmt-boom"));

  const typeF = await safeFormat(() => 42 as unknown as string, "formatCapsule", 2000);
  assert.ok(typeF.error !== undefined && typeF.error.includes("字符串"));
}

// ---------------------------------------------------------------- normalizeConfig

{
  const c = normalizeConfig(undefined);
  assert.equal(c.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs);
  assert.equal(c.provider, "opencode-go");
  const m = normalizeConfig({ adapter: "/tmp/a.mjs", staticPath: "/v1/usage", provider: "deepseek", apiKey: "sk-x", fetchTimeoutMs: 99999, maxAgeDays: 9999 });
  assert.equal(m.adapter, "/tmp/a.mjs");
  assert.equal(m.provider, "deepseek");
  assert.equal(m.apiKey, "sk-x");
  assert.equal(m.fetchTimeoutMs, 30000, "超时上限 clamp 到 30s");
  assert.equal(m.maxAgeDays, 365, "保留天数上限 clamp");
}

// ---------------------------------------------------------------- provider-config 配置链

{
  // 显式 key 优先
  const r1 = await resolveProviderConfig("myprov", { apiKey: "explicit", apiEndpoint: "https://x" });
  assert.equal(r1.apiKey, "explicit");
  assert.equal(r1.apiEndpoint, "https://x");

  // env 回落：provider myprov-test → 环境变量 MYPROV_TEST_API_KEY
  process.env.MYPROV_TEST_API_KEY = "from-env";
  const r2 = await resolveProviderConfig("myprov-test", {});
  assert.equal(r2.apiKey, "from-env");
  delete process.env.MYPROV_TEST_API_KEY;

  // 无密钥
  const r3 = await resolveProviderConfig("never-exists-prov", {});
  assert.equal(r3.apiKey, undefined);

  // credentials 文件路径
  assert.ok(credentialsFile("/tmp/dsh").endsWith(".credentials.yaml"));
}

// ---------------------------------------------------------------- opencode-go v2

{
  // parseUsageResponse 兼容两种形状
  const p1 = parseUsageResponse({ usage: { rolling: { percent: 2 } } });
  assert.ok(p1 !== null && p1.rolling.percent === 2);
  const p2 = parseUsageResponse({ rolling: { percent: 3 } });
  assert.ok(p2 !== null && p2.rolling.percent === 3);
  assert.equal(parseUsageResponse("junk"), null);

  // fetchOpenCodeGoV2：成功
  const fakeRes = (status: number, body: unknown): Response =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
  const okF = await fetchOpenCodeGoV2(
    { apiEndpoint: "https://x", staticPath: "/usage", apiKey: "sk-1", provider: OPENCODE_GO_PROVIDER, timeoutMs: 2000 },
    (async () => fakeRes(200, { usage: { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } } })) as unknown as typeof fetch,
  );
  assert.ok(okF.rolling !== undefined);

  // 401 → 抛 unauthorized（由 safeFetchData 在管道层隔离）
  await assert.rejects(
    () => fetchOpenCodeGoV2(
      { apiEndpoint: "https://x", staticPath: "/u", apiKey: "sk-1", provider: "p", timeoutMs: 2000 },
      (async () => fakeRes(401, {})) as unknown as typeof fetch,
    ),
    /unauthorized/,
  );

  // 缺 key
  await assert.rejects(
    () => fetchOpenCodeGoV2({ apiEndpoint: "", staticPath: "", provider: "p", timeoutMs: 2000 }),
    /no-api-key/,
  );

  // 内置适配器契约自检
  assert.equal(isUsageStatsAdapter(openCodeGoAdapter), true, "内置适配器必须通过 v2 契约校验");
  assert.deepEqual(openCodeGoAdapter.providers, ["opencode-go"]);
  assert.equal(openCodeGoAdapter.name, OPENCODE_GO_ADAPTER_ID);

  // formatCapsule 返回 HTML 字符串（含窗口短名）
  const html = openCodeGoAdapter.formatCapsule({
    time: Date.now(),
    data: { rolling: { percent: 5 }, weekly: { percent: 1 }, monthly: { percent: 0 } },
    status: "fresh",
    esc,
  });
  assert.ok(html.includes("5h"), "胶囊文案应含窗口短名");

  // formatPanel 返回三窗口迷你图卡片 HTML（SVG 图表，与 v1 展示逻辑一致）
  const panel = openCodeGoAdapter.formatPanel({
    entries: [
      { time: Date.now() - 600000, data: { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } } },
      { time: Date.now(), data: { rolling: { percent: 5 }, weekly: { percent: 3 }, monthly: { percent: 1 } } },
    ],
    range: { start: Date.now() - 1000, end: Date.now() },
    truncated: false,
    esc,
  });
  assert.ok(panel.includes("dou-card"), "面板应含卡片");
  assert.ok(panel.includes("5h 滚动") && panel.includes("每周") && panel.includes("每月"), "面板含三窗口名称");
  assert.ok(panel.includes("<svg"), "面板含 SVG 迷你图");
  assert.ok(panel.includes("dou-cardCur"), "卡片头含当前百分比");
  // 空历史 → 空态文案
  const emptyPanel = openCodeGoAdapter.formatPanel({
    entries: [],
    range: { start: 0, end: 1 },
    truncated: false,
    esc,
  });
  assert.ok(emptyPanel.includes("暂无"), "空历史应有空态提示");
  // 单点历史 → 采集中提示（≥2 点才显示趋势）
  const onePanel = openCodeGoAdapter.formatPanel({
    entries: [{ time: Date.now(), data: { rolling: { percent: 5 }, weekly: { percent: 3 }, monthly: { percent: 1 } } }],
    range: { start: Date.now() - 1000, end: Date.now() },
    truncated: false,
    esc,
  });
  assert.ok(onePanel.includes("dou-chartEmpty"), "单点历史显示采集中提示");
}

// ---------------------------------------------------------------- registry v2

{
  const reg = makeAdapterRegistry();
  reg.register(validAdapter as never, "user-file", "/tmp/x.mjs");
  assert.ok(reg.get("p1") !== undefined);
  assert.ok(reg.enabledProviders().includes("p1"));
  const snap = reg.snapshot();
  assert.equal(snap.infos.length, 1);
  assert.equal(snap.errors.length, 0);
  reg.recordError("test", "exec", "oops");
  assert.equal(reg.snapshot().errors.length, 1);
  assert.equal(reg.select("p1", null), true);
  assert.equal(reg.get("p1"), undefined);
}

// ---------------------------------------------------------------- 热更新加载校验

{
  const dir = mkdtempSync(join(tmpdir(), "dou-hot-"));

  // 合法适配器
  const okFile = join(dir, "adapter-ok.mjs");
  writeFileSync(okFile, `
export const version = 2;
export const name = "hot-adapter";
export const providers = ["hp"];
export async function fetchData() { return {}; }
export function formatCapsule() { return ""; }
export function formatPanel() { return ""; }
`, "utf8");
  const stamp = await readStamp(okFile);
  assert.ok(stamp !== null);
  const loaded = await loadAndValidateAdapter(okFile, stamp);
  assert.ok(loaded.adapter !== undefined && loaded.adapter.name === "hot-adapter");
  assert.equal(stampEqual(stamp, stamp), true);
  assert.equal(stampEqual(stamp, null), false);

  // 非法适配器（缺导出）→ fail-fast 拒收
  // （用独立文件：同文件快速重写可能落同一 mtimeMs，?t= 缓存键相同会命中旧模块）
  const badFile = join(dir, "adapter-bad.mjs");
  writeFileSync(badFile, `export const version = 2; export const name = "x2";`, "utf8");
  const stamp2 = await readStamp(badFile);
  assert.ok(stamp2 !== null && !stampEqual(stamp, stamp2));
  const bad = await loadAndValidateAdapter(badFile, stamp2);
  assert.ok(bad.error !== undefined && bad.error.includes("契约校验失败"));
  assert.equal(bad.adapter, undefined);

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 路由表形状

assert.equal(typeof ROUTES.stats, "string");
assert.ok(ROUTES.stats.startsWith("/api/"));
assert.ok(ROUTES.health.startsWith("/api/"));

console.log("[smoke-pure] 全部断言通过 ✓ (v2)");
