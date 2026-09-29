/**
 * dsh-mcp-manager — unit：外层调用超时纯函数与注册面透传（#935）。
 *
 * 单元层是白盒面：直引 inject 域实现（impl/call-timeout）与注册入口，不经组合根
 * （I8①：unit 层不得值引 src/index.ts；装配面手装四端口，与组合根同实参）。
 * 覆盖：
 * - resolve 取 max、缺席/非法值按缺省 15s 计、空集回落 40s；
 * - 外层公式断言：期望值用共享常量现算，不写字面量（共享常量与纯函数内镜像改动
 *   不同步时本用例打红）；
 * - 多源等价（@global 连接 + 项目连接 + 运行时内存注入的封装项都只是数字源）；
 * - 70s 长任务 fake-timer 等价：内层预算 72s 可结算、外层覆盖内层，无真实长等待；
 * - registerMiddlewareTools 吃传入 callTimeoutMs，省略时按空集回落。
 *
 * 全离线、无落盘；路由 403/405 围栏由既有用例照带（本文件不碰路由面）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { McpMiddleware } from "../../src/server/connection/runtime/interface.ts";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
} from "../../src/server/shared/interface.ts";
import { withTimeout } from "../../src/server/pipeline/interface.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as runtimeApi from "../../src/server/connection/runtime/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import { installInject, releaseInject } from "../../src/server/inject/interface.ts";

// 经 inject/interface 直引注册入口与超时纯函数并手装四端口（与组合根同实参），
// 不经组合根求值装配；跨域只经门面，不直引 impl 文件。
const { registerMiddlewareTools, resolveMiddlewareCallTimeoutMs } =
  await import("../../src/server/inject/interface.ts");

/** 外层内部尾：CONNECT(10s) + DISCOVERY(10s) + 5000，用常量现算、不用字面量。 */
const OUTER_TAIL = CONNECT_TIMEOUT_MS + DISCOVERY_TIMEOUT_MS + 5000;

function installInjectPorts(): void {
  installInject({
    catalog: catalogApi,
    runtime: runtimeApi,
    pipeline: pipelineApi,
    workspace: workspaceApi,
  });
}

afterEach(() => {
  try {
    releaseInject();
  } catch {
    // 未装配忽略
  }
});

describe("resolveMiddlewareCallTimeoutMs：纯函数口径", () => {
  it("零依赖：源码无 import 语句", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "../../src/server/inject/impl/call-timeout/index.ts"),
      "utf8",
    );
    expect(/^\s*import[\s(]/m.test(src)).toBe(false);
    expect(src.includes("require(")).toBe(false);
  });

  it("空集回落：缺省 15s + 内部尾（期望值用常量现算）", () => {
    expect(resolveMiddlewareCallTimeoutMs([])).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS + OUTER_TAIL);
  });

  it("缺席与非法值按缺省计", () => {
    expect(resolveMiddlewareCallTimeoutMs([undefined])).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS + OUTER_TAIL,
    );
    expect(resolveMiddlewareCallTimeoutMs([Number.NaN, -5, 0])).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS + OUTER_TAIL,
    );
  });

  it("取 max：多源中最大者 + 内部尾", () => {
    expect(resolveMiddlewareCallTimeoutMs([5000, 120_000, 30_000])).toBe(120_000 + OUTER_TAIL);
  });

  it("多源等价：@global 连接 + 项目连接 + 内存注入封装项同按数字源取 max", () => {
    // 组合根收集时三者已拍平成数字（units 全 root 含 @global + runtimeRegistry），
    // 这里锁定「来源身份不影响结果，只有数值参与 max」。
    const fromGlobalUnit = 60_000;
    const fromProjectUnit = 15_000;
    const fromRuntimeRegistryWrapped = 70_000;
    expect(
      resolveMiddlewareCallTimeoutMs([fromGlobalUnit, fromProjectUnit, fromRuntimeRegistryWrapped]),
    ).toBe(fromRuntimeRegistryWrapped + OUTER_TAIL);
  });
});

describe("70s 长任务 fake-timer 等价（无真实长等待）", () => {
  it("内层预算 72s 可结算 70s 任务，且外层覆盖内层", async () => {
    vi.useFakeTimers();
    try {
      const sourceTimeout = 70_000;
      const task = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 70_000));
      const pending = withTimeout(task, sourceTimeout + 2000, "inner timeout");
      const assertion = expect(pending).resolves.toBe("done");
      await vi.advanceTimersByTimeAsync(70_000);
      await assertion;
      // 外层恒大于内层兜底：70s 调用不会被外层先误杀。
      expect(resolveMiddlewareCallTimeoutMs([sourceTimeout])).toBeGreaterThan(sourceTimeout + 2000);
      expect(resolveMiddlewareCallTimeoutMs([sourceTimeout])).toBe(sourceTimeout + OUTER_TAIL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("对照：预算耗尽仍按时熔断（定时器不是摆设）", async () => {
    vi.useFakeTimers();
    try {
      const task = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 73_000));
      const pending = withTimeout(task, 72_000, "ws_mcp_call: 调用超时（70000ms）");
      const assertion = expect(pending).rejects.toThrow(/调用超时（70000ms）/);
      await vi.advanceTimersByTimeAsync(73_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registerMiddlewareTools：外层 timeoutMs 透传", () => {
  function registerFixture(options: { callTimeoutMs?: number } = {}) {
    installInjectPorts();
    const defs: ToolDefinition[] = [];
    const ctxFake = {
      tools: {
        register: (def: ToolDefinition) => {
          defs.push(def);
          return () => {};
        },
      },
      on: () => () => {},
    };
    const mwFake = {
      units: new Map(),
      disabledTools: new Map(),
    } as unknown as McpMiddleware;
    registerMiddlewareTools(ctxFake as unknown as Context, mwFake, async () => "/proj", {
      disabledTools: new Map(),
      ...options,
    });
    const call = defs.find((def) => def.name === "ws_mcp_call");
    expect(call).toBeDefined();
    return (call as unknown as { timeoutMs?: unknown }).timeoutMs;
  }

  it("吃传入 callTimeoutMs", () => {
    expect(registerFixture({ callTimeoutMs: 95_000 })).toBe(95_000);
  });

  it("省略时按空集回落（期望值用常量现算，不用 40000 字面量）", () => {
    expect(registerFixture()).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS + OUTER_TAIL);
  });
});
