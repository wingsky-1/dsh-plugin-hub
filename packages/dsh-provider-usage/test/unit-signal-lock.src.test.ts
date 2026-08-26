// @ts-nocheck
/**
 * dsh-provider-usage — unit：#120 signal 接线 + per-provider 互斥配套断言。
 *
 * 硬性断言三项（issue #120 配套要求）：
 * 1. 超时后底层 fetch 收到 abort——合并信号下发至 fetchData 入参并透传给 fetchImpl，
 *    超时触发后该 signal.aborted === true（真实场景下 undici fetch 收到同一信号即中断请求）；
 * 2. 0 参 fetchData 兼容不受影响——形参 0 个的适配器照常走 fresh 通道；
 * 3. 超时失败不当 fresh 落历史——失败帧 ok=false/status='stale'/无 rawData，
 *    上层 append 门控（ok && fresh && rawData!==undefined）三条件全破，绝不落盘。
 *
 * 另覆盖：外部信号合流（手动级联监听，engines node>=20 兼容，不用 AbortSignal.any）、
 * 已 abort 外部信号的同步短路、成功路径监听器摘除、管道组装 fail-fast 断言。
 */
console.error("EVAL-ORDER-TAG: SIGNAL-LOCK");
import { getEventListeners } from "node:events";
import { assert } from "./helpers.ts";
import {
  runV2Pipeline,
  safeFetchData,
} from "../src/index.ts";

/** 构造满足 v2 契约的最小适配器（format 函数恒返回占位）。 */
function mkAdapter(name, provider, fetchData) {
  return {
    version: 2,
    name,
    providers: [provider],
    fetchData,
    formatCapsule: () => "<span>s</span>",
    formatPanel: () => "<p>s</p>",
  };
}

// ---------------------------------------------------------------- 硬性1：超时后底层 fetch 收到 abort

{
  // safeFetchData 层：fn 收到合并信号；超时后该信号 aborted=true
  let seen;
  const r = await safeFetchData(async (signal) => {
    seen = signal;
    await new Promise(() => {}); // 模拟慢远端永挂
    return {};
  }, 25);
  assert.equal(r.error, "fetchData 超时", "超时错误文案稳定");
  assert.ok(seen instanceof AbortSignal, "fn 入参收到 AbortSignal（合并信号已下发）");
  assert.equal(seen.aborted, true, "超时后合并信号已 abort（透传给 fetch 即中断真实请求）");
}
{
  // runV2Pipeline 层端到端：fetchData 把 ctx.signal 透传给注入的 fetch（deepseek-official
  // 直传形态），超时后底层 fetch 手里的正是同一个已 abort 的信号（接线证据链闭合）
  const seen = { fromAdapter: undefined, fromFetch: undefined };
  const adapter = mkAdapter("sig-adp", "p-sig", async (ctx) => {
    seen.fromAdapter = ctx.signal;
    // 模拟真实适配器：signal 原样进 RequestInit.signal，fetch 内部挂到网络上
    return await ctx.fetch("https://gw.test/usage", { signal: ctx.signal });
  });
  const r = await runV2Pipeline({
    adapter,
    provider: "p-sig",
    config: {},
    staticPath: "",
    timeoutMs: 25,
    fetchImpl: (_url, init) => new Promise((_res, rej) => {
      seen.fromFetch = init.signal;
      init.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    }),
  });
  assert.equal(r.ok, false, "超时取数失败帧 ok=false");
  assert.equal(r.status, "stale", "超时失败帧 status=stale");
  assert.equal(r.error, "fetchData 超时", "超时文案经管线原样上浮");
  assert.ok(seen.fromAdapter instanceof AbortSignal, "fetchData 入参收到合并 AbortSignal");
  assert.equal(seen.fromAdapter.aborted, true, "超时后 fetchData 手里的信号已 abort");
  assert.equal(seen.fromFetch, seen.fromAdapter, "底层 fetch 收到的正是下发的合并信号（同对象）");
  assert.equal(seen.fromFetch.aborted, true, "底层 fetch 观察到 abort（socket 可中断）");
}
{
  // opencode-go 监听形态：fetchData 监听 ctx.signal 做补偿取消，超时后同样被触发
  let notified = false;
  const adapter = mkAdapter("sig-listen", "p-sig-l", (ctx) => new Promise((_res, rej) => {
    ctx.signal.addEventListener("abort", () => {
      notified = true;
      rej(new Error("aborted"));
    }, { once: true });
  }));
  const r = await runV2Pipeline({ adapter, provider: "p-sig-l", config: {}, staticPath: "", timeoutMs: 25 });
  assert.equal(r.error, "fetchData 超时", "race 超时分支先于 fn rejection 定格错误文案");
  assert.equal(notified, true, "监听型适配器在超时后收到取消通知");
}

// ---------------------------------------------------------------- 硬性2：0 参 fetchData 兼容不受影响

{
  // 形参 0 个的 fetchData（旧版常见声明）：不读入参、不依赖 signal，走正常 fresh 通道
  const zeroArg = function zero() { return Promise.resolve({ visits: 9 }); };
  assert.equal(zeroArg.length, 0, "前置确认：被测 fetchData 为 0 形参声明");
  const adapter = mkAdapter("zero-adp", "p-zero", zeroArg);
  const r = await runV2Pipeline({ adapter, provider: "p-zero", config: {}, staticPath: "", timeoutMs: 1000 });
  assert.equal(r.ok, true, "0 参 fetchData 正常成功");
  assert.equal(r.status, "fresh", "0 参 fetchData 走 fresh 通道");
  assert.deepEqual(r.rawData, { visits: 9 }, "数据保真（多传一个 signal 实参无影响）");
  assert.equal(typeof r.capsuleHtml, "string", "胶囊照常渲染");
}

