// @ts-nocheck
/**
 * dsh-opencode-usage — 宿主端冒烟测试（fake ctx + 注入 fetch，无网络）。
 *
 * 覆盖（M1 适配器框架）：
 * - normalizeConfig：默认值/部分覆盖/非法值丢弃/限额合并/新增 adapters 键
 * - 契约与注册表：isHostProviderAdapter 校验、内置注册、用户覆盖内置、
 *   未命中 no-adapter、snapshot
 * - opencode-go 内置适配器：pickWindow / parseUsageResponse / fetchOpenCodeGo
 *   （200 / 401 / 500 / 网络错 / 坏 JSON / 无 key / 超时）
 * - credentialsKeyFromYaml / opencodeKeyFromAuth / resolveApiKey：解析链优先级
 * - makeUsageCache（按 provider 键控）、makeHistoryStore（v1 单序列）
 * - apply：enabled:false 不注册；注册 stats/history/adapters/health 四路由；
 *   stats 403/405；stats 200 全链路 + 缓存命中；adapters.json 元数据；
 *   history 采样累积与 ?days 过滤；health 摘要
 * - 客户端路由常量一致性（正则提取 client bundle /api/ 字面量 vs host ROUTES）
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  apply,
  ROUTES,
  DEFAULT_CONFIG,
  normalizeConfig,
  ADAPTER_CONTRACT_VERSION,
  makeHostAdapterRegistry,
  isHostProviderAdapter,
  isClientProviderRenderer,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  openCodeGoHostAdapter,
  defineUsageAdapter,
  stripSensitiveKeys,
  collectSamplePoint,
  pickWindow,
  parseUsageResponse,
  fetchOpenCodeGo,
  credentialsKeyFromYaml,
  opencodeKeyFromAuth,
  resolveApiKey,
  makeUsageCache,
  makeHistoryStore,
  writeHistoryFile,
  readHistoryFile,
} from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 配置

assert.equal(normalizeConfig(undefined).baseUrl, DEFAULT_CONFIG.baseUrl);
const merged = normalizeConfig({ baseUrl: "https://example.com/x", timeoutMs: 999, cacheTtlMs: 5000, limits: { weekly: 40 }, bogus: 1 });
assert.equal(merged.baseUrl, "https://example.com/x");
assert.equal(merged.timeoutMs, 999);
assert.equal(merged.cacheTtlMs, 5000);
assert.equal(merged.limits.weekly, 40);
assert.equal(merged.limits.rolling, DEFAULT_CONFIG.limits.rolling, "未覆盖的限额保留默认");
assert.equal(merged.bogus, undefined, "未知键丢弃");
assert.equal(normalizeConfig({ timeoutMs: "x" }).timeoutMs, DEFAULT_CONFIG.timeoutMs, "非法数字回退");
assert.equal(normalizeConfig({ timeoutMs: -5 }).timeoutMs, DEFAULT_CONFIG.timeoutMs, "负数回退");
assert.equal(normalizeConfig({ timeoutMs: 999999 }).timeoutMs, 120000, "超上限钳制");
assert.equal(DEFAULT_CONFIG.sampleIntervalMs, 300000, "后台采样默认 5 分钟");
assert.equal(normalizeConfig({ sampleIntervalMs: 60000 }).sampleIntervalMs, 60000, "后台采样间隔可配置");
assert.equal(normalizeConfig({ sampleIntervalMs: 1000 }).sampleIntervalMs, DEFAULT_CONFIG.sampleIntervalMs, "后台采样间隔 <30s 回退（防打爆官方接口）");
assert.equal(normalizeConfig({ sampleIntervalMs: 99999999 }).sampleIntervalMs, 3600000, "后台采样间隔上限钳制 1h");
assert.equal(normalizeConfig({ apiKey: "  sk-abc  " }).apiKey, "sk-abc", "apiKey 修剪");
assert.equal(normalizeConfig({ maxAgeDays: 30 }).maxAgeDays, 30, "maxAgeDays 覆盖");
assert.equal(normalizeConfig({ maxAgeDays: 9999 }).maxAgeDays, 365, "maxAgeDays 钳制上限");
assert.equal(normalizeConfig({ persistFile: " /tmp/h.json " }).persistFile, "/tmp/h.json", "persistFile 修剪");
assert.equal(ADAPTER_CONTRACT_VERSION, 1, "契约版本 = 1");

// 新增 adapters 配置归一化
{
  const c = normalizeConfig({
    adapters: {
      host: [{ provider: "my-relay", file: "/abs/my-relay-host.mjs", enabled: false }, { provider: "", file: "/x.js" }, "bad"],
      client: [{ file: "/abs/my-relay-client.js" }, 42],
    },
    providerHint: { "my-relay": "/abs/my-relay-host.mjs", n: 5 },
    stripSecrets: false,
  });
  assert.deepEqual(c.adapters.host, [{ provider: "my-relay", file: "/abs/my-relay-host.mjs", enabled: false }], "host 适配器净化（含 enabled 字段）");
  assert.deepEqual(c.adapters.client, [{ file: "/abs/my-relay-client.js" }], "client 适配器净化");
  assert.deepEqual(c.providerHint, { "my-relay": "/abs/my-relay-host.mjs" }, "providerHint 只收字符串");
  assert.equal(c.stripSecrets, false, "stripSecrets 可关");
  assert.equal(normalizeConfig({ stripSecrets: "x" }).stripSecrets, true, "stripSecrets 非法值回退默认");
  // enabled 缺省（undefined）→ 默认启用
  const c2 = normalizeConfig({ adapters: { host: [{ provider: "p", file: "/x.js" }] } });
  assert.equal(c2.adapters.host[0].enabled, undefined, "enabled 缺省 undefined（注册时默认启用）");
}

// ---------------------------------------------------------------- 契约校验

assert.ok(isHostProviderAdapter(openCodeGoHostAdapter), "内置适配器通过契约校验（含 id/label）");
assert.equal(openCodeGoHostAdapter.id, "opencode-go-builtin", "内置适配器 id");
assert.equal(openCodeGoHostAdapter.label, "OpenCode Go 官方", "内置适配器 label");
assert.equal(typeof openCodeGoHostAdapter.summarize, "function", "工厂自动派生 summarize");
assert.equal(typeof openCodeGoHostAdapter.samplePoint, "function", "工厂自动派生 samplePoint");
assert.ok(!isHostProviderAdapter({ version: 2, id: "a", label: "A", providers: ["x"], fetchUsage: () => {} }), "版本不符拒绝");
assert.ok(!isHostProviderAdapter({ version: 1, id: "a", label: "A", providers: [], fetchUsage: () => {} }), "空 providers 拒绝");
assert.ok(!isHostProviderAdapter({ version: 1, id: "", label: "A", providers: ["x"], fetchUsage: () => {} }), "空 id 拒绝");
assert.ok(!isHostProviderAdapter({ version: 1, id: "a", label: "A", providers: ["x"] }), "缺 fetchUsage 拒绝");
assert.ok(!isHostProviderAdapter(null), "null 拒绝");
assert.ok(isClientProviderRenderer({ version: 1, providers: ["x"], render: () => {} }), "合法渲染器通过");
assert.ok(!isClientProviderRenderer({ version: 1, providers: ["x"] }), "缺 render 拒绝");

// ---------------------------------------------------------------- 注册表（候选 + 唯一启用）

{
  const diags = [];
  const reg = makeHostAdapterRegistry({ diag: (m) => diags.push(m) });
  assert.ok(reg.register(openCodeGoHostAdapter, "builtin"), "内置注册成功");
  assert.equal(reg.get(OPENCODE_GO_PROVIDER), openCodeGoHostAdapter, "按 provider 查到内置（默认启用）");

  // 用户适配器加入候选并成为当前启用者（同 provider，默认启）
  const userAdapter = {
    version: 1,
    id: "my-opencode-go-v1",
    label: "我的增强版",
    providers: [OPENCODE_GO_PROVIDER],
    fetchUsage: async () => ({ ok: true, provider: OPENCODE_GO_PROVIDER, label: "用户版", fetchedAt: 1 }),
  };
  assert.ok(reg.register(userAdapter, "user-file", "/u.mjs"), "用户注册成功");
  assert.equal(reg.get(OPENCODE_GO_PROVIDER), userAdapter, "用户成为当前启用者");
  assert.equal(reg.isEnabled(OPENCODE_GO_PROVIDER, userAdapter.id), true, "用户启用标记");

  // select 切回内置
  assert.equal(reg.select(OPENCODE_GO_PROVIDER, OPENCODE_GO_ADAPTER_ID), true, "切回内置");
  assert.equal(reg.get(OPENCODE_GO_PROVIDER), openCodeGoHostAdapter, "内置重新启用");
  assert.equal(reg.select(OPENCODE_GO_PROVIDER, "not-exist"), false, "切换不存在的适配器失败");

  // 显式 enabled:false 的用户适配器 → 禁用候选（不启用）
  const disabledRelay = {
    version: 1,
    id: "my-relay",
    label: "中转站",
    providers: ["my-relay"],
    fetchUsage: async () => ({ ok: true, provider: "my-relay", label: "R", fetchedAt: 1 }),
  };
  assert.ok(reg.register(disabledRelay, "user-file", "/r.mjs", false), "禁用候选注册成功");
  assert.equal(reg.get("my-relay"), undefined, "禁用候选不作为启用者");
  assert.equal(reg.hasCandidates("my-relay"), true, "有候选但未启用");
  const r = await reg.fetchUsage("my-relay", { provider: "my-relay", fetch });
  assert.equal(r.error, "no-enabled-adapter", "有候选但全禁用 → no-enabled-adapter");

  // 无候选 provider → no-adapter
  const r2 = await reg.fetchUsage("ghost", { provider: "ghost", fetch });
  assert.equal(r2.error, "no-adapter");

  // adapter-crash：运行抛错被归一化
  const badReg = makeHostAdapterRegistry();
  badReg.register({ version: 1, id: "boom", label: "B", providers: ["boom"], fetchUsage: async () => { throw new Error("x"); } }, "builtin");
  const crash = await badReg.fetchUsage("boom", { provider: "boom", fetch });
  assert.equal(crash.error, "adapter-crash");

  // 契约校验失败的注册 → 告警且不注册
  const before = diags.length;
  reg.register({ version: 1, id: "bad", label: "B", providers: [], fetchUsage: () => {} }, "user-file", "/bad.mjs");
  assert.ok(diags.length > before, "无效适配器告警");
  // id 重复拒绝
  reg.register({ version: 1, id: "my-opencode-go-v1", label: "X", providers: ["ghost2"], fetchUsage: () => {} }, "user-file", "/dup.mjs");
  assert.equal(reg.get("ghost2"), undefined, "id 重复的适配器被拒绝，不注册");

  // snapshot：候选详情 + enabled 映射 + enabledProviders
  const snap = reg.snapshot();
  assert.equal(snap.enabledProviders.includes("opencode-go"), true, "enabledProviders 含 opencode-go（内置已启用）");
  assert.equal(snap.enabled["opencode-go"], OPENCODE_GO_ADAPTER_ID, "enabled 映射 provider→adapterId");
  const myRelayInfo = snap.infos.find((i) => i.id === "my-relay");
  assert.equal(myRelayInfo.enabled, false, "禁用候选 enabled=false");
}

// ---------------------------------------------------------------- 密钥护栏（stripSecrets 值模式 + 键名）

{
  const obj = {
    ok: "fine",
    token: "sk-secret-token-12345", // 键名命中 → 脱敏
    authHeader: "Bearer sk-abcdefghijkl", // 值模式 Bearer → 脱敏
    api_key: "abc", // 键名命中但值 <8 → 不脱敏（保留）
    nested: { raw: "这里有一些文本，无密钥", deep: { k: "Bearer sk-1234567890abcdef" } },
    list: [{ secret: "sk-bbbbbbbb" }],
  };
  stripSensitiveKeys(obj);
  assert.equal(obj.token, "<redacted>", "键名 token 值脱敏");
  assert.equal(obj.authHeader, "<redacted>", "值模式 Bearer 脱敏");
  assert.equal(obj.api_key, "abc", "键名命中但短值保留");
  assert.equal(obj.nested.deep.k, "<redacted>", "嵌套值 Bearer 脱敏");
  assert.equal(obj.list[0].secret, "<redacted>", "数组内键名脱敏");
  assert.equal(obj.nested.raw, "这里有一些文本，无密钥", "普通文本不动");
}

// ---------------------------------------------------------------- samplePoint（数据格式放开）

{
  // 无 samplePoint 但含 windows → 回落通用提取
  const adapter = { id: "a", label: "A", providers: ["x"], fetchUsage: async () => ({ ok: true, provider: "x", label: "A", fetchedAt: 1 }) };
  const usage = { ok: true, provider: "x", label: "A", fetchedAt: 1, windows: [{ key: "rolling", name: "5h", percent: 3 }, { key: "monthly", name: "月", percent: 0 }] };
  const sp = collectSamplePoint(adapter, usage);
  assert.deepEqual(sp.values, [3, 0], "回落从 windows 提取 percent 列");
  assert.deepEqual(sp.cols.map((c) => c.key), ["rolling", "monthly"], "回落列声明 = windows key");

  // 自定义 samplePoint（自定义格式）
  const custom = {
    id: "c", label: "C", providers: ["y"],
    fetchUsage: async () => ({ ok: true, provider: "y", label: "C", fetchedAt: 1 }),
    samplePoint: (u) => ({ cols: [{ key: "credit", name: "余额" }], values: [u.data.credit] }),
  };
  const customSp = collectSamplePoint(custom, { ok: true, provider: "y", label: "C", fetchedAt: 1, data: { credit: 42 } });
  assert.deepEqual(customSp, { cols: [{ key: "credit", name: "余额" }], values: [42] }, "自定义 samplePoint 优先");

  // 两者都没有 → 不采样
  const plain = { id: "p", label: "P", providers: ["y"], fetchUsage: async () => ({ ok: true, provider: "y", label: "P", fetchedAt: 1 }) };
  const none = collectSamplePoint(plain, { ok: true, provider: "y", label: "P", fetchedAt: 1, data: { a: 1 } });
  assert.equal(none, null, "无 samplePoint 且无 windows → 不采样");
}

// ---------------------------------------------------------------- defineUsageAdapter 工厂

{
  const made = defineUsageAdapter({
    id: "relay",
    label: "中转站",
    providers: ["relay"],
    windows: [{ key: "credit", name: "额度", limit: 100, resetPeriodMs: 86400000 }],
    fetchUsage: async () => ({ ok: true, provider: "relay", label: "中转站", fetchedAt: 1, windows: [{ key: "credit", name: "额度", percent: 30, limit: 100 }] }),
  });
  assert.equal(made.id, "relay");
  assert.equal(made.version, 1, "工厂默认契约版本");
  const sample = made.samplePoint({ ok: true, provider: "relay", label: "中转站", fetchedAt: 1, windows: [{ key: "credit", name: "额度", percent: 30, limit: 100 }] });
  assert.deepEqual(sample.values, [30], "工厂派生 samplePoint");
  const sum = await made.summarize({ provider: "relay", fetch, usage: { ok: true, provider: "relay", label: "中转站", fetchedAt: 1, windows: [{ key: "credit", name: "额度", percent: 30 }] } });
  assert.equal(sum.hasAdapter, true);
  assert.equal(typeof sum.text, "string");
}


assert.deepEqual(pickWindow({ status: "ok", percent: 9, resetsAt: "2026-08-15T00:00:00Z" }, "rolling", "5h 滚动", 12), { key: "rolling", name: "5h 滚动", percent: 9, resetsAt: "2026-08-15T00:00:00Z", limit: 12, raw: undefined });
assert.deepEqual(pickWindow({ percent: "12" }, "r", "R", 1).percent, 12, "字符串 percent 转数字");
assert.deepEqual(pickWindow({ percent: "abc" }, "r", "R", 1).percent, null, "非法 percent 置 null");
assert.equal(pickWindow(null, "r", "R", 1), null);
assert.equal(pickWindow("x", "r", "R", 1), null);

assert.deepEqual(parseUsageResponse({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } } }).monthly.percent, 3, "嵌套 usage");
assert.deepEqual(parseUsageResponse({ rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } }).rolling.percent, 1, "直接三键");
assert.equal(parseUsageResponse(null), null);
assert.equal(parseUsageResponse("x"), null);

function fakeRes(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const OK_BODY = { usage: { rolling: { status: "ok", percent: 2, resetsAt: "r" }, weekly: { status: "ok", percent: 1, resetsAt: "w" }, monthly: { status: "ok", percent: 0, resetsAt: "m" } } };

{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(200, OK_BODY) });
  assert.equal(r.ok, true);
  assert.equal(r.windows.length, 3, "三窗口");
  assert.equal(r.windows[2].percent, 0);
  assert.equal(r.windows[2].key, "monthly");
}
{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(401, {}) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unauthorized");
}
{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(500, {}) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "http-500");
}
{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
}
{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(200, "<html>") });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad-json");
}
{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "", fetchImpl: async () => fakeRes(200, OK_BODY) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no-api-key");
}
{
  const r = await fetchOpenCodeGo({
    baseUrl: "https://x",
    apiKey: "sk-1",
    timeoutMs: 5,
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
}

// 内置适配器 fetchUsage 归一化
{
  const usage = await openCodeGoHostAdapter.fetchUsage({
    provider: OPENCODE_GO_PROVIDER,
    apiKey: "sk-1",
    fetch: async () => fakeRes(200, OK_BODY),
  });
  assert.equal(usage.ok, true);
  assert.equal(usage.provider, "opencode-go");
  assert.equal(usage.label, "OpenCode Go");
  assert.equal(usage.windows.length, 3);
  const nokey = await openCodeGoHostAdapter.fetchUsage({ provider: OPENCODE_GO_PROVIDER, fetch: async () => fakeRes(200, OK_BODY) });
  assert.equal(nokey.ok, false);
  assert.equal(nokey.error, "no-api-key");
}

// ---------------------------------------------------------------- API Key 解析链

assert.equal(credentialsKeyFromYaml('DEEPSEEK_API_KEY: sk-aaa\nOPENCODE_GO_API_KEY: sk-opencode-123\n'), "sk-opencode-123");
assert.equal(credentialsKeyFromYaml('OPENCODE_GO_API_KEY: "sk-q"'), "sk-q", "带引号");
assert.equal(credentialsKeyFromYaml(""), undefined);
assert.equal(credentialsKeyFromYaml(undefined), undefined);
assert.equal(opencodeKeyFromAuth('{"opencode-go":{"type":"api","key":"sk-go-1"}}'), "sk-go-1", "opencode-go 优先");
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"api","key":"sk-oc-2"}}'), "sk-oc-2", "回退 opencode");
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"api"}}'), undefined, "无 key");
assert.equal(opencodeKeyFromAuth("{bad json"), undefined);
assert.equal(resolveApiKey({ explicit: "sk-e", env: "sk-v", credentialsYaml: "k: sk-c", authJson: "{}" }), "sk-e", "显式优先");
assert.equal(resolveApiKey({ env: "sk-v", credentialsYaml: "k: sk-c", authJson: "{}" }), "sk-v", "环境变量次之");
assert.equal(resolveApiKey({ authJson: '{"opencode-go":{"type":"api","key":"sk-a"}}' }), "sk-a", "auth.json 兜底");
assert.equal(resolveApiKey({}), undefined, "全缺返回 undefined");

// ---------------------------------------------------------------- 历史采样序列（v3 多文件，(provider, adapterId) 双键）

{
  let now = 1_000_000;
  const store = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  const cols = [{ key: "rolling", name: "5h" }, { key: "weekly", name: "周" }, { key: "monthly", name: "月" }];
  // 按 (provider, adapterId) 追加
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [now, 2, 1, 0]), { appended: 1, replaced: 0 });
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [now + 1000, 4, 5, 6]), { appended: 0, replaced: 1 }, "同分钟替换");
  assert.equal(store.list("opencode-go", "opencode-go-builtin").samples.length, 1);
  assert.deepEqual(store.list("opencode-go", "opencode-go-builtin").samples[0], [now + 1000, 4, 5, 6], "替换后保留最新点");
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [now + 60000, 7, 8, 9]), { appended: 1, replaced: 0 }, "跨分钟追加");
  assert.equal(store.list("opencode-go", "opencode-go-builtin").samples.length, 2);

  // 另一 adapterId（同 provider）独立桶
  assert.deepEqual(store.append("opencode-go", "my-v2", [{ key: "credit", name: "余额" }], [now, 50]), { appended: 1, replaced: 0 });
  assert.equal(store.list("opencode-go", "my-v2").samples.length, 1);
  assert.equal(store.list("opencode-go", "opencode-go-builtin").samples.length, 2, "各 adapterId 独立桶，互不干扰");

  // 列声明随桶
  const ocgBucket = store.list("opencode-go", "opencode-go-builtin");
  assert.deepEqual(ocgBucket.columns.map((c) => c.key), ["rolling", "weekly", "monthly"], "columns 随桶落盘");

  // 列数一致性：声明列数与已记录不一致 → 跳过
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", [{ key: "x", name: "X" }], [now + 90000, 1, 2, 3, 4]), { appended: 0, replaced: 0 }, "列数不一致跳过");

  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, null), { appended: 0, replaced: 0 });
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [1]), { appended: 0, replaced: 0 }, "元素不足 2 丢弃");
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, ["x", 1, 2, 3]), { appended: 0, replaced: 0 }, "ts 非法丢弃");
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [now + 120000, "bad", 5, null]), { appended: 1, replaced: 0 });
  assert.equal(store.list("opencode-go", "opencode-go-builtin").samples.at(-1)[1], null, "非法 percent 归一为 null");

  // trimAll 裁剪所有桶
  now += 15 * 86400000;
  store.trimAll();
  assert.equal(store.list("opencode-go", "opencode-go-builtin").samples.length, 0, "超龄点被裁剪");
  assert.equal(store.list("opencode-go", "my-v2").samples.length, 0, "my-v2 也被裁剪");

  // bucketJson / loadBucket 往返
  const store3 = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  store3.append("opencode-go", "opencode-go-builtin", cols, [now - 3600000, 1, 2, 3]);
  store3.append("opencode-go", "opencode-go-builtin", cols, [now, 4, 5, 6]);
  const text = store3.bucketJson("opencode-go", "opencode-go-builtin");
  const store4 = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  assert.equal(store4.loadBucket("opencode-go", "opencode-go-builtin", text), 2, "loadBucket 返回加载点数");
  assert.deepEqual(store4.list("opencode-go", "opencode-go-builtin").samples, store3.list("opencode-go", "opencode-go-builtin").samples, "往返一致");
  assert.deepEqual(store4.list("opencode-go", "opencode-go-builtin").columns.map((c) => c.key), ["rolling", "weekly", "monthly"], "columns 往返一致");

  // 防御
  const bad = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  assert.equal(bad.loadBucket("a", "b", "{bad json"), 0, "坏 JSON 返回 0");
  assert.equal(bad.loadBucket("a", "b", JSON.stringify({ version: 3, samples: "x" })), 0, "坏结构返回 0");
  assert.equal(bad.loadBucket("a", "b", JSON.stringify({ version: 3, columns: [{ key: "x", name: "X" }], samples: [[1], ["x", 1, 2], [now, 1, 2]] })), 1, "坏元素丢弃，好元素保留");
}

{
  const dir = mkdtempSync(join(tmpdir(), "dou-smoke-"));
  const file = join(dir, "hist.json");
  await writeHistoryFile(file, JSON.stringify({ version: 1, samples: [[1, 2, 3, 4]] }));
  const text = await readHistoryFile(file);
  assert.equal(JSON.parse(text).samples.length, 1, "落盘往返");
  assert.equal(await readHistoryFile(join(dir, "no-such.json")), undefined, "文件不存在返回 undefined");
}

// ---------------------------------------------------------------- TTL 缓存（按 provider 键控）

let now = 1000;
const cache = makeUsageCache({ ttlMs: 30000, now: () => now });
assert.equal(cache.get("a"), undefined);
cache.set("a", { v: 1 });
cache.set("b", { v: 2 });
assert.deepEqual(cache.get("a"), { v: 1 });
assert.deepEqual(cache.get("b"), { v: 2 }, "多 provider 独立缓存");
cache.clear("a");
assert.equal(cache.get("a"), undefined, "按 provider 清除");
now = 1000 + 30000;
assert.equal(cache.get("b"), undefined, "TTL 过期失效");
cache.set("b", { x: 1 });
cache.clear();
assert.equal(cache.get("b"), undefined, "clear 全清");

// ---------------------------------------------------------------- fake ctx + apply

function fakeReq(overrides = {}) {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    // readJsonBody 用 for await 读 body：提供 async-iterator 桩
    [Symbol.asyncIterator]: async function* () {
      if (typeof overrides.body === "string" && overrides.body !== "") {
        yield Buffer.from(overrides.body);
      }
      // 无 body 或空 → 直接结束（readJsonBody 得到空 → JSON.parse 抛 → 400）
    },
    ...overrides,
  };
  return req;
}

function makeFakeCtx(overrides = {}) {
  const routes = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    ...overrides,
  };
  return { ctx, routes };
}

// enabled:false 不注册任何路由
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { enabled: false });
  assert.equal(routes.length, 0, "enabled:false 不注册路由");
}

// 注册 stats + select + history + adapters + user + health 六路由
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [ROUTES.health, ROUTES.history, ROUTES.adapters, ROUTES.stats, ROUTES.select, "/api/dsh-opencode-usage/user/"].sort(),
    "注册六条路由",
  );
  assert.ok(routes.every((r) => r.kind === "exact" || r.kind === "prefix"), "路由 exact 或 prefix");
}

// stats 路由：403（非回环）/ 405（非 GET）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const stats = routes.find((r) => r.path === ROUTES.stats);
  assert.ok(stats, "stats 路由存在");

  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  const req403 = fakeReq({ socket: { remoteAddress: "10.0.0.2" } });
  stats.handler(req403, res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "非回环 403");

  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  stats.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(responses.at(-1).__code, 405, "非 GET 405");
}

// adapters.json 路由：403 / 405 / 200 元数据
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
  assert.ok(adaptersRoute, "adapters 路由存在");
  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  adaptersRoute.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "adapters 非回环 403");
  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  adaptersRoute.handler(fakeReq({ method: "DELETE" }), res405);
  assert.equal(responses.at(-1).__code, 405, "adapters 非 GET 405");
  let payload;
  const res2 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  adaptersRoute.handler(fakeReq(), res2);
  assert.equal(payload.version, 1, "adapters.json 带契约版本");
  assert.equal(payload.host.length >= 1, true, "内置 opencode-go 在元数据中");
  assert.equal(payload.host[0].providers.includes("opencode-go"), true);
  assert.equal(payload.host[0].id, "opencode-go-builtin", "候选带 id");
  assert.equal(payload.host[0].enabled, true, "候选带 enabled");
  assert.equal(payload.enabled["opencode-go"], "opencode-go-builtin", "enabled 映射 provider→adapterId");
  assert.deepEqual(payload.client, [], "无客户端适配器时为 []");
  // 带客户端适配器配置
  const { ctx: ctx3, routes: routes3 } = makeFakeCtx();
  await apply(ctx3, {
    adapters: { client: [{ file: "/abs/my-relay-client.js" }] },
  });
  const adaptersRoute3 = routes3.find((r) => r.path === ROUTES.adapters);
  let payload3;
  const res3 = { writeHead: () => {}, end: (chunk) => { payload3 = JSON.parse(chunk); } };
  adaptersRoute3.handler(fakeReq(), res3);
  assert.equal(payload3.client.length, 1, "有客户端适配器时 client 非空");
  assert.equal(payload3.client[0].file, "/abs/my-relay-client.js");
  assert.ok(payload3.client[0].url.startsWith("/api/dsh-opencode-usage/user/"), "客户端适配器有 serve URL");
  assert.equal(payload3.client[0].resolved, false, "文件不存在标记 resolved=false");
}

// select 路由：403 / 405 / 400 / 404 / 200（光标方法）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const select = routes.find((r) => r.path === ROUTES.select);
  assert.ok(select, "select 路由存在");

  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  select.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "select 非回环 403");

  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  select.handler(fakeReq({ method: "GET" }), res405);
  assert.equal(responses.at(-1).__code, 405, "select 非 POST 405");

  // 400：空/非法 body
  const res400 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  await select.handler(fakeReq({ method: "POST" }), res400);
  assert.equal(responses.at(-1).__code, 400, "select 空 body 400");

  // 404：未知 adapterId
  const res404 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  await select.handler(
    fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: "opencode-go", adapterId: "no-such" }),
    }),
    res404,
  );
  assert.equal(responses.at(-1).__code, 404, "select 未知 adapter 404");

  // 200：重选内置自身
  let payload;
  const res200 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await select.handler(
    fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: "opencode-go", adapterId: "opencode-go-builtin" }),
    }),
    res200,
  );
  assert.equal(payload.ok, true, "select 重选内置成功");
  assert.equal(payload.adapterId, "opencode-go-builtin");
}

// user 路由：403 / 405 / 404
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const userRoute = routes.find((r) => r.path === "/api/dsh-opencode-usage/user/");
  assert.ok(userRoute, "user 路由存在");
  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  userRoute.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "user 非回环 403");
  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  userRoute.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(responses.at(-1).__code, 405, "user 非 GET 405");
  const res404 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  userRoute.handler(fakeReq({ url: "/api/dsh-opencode-usage/user/999.js" }), res404);
  assert.equal(responses.at(-1).__code, 404, "user 不存在的索引 404");
}

// stats 200 全链路：注入 fetchImpl + apiKey（不落盘、不网络）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    apiKey: "sk-test",
    cacheTtlMs: 30000,
    fetchImpl: async () => fakeRes(200, OK_BODY),
  });
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats.handler(fakeReq(), res);
  assert.equal(payload.ok, true);
  assert.equal(payload.configured, true);
  assert.equal(payload.error, null);
  assert.equal(payload.provider, "opencode-go", "默认 provider 为 opencode-go");
  assert.equal(payload.label, "OpenCode Go");
  assert.equal(payload.usage.ok, true);
  assert.equal(payload.usage.windows.length, 3, "归一化三窗口");
  assert.equal(payload.usage.windows[2].percent, 0, "monthly percent 0");
  assert.equal(payload.usage.windows[2].limit, 60, "窗口自带限额");
  assert.equal(payload.limits.monthly, 60, "响应带展示限额（兼容键）");
  assert.equal(payload.plugin, "dsh-opencode-usage");
  // R2：summary 子树 + adapterId/hasAdapter
  assert.equal(payload.adapterId, "opencode-go-builtin", "响应带当前启用 adapterId");
  assert.equal(payload.hasAdapter, true, "有启用适配器");
  assert.equal(payload.summary.provider, "opencode-go", "summary 内嵌子树");
  assert.equal(payload.summary.hasAdapter, true, "summary 有启用适配器");
  assert.equal(payload.summary.text, "5h 2% · 周 1% · 月 0%", "胶囊文案来自内置 summarize（短名）");
  const fetchedAt = payload.fetchedAt;

  // 显式 provider 参数
  await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=opencode-go` }), res);
  assert.equal(payload.ok, true, "显式 provider 参数正常");

  // 未知 provider → no-adapter 引导（无候选）
  await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=ghost-relay` }), res);
  assert.equal(payload.configured, false);
  assert.equal(payload.reason, "no-adapter");
  assert.equal(payload.usage, null);
  assert.equal(payload.hasAdapter, false, "未知 provider 无启用适配器");
  assert.equal(payload.adapterId, null, "未知 provider adapterId null");
  assert.equal(payload.summary.hasAdapter, false, "summary 标记无适配器");

  // 缓存命中：第二次请求不触发 fetchImpl（计数不变）
  let calls = 0;
  const { ctx: ctx2, routes: routes2 } = makeFakeCtx();
  await apply(ctx2, {
    apiKey: "sk-test",
    cacheTtlMs: 30000,
    fetchImpl: async () => { calls += 1; return fakeRes(200, OK_BODY); },
  });
  const stats2 = routes2.find((r) => r.path === ROUTES.stats);
  const res2 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats2.handler(fakeReq(), res2);
  await stats2.handler(fakeReq(), res2);
  assert.equal(calls, 1, "TTL 内第二次命中缓存，不重复请求");
  assert.equal(payload.cached, true, "缓存命中标记");
  assert.ok(payload.fetchedAt >= fetchedAt);
}

// history 路由：403（非回环）/ 405（非 GET）/ 200（采样累积后返回序列）
{
  const dir = mkdtempSync(join(tmpdir(), "dou-hist-"));
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    apiKey: "sk-test",
    cacheTtlMs: 30000,
    fetchImpl: async () => fakeRes(200, OK_BODY),
    persistFile: join(dir, "history.json"),
  });
  const stats = routes.find((r) => r.path === ROUTES.stats);
  const history = routes.find((r) => r.path === ROUTES.history);
  assert.ok(history, "history 路由存在");

  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  history.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "history 非回环 403");
  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  history.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(responses.at(-1).__code, 405, "history 非 GET 405");

  let payload;
  const res2 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  history.handler(fakeReq(), res2);
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 3, "历史数据 v3");
  assert.equal(payload.provider, "opencode-go", "缺省 provider = opencode-go");
  assert.equal(payload.adapterId, "opencode-go-builtin", "缺省 adapterId = 内置");
  assert.equal(payload.count, 0, "未采样前空历史");
  assert.deepEqual(payload.samples, []);

  // 未见过 provider → 空序列（不串厂商）
  history.handler(fakeReq({ url: `${ROUTES.history}?provider=ghost-relay` }), res2);
  assert.equal(payload.count, 0, "未见过 provider 返回空序列");
  assert.equal(payload.provider, "ghost-relay");

  const res3 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats.handler(fakeReq(), res3);
  history.handler(fakeReq(), res3);
  assert.equal(payload.count, 1, "一次成功 fetch 产生一个采样点");
  assert.deepEqual(payload.samples[0].slice(1), [2, 1, 0], "采样点 = [ts, rolling, weekly, monthly] percent");
  assert.deepEqual(payload.columns.map((c) => c.key), ["rolling", "weekly", "monthly"], "历史响应带列声明");

  history.handler(fakeReq({ url: "/api/dsh-opencode-usage/history?days=1" }), res3);
  assert.equal(payload.count, 1, "days=1 内包含当前采样点");

  await stats.handler(fakeReq(), res3);
  assert.equal(payload.cached, true, "第二次命中缓存");
  history.handler(fakeReq(), res3);
  assert.equal(payload.count, 1, "缓存命中不产生新采样点");
}

// stats：无 key 时 usage.error=no-api-key（不网络；路径指向不存在文件）
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    fetchImpl: async () => fakeRes(200, OK_BODY),
    credentialsFile: join(here, "no-such-credentials.yaml"),
    authFile: join(here, "no-such-auth.json"),
  });
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await stats.handler(fakeReq(), res);
  assert.equal(payload.configured, true, "适配器已注册 → configured 为 true");
  assert.equal(payload.usage.ok, false);
  assert.equal(payload.usage.error, "no-api-key");
}

// health 路由：200 摘要
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const health = routes.find((r) => r.path === ROUTES.health);
  let payload;
  const res = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq(), res);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin, "dsh-opencode-usage");
  assert.equal(payload.baseUrl, DEFAULT_CONFIG.baseUrl);
  assert.equal(payload.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs);
  assert.deepEqual(payload.limits, DEFAULT_CONFIG.limits);
  assert.equal(payload.history.maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "health 带历史摘要");
  assert.equal(typeof payload.history.count, "number");
  assert.equal(typeof payload.history.root, "string");
  assert.equal(payload.adapters.length >= 1, true, "health 带适配器快照");
  assert.equal(payload.adapters[0].id, "opencode-go-builtin", "适配器快照带 id");
  assert.equal(payload.adapters[0].enabled, true, "适配器快照带 enabled");

  const res403 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq({ socket: { remoteAddress: "192.168.1.5" } }), res403);
  assert.equal(payload.error, "forbidden: loopback-only", "health 也强制 loopback");
}

// ---------------------------------------------------------------- 客户端路由一致性

{
  const client = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  assertClientSourceContract(join(here, ".."));
  assertClientProductContract(join(here, ".."));
  const literals = new Set(client.match(/\/api\/[A-Za-z0-9_/.-]+/gu) ?? []);
  const hostPaths = new Set([ROUTES.stats, ROUTES.history, ROUTES.health, ROUTES.adapters, ROUTES.select]);
  for (const lit of literals) {
    assert.ok(hostPaths.has(lit), `client 字面量 ${lit} 在 host ROUTES 中存在`);
  }
}

console.log("dsh-opencode-usage smoke: 全部通过 ✅");