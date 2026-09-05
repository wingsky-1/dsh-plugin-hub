// @ts-nocheck
/**
 * dsh-notifier — 真实 cordis Context 形态测试（issue #290 C/D/E 系列）。
 *
 * 覆盖（qa 独立复核必须；纯宿主逻辑，qa 实测豁免——隔离环境用真实 cordis 复核）：
 * - C-1/C-3：smoke-lib `assertRealCordisContextSemantics` 在真实 cordis 4.0.1
 *   Context（插件 fiber 运行时上下文）上成立——未注入服务访问抛错 / ctx.get
 *   安全返回 / effect disposer 真实清理语义；
 * - D-1/D-2/D-3：真实 Context 派发 `agent/status` 与 `session/event` 可达性契约
 *   （untagged 放行 + {global:true} 防御），fail-closed（硬断言、无 skip/容错）；
 * - A-1/E-1 静态契约断言：src/index.ts 不得直读 `ctx.agents`、isSubagentOf 走
 *   `ctx.get("agents", false)` 安全读取；全部 `ctx.on` 注册处带 `{ global: true }`
 *   第三参数；
 * - E-2/F 系列（issue #559）：approval/request 注册必须 `{ global: true,
 *   prepend: true }` 链头契约——真实 cordis 双向固化（F-1 反证：push 序下先
 *   注册的短路 answerer 独占执行；F-2 修复：prepend 链头先执行且 outcome 透传）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { assertRealCordisContextSemantics, assertEventReachability } from "../../../test/smoke-lib.ts";

// ── C-1/C-3：真实 Context 三断言（未注入访问抛错 / ctx.get 安全 / effect disposer）──
{
  const root = new Context();
  let pluginCtx = null;
  await root.plugin((ctx) => {
    pluginCtx = ctx;
  });
  assert.ok(pluginCtx !== null && !!pluginCtx.fiber.runtime, "插件 fiber context 已激活（fiber.runtime truthy）");
  assertRealCordisContextSemantics(pluginCtx);
}

// ── D-1/D-3：真实 Context 派发 agent/status 可达 + fail-closed ──
{
  const root = new Context();
  let pluginCtx = null;
  await root.plugin((ctx) => {
    pluginCtx = ctx;
  });
  assertEventReachability(pluginCtx, Context, "agent/status", { agent: { id: "rc-1" }, status: "idle" });
}

// ── D-2/D-3：真实 Context 派发 session/event 可达 + fail-closed ──
{
  const root = new Context();
  let pluginCtx = null;
  await root.plugin((ctx) => {
    pluginCtx = ctx;
  });
  assertEventReachability(pluginCtx, Context, "session/event", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
}

// ── A-1/E-1：源码静态契约断言（test 内扫描，杜绝根因 A 与 {global:true} 遗漏回归）──
{
  const src = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  // A-1：isSubagentOf 不得直读未注入的 ctx.agents；必须走 ctx.get 安全读取
  assert.ok(!/isSubagentOf\(\s*[^)]*ctx\.agents/.test(src), "A-1：isSubagentOf 不得直读 ctx.agents");
  assert.ok(/ctx\.get\("agents", false\)/.test(src), "A-1：isSubagentOf 走 ctx.get(\"agents\", false) 安全读取");
  // inject 保持 ["webServer"]（不动）
  assert.ok(/export const inject = \["webServer"\]/.test(src), "A-1：inject 保持 [\"webServer\"]");
  // E-1：全部 ctx.on 注册处均带 { global: true } 第三参数（当前主干 7 处；
  // approval/request 一处升级为 { global: true, prepend: true }——issue #559 链序契约）
  const onCalls = (src.match(/ctx\.on\(\s*"/g) ?? []).length;
  const globalized = (src.match(/ctx\.on\(\s*"[^"]+"[^]*?\{ global: true[ ,}]/g) ?? []).length;
  assert.ok(onCalls >= 7, `主干 ctx.on 注册应 ≥7 处（实测 ${onCalls}）`);
  assert.equal(globalized, onCalls, `全部 ${onCalls} 处 ctx.on 均应带 {global:true}（实测 ${globalized}）`);
  // E-2（issue #559）：approval/request 注册处必须带 prepend: true（链头契约）
  assert.ok(
    /ctx\.on\(\s*"approval\/request"[^]*?\{ global: true, prepend: true \}/.test(src),
    "E-2：approval/request 注册必须带 { global: true, prepend: true }（否则宿主内置 answerer 短路后不可达）"
  );
}

// ── F：approval/request waterfall 链序契约（issue #559，真实 cordis 派发）──
// 真实宿主形态：官方 remote 转发桥（dsh-api-remotes）在内核启动时注册短路
// answerer（GUI 应答后不调 next()），先于 profile 挂载的第三方插件。notifier
// 以 { global: true, prepend: true } 注册插到链头才可达——此处以真实 cordis
// 复现该链序并双向固化：F-1 反证基线（push 序不可达）+ F-2 修复行为（prepend
// 链头先执行、outcome 透传）。
{
  // F-1：对照基线——push 序下先注册的短路 answerer 独占执行（回归防线：
  // 若 cordis 语义变化使 prepend 失效，本断言与 F-2 的差异面会同时暴露）
  {
    const root = new Context();
    const order = [];
    await root.plugin((ctx) => {
      // 内核先注册：官方转发桥形态的短路 answerer（不调 next = 短路）
      ctx.on("approval/request", () => { order.push("answerer"); return "rejected"; });
    });
    await root.plugin((ctx) => {
      // 插件后注册：旧行为（默认 push 序）
      ctx.on("approval/request", (req, next) => { order.push("notifier"); return next(); });
    });
    const outcome = await root.waterfall("approval/request", { agent: { id: "f1" } }, () => "unavailable");
    assert.deepEqual(order, ["answerer"], "F-1：push 序下先注册的短路 answerer 独占执行，后注册者不可达");
    assert.equal(outcome, "rejected", "F-1：短路 answerer 的返回值决定 outcome");
  }
  // F-2：修复行为——prepend 把后注册的插件监听器固定在链头（先通知再透传）；
  // 派发用 filter carrier 形态（对无 scope 标签的 listener ctx 放行），贴近官方
  // ApprovalService 经 scopeTarget(agent, agent) 的真实派发面。
  {
    const root = new Context();
    const order = [];
    await root.plugin((ctx) => {
      ctx.on("approval/request", () => { order.push("answerer"); return "rejected"; });
    });
    await root.plugin((ctx) => {
      ctx.on("approval/request", (req, next) => { order.push("notifier"); return next(); }, { global: true, prepend: true });
    });
    const outcome = await root.waterfall({ [Context.filter]: () => true }, "approval/request", { agent: { id: "f2" } }, () => "unavailable");
    assert.deepEqual(order, ["notifier", "answerer"], "F-2：prepend 使后注册的监听器先于短路 answerer 执行");
    assert.equal(outcome, "rejected", "F-2：outcome 语义不变（answerer 短路返回值仍决定结果）");
  }
}

console.log("real-context: OK");
