// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — 真实 cordis Context 形态测试（真实派发面与静态契约断言）。
 *
 * 覆盖（qa 独立复核必须；纯宿主逻辑，qa 实测豁免——隔离环境用真实 cordis 复核）：
 * - smoke-lib `assertRealCordisContextSemantics` 在真实 cordis
 *   （catalog 锁定版）Context（插件 fiber 运行时上下文）上成立——未注入服务
 *   访问抛错 / ctx.get 安全返回 / effect disposer 真实清理语义；
 * - 真实 Context 派发 `agent/status` 与 `session/event` 可达性契约
 *   （untagged 放行 + {global:true} 防御），fail-closed（硬断言、无 skip/容错）；
 * - 静态契约断言：src/index.ts 不得直读 `ctx.agents`、isSubagentOf 走
 *   `ctx.get("agents", false)` 安全读取；全部 `ctx.on` 注册处带 `{ global: true }`
 *   第三参数；
 * - approval/request 链序契约：注册必须 `{ global: true,
 *   prepend: true }` 链头契约——真实 cordis 双向固化（反证：push 序下先
 *   注册的短路 answerer 独占执行；修复：prepend 链头先执行且 outcome 透传）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { assertRealCordisContextSemantics, assertEventReachability } from "../../../../test/smoke-lib.ts";

/** 真实 cordis 插件 fiber 上下文（root.plugin 内取得）。 */
async function pluginContext() {
  const root = new Context();
  let pluginCtx: any = null;
  await root.plugin((ctx) => {
    pluginCtx = ctx;
  });
  return pluginCtx;
}

describe("真实 Context 三断言（未注入访问抛错 / ctx.get 安全 / effect disposer）", () => {
  it("插件 fiber context 已激活（fiber.runtime truthy）", async () => {
    const pluginCtx = await pluginContext();
    expect(pluginCtx !== null && !!pluginCtx.fiber.runtime).toBeTruthy();
  });

  it("真实 cordis Context 语义（assertRealCordisContextSemantics：未注入抛错 / ctx.get 安全 / disposer 清理）", async () => {
    assertRealCordisContextSemantics(await pluginContext());
  });
});

describe("真实 Context 派发可达性契约（fail-closed）", () => {
  it("agent/status 可达 + fail-closed", async () => {
    assertEventReachability(await pluginContext(), Context, "agent/status", { agent: { id: "rc-1" }, status: "idle" });
  });

  it("session/event 可达 + fail-closed", async () => {
    assertEventReachability(await pluginContext(), Context, "session/event", { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  });
});

describe("源码静态契约断言（扫 src/index.ts，杜绝根因 A 与 {global:true} 遗漏回归）", () => {
  const src = readFileSync(join(import.meta.dirname, "../../src/index.ts"), "utf8");
  const onCalls = (src.match(/ctx\.on\(\s*"/g) ?? []).length;
  const globalized = (src.match(/ctx\.on\(\s*"[^"]+"[^]*?\{ global: true[ ,}]/g) ?? []).length;

  it("A-1：isSubagentOf 不得直读 ctx.agents", () => {
    expect(!/isSubagentOf\(\s*[^)]*ctx\.agents/.test(src)).toBeTruthy();
  });

  it('A-1：isSubagentOf 走 ctx.get("agents", false) 安全读取', () => {
    expect(/ctx\.get\("agents", false\)/.test(src)).toBeTruthy();
  });

  it('A-1：inject 保持 ["webServer"]', () => {
    expect(/export const inject = \["webServer"\]/.test(src)).toBeTruthy();
  });

  it("主干 ctx.on 注册应 ≥7 处", () => {
    // 当前主干 7 处；approval/request 一处升级为 { global: true, prepend: true } 链序契约
    expect(onCalls >= 7).toBeTruthy();
  });

  it("全部 ctx.on 均应带 {global:true}", () => {
    expect(globalized).toBe(onCalls);
  });

  it("E-2：approval/request 注册必须带 { global: true, prepend: true }（否则宿主内置 answerer 短路后不可达）", () => {
    expect(/ctx\.on\(\s*"approval\/request"[^]*?\{ global: true, prepend: true \}/.test(src)).toBeTruthy();
  });
});

// ── approval/request waterfall 链序契约（真实 cordis 派发）──
// 真实宿主形态：官方 remote 转发桥（dsh-api-remotes）在内核启动时注册短路
// answerer（GUI 应答后不调 next()），先于 profile 挂载的第三方插件。notifier
// 以 { global: true, prepend: true } 注册插到链头才可达——此处以真实 cordis
// 复现该链序并双向固化：反证基线（push 序不可达）+ 修复行为（prepend
// 链头先执行、outcome 透传）。

/** 对照基线：push 序下先注册的短路 answerer 独占执行。 */
async function pushOrderFixture() {
  // 回归防线：若 cordis 语义变化使 prepend 失效，本断言与修复行为的差异会同时暴露
  const root = new Context();
  const order: string[] = [];
  await root.plugin((ctx) => {
    // 内核先注册：官方转发桥形态的短路 answerer（不调 next = 短路）
    ctx.on("approval/request", () => { order.push("answerer"); return "rejected"; });
  });
  await root.plugin((ctx) => {
    // 插件后注册：旧行为（默认 push 序）
    ctx.on("approval/request", (req, next) => { order.push("notifier"); return next(); });
  });
  const outcome = await root.waterfall("approval/request", { agent: { id: "f1" } }, () => "unavailable");
  return { order, outcome };
}

/** 修复行为：prepend 把后注册的插件监听器固定在链头（先通知再透传）。 */
async function prependOrderFixture() {
  // 派发用 filter carrier 形态（对无 scope 标签的 listener ctx 放行），贴近官方
  // ApprovalService 经 scopeTarget(agent, agent) 的真实派发面。
  const root = new Context();
  const order: string[] = [];
  await root.plugin((ctx) => {
    ctx.on("approval/request", () => { order.push("answerer"); return "rejected"; });
  });
  await root.plugin((ctx) => {
    ctx.on("approval/request", (req, next) => { order.push("notifier"); return next(); }, { global: true, prepend: true });
  });
  const outcome = await root.waterfall({ [Context.filter]: () => true }, "approval/request", { agent: { id: "f2" } }, () => "unavailable");
  return { order, outcome };
}

describe("approval/request 链序：push 序对照基线（后注册者不可达）", () => {
  it("F-1：push 序下先注册的短路 answerer 独占执行，后注册者不可达", async () => {
    expect((await pushOrderFixture()).order).toEqual(["answerer"]);
  });

  it("F-1：短路 answerer 的返回值决定 outcome", async () => {
    expect((await pushOrderFixture()).outcome).toBe("rejected");
  });
});

describe("approval/request 链序：prepend 链头先执行且 outcome 透传", () => {
  it("F-2：prepend 使后注册的监听器先于短路 answerer 执行", async () => {
    expect((await prependOrderFixture()).order).toEqual(["notifier", "answerer"]);
  });

  it("F-2：outcome 语义不变（answerer 短路返回值仍决定结果）", async () => {
    expect((await prependOrderFixture()).outcome).toBe("rejected");
  });
});
