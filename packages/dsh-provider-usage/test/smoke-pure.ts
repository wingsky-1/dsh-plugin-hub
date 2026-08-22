/**
 * dsh-provider-usage — 纯函数断言区（issue #28：本文件不带 @ts-nocheck，
 * 全部强类型；集成区见 smoke.ts）。
 *
 * 覆盖：
 * - normalizeConfig / Config schema 只读语义
 * - 契约校验、候选注册表（启用切换）、stripSecrets、collectSamplePoint
 * - defineUsageAdapter 工厂（自动派生 + cols/values 长度拦截）
 * - pickWindow / parseUsageResponse / fetchOpenCodeGo（200/401/500/网络错/
 *   坏 JSON/无 key/超时）/ 内置适配器归一化（含 ctx.timeoutMs 通道）
 * - API Key 解析链、makeHistoryStore（v3 双键桶）、writeHistoryFile 往返、
 *   makeUsageCache TTL
 * - 客户端行为纯函数：胶囊文案/等级/title、D11 隐藏语义、渲染器配对键序
 *   （替代对 lib/client.js 的 includes 字符串断言）
 */
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import type { FetchLike, ProviderSummary, ProviderUsage, SummaryLevel } from "../lib/index.js";
import * as libIndex from "../lib/index.js";
import {
  ROUTES,
  DEFAULT_CONFIG,
  Config,
  normalizeConfig,
  ADAPTER_CONTRACT_VERSION,
  makeHostAdapterRegistry,
  isHostProviderAdapter,
  isClientProviderRenderer,
  describeAdapterShape,
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
  // 客户端行为纯函数（issue #28：宿主侧可导入，client bundle 同源内联）
  derivePillLabel,
  derivePillLevel,
  derivePillTitle,
  shouldHideFloat,
  rendererLookupKeys,
  // 设置页提供商全集（issue #38）
  unionProviders,
  providerBadgeText,
} from "../lib/index.js";

// ---------------------------------------------------------------- 共享桩（导出给集成区复用）

