// @ts-nocheck
/**
 * dsh-provider-usage — 宿主端冒烟测试·集成区（fake ctx + 注入 fetch，无网络）。
 *
 * 纯函数断言区已拆至 smoke-pure.ts（issue #28：该文件无 @ts-nocheck、强类型，
 * 经 ESM import 先于本文件执行）。本文件覆盖 apply 集成链路：
 * - apply：enabled:false 不注册；注册六路由；stats/select/history/adapters/user/
 *   health 的 403/405/400/404/200 全链路
 * - 割接迁移（v1/v2 单文件 → 多文件 v3 + legacy 桶）、数据目录改名迁移
 * - 客户端 bundle 契约面与路由一致性
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
// 纯函数断言区（强类型、无 @ts-nocheck）：副作用导入，先于本文件执行；
// fakeRes/OK_BODY 为共享桩。
import "./smoke-pure.ts";
import { fakeRes, OK_BODY } from "./smoke-pure.ts";
import {
  apply,
  ROUTES,
  DEFAULT_CONFIG,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  LEGACY_ADAPTER_ID,
} from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// 全局隔离（红线）：所有未显式 persistFile 的 apply 用例一律落在临时 DSH_HOME，
// 绝不允许触碰真实 ~/.dsh（数据目录割接逻辑会迁移真实目录，必须隔离）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-home-"));

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

// 注册 stats + select + add + history + adapters + user + health 七路由
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  assert.deepEqual(
    routes.map((r) => r.path).sort(),
    [ROUTES.health, ROUTES.history, ROUTES.adapters, ROUTES.stats, ROUTES.select, ROUTES.add, "/api/dsh-provider-usage/user/"].sort(),
    "注册七条路由",
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
  assert.deepEqual(payload.knownProviders, ["opencode-go"], "knownProviders 内置已知清单（issue #38）");
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
  // issue #29 信息面收敛：只披露文件名，不外泄绝对路径
  assert.equal(payload3.client[0].file, "my-relay-client.js");
  assert.ok(!JSON.stringify(payload3).includes("/abs/"), "adapters.json 不含绝对路径");
  assert.ok(payload3.client[0].url.startsWith("/api/dsh-provider-usage/user/"), "客户端适配器有 serve URL");
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

// ---------------------------------------------------------------- adapters/add 路由（issue #38）：围栏 / 校验 / 登记热注册 / 重启合并

{
  const dir = mkdtempSync(join(tmpdir(), "dou-add-"));
  const adapterFile = join(dir, "added-relay.mjs");
  writeFileSync(
    adapterFile,
    [
      "export default {",
      "  version: 1,",
      '  id: "added-relay",',
      '  label: "Added Relay",',
      '  providers: ["added-relay-provider"],',
      '  async fetchUsage() { return { ok: true, provider: "added-relay-provider", label: "Added", fetchedAt: 0 }; },',
      "};",
    ].join("\n"),
  );
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    persistFile: join(dir, "history.json"),
    credentialsFile: join(here, "no-such-credentials.yaml"),
    authFile: join(here, "no-such-auth.json"),
  });
  const add = routes.find((r) => r.path === ROUTES.add);
  assert.ok(add, "add 路由存在");
  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  const resCode = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  const post = (body, target = resCode) => add.handler(fakeReq({ method: "POST", body }), target);

  // 围栏：403 / 405
  await add.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "add 非回环 403");
  await add.handler(fakeReq({ method: "GET" }), resCode);
  assert.equal(responses.at(-1).__code, 405, "add 非 POST 405");

  // 400：缺字段 / 坏 body
  await post(undefined);
  assert.equal(responses.at(-1).__code, 400, "add 空 body 400");
  await post(JSON.stringify({ id: "x", label: "y" }));
  assert.equal(responses.at(-1).__code, 400, "add 缺 provider/file 400");
  await post(JSON.stringify({ id: `x`.repeat(129), label: "y", provider: "p", file: adapterFile }));
  assert.equal(responses.at(-1).__code, 400, "add 超长 id 400");

  // 400：文件不存在 / 未规整穿越形态
  await post(JSON.stringify({ id: "a", label: "b", provider: "p", file: join(dir, "no-such.mjs") }));
  assert.equal(responses.at(-1).__code, 400, "add 不存在文件 400");
  await post(JSON.stringify({ id: "a", label: "b", provider: "p", file: `${dir}/sub/../added-relay.mjs` }));
  assert.equal(responses.at(-1).__code, 400, "add 含 .. 未规整路径 400（禁穿越）");

  // 422：合法文件但模块导出畸形（缺 fetchUsage）/ id 与入参不一致
  const badExport = join(dir, "bad-export.mjs");
  writeFileSync(badExport, 'export default { version: 1, id: "bad-export", label: "Bad", providers: ["p"] };');
  await post(JSON.stringify({ id: "bad-export", label: "Bad", provider: "p", file: badExport }));
  assert.equal(responses.at(-1).__code, 422, "add 畸形导出（缺 fetchUsage）422");

  const mismatched = join(dir, "mismatched.mjs");
  writeFileSync(mismatched, 'export default { version: 1, id: "actual-id", label: "M", providers: ["p"], async fetchUsage() {} };');
  await post(JSON.stringify({ id: "claimed-id", label: "M", provider: "p", file: mismatched }));
  assert.equal(responses.at(-1).__code, 422, "add 导出 id 与入参不一致 422");

  // 200：成功登记 + 热注册 + 清单落盘
  let payload;
  const res200 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  await post(JSON.stringify({ id: "added-relay", label: "Added Relay", provider: "added-relay-provider", file: adapterFile }), res200);
  assert.equal(payload.ok, true, "add 成功");
  assert.equal(payload.adapter.id, "added-relay");
  assert.ok(!JSON.stringify(payload).includes(dir), "add 响应不外泄绝对路径（只披露文件名）");

  // 热注册生效：adapters.json 出现新候选并默认启用；stats 可取该 provider（no-api-key 错误态即证明走通了适配器）
  const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
  let meta;
  const metaRes = { writeHead: () => {}, end: (chunk) => { meta = JSON.parse(chunk); } };
  adaptersRoute.handler(fakeReq(), metaRes);
  const addedInfo = meta.host.find((h) => h.id === "added-relay");
  assert.ok(addedInfo, "热注册后候选可见");
  assert.equal(addedInfo.enabled, true, "新添加适配器默认启用");
  assert.equal(meta.enabled["added-relay-provider"], "added-relay", "enabled 映射含新 provider");
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let statsPayload;
  const statsRes = { writeHead: () => {}, end: (chunk) => { statsPayload = JSON.parse(chunk); } };
  await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=added-relay-provider` }), statsRes);
  assert.equal(statsPayload.hasAdapter, true, "stats 走通热注册适配器");

  // 清单落盘：重启后合并加载（无需再 add）
  const listFile = join(dir, "user-adapters.json");
  assert.equal(await waitFor(() => existsSync(listFile)), true, "清单已落盘");
  const { ctx: ctx2, routes: routes2 } = makeFakeCtx();
  await apply(ctx2, {
    persistFile: join(dir, "history.json"),
    credentialsFile: join(here, "no-such-credentials.yaml"),
    authFile: join(here, "no-such-auth.json"),
  });
  let meta2;
  const metaRes2 = { writeHead: () => {}, end: (chunk) => { meta2 = JSON.parse(chunk); } };
  routes2.find((r) => r.path === ROUTES.adapters).handler(fakeReq(), metaRes2);
  assert.ok(meta2.host.find((h) => h.id === "added-relay"), "重启后清单合并加载恢复候选");

  // 409：同 id 重复登记
  await post(JSON.stringify({ id: "added-relay", label: "Added Relay", provider: "added-relay-provider", file: adapterFile }));
  assert.equal(responses.at(-1).__code, 409, "重复 id 409");
}

// user 路由：403 / 405 / 404
{
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {});
  const userRoute = routes.find((r) => r.path === "/api/dsh-provider-usage/user/");
  assert.ok(userRoute, "user 路由存在");
  const responses = [];
  const res = { writeHead: () => {}, end: (chunk) => responses.push(JSON.parse(chunk)) };
  userRoute.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
  assert.equal(responses.at(-1).error, "forbidden: loopback-only", "user 非回环 403");
  const res405 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  userRoute.handler(fakeReq({ method: "POST" }), res405);
  assert.equal(responses.at(-1).__code, 405, "user 非 GET 405");
  const res404 = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  userRoute.handler(fakeReq({ url: "/api/dsh-provider-usage/user/999.js" }), res404);
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
  assert.equal(payload.plugin, "dsh-provider-usage");
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

  history.handler(fakeReq({ url: "/api/dsh-provider-usage/history?days=1" }), res3);
  assert.equal(payload.count, 1, "days=1 内包含当前采样点");

  await stats.handler(fakeReq(), res3);
  assert.equal(payload.cached, true, "第二次命中缓存");
  history.handler(fakeReq(), res3);
  assert.equal(payload.count, 1, "缓存命中不产生新采样点");
}

// ---------------------------------------------------------------- 割接迁移（v1/v2 单文件 → 多文件 v3，.bak 保留不删）

/** 轮询等待条件成立（替代固定 sleep：防抖 1000ms 在慢机上会 flake）。 */
async function waitFor(cond, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

{
  // v1 单序列 → opencode-go 内置桶；旧文件重命名 .bak 保留（用户要求：不删除）
  const dir = mkdtempSync(join(tmpdir(), "dou-mig-"));
  const legacy = join(dir, "history.json");
  // 取过去两分钟的整点（避开当前分钟：否则启动采样会同分钟替换最后一个迁移点，断言不确定）
  const nowMin = Math.floor(Date.now() / 60000) * 60000;
  const legacyTs = [nowMin - 120000, nowMin - 60000];
  writeFileSync(legacy, JSON.stringify({ version: 1, samples: [[legacyTs[0], 1, 2, 3], [legacyTs[1], 4, 5, 6]] }));

  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, { apiKey: "sk-test", fetchImpl: async () => fakeRes(200, OK_BODY), persistFile: join(dir, "history.json") });

  const bucketFile = join(dir, "history", "opencode-go", "opencode-go-builtin.json");
  assert.equal(existsSync(bucketFile), true, "v1 迁移生成多文件桶");
  let bucket;
  const flushed = await waitFor(() => {
    try {
      bucket = JSON.parse(readFileSync(bucketFile, "utf8"));
      return Array.isArray(bucket.samples) && bucket.samples.length >= 3;
    } catch {
      return false;
    }
  });
  assert.equal(flushed, true, "防抖落盘完成（迁移 2 点 + 启动采样 1 点）");
  assert.equal(bucket.version, 3, "桶文件 v3");
  assert.equal(bucket.adapterId, "opencode-go-builtin", "opencode-go 旧历史归内置桶");
  for (const t of legacyTs) {
    assert.equal(bucket.samples.some((s) => s[0] === t), true, `旧采样点迁入（ts=${t}）`);
  }
  const tsSet = new Set(bucket.samples.map((s) => s[0]));
  assert.equal(tsSet.size, bucket.samples.length, "无重复 ts（回归：割接写盘 + 目录重扫叠加不翻倍）");
  assert.deepEqual(bucket.columns.map((c) => c.key), ["rolling", "weekly", "monthly"], "columns=内置三窗口");

  assert.equal(existsSync(legacy), false, "旧文件本体已移除（幂等）");
  assert.equal(existsSync(join(dir, "history.json.v1.bak")), true, ".bak 备份保留（不删除，由用户清理）");

  // 幂等：再次 apply 不重复迁移、.bak 不被覆盖
  const bakMtime = existsSync(join(dir, "history.json.v1.bak"));
  const { ctx: ctxB } = makeFakeCtx();
  await apply(ctxB, { apiKey: "sk-test", fetchImpl: async () => fakeRes(200, OK_BODY), persistFile: join(dir, "history.json") });
  assert.equal(existsSync(join(dir, "history.json.v1.bak")), bakMtime, "重复启动不二次迁移/覆盖备份");
}

