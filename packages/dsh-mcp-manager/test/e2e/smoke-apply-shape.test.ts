// dsh-mcp-manager 冒烟测试（vitest e2e project）—— apply 装配面族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 apply it 族整块迁入本文件
// （enabled:false 不注册路由/提示词、默认配置注册路由与提示词、
// #767 S1-5b apply 恒注册中间层工具）。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { apply, MCP_SECTION_ORDER, ROUTES } from "../../lib/index.js";
import { installCompositionPorts, releaseCompositionPorts } from "../helpers.ts";
import { fakeCtx } from "./remaining-smoke-support.ts";

beforeAll(() => {
  installCompositionPorts();
});

afterAll(() => {
  releaseCompositionPorts();
});

it("enabled:false 不注册路由/提示词", async () => {
  const ctx = fakeCtx();
  await apply(ctx, { enabled: false });
  expect(ctx.routes.length).toBe(0);
  expect(ctx.sections.length).toBe(0);
});
it("默认配置注册路由与提示词（空存储不连接）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-apply-"));
  const ctx = fakeCtx();
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    expect(ctx.routes.length).toBe(11); // 9 条业务路由 + 1 条 SSE events + 1 条 health
    expect(
      ctx.routes.some((route) => route.path === ROUTES.events),
      "SSE events 路由已注册",
    ).toBeTruthy();
    expect(ctx.sections.length).toBe(1);
    expect(ctx.sections[0].name).toBe("plugin:dsh-mcp-manager");
    expect(ctx.sections[0].text).toMatch(/dsh-mcp-manager/);
    // 补充说明」，该相对位置不变——此断言防未来官方再重排后本段落静默贬值。
    expect(ctx.sections[0].order, "分节 order 取具名常量（防裸数字漂移）").toBe(MCP_SECTION_ORDER);
    expect(
      ctx.sections[0].order > 0 && ctx.sections[0].order < 500,
      "分节位置落在官方 DEPLOYMENT_PERSONA_PREFIX(0) 与 PLAN_POLICY(500) 之间",
    ).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("#767 S1-5b：apply 恒注册中间层工具（与配置键无关）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-mwtools-"));
  const ctx = fakeCtx();
  try {
    await apply(ctx, { enabled: true, storePath: join(dir, "dsh-mcp.json") });
    // 这条断言不再依赖任何热切换路径（#362 热切换用例随配置键一并删除）。
    const toolNames = ctx.registeredTools.map((def) => def.name);
    expect(toolNames.includes("ws_mcp_call"), "apply 恒注册中间层工具").toBeTruthy();
    expect(
      ctx.routes.some((route) => route.path === ROUTES.config),
      "config 路由已注册",
    ).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