export function fakeRes(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

export const OK_BODY = {
  usage: {
    rolling: { status: "ok", percent: 2, resetsAt: "r" },
    weekly: { status: "ok", percent: 1, resetsAt: "w" },
    monthly: { status: "ok", percent: 0, resetsAt: "m" },
  },
};

// ---------------------------------------------------------------- 配置

assert.equal(normalizeConfig(undefined).baseUrl, DEFAULT_CONFIG.baseUrl);
const merged = normalizeConfig({ baseUrl: "https://example.com/x", timeoutMs: 999, cacheTtlMs: 5000, limits: { weekly: 40 }, bogus: 1 });
assert.equal(merged.baseUrl, "https://example.com/x");
assert.equal(merged.timeoutMs, 999);
assert.equal(merged.cacheTtlMs, 5000);
assert.equal(merged.limits.weekly, 40);
assert.equal(merged.limits.rolling, DEFAULT_CONFIG.limits.rolling, "未覆盖的限额保留默认");
// issue #29：providerHint 死配置键已删除（解析后零消费）
assert.equal("providerHint" in normalizeConfig({ providerHint: { a: "b" } }), false, "providerHint 键已删除不再解析");
assert.equal("bogus" in merged, false, "未知键丢弃");
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

// adapters 配置归一化
{
  const c = normalizeConfig({
    adapters: {
      host: [{ provider: "my-relay", file: "/abs/my-relay-host.mjs", enabled: false }, { provider: "", file: "/x.js" }, "bad"],
      client: [{ file: "/abs/my-relay-client.js" }, 42],
    },
    stripSecrets: false,
  });
  assert.deepEqual(c.adapters.host, [{ provider: "my-relay", file: "/abs/my-relay-host.mjs", enabled: false }], "host 适配器净化（含 enabled 字段）");
  assert.deepEqual(c.adapters.client, [{ file: "/abs/my-relay-client.js" }], "client 适配器净化");
  assert.equal(c.stripSecrets, false, "stripSecrets 可关");
  assert.equal(normalizeConfig({ stripSecrets: "x" }).stripSecrets, true, "stripSecrets 非法值回退默认");
  // enabled 缺省（undefined）→ 默认启用
  const c2 = normalizeConfig({ adapters: { host: [{ provider: "p", file: "/x.js" }] } });
  assert.equal(c2.adapters.host[0].enabled, undefined, "enabled 缺省 undefined（注册时默认启用）");
}

// ---------------------------------------------------------------- 设置面板 schema 只读语义（issue #27）

{
  const schemaJson = JSON.stringify(Config);
  const disabledCount = (schemaJson.match(/"disabled":true/gu) ?? []).length;
  assert.equal(disabledCount, 6, "Config 六个字段全部 disabled 只读态");
  assert.ok(schemaJson.includes("cordis.patch.yml"), "schema description 注明修改走 patch 层");
}

// ---------------------------------------------------------------- 契约校验

assert.ok(isHostProviderAdapter(openCodeGoHostAdapter), "内置适配器通过契约校验（含 id/label）");
assert.equal(openCodeGoHostAdapter.id, "opencode-go-builtin", "内置适配器 id");
assert.equal(openCodeGoHostAdapter.label, "OpenCode Go 官方", "内置适配器 label");
assert.equal(typeof openCodeGoHostAdapter.summarize, "function", "工厂自动派生 summarize");
assert.equal(typeof openCodeGoHostAdapter.samplePoint, "function", "工厂自动派生 samplePoint");
assert.ok(!isHostProviderAdapter({ version: 2, id: "a", label: "A", providers: ["x"], fetchUsage: () => Promise.resolve({}) as never }), "版本不符拒绝");
assert.ok(!isHostProviderAdapter({ version: 1, id: "a", label: "A", providers: [], fetchUsage: () => Promise.resolve({}) as never }), "空 providers 拒绝");
assert.ok(!isHostProviderAdapter({ version: 1, id: "", label: "A", providers: ["x"], fetchUsage: () => Promise.resolve({}) as never }), "空 id 拒绝");
assert.ok(!isHostProviderAdapter({ version: 1, id: "a", label: "A", providers: ["x"] }), "缺 fetchUsage 拒绝");
assert.ok(!isHostProviderAdapter(null), "null 拒绝");
assert.ok(isClientProviderRenderer({ version: 1, providers: ["x"], render: () => {} }), "合法渲染器通过");
assert.ok(!isClientProviderRenderer({ version: 1, providers: ["x"] }), "缺 render 拒绝");

// ---------------------------------------------------------------- 注册表（候选 + 唯一启用）

{
  const diags: string[] = [];
  const reg = makeHostAdapterRegistry({ diag: (m) => diags.push(m) });
  assert.ok(reg.register(openCodeGoHostAdapter, "builtin"), "内置注册成功");
  assert.equal(reg.get(OPENCODE_GO_PROVIDER), openCodeGoHostAdapter, "按 provider 查到内置（默认启用）");

  // 用户适配器加入候选并成为当前启用者（同 provider，默认启）
  const userAdapter = {
    version: 1,
    id: "my-opencode-go-v1",
    label: "我的增强版",
    providers: [OPENCODE_GO_PROVIDER],
    fetchUsage: async (): Promise<ProviderUsage> => ({ ok: true, provider: OPENCODE_GO_PROVIDER, label: "用户版", fetchedAt: 1 }),
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
    fetchUsage: async (): Promise<ProviderUsage> => ({ ok: true, provider: "my-relay", label: "R", fetchedAt: 1 }),
  };
  assert.ok(reg.register(disabledRelay, "user-file", "/r.mjs", false), "禁用候选注册成功");
  assert.equal(reg.get("my-relay"), undefined, "禁用候选不作为启用者");
  assert.equal(reg.hasCandidates("my-relay"), true, "有候选但未启用");
  const r = await reg.fetchUsage("my-relay", { provider: "my-relay", fetch });
  assert.equal(r.error, "no-enabled-adapter", "有候选但全禁用 → no-enabled-adapter");

  // 无候选 provider → no-adapter
  const r2 = await reg.fetchUsage("ghost", { provider: "ghost", fetch });
  assert.equal(r2.error, "no-adapter");

  // adapter-crash：运行抛错被归一化（容错：执行抛错）
  const badReg = makeHostAdapterRegistry();
  badReg.register(
    {
      version: 1,
      id: "boom",
      label: "B",
      providers: ["boom"],
      fetchUsage: async (): Promise<ProviderUsage> => {
        throw new Error("x");
      },
    },
    "builtin",
  );
  const crash = await badReg.fetchUsage("boom", { provider: "boom", fetch });
  assert.equal(crash.error, "adapter-crash");

  // 契约校验失败的注册 → 告警且不注册（容错：畸形导出）
  const before = diags.length;
  reg.register({ version: 1, id: "bad", label: "B", providers: [], fetchUsage: () => Promise.resolve({}) as never }, "user-file", "/bad.mjs");
  assert.ok(diags.length > before, "无效适配器告警");
  // id 重复拒绝
  reg.register({ version: 1, id: "my-opencode-go-v1", label: "X", providers: ["ghost2"], fetchUsage: () => Promise.resolve({}) as never }, "user-file", "/dup.mjs");
  assert.equal(reg.get("ghost2"), undefined, "id 重复的适配器被拒绝，不注册");

  // snapshot：候选详情 + enabled 映射 + enabledProviders
  const snap = reg.snapshot();
  assert.equal(snap.enabledProviders.includes("opencode-go"), true, "enabledProviders 含 opencode-go（内置已启用）");
  assert.equal(snap.enabled["opencode-go"], OPENCODE_GO_ADAPTER_ID, "enabled 映射 provider→adapterId");
  const myRelayInfo = snap.infos.find((i) => i.id === "my-relay");
  assert.equal(myRelayInfo?.enabled, false, "禁用候选 enabled=false");

  // issue #38：select(null) 清空启用项（幂等）
  assert.equal(reg.select(OPENCODE_GO_PROVIDER, null), true, "清空内置 provider 启用项成功");
  assert.equal(reg.get(OPENCODE_GO_PROVIDER), undefined, "清空后无启用者");
  assert.equal(reg.hasCandidates(OPENCODE_GO_PROVIDER), true, "候选仍在（no-enabled-adapter 语义）");
  assert.equal(reg.select("never-seen", null), true, "清空未知 provider 幂等成功");
}

// ---------------------------------------------------------------- 形状明细诊断 + 超时护栏 + 错误登记（issue #38）

{
  // describeAdapterShape：拒收时给出「缺什么」明细
  assert.equal(describeAdapterShape(openCodeGoHostAdapter), null, "合法适配器无形状问题");
  assert.ok(describeAdapterShape(null)?.includes("不是对象"), "null 导出 → 非对象描述");
  assert.ok(describeAdapterShape({ version: 2 })?.includes("fetchUsage"), "缺 fetchUsage 出现在明细中");
  assert.ok(describeAdapterShape({ version: 1, id: "a", label: "A" })?.includes("providers"), "缺 providers 出现在明细中");
  assert.ok(describeAdapterShape({ version: 9, id: "", label: "", providers: ["x"] })?.includes("version"), "版本不符出现在明细中");

  const diags: string[] = [];
  const reg = makeHostAdapterRegistry({
    diag: (m) => diags.push(m),
    sanitizePath: (s) => s.replaceAll("/home/secret-user", "~"),
  });

  // 契约拒收 → 明细诊断 + 错误登记（file:<名> 键，消息经脱敏）
  reg.register({ version: 1, id: "bad-shape", label: "B", providers: [] }, "user-file", "/home/secret-user/x/bad.mjs");
  const loadErr = reg.snapshot().errors.find((e) => e.key === "file:bad.mjs");
  assert.ok(loadErr, "契约拒收已登记错误");
  assert.equal(loadErr?.kind, "load");
  assert.ok(loadErr?.message.includes("providers"), "登记消息含缺失成员明细");
  assert.ok(!loadErr?.message.includes("/home/secret-user"), "登记消息已经路径脱敏");
  assert.ok(diags.some((m) => m.includes("providers")), "诊断输出含明细");

  // recordError（加载链 import 失败场景）+ 同 key 覆盖取最近一次
  reg.recordError("file:gone.mjs", "load", "ENOENT: /x/gone.mjs");
  reg.recordError("file:gone.mjs", "load", "第二次错误（覆盖）");
  const goneErrs = reg.snapshot().errors.filter((e) => e.key === "file:gone.mjs");
  assert.equal(goneErrs.length, 1, "同 key 只保留最近一次");
  assert.equal(goneErrs[0]?.message, "第二次错误（覆盖）", "最近一次错误生效");

  // 超时护栏：挂起适配器限时拦截为 adapter-timeout + exec 登记
  const hangReg = makeHostAdapterRegistry({ diag: (m) => diags.push(m) });
  hangReg.register(
    {
      version: 1,
      id: "hang",
      label: "H",
      providers: ["hang"],
      fetchUsage: async () => new Promise<ProviderUsage>(() => {}),
    },
    "builtin",
  );
  const before = Date.now();
  const guarded = await hangReg.fetchUsage("hang", { provider: "hang", fetch, timeoutMs: 80 });
  assert.equal(guarded.error, "adapter-timeout", "挂起适配器被护栏拦截");
  assert.ok(Date.now() - before >= 50 && Date.now() - before < 5000, "护栏按时触发且不永久阻塞");
  const hangErr = hangReg.snapshot().errors.find((e) => e.key === "hang");
  assert.ok(hangErr?.kind === "exec" && hangErr.message.includes("超时"), "超时登记 kind=exec");
}

// ---------------------------------------------------------------- 密钥护栏（stripSecrets 值模式 + 键名）

{
  const obj = {
    ok: "fine",
    token: "sk-secret-token-12345", // 键名命中 → 脱敏
    authHeader: "Bearer sk-abcdefghijkl", // 值模式 Bearer → 脱敏
    api_key: "abc", // 泛化键名命中但值 <8 → 不脱敏（保留，防误伤）
    password: "p@ssw0rd-xyz", // 键名 password → 脱敏（R1 扩展）
    passphrase: "x", // 高敏键名免长度门槛：短值也脱敏
    sortKey: "name", // 含 "key" 的普通字段名 + 短值 → 保留（防误伤）
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", // 值模式 JWT → 脱敏
    nested: { raw: "这里有一些文本，无密钥", deep: { k: "Bearer sk-1234567890abcdef" } },
    list: [{ secret: "sk-bbbbbbbb" }],
  };
  stripSensitiveKeys(obj);
  assert.equal(obj.token, "<redacted>", "键名 token 值脱敏");
  assert.equal(obj.authHeader, "<redacted>", "值模式 Bearer 脱敏");
  assert.equal(obj.api_key, "abc", "键名命中但短值保留");
  assert.equal(obj.password, "<redacted>", "键名 password 值脱敏");
  assert.equal(obj.passphrase, "<redacted>", "高敏键名免长度门槛（短值也脱敏）");
  assert.equal(obj.sortKey, "name", "含 key 的普通字段短值不误伤");
  assert.equal(obj.jwt, "<redacted>", "值模式 JWT 脱敏");
  assert.equal(obj.nested.deep.k, "<redacted>", "嵌套值 Bearer 脱敏");
  assert.equal(obj.list[0]?.secret, "<redacted>", "数组内键名脱敏");
  assert.equal(obj.nested.raw, "这里有一些文本，无密钥", "普通文本不动");
}

// ---------------------------------------------------------------- samplePoint（数据格式放开）

{
  // 无 samplePoint 但含 windows → 回落通用提取
  const adapter = {
    version: ADAPTER_CONTRACT_VERSION,
    id: "a",
    label: "A",
    providers: ["x"],
    fetchUsage: async (): Promise<ProviderUsage> => ({ ok: true, provider: "x", label: "A", fetchedAt: 1 }),
  };
  const usage: ProviderUsage = {
    ok: true, provider: "x", label: "A", fetchedAt: 1,
    windows: [{ key: "rolling", name: "5h", percent: 3 }, { key: "monthly", name: "月", percent: 0 }],
  };
  const sp = collectSamplePoint(adapter, usage);
  assert.deepEqual(sp?.values, [3, 0], "回落从 windows 提取 percent 列");
  assert.deepEqual(sp?.cols.map((c) => c.key), ["rolling", "monthly"], "回落列声明 = windows key");

  // 自定义 samplePoint（自定义格式）
  const custom = {
    version: ADAPTER_CONTRACT_VERSION,
    id: "c", label: "C", providers: ["y"],
    fetchUsage: async (): Promise<ProviderUsage> => ({ ok: true, provider: "y", label: "C", fetchedAt: 1 }),
    samplePoint: (u: ProviderUsage) => ({
      cols: [{ key: "credit", name: "余额" }],
      values: [(u.data as { credit: number }).credit],
    }),
  };
  const customSp = collectSamplePoint(custom, { ok: true, provider: "y", label: "C", fetchedAt: 1, data: { credit: 42 } });
  assert.deepEqual(customSp, { cols: [{ key: "credit", name: "余额" }], values: [42] }, "自定义 samplePoint 优先");

  // 两者都没有 → 不采样
  const plain = {
    version: ADAPTER_CONTRACT_VERSION,
    id: "p", label: "P", providers: ["y"],
    fetchUsage: async (): Promise<ProviderUsage> => ({ ok: true, provider: "y", label: "P", fetchedAt: 1 }),
  };
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
  const sample = made.samplePoint?.({ ok: true, provider: "relay", label: "中转站", fetchedAt: 1, windows: [{ key: "credit", name: "额度", percent: 30, limit: 100 }] });
  assert.deepEqual(sample?.values, [30], "工厂派生 samplePoint");
  const sum = (await made.summarize?.({ provider: "relay", fetch, usage: { ok: true, provider: "relay", label: "中转站", fetchedAt: 1, windows: [{ key: "credit", name: "额度", percent: 30 }] } }))!;
  assert.equal(sum.hasAdapter, true);
  assert.equal(typeof sum.text, "string");

  // issue #26：声明 windows 数 ≠ 实际返回 windows 数 → 长度校验拦截，跳过采样
  const mismatched = defineUsageAdapter({
    id: "mismatch",
    label: "M",
    providers: ["m"],
    windows: [
      { key: "a", name: "A", limit: 100 },
      { key: "b", name: "B", limit: 100 },
    ],
    fetchUsage: async () => ({ ok: true, provider: "m", label: "M", fetchedAt: 1 }),
  });
  const badSample = mismatched.samplePoint?.({
    ok: true, provider: "m", label: "M", fetchedAt: 1,
    windows: [{ key: "a", name: "A", percent: 10 }],
  });
  assert.equal(badSample, null, "cols/values 长度不等 → 工厂跳过采样（返回 null）");
}

// ---------------------------------------------------------------- opencode-go 解析与取数

assert.deepEqual(
  pickWindow({ status: "ok", percent: 9, resetsAt: "2026-08-15T00:00:00Z" }, "rolling", "5h 滚动", 12),
  { key: "rolling", name: "5h 滚动", percent: 9, resetsAt: "2026-08-15T00:00:00Z", limit: 12, raw: undefined },
);
assert.equal(pickWindow({ percent: "12" }, "r", "R", 1)?.percent, 12, "字符串 percent 转数字");
assert.equal(pickWindow({ percent: "abc" }, "r", "R", 1)?.percent, null, "非法 percent 置 null");
assert.equal(pickWindow(null, "r", "R", 1), null);
assert.equal(pickWindow("x", "r", "R", 1), null);

{
  const parsed = parseUsageResponse({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } } });
  assert.equal(parsed?.monthly?.percent, 3, "嵌套 usage");
  const parsed2 = parseUsageResponse({ rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: 3 } });
  assert.equal(parsed2?.rolling?.percent, 1, "直接三键");
}
assert.equal(parseUsageResponse(null), null);
assert.equal(parseUsageResponse("x"), null);