{
  // v2 单文件分桶 → 各 provider 桶；.bak 保留
  const dir = mkdtempSync(join(tmpdir(), "dou-mig2-"));
  const legacy = join(dir, "history.json");
  const relayTs = Date.now() - 60000;
  writeFileSync(legacy, JSON.stringify({
    version: 2,
    series: {
      "opencode-go": { samples: [[Date.now() - 60000, 1, 2, 3]] },
      "my-relay": { samples: [[relayTs, 9]] },
    },
  }));
  const { ctx } = makeFakeCtx();
  await apply(ctx, { apiKey: "sk-test", fetchImpl: async () => fakeRes(200, OK_BODY), persistFile: join(dir, "history.json") });

  const ocgFile = join(dir, "history", "opencode-go", "opencode-go-builtin.json");
  // issue #26：非 opencode provider 归独立 legacy 桶（不再强制 opencode-go 三窗口桶）
  const relayFile = join(dir, "history", "my-relay", `${LEGACY_ADAPTER_ID}.json`);
  assert.equal(existsSync(ocgFile), true, "v2 opencode-go 桶迁移");
  assert.equal(existsSync(relayFile), true, "v2 非 opencode provider 归独立 legacy 桶");
  const relayBucket = JSON.parse(readFileSync(relayFile, "utf8"));
  assert.deepEqual(relayBucket.samples.map((s) => s[0]), [relayTs], "relay 桶恰好 1 点（无翻倍/无多余采样）");
  // 列声明按样本宽度生成通用列名（样本 [ts, 9] 宽度 1 → col-1）
  assert.deepEqual(
    relayBucket.columns,
    [{ key: "col-1", name: "col-1" }],
    "legacy 桶 columns = 按样本宽度的通用列名",
  );
  assert.equal(existsSync(join(dir, "history.json.v2.bak")), true, "v2 .bak 备份保留");
  assert.equal(existsSync(legacy), false, "v2 旧文件本体移除");
}