// ---------------------------------------------------------------- 硬性3：超时失败不当 fresh 落历史

{
  // 失败帧三条件全破：ok=false / status='stale' / rawData===undefined
  // ——上层 append 门控（result.ok && status==='fresh' && rawData!==undefined）绝不放行
  const adapter = mkAdapter("slow-adp", "p-hist", () => new Promise(() => {}));
  const r = await runV2Pipeline({ adapter, provider: "p-hist", config: {}, staticPath: "", timeoutMs: 25 });
  assert.equal(r.ok, false, "超时帧 ok=false（门控条件1破）");
  assert.equal(r.status, "stale", "超时帧 status=stale（门控条件2破）");
  assert.equal(r.rawData, undefined, "超时帧无 rawData（门控条件3破）→ 绝不以 fresh 身份落历史");
  assert.equal(r.reason, "fetch-failed", "失败原因标记 fetch-failed");
  assert.notEqual(r.error, null, "error 字段携带失败信息");
}
{
  // 对照组：fresh 成功帧携带 rawData——证明「无 rawData」是超时路径特有而非通用形状
  const adapter = mkAdapter("fast-adp", "p-hist-ok", async () => ({ v: 1 }));
  const ok = await runV2Pipeline({ adapter, provider: "p-hist-ok", config: {}, staticPath: "", timeoutMs: 1000 });
  assert.equal(ok.status, "fresh", "对照组 fresh");
  assert.deepEqual(ok.rawData, { v: 1 }, "fresh 帧携带 rawData 供历史落盘");
}

// ---------------------------------------------------------------- 外部信号合流（手动级联，node>=20 兼容）

{
  // 外部信号中途 abort → 取数立即取消，不等超时窗口
  const external = new AbortController();
  const t0 = Date.now();
  const pending = safeFetchData(() => new Promise(() => {}), 10_000, external.signal);
  setTimeout(() => external.abort(), 5);
  const r = await pending;
  assert.equal(r.error, "fetchData 已被取消", "外部取消走专用错误文案");
  assert.ok(Date.now() - t0 < 2000, `外部取消立即生效（实际 ${Date.now() - t0}ms），不等 10s 超时`);
}
{
  // 预先已 abort 的外部信号：同步短路立即取消
  const external = new AbortController();
  external.abort();
  const t0 = Date.now();
  const r = await safeFetchData(() => new Promise(() => {}), 10_000, external.signal);
  assert.equal(r.error, "fetchData 已被取消", "预 abort 外部信号立即取消");
  assert.ok(Date.now() - t0 < 2000, "同步短路不等超时");
}
{
  // 成功路径：外部信号监听器被摘除——后续外部 abort 不再产生任何副作用，
  // 且结果不受影响（防长生命周期外部信号累积监听器泄漏）
  const external = new AbortController();
  const r = await safeFetchData(async () => ({ ok: 1 }), 1000, external.signal);
  assert.equal(r.data?.ok, 1, "带外部信号的正常取数不受影响");
  // 可观测代理：node:events#getEventListeners 直读 EventTarget 监听器表，锁死
  // 「成功路径必须摘除内部 abort 监听器」（原 eventListenerList 非 Node AbortSignal
  // 公开属性、before>=0 恒真弱断言，已按 hardener 纪律清除）
  assert.equal(getEventListeners(external.signal, "abort").length, 0, "成功路径后外部信号无残留 abort 监听器");
  external.abort(); // 监听器已摘除，此 abort 不产生任何副作用
  assert.equal(r.data?.ok, 1, "结果保持不变");
}
{
  // 外部取消判负后的用户 promise rejection 不产生 unhandledRejection：
  // fn 在 abort 后以 rejected 结束（模拟真实 fetch 抛 AbortError），进程必须存活
  const external = new AbortController();
  process.once("unhandledRejection", () => {
    throw new Error("出现了 unhandledRejection——safeFetchData 未兜底 race 判负的用户 promise");
  });
  const pending = safeFetchData((_signal) => new Promise((_res, rej) => {
    external.signal.addEventListener("abort", () => rej(new Error("AbortError: canceled")), { once: true });
  }), 10_000, external.signal);
  setTimeout(() => external.abort(), 5);
  const r = await pending;
  assert.equal(r.error, "fetchData 已被取消", "外部取消正常上报");
  await new Promise((res) => setTimeout(res, 30)); // 给潜在 unhandledRejection 留出暴露窗口
}

// ---------------------------------------------------------------- fail-fast：管道内部组装断言

{
  // timeoutMs 非法（0/负数/NaN）时不发起任何取数，直接产出既有 error 帧；
  // 不新增配置项、不是对用户适配器的契约约束（#120 P2 判定点=管道组装）
  for (const bad of [0, -5, Number.NaN]) {
    let called = false;
    const adapter = mkAdapter("ff-adp", "p-ff", async () => { called = true; return {}; });
    const r = await runV2Pipeline({ adapter, provider: "p-ff", config: {}, staticPath: "", timeoutMs: bad });
    assert.equal(r.ok, false, `timeoutMs=${bad} 时 fail-fast 失败帧`);
    assert.equal(r.status, "stale", `timeoutMs=${bad} 错误形态为既有 stale 帧`);
    assert.match(r.error ?? "", /pipeline 组装非法/, "fail-fast 文案点明组装非法");
    assert.equal(called, false, `timeoutMs=${bad} 未发起任何用户取数`);
  }
}

console.log("[unit] #120 signal 接线 + per-provider 配套断言 ✓");