{
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => fakeRes(200, OK_BODY) });
  assert.equal(r.ok, true, "200 取数成功");
  if (r.ok) {
    assert.equal(r.windows.length, 3, "三窗口");
    assert.equal(r.windows[2]?.percent, 0);
    assert.equal(r.windows[2]?.key, "monthly");
  }
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
  // 容错：网络抛错
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
}
{
  // 容错：坏 JSON
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
  // 超时：abort 触发 reject → network
  const hangingFetch: FetchLike = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const r = await fetchOpenCodeGo({ baseUrl: "https://x", apiKey: "sk-1", timeoutMs: 5, fetchImpl: hangingFetch });
  assert.equal(r.ok, false);
  assert.equal(r.error, "network");
}

// 内置适配器 fetchUsage 归一化（含 ctx.timeoutMs 通道）
{
  const usage = await openCodeGoHostAdapter.fetchUsage({
    provider: OPENCODE_GO_PROVIDER,
    apiKey: "sk-1",
    fetch: async () => fakeRes(200, OK_BODY),
  });
  assert.equal(usage.ok, true);
  assert.equal(usage.provider, "opencode-go");
  assert.equal(usage.label, "OpenCode Go");
  assert.equal(usage.windows?.length, 3);
  const nokey = await openCodeGoHostAdapter.fetchUsage({ provider: OPENCODE_GO_PROVIDER, fetch: async () => fakeRes(200, OK_BODY) });
  assert.equal(nokey.ok, false);
  assert.equal(nokey.error, "no-api-key");

  // issue #26：ctx.timeoutMs 经 HostFetchContext 下发生效（5ms 快速 abort；
  // 若通道断裂回落硬编码 15000，本用例会挂起而非快速返回）
  const t0 = Date.now();
  const slow = await openCodeGoHostAdapter.fetchUsage({
    provider: OPENCODE_GO_PROVIDER,
    apiKey: "sk-1",
    timeoutMs: 5,
    fetch: (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  assert.equal(slow.ok, false);
  assert.equal(slow.error, "network", "ctx.timeoutMs=5 触发取数超时");
  assert.ok(Date.now() - t0 < 5000, "超时按 ctx.timeoutMs 生效而非默认 15000");
}

// ---------------------------------------------------------------- API Key 解析链

assert.equal(credentialsKeyFromYaml('DEEPSEEK_API_KEY: sk-aaa\nOPENCODE_GO_API_KEY: sk-opencode-123\n'), "sk-opencode-123");
assert.equal(credentialsKeyFromYaml('OPENCODE_GO_API_KEY: "sk-q"'), "sk-q", "带引号");
assert.equal(credentialsKeyFromYaml(""), undefined);
assert.equal(credentialsKeyFromYaml(undefined), undefined);
assert.equal(opencodeKeyFromAuth('{"opencode-go":{"type":"api","key":"sk-go-1"}}'), "sk-go-1", "opencode-go 优先");
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"api","key":"sk-oc-2"}}'), "sk-oc-2", "回退 opencode");
assert.equal(opencodeKeyFromAuth('{"opencode":{"type":"api"}}'), undefined, "无 key");
assert.equal(opencodeKeyFromAuth("{bad json"), undefined, "容错：坏 JSON");
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

  // 列数一致性：单点 cols ≠ values 宽度 → 跳过（issue #26 单点校验）
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", [{ key: "x", name: "X" }], [now + 90000, 1, 2, 3, 4]), { appended: 0, replaced: 0 }, "列数不一致跳过");

  // issue #26：首点即 cols/values 宽度不等 → 单点校验拦截，桶保持空
  const freshStore = makeHistoryStore({ maxAgeDays: 14, now: () => now });
  assert.deepEqual(
    freshStore.append("p1", "a1", [{ key: "x", name: "X" }], [now, 1, 2]),
    { appended: 0, replaced: 0 },
    "cols 1 ≠ values 2 → append 跳过",
  );
  assert.equal(freshStore.list("p1", "a1").samples.length, 0, "被拒点不入桶");
  // 合法宽度一致 → 正常入桶
  assert.deepEqual(freshStore.append("p1", "a1", [{ key: "x", name: "X" }], [now + 1000, 3]), { appended: 1, replaced: 0 }, "宽度相等正常入桶");

  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, null), { appended: 0, replaced: 0 });
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [1]), { appended: 0, replaced: 0 }, "元素不足 2 丢弃");
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, ["x", 1, 2, 3]), { appended: 0, replaced: 0 }, "ts 非法丢弃");
  assert.deepEqual(store.append("opencode-go", "opencode-go-builtin", cols, [now + 120000, "bad", 5, null]), { appended: 1, replaced: 0 });
  const lastPoint = store.list("opencode-go", "opencode-go-builtin").samples.at(-1);
  assert.equal(lastPoint?.[1], null, "非法 percent 归一为 null");

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

  // 防御（容错：坏文件/坏结构）
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
  assert.equal(JSON.parse(text ?? "{}").samples.length, 1, "落盘往返");
  assert.equal(await readHistoryFile(join(dir, "no-such.json")), undefined, "文件不存在返回 undefined");

  // issue #29：rename 失败（目标路径已是目录）→ 抛错且 .tmp 无残留（容错：执行抛错）
  const occupied = join(dir, "occupied.json");
  await mkdir(occupied); // 目标为目录 → rename(tmp, dir) 必败
  let threw = false;
  try {
    await writeHistoryFile(occupied, JSON.stringify({ x: 1 }));
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "rename 到目录目标抛错");
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], ".tmp 残留已清理");
}