// ---------------------------------------------------------------- 改名数据割接（旧数据目录 → 新默认根）

{
  const home = mkdtempSync(join(tmpdir(), "dou-rename-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const legacyDir = join(home, "dsh-opencode-usage");
    const newDir = join(home, "dsh-provider-usage");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "history.json"),
      JSON.stringify({ version: 1, samples: [[Date.now() - 60000, 1, 2, 3]] }),
    );
    const { ctx } = makeFakeCtx();
    await apply(ctx, { apiKey: "sk-test", fetchImpl: async () => fakeRes(200, OK_BODY) });
    assert.equal(existsSync(newDir), true, "旧数据目录整体迁移到新根");
    assert.equal(existsSync(legacyDir), false, "旧目录已移走（原子 rename）");
    const bucketFile = join(newDir, "history", "opencode-go", "opencode-go-builtin.json");
    assert.equal(existsSync(bucketFile), true, "迁移后历史桶已落盘可加载");

    // 新根已存在 → 不再触发迁移（幂等）
    const { ctx: ctx2 } = makeFakeCtx();
    await apply(ctx2, { apiKey: "sk-test", fetchImpl: async () => fakeRes(200, OK_BODY) });
    assert.equal(existsSync(newDir), true, "二次启动幂等（新根存在不重复迁移）");
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
}

