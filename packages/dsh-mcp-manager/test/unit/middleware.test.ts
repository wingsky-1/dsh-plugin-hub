/**
 * dsh-mcp-manager — unit：中间层（ws_mcp_search / ws_mcp_call）。
 *
 * 覆盖：
 * - fullServerName / parseFullServerName（含非法形态）
 * - normalizeToolName（mcp__ 前缀剥离 / 跨 server 拒绝）
 * - B11：server 名含连续双下划线 → guard fail-closed 拒绝并指往 ws_mcp_call（#903 B-M4）
 * - normalizeArguments（JSON 字符串参数解析 / 标量保留）
 * - globMatch（工具名通配纯函数）
 * - scoreTool / searchCatalog（跨字段打分 / unavailable 段 / 空查询摘要）
 * - McpMiddleware：projectUnitFor 惰性创建 + userDisabled 合并 + inFlight 去重
 * - #903 M4：projectUnitFor 后台连接失败记 warn（非 unhandled）
 * - callTool：未知 server / 未连接 / 连接中 / 路由一致性
 * - evictIfNeeded LRU 淘汰
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pollUntil } from "../helpers.ts";
import {
  createMiddlewareShapeSupport,
  installMiddlewareShapeComposition,
  releaseMiddlewareShapeComposition,
} from "./middleware-shape-support.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
/**
 * JSON 值面（render/value 入参口径）：从官方 ToolOutputDefinition 声明派生，不自造第二套
 * （`@deepseek-ai/dsh-util-values` 不在本包依赖内，不直引）。
 */
import type { ServerConfig } from "../../src/server/config/interface.ts";

// I8①：单元层不得值引组合根 src/index.ts——中间层类与注册入口改经各自域门面直取，
// 组合根顶层那六张静态端口表由 helpers 以同实参、同顺序手装，不经组合根求值装配。
const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
beforeAll(installMiddlewareShapeComposition);

afterAll(releaseMiddlewareShapeComposition);
const { fullServerName } = await import("../../src/server/workspace/interface.ts");
const middlewareShape = createMiddlewareShapeSupport();
const ROOT = middlewareShape.root;
const makeHost = middlewareShape.makeHost.bind(middlewareShape);
const identity = middlewareShape.identity.bind(middlewareShape);
const trackMw = middlewareShape.trackMw.bind(middlewareShape);

afterEach(async () => {
  await middlewareShape.cleanup();
});

describe("#903 M4：projectUnitFor 后台连接失败记 warn", () => {
  it("后台 ensureConnected 翻错 → warn 落日志（把 .catch 删掉即无 warn 红）", async () => {
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: true },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const warns: string[] = [];
    const capturingHost = {
      ...host,
      logger: {
        info: () => {},
        warn: (message: string): void => {
          warns.push(message);
        },
        error: () => {},
      },
    };
    const mw = trackMw(new McpMiddleware(capturingHost as unknown as MiddlewareHost));
    mw.ensureConnected = async () => {
      throw new Error("boom-bg");
    };
    // 反证：projectUnitFor 内后台循环的 .catch 删掉 → 拒绝浮空，warn 缺席红。
    await mw.projectUnitFor(ROOT);
    await pollUntil("后台连接失败 warn", () =>
      warns.some((message) => message.includes("background connect")),
    );
    expect(
      warns.some(
        (message) =>
          message.includes("background connect") &&
          message.includes("ctx") &&
          message.includes("failed"),
      ),
    ).toBe(true);
  });
});

describe("callTool：路由一致性 / 未连接", () => {
  async function callToolFixture() {
    // enabled:false → 不触发真实连接（单元测试不 spawn 子进程）
    const servers: ServerConfig[] = [
      { name: "ctx", transport: "stdio", command: "npx", enabled: false },
    ];
    const { host } = makeHost(new Map([[ROOT, servers]]));
    const mw = trackMw(new McpMiddleware(host as unknown as MiddlewareHost));
    await mw.projectUnitFor(ROOT);
    return mw;
  }

  it("路由一致性：参数 root ≠ 路由 root → 拒绝", async () => {
    const mw = await callToolFixture();
    await expect(
      mw.callTool("@/other/root/ctx", "use_ctx", {}, undefined, identity()),
    ).rejects.toThrow(/不属于当前工作空间|未激活/);
  });

  it("未知 server 形态 → 格式错误", async () => {
    const mw = await callToolFixture();
    await expect(mw.callTool("ctx", "use_ctx", {}, undefined, identity())).rejects.toThrow(
      /格式应为/,
    );
  });

  it("未连接 → 错误含下一步提示（ws_mcp_search 或 ws_mcp_list）", async () => {
    const mw = await callToolFixture();
    await expect(
      mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined, identity()),
    ).rejects.toThrow(/未连接或连接失败，请先 ws_mcp_search 或 ws_mcp_list 确认 server 已连接/);
  });

  it("userDisabled → 错误含 GUI 重连提示", async () => {
    const mw = await callToolFixture();
    mw.disabledByRoot.set(ROOT, new Set(["ctx"]));
    const disabledUnit = await mw.projectUnitFor(ROOT);
    // 单元存在由前置连接保证（同一装配器），此处断言存在。
    disabledUnit!.userDisabled.add("ctx");
    await expect(
      mw.callTool(fullServerName(ROOT, "ctx"), "use_ctx", {}, undefined, identity()),
    ).rejects.toThrow(/已被用户禁用；可先在 GUI「MCP」浮窗中重新连接/);
  });
});
