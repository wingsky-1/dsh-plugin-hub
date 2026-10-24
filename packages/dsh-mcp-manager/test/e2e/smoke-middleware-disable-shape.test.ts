// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 中间层面：工具级禁用三入口与持久化。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的中间层 describe-less it 族整块迁入本文件
// （工具注册 128 eff、all 模式 @global 191 eff、#362 P0-1 三入口一致 234 eff 等），fullName 与
// 断言逐字保留（顶层 it 原名，不新增 describe 层级）。仍是 e2e 层判据：被测对象是真实
// registerMiddlewareTools + 真 McpMiddleware/McpManager/McpStore + mkdtemp 隔离目录。
//
// import 实例纪律（与原文件一致，不得改动）：lib/index.js 是自包含 bundle、有自己一份已装配的
// 六张静态端口单例；本文件同时从 src 域门面取符号，故按同实参、同顺序手装组合根端口
// （重复装配会抛，故 beforeAll 只装一次、afterAll 逆序释放）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreToolDecision, ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeManagerCtx, installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { releaseCatalogTempDirs, type SmokeGuard } from "./remaining-smoke-support.ts";
import {
  makeDisableHostFixture,
  runDisableStatsAssertions,
} from "./smoke-middleware-shape-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCatalogTempDirs(catalogTempDirs);
  releaseCompositionPorts();
});