// ---------------------------------------------------------------- select 持久化串行化 + 用户宿主适配器加载（issue #29）

{
  const dir = mkdtempSync(join(tmpdir(), "dou-sel-"));
  const adapterFile = join(dir, "user-ocg.mjs");
  writeFileSync(
    adapterFile,
    [
      "export default {",
      "  version: 1,",
      '  id: "user-ocg",',
      '  label: "User OpenCode",',
      '  providers: ["opencode-go"],',
      '  async fetchUsage() { return { ok: true, provider: "opencode-go", label: "User", fetchedAt: 0 }; },',
      "};",
    ].join("\n"),
  );
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    apiKey: "sk-test",
    persistFile: join(dir, "history.json"),
    adapters: { host: [{ provider: "opencode-go", file: adapterFile }] },
    credentialsFile: join(here, "no-such-credentials.yaml"),
    authFile: join(here, "no-such-auth.json"),
  });

  const adaptersRoute2 = routes.find((r) => r.path === ROUTES.adapters);
  let meta;
  const metaRes = { writeHead: () => {}, end: (chunk) => { meta = JSON.parse(chunk); } };
  adaptersRoute2.handler(fakeReq(), metaRes);
  assert.equal(meta.host.length, 2, "内置 + 用户宿主适配器都在候选");
  const userInfo = meta.host.find((h) => h.id === "user-ocg");
  assert.equal(userInfo.file, "user-ocg.mjs", "信息面收敛：用户文件只披露文件名");
  assert.equal(userInfo.enabled, true, "后注册的用户适配器默认启用");

  // 连续两次 select（promise 链串行化）：最终落盘态 = 最后一次选择
  const selectRoute2 = routes.find((r) => r.path === ROUTES.select);
  let selPayload;
  const selRes = { writeHead: () => {}, end: (chunk) => { selPayload = JSON.parse(chunk); } };
  const postSelect = (adapterId) =>
    selectRoute2.handler(
      fakeReq({ method: "POST", body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterId }) }),
      selRes,
    );
  await postSelect(OPENCODE_GO_ADAPTER_ID);
  await postSelect("user-ocg");

  const stateFile = join(dir, "adapter-state.json");
  const settled = await waitFor(() => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === "user-ocg";
    } catch {
      return false;
    }
  });
  assert.equal(settled, true, "连续 select 串行化落盘：最终态 = 最后一次选择");
}

