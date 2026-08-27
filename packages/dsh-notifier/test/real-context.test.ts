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
 *   第三参数。
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
  // E-1：全部 ctx.on 注册处均带 { global: true } 第三参数（当前主干 7 处）
  const onCalls = (src.match(/ctx\.on\(\s*"/g) ?? []).length;
  const globalized = (src.match(/ctx\.on\(\s*"[^"]+"[^]*?\{ global: true \}/g) ?? []).length;
  assert.ok(onCalls >= 7, `主干 ctx.on 注册应 ≥7 处（实测 ${onCalls}）`);
  assert.equal(globalized, onCalls, `全部 ${onCalls} 处 ctx.on 均应带 {global:true}（实测 ${globalized}）`);
}

console.log("real-context: OK");