/** catalogTempDirs 账本由本文件独自持一份（原 smoke 顶层 catalogTempDirs 的同形状）。 */
const catalogTempDirs: string[] = [];
it("#362 P0-1：工具级禁用三入口一致（callTool / pre-execute guard / mcp__ 直呼）", async () => {
  const { fullServerName } = await import("../../src/server/workspace/interface.ts");
  const { parseDisabledTools } = await import("../../src/server/store/interface.ts");
  const { isToolDenied, toolDisabledReason } =
    await import("../../src/server/pipeline/interface.ts");
  // 1) isToolDenied 纯函数：项目 root 命中 + @global 回落 + 哈希超长名不误禁。
  const map = parseDisabledTools({ "/proj": { ctx: ["use_ctx"] }, "@global": { gctx: ["use_g"] } });
  expect(isToolDenied(map, fullServerName("/proj", "ctx"), "use_ctx"), "项目 root 记录命中").toBe(
    true,
  );
  expect(isToolDenied(map, fullServerName("/proj", "ctx"), "other"), "未禁用工具放行").toBe(false);
  expect(
    isToolDenied(map, fullServerName("/proj", "gctx"), "use_g"),
    "@global 共享记录回落命中",
  ).toBe(true);
  expect(
    isToolDenied(map, fullServerName("@global", "gctx"), "use_g"),
    "@global root 自身记录命中",
  ).toBe(true);
  expect(isToolDenied(map, "mcp__ctx__use_ctx_hash123456", "x"), "哈希超长名不可逆 → 不误禁").toBe(
    false,
  );
  // 2) registerMiddlewareTools 的 pre-execute guard：mcp__ 直呼被 deny。
  // 装配段（ctx 的 register/on 面 + 目录投影 host + register 带 disabledTools）上提为具名工厂
  // makeDisableHostFixture，it 回调只留断言；实参与调用顺序逐字不变。
  const { mw, guard, dispose } = await makeDisableHostFixture(map, catalogTempDirs);
  expect(typeof guard === "function", "pre-execute guard 已注册").toBeTruthy();
  const deny = await guard!(
    {
      name: "mcp__ctx__use_ctx",
      agent: { session: { header: { cwd: "/proj" } } },
    } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(deny.kind, "mcp__ 直呼被禁用表 deny").toBe("deny");
  expect((deny as unknown as { reason: string }).reason, "拒绝原因含禁用语义声明").toMatch(
    /已被用户在「MCP」浮窗禁用/,
  );
  const allow = await guard!(
    {
      name: "mcp__ctx__other",
      agent: { session: { header: { cwd: "/proj" } } },
    } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  // #1014 B5：未禁用的 mcp__ 直呼也不再放行——内部注册名不可由模型发起。
  expect(allow.kind, "未禁用工具直呼一律拒").toBe("deny");
  expect((allow as unknown as { reason: string }).reason).toContain("ws_mcp_call");
  // agent-less → root 解析不出，退到最宽可见面（@global 共享记录仍生效）。
  const gDeny = await guard!(
    { name: "mcp__gctx__use_g" } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(gDeny.kind, "agent-less 时 @global 共享记录仍 deny").toBe("deny");
  // #1014 B5 / R8：上面那条走的是「@global 命中禁用」分支；这里补它的**另一侧**——
  // agent-less 且 @global 无记录时，handleDirectMcpGuard 返回 undefined（不构成裁决），
  // 由兜底拒接手。缺这条时，把那个 return undefined 改成提前 deny 或提前放行都不会红：
  // 两条分支在 B5 后都收敛到 deny，只是文案不同。这里把文案钉住（禁用语义 vs 内部名语义），
  // 让「提前短路」这种改法也会被打红。
  const gAllow = await guard!(
    { name: "mcp__gctx__other" } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(gAllow.kind, "agent-less 且 @global 无记录时仍拒").toBe("deny");
  expect((gAllow as unknown as { reason: string }).reason).not.toContain("禁用");
  // 超长哈希名（含非法字符被替换）→ 不误禁。
  const hashed = await guard!(
    { name: "mcp__ctx__use_ctx_0123456789ab" } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  // 哈希/截断名同样以 mcp__ 开头：前缀判定恒成立，走兜底拒而非「按未知 server 放行」。
  expect(hashed.kind, "哈希后缀名直呼一律拒").toBe("deny");
  // ws_mcp_call guard：禁用命中 → deny。
  const callDeny = await guard!(
    {
      name: "ws_mcp_call",
      arguments: { server: fullServerName("/proj", "ctx"), tool: "use_ctx" },
    } as unknown as Parameters<SmokeGuard>[0],
    async () => ({ kind: "allow" }) as PreToolDecision,
  );
  expect(callDeny.kind, "ws_mcp_call guard 查禁用表").toBe("deny");
  expect(
    toolDisabledReason(fullServerName("/proj", "ctx"), "use_ctx").includes("mcp-manager 管辖"),
    "禁用原因声明覆盖 mcp__ 与中间层工具（#413）",
  ).toBe(true);

  // 3) callTool（ws_mcp_call 执行路径）：禁用工具 → 显式抛错（验收 14：三入口一致）。
  // 单元与连接条目改由真实路径建立（#767 S1-3b：目录内存态归 catalog 域，手工塞单元
  // 已无法把目录带进去）；host.projectServersFor 给的是**虚拟连接**定义服务器，
  // 它的 statusOf 恒 connected（#413 既有契约），与本段判据一致。
  await mw.projectUnitFor("/proj");
  await mw.ensureConnected("/proj", "ctx");
  // callTool 的第 5 形参换成身份对象（agent / callId / rootCallId / parent）：dispatch 要拿它
  // 合成子调用 id 并透传 parent。本用例只走本地守卫与投影，给最小身份即可。
  const IDENTITY = { callId: "smoke-call-1" as ToolExecutionInput["callId"] };
  await expect(
    () => mw.callTool(fullServerName("/proj", "ctx"), "use_ctx", {}, undefined, IDENTITY),
    "callTool 先查禁用表（三入口一致）",
  ).rejects.toThrow(/已被用户在「MCP」浮窗禁用/);
  // 未禁用工具正常放行到调用。
  const okValue = (await mw.callTool(
    fullServerName("/proj", "ctx"),
    "other",
    {},
    undefined,
    IDENTITY,
  )) as { content: unknown };
  // 判据面随夹具换面（#767 S1-3b）：原夹具是远端条目，投影后 content 为空数组；现夹具
  // 走封装直呼分支（无 output.render），渲染器把封装返回值按 JSON 文本投影成一个 text 块。
  // 夹具确定性（execute 恒返回 {content:[]}），故这里逐字钉死投影结果。
  expect(okValue.content, "未禁用工具正常调用（封装返回值按 JSON 文本投影）").toEqual([
    { type: "text", text: '{"content":[]}' },
  ]);

  // 4) stats：四个原子工具埋点与统计断言（执行段上提为具名工厂，断言逐字不变）。
  await runDisableStatsAssertions(mw);
  dispose();
});
it("#362 P1：disabledTools 持久化（合并式写盘 + 重启保留）", async () => {
  const { MIDDLEWARE_GLOBAL_ROOT } = await import("../../lib/index.js");
  const { McpManager } = await import("../../src/server/connection/orchestrator/interface.ts");
  const { McpStore, loadDisabledTools, saveDisabledTools, parseDisabledTools } =
    await import("../../src/server/store/interface.ts");
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-tools-"));
  try {
    const file = join(dir, "dsh-mcp-user-state.json");
    // 预置磁盘记录（模拟另一工作空间已禁用），并让 manager 加载（等价
    // initMiddleware 的 loadDisabledTools 路径——进程内完整视图）。
    await saveDisabledTools(file, parseDisabledTools({ "/other": { s2: ["t2"] } }));
    const manager = new McpManager(fakeManagerCtx(), new McpStore(join(dir, "mcp.json")));
    manager.userStatePath = file;
    manager.disabledTools = await loadDisabledTools(file);
    // 多空间共存：新增 /proj 记录，/other 记录保留（不整表覆盖）。
    await manager.setToolDisabled("/proj", "ctx", "use_ctx", true);
    await manager.setToolDisabled(MIDDLEWARE_GLOBAL_ROOT, "gctx", "use_g", true);
    const reloaded = await loadDisabledTools(file);
    const hasTool = (
      state: Map<string, Map<string, Set<string>>>,
      root: string,
      s: string,
      t: string,
    ) => state.get(root)?.get(s)?.has(t) === true;
    expect(hasTool(reloaded, "/proj", "ctx", "use_ctx"), "/proj 记录落盘").toBe(true);
    expect(hasTool(reloaded, "@global", "gctx", "use_g"), "@global 记录落盘").toBe(true);
    expect(
      hasTool(reloaded, "/other", "s2", "t2"),
      "既有 /other 记录保留（合并式，绝不整表覆盖）",
    ).toBe(true);
    // 解除禁用 → 记录清除；其他记录保留。
    await manager.setToolDisabled("/proj", "ctx", "use_ctx", false);
    const after = await loadDisabledTools(file);
    const projTools = after.get("/proj")?.get("ctx");
    expect(projTools === undefined || !projTools.has("use_ctx"), "解除后记录清除").toBe(true);
    expect(after.get("/other")?.get("s2")?.has("t2"), "解除不影响其他记录").toBe(true);
    await manager.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