// ---------------------------------------------------------------- select 清空（adapterId: null，issue #38）

{
  const dir = mkdtempSync(join(tmpdir(), "dou-clear-"));
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    apiKey: "sk-test",
    persistFile: join(dir, "history.json"),
    fetchImpl: async () => fakeRes(200, OK_BODY),
  });
  const select = routes.find((r) => r.path === ROUTES.select);
  const stats = routes.find((r) => r.path === ROUTES.stats);
  const responses = [];
  const resCode = { writeHead: (code) => { responses.push({ __code: code }); }, end: () => {} };
  let payload;
  const res200 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  let statsPayload;
  const statsRes = { writeHead: () => {}, end: (chunk) => { statsPayload = JSON.parse(chunk); } };

  // adapterId 缺失/空串仍 400（清空必须显式 null）
  await select.handler(fakeReq({ method: "POST", body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER }) }), resCode);
  assert.equal(responses.at(-1).__code, 400, "adapterId 缺失仍 400");

  // 清空：200 + adapterId null；stats → no-enabled-adapter（有候选全禁用）
  await select.handler(
    fakeReq({ method: "POST", body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterId: null }) }),
    res200,
  );
  assert.equal(payload.ok, true, "清空成功");
  assert.equal(payload.adapterId, null, "响应 adapterId null");
  await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }), statsRes);
  assert.equal(statsPayload.hasAdapter, false, "清空后无启用适配器（浮窗隐藏语义）");
  assert.equal(statsPayload.reason, "no-enabled-adapter", "清空后 reason 为 no-enabled-adapter");

  // 落盘为显式 null；重启后保持禁用（不回退默认启用）
  const stateFile = join(dir, "adapter-state.json");
  assert.equal(
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === null;
      } catch {
        return false;
      }
    }),
    true,
    "清空态以显式 null 落盘",
  );
  const { ctx: ctx2, routes: routes2 } = makeFakeCtx();
  await apply(ctx2, {
    apiKey: "sk-test",
    persistFile: join(dir, "history.json"),
    fetchImpl: async () => fakeRes(200, OK_BODY),
  });
  let stats2;
  const statsRes2 = { writeHead: () => {}, end: (chunk) => { stats2 = JSON.parse(chunk); } };
  await routes2.find((r) => r.path === ROUTES.stats).handler(fakeReq(), statsRes2);
  assert.equal(stats2.hasAdapter, false, "重启后显式清空态保持（不回退内置默认启用）");
}

// ---------------------------------------------------------------- 注入容错补强（issue #38）：执行抛错 / 超时护栏 / 错误登记披露