// ---------------------------------------------------------------- TTL 缓存（按 provider 键控）

{
  let now = 1000;
  const cache = makeUsageCache<{ v?: number; x?: number }>({ ttlMs: 30000, now: () => now });
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
}

// ---------------------------------------------------------------- 客户端行为纯函数（issue #28：替代 bundle includes 断言）

function mkSummary(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    ok: true, provider: "opencode-go", label: "OpenCode Go",
    text: "5h 2% · 周 1% · 月 0%", level: "ok", hasAdapter: true, fetchedAt: 1,
    ...overrides,
  };
}

{
  const summary = mkSummary();

  // 渲染器 pill 钩子优先（文案 + 等级）
  const customRenderer = { pill: (): { text: string; level: SummaryLevel } => ({ text: "自定义 7%", level: "warn" }) };
  assert.equal(derivePillLabel({ renderer: customRenderer, summary }), "自定义 7%", "pill 钩子文案优先");
  assert.equal(derivePillLevel({ renderer: customRenderer, summary }), "warn", "pill 钩子等级优先");

  // pill 返回 null → 回落 summary.text / summary.level
  const nullRenderer = { pill: (): null => null };
  assert.equal(derivePillLabel({ renderer: nullRenderer, summary }), "5h 2% · 周 1% · 月 0%", "pill null 回落 summary.text");
  assert.equal(derivePillLevel({ renderer: nullRenderer, summary }), "ok", "pill null 回落 summary.level");

  // 无渲染器无 summary → windows 兜底推导（短名 + 百分比拼接）
  const usage: ProviderUsage = {
    ok: true, provider: "x", label: "X", fetchedAt: 1,
    windows: [
      { key: "rolling", name: "5h 滚动", percent: 3 },
      { key: "monthly", name: "每月", percent: 0 },
    ],
  };
  assert.equal(derivePillLabel({ data: usage, provider: "x" }), "5h 滚 3% · 每月 0%", "windows 兜底推导（窗口名 >4 字符截断）");

  // 全缺 → label --%（字符串 label 不截断，与既有行为一致）
  assert.equal(derivePillLabel({ provider: "ghost-relay" }), "ghost-relay --%", "全缺回落 label --%");

  // D11 隐藏语义：无启用适配器隐藏浮窗、有则显示
  assert.equal(shouldHideFloat(false), true, "无启用适配器隐藏浮窗");
  assert.equal(shouldHideFloat(true), false, "有启用适配器显示");

  // title：无适配器提示 / hint 拼接 / 错误态
  assert.equal(derivePillTitle({ hasAdapter: false, provider: "p" }), "p 用量：无启用适配器", "title 无适配器提示");
  assert.equal(
    derivePillTitle({ hasAdapter: true, summary: mkSummary({ hint: "限额 $12" }) }),
    "OpenCode Go 用量：5h 2% · 周 1% · 月 0% · 限额 $12",
    "title 拼接 text 与 hint",
  );
  assert.equal(
    derivePillTitle({ hasAdapter: true, data: { ok: false, provider: "p", label: "L", fetchedAt: 1, error: "no-api-key" } }),
    "L 用量获取失败：no-api-key",
    "title 错误态说明（有适配器但取数失败）",
  );

  // 渲染器配对键优先级：专用 provider/adapterId → 默认 provider
  assert.deepEqual(
    rendererLookupKeys("opencode-go", "opencode-go-builtin"),
    ["opencode-go/opencode-go-builtin", "opencode-go"],
    "配对键先专用后默认",
  );
  assert.deepEqual(rendererLookupKeys("opencode-go"), ["opencode-go"], "无 adapterId 只查默认");
}