{
  const dir = mkdtempSync(join(tmpdir(), "dou-fault-"));
  // 执行抛错适配器
  const crashFile = join(dir, "crash-adapter.mjs");
  writeFileSync(
    crashFile,
    [
      "export default {",
      "  version: 1,",
      '  id: "crash-adapter",',
      '  label: "Crash",',
      '  providers: ["crash-relay"],',
      '  async fetchUsage() { throw new Error("boom-crash"); },',
      "};",
    ].join("\n"),
  );
  // 挂起适配器（永不 resolve 的 promise：护栏必须放行采样循环）
  const hangFile = join(dir, "hang-adapter.mjs");
  writeFileSync(
    hangFile,
    [
      "export default {",
      "  version: 1,",
      '  id: "hang-adapter",',
      '  label: "Hang",',
      '  providers: ["hang-relay"],',
      "  async fetchUsage() { return new Promise(() => {}); },",
      "};",
    ].join("\n"),
  );
  // 畸形导出（缺 fetchUsage）：放 DSH_HOME 下以同时验证错误消息路径脱敏
  const badRel = "plugins/provider-usage/bad-shape.mjs";
  const badAbs = join(process.env.DSH_HOME, "plugins", "provider-usage");
  mkdirSync(badAbs, { recursive: true });
  writeFileSync(join(badAbs, "bad-shape.mjs"), 'export default { version: 1, id: "bad-shape", label: "Bad", providers: ["p"] };');

  const t0 = Date.now();
  const { ctx, routes } = makeFakeCtx();
  await apply(ctx, {
    persistFile: join(dir, "history.json"),
    timeoutMs: 120,
    credentialsFile: join(here, "no-such-credentials.yaml"),
    authFile: join(here, "no-such-auth.json"),
    adapters: {
      host: [
        { provider: "crash-relay", file: crashFile },
        { provider: "hang-relay", file: hangFile },
        { provider: "p", file: badRel },
      ],
    },
  });

  const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
  const stats = routes.find((r) => r.path === ROUTES.stats);
  let meta;
  const metaRes = { writeHead: () => {}, end: (chunk) => { meta = JSON.parse(chunk); } };
  let statsPayload;
  const statsRes = { writeHead: () => {}, end: (chunk) => { statsPayload = JSON.parse(chunk); } };

  // 加载期：畸形导出拒收 + 错误登记（消息含明细、DSH_HOME 绝对路径已脱敏）
  adaptersRoute.handler(fakeReq(), metaRes);
  assert.ok(!meta.host.some((h) => h.id === "bad-shape"), "畸形导出不注册");
  const loadErr = meta.errors.find((e) => e.key === "file:bad-shape.mjs");
  assert.ok(loadErr, "加载错误已登记");
  assert.equal(loadErr.kind, "load");
  assert.ok(loadErr.message.includes("fetchUsage"), "错误消息含缺失成员明细");
  assert.ok(!JSON.stringify(meta).includes(process.env.DSH_HOME), "adapters.json 错误消息不含 DSH_HOME 绝对路径");

  // 执行抛错：stats 降级 adapter-crash + exec 错误登记
  await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=crash-relay` }), statsRes);
  assert.equal(statsPayload.usage.ok, false);
  assert.equal(statsPayload.usage.error, "adapter-crash", "执行抛错降级 adapter-crash");
  adaptersRoute.handler(fakeReq(), metaRes);
  const crashErr = meta.errors.find((e) => e.key === "crash-adapter");
  assert.ok(crashErr && crashErr.kind === "exec" && crashErr.message === "boom-crash", "执行错误已登记（最近一次）");

  // 超时护栏：挂起适配器被限时拦截，返回 adapter-timeout 且调用方不再无限等待
  const before = Date.now();
  await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=hang-relay` }), statsRes);
  const elapsed = Date.now() - before;
  assert.equal(statsPayload.usage.ok, false);
  assert.equal(statsPayload.usage.error, "adapter-timeout", "挂起适配器被护栏拦截为 adapter-timeout");
  assert.ok(elapsed < 5000, `护栏及时放行（耗时 ${elapsed}ms，未阻塞请求链）`);
  assert.ok(elapsed >= 100, "护栏时长 ≥ ctx.timeoutMs");
  adaptersRoute.handler(fakeReq(), metaRes);
  const hangErr = meta.errors.find((e) => e.key === "hang-adapter");
  assert.ok(hangErr && hangErr.kind === "exec" && hangErr.message.includes("超时"), "超时错误已登记");

  // health 同步披露错误登记
  const health = routes.find((r) => r.path === ROUTES.health);
  let healthPayload;
  const healthRes = { writeHead: () => {}, end: (chunk) => { healthPayload = JSON.parse(chunk); } };
  health.handler(fakeReq(), healthRes);
  assert.ok(Array.isArray(healthPayload.errors) && healthPayload.errors.length >= 3, "health 披露错误登记");
  assert.ok(!JSON.stringify(healthPayload).includes(process.env.DSH_HOME), "health 错误消息同样路径脱敏");
  assert.ok(Date.now() - t0 < 15000, "整组容错用例未出现死等");
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
  assert.equal(payload.plugin, "dsh-provider-usage");
  assert.equal(payload.baseUrl, DEFAULT_CONFIG.baseUrl);
  assert.equal(payload.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs);
  assert.deepEqual(payload.limits, DEFAULT_CONFIG.limits);
  assert.equal(payload.history.maxAgeDays, DEFAULT_CONFIG.maxAgeDays, "health 带历史摘要");
  assert.equal(typeof payload.history.count, "number");
  // issue #29 信息面收敛：不再暴露 history.root 绝对路径
  assert.equal("root" in payload.history, false, "health.history 不再暴露 root");
  assert.ok(!JSON.stringify(payload).includes(process.env.DSH_HOME), "health 响应不含 DSH_HOME 绝对路径");
  assert.equal(payload.adapters.length >= 1, true, "health 带适配器快照");
  assert.equal(payload.adapters[0].id, "opencode-go-builtin", "适配器快照带 id");
  assert.equal(payload.adapters[0].enabled, true, "适配器快照带 enabled");

  const res403 = { writeHead: () => {}, end: (chunk) => { payload = JSON.parse(chunk); } };
  health.handler(fakeReq({ socket: { remoteAddress: "192.168.1.5" } }), res403);
  assert.equal(payload.error, "forbidden: loopback-only", "health 也强制 loopback");
}

// ---------------------------------------------------------------- 客户端 bundle 契约面

{
  const client = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  // 胶囊文案/状态点/D11 隐藏/(provider, adapterId) 配对四块逻辑已抽为
  // client-logic.ts 纯函数，在 smoke-pure.ts 做行为级断言（issue #28），
  // 此处不再做 lib/client.js 的 includes 字符串断言。
  assert.ok(client.includes("设置面板「用量统计」"), "面板无启用适配器引导入口");
  assert.ok(client.includes("no-enabled-adapter"), "错误态含 no-enabled-adapter");
  // M3b：settings.section 独立 tab
  assert.ok(client.includes('"settings.section"'), "注册 settings.section 顶层 tab");
  assert.ok(client.includes("用量统计"), "tab 标签「用量统计」");
  assert.ok(client.includes("adapters/select"), "适配器管理走 select 接口");

  // issue #38：设置页按提供商重构（总览 + 提供商手风琴列表）
  assert.ok(client.includes("adapters/add"), "添加适配器走 add 接口");
  assert.ok(client.includes("禁用该提供商"), "提供商展开页内禁用按钮");
  assert.ok(client.includes("+ 添加适配器"), "提供商展开页内添加入口");
  assert.ok(client.includes("dou-provHead"), "手风琴折叠头样式类");
  assert.ok(client.includes("dou-provErr"), "错误登记展示（候选执行/文件加载最近一次错误）");
  assert.ok(client.includes("knownProviders"), "消费宿主内置已知清单");

  // issue #27：总览不再硬编码 opencode-go，按 adapters.json enabled 映射逐 provider 拉取
  assert.ok(!client.includes("?provider=opencode-go"), "settings 总览移除硬编码 ?provider=opencode-go");
  assert.ok(client.includes("encodeURIComponent(provider)"), "逐 provider 拉取 /stats（URL 编码）");
  // issue #27：slots 注入独立 try/catch，注册失败不连坐浮窗挂载
  assert.ok(
    client.includes("设置面板 section 注册失败"),
    "slots.inject 独立 try/catch（失败只降级不炸 apply）",
  );
}

// ---------------------------------------------------------------- 客户端路由一致性

{
  const client = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  assertClientSourceContract(join(here, ".."));
  assertClientProductContract(join(here, ".."));
  const literals = new Set(client.match(/\/api\/[A-Za-z0-9_/.-]+/gu) ?? []);
  const hostPaths = new Set([ROUTES.stats, ROUTES.history, ROUTES.health, ROUTES.adapters, ROUTES.select, ROUTES.add]);
  for (const lit of literals) {
    assert.ok(hostPaths.has(lit), `client 字面量 ${lit} 在 host ROUTES 中存在`);
  }
}

console.log("dsh-provider-usage smoke: 全部通过");