// ---------------------------------------------------------------- 死代码清理回归（issue #29）

{
  // 无调用方的导出已从导出面移除（防回归）
  for (const key of ["CONFIG_KEYS", "defaultPersistFile", "resolvePathWeak", "OPENCODE_GO_DEFAULT_ENABLED"] as const) {
    assert.equal(key in libIndex, false, `死代码 ${key} 已从导出面移除`);
  }
  // 注册表不再暴露 unregisterProvider（无调用方）
  const reg = makeHostAdapterRegistry();
  assert.equal("unregisterProvider" in reg, false, "unregisterProvider 已移除");
  // 宿主适配器 providers 数组无重复项
  assert.equal(
    new Set(openCodeGoHostAdapter.providers).size,
    openCodeGoHostAdapter.providers.length,
    "providers 数组无重复",
  );
}

// ---------------------------------------------------------------- 设置页·提供商全集（issue #38）

{
  const items = unionProviders({
    candidatesByProvider: {
      "opencode-go": [{ id: "opencode-go-builtin", label: "OpenCode Go 官方", source: "builtin" }],
      "z-relay": [{ id: "z-relay-user", label: "Z Relay", source: "user-file" }],
    },
    enabled: { "opencode-go": "opencode-go-builtin", "runtime-only": "x" },
    recognized: ["hist-only", "runtime-only", "opencode-go"],
    known: ["opencode-go", "future-provider"],
  });
  // 全集四路合并去重：候选 ∪ 启用 ∪ 运行时识别 ∪ 已知
  assert.deepEqual(
    items.map((i) => i.provider),
    ["future-provider", "opencode-go", "hist-only", "runtime-only", "z-relay"],
    "全集 = 候选 ∪ 运行时启用 ∪ 运行时识别 ∪ 内置已知（已知在前，其余字典序）",
  );
  const ocg = items.find((i) => i.provider === "opencode-go");
  assert.ok(ocg?.hasCandidates && ocg.enabledId === "opencode-go-builtin", "已知且有候选：带启用态");
  const future = items.find((i) => i.provider === "future-provider");
  assert.equal(future?.hasCandidates, false, "仅已知清单项无候选（引导位）");
  // 运行时识别项：无候选无启用也入全集；与 enabled 重叠的 provider 去重只出现一次
  const hist = items.find((i) => i.provider === "hist-only");
  assert.equal(hist?.hasCandidates, false, "运行时识别项无候选");
  assert.equal(hist?.enabledId, null, "运行时识别项未启用");
  assert.equal(items.filter((i) => i.provider === "runtime-only").length, 1, "识别与启用重叠去重");
  assert.equal(items.find((i) => i.provider === "runtime-only")?.enabledId, "x", "运行时启用映射入全集");
  // 空输入 → 空列表
  assert.deepEqual(unionProviders({ candidatesByProvider: {}, known: [] }), [], "空输入空列表");
}

{
  assert.equal(
    providerBadgeText({ enabledId: "opencode-go-builtin" }),
    "启用中: opencode-go-builtin",
    "折叠徽标显示启用中 adapter-id",
  );
  assert.equal(providerBadgeText({ enabledId: null }), "未启用", "清空/未启用徽标文案");
}
