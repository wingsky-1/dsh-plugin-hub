// @ts-nocheck
/**
 * dsh-mcp-manager — unit：执行管道域契约（#664 阶段 2）。
 *
 * 两路径（supervisor 直呼 / ws_mcp_call）同构契约：同一远端结果 → 同一工具契约
 * 投影（#512 单一事实源，pipeline/project.ts）。差异面显式排除三项并文档化：
 *   - timeout：supervisor 靠 SDK timeoutMs（无 withTimeout 层）；middleware 有
 *     withTimeout 兜底（+2s，C-ABT/D6 口径）——同构断言不覆盖超时；
 *   - redact：middleware 错误文案经 hostRedact（createRedactor），supervisor
 *     B8 修复后走日志脱敏面——同构断言只比投影白名单，不比文案；
 *   - stale：目录 TTL 过期前置提示仅 middleware 有——同构断言不覆盖。
 * 其余环节（arguments 归一 → callTool → 投影）输入同、输出同。
 *
 * 另含 supervisor 路径 stats 埋点契约（行为扩展声明，红测先行）：
 * execute 成功后必须 recordCall（现状缺失，commit3 修复）。
 */
import { describe, expect, it } from "vitest";
import { fakeMCPClient } from "../helpers.ts";

const {
  defaultCallResultFallbackText,
  msgOf,
  normalizeArguments,
  projectCallToolResult,
  buildToolDefinition,
} = await import("../../src/index.ts");

// 同一远端 CallToolResult 形态矩阵：两路径 handler 差异（文本渲染风格）之外，
// 投影产物（content / structuredContent 键集与值）必须一致。
const results = [
  { content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 }, isError: false },
  { content: [], isError: false },
  { toolResult: { value: 42 }, isError: false }, // 无 content → 兜底分支
  { content: "not-an-array", isError: false }, // 协议违规形态 → 兜底分支
];
const supervisorHandlers = {
  // supervisor 风格：extractText 占位符渲染 + 截断（差异面仅文本，投影白名单同）
  errorText: (c) => `ERR:${c.length}`,
  fallbackText: (r) => JSON.stringify(r),
};
const middlewareHandlers = {
  // middleware 风格：msgOf + 保留远端原文
  errorText: (c) => `ws_mcp_call:远端错误:${msgOf(c)}`,
  fallbackText: (r) =>
    typeof r === "object" && r !== null && "content" in r && !Array.isArray(r.content)
      ? msgOf(r.content)
      : defaultCallResultFallbackText(r),
};

describe("两路径同构：投影面（#512 单一事实源）", () => {
  it("两路径投影键集合同构", () => {
    for (const result of results) {
      const viaSupervisor = projectCallToolResult(result, supervisorHandlers);
      const viaMiddleware = projectCallToolResult(result, middlewareHandlers);
      // 结构契约同构：键集合一致（structuredContent 只随输入存在）
      expect("structuredContent" in viaMiddleware).toBe("structuredContent" in viaSupervisor);
    }
  });

  it("structuredContent 值同构", () => {
    for (const result of results) {
      const viaSupervisor = projectCallToolResult(result, supervisorHandlers);
      const viaMiddleware = projectCallToolResult(result, middlewareHandlers);
      if ("structuredContent" in viaSupervisor) {
        expect(viaMiddleware.structuredContent).toEqual(viaSupervisor.structuredContent);
      }
    }
  });

  it("投影 content 为数组", () => {
    for (const result of results) {
      const viaSupervisor = projectCallToolResult(result, supervisorHandlers);
      expect(Array.isArray(viaSupervisor.content)).toBeTruthy();
    }
  });

  it("投影 content 块数同构", () => {
    // content 形态同构：数组 + 块数 + 块类型一致（渲染文本是 handler 注入的
    // 调用方差异面，允许不同——同构断言只比投影结构）
    for (const result of results) {
      const viaSupervisor = projectCallToolResult(result, supervisorHandlers);
      const viaMiddleware = projectCallToolResult(result, middlewareHandlers);
      expect(viaMiddleware.content.length).toBe(viaSupervisor.content.length);
    }
  });

  it("投影 content 块类型同构", () => {
    for (const result of results) {
      const viaSupervisor = projectCallToolResult(result, supervisorHandlers);
      const viaMiddleware = projectCallToolResult(result, middlewareHandlers);
      if (viaSupervisor.content.length > 0) {
        expect(viaMiddleware.content[0].type).toBe(viaSupervisor.content[0].type);
      }
    }
  });

  it("直通路径 content 逐字同构", () => {
    // 正常 content 直通路径（无渲染差异）→ 内容逐字一致
    for (const result of results) {
      const viaSupervisor = projectCallToolResult(result, supervisorHandlers);
      const viaMiddleware = projectCallToolResult(result, middlewareHandlers);
      if (Array.isArray(result.content) && result.isError !== true) {
        expect(viaMiddleware.content).toEqual(viaSupervisor.content);
      }
    }
  });

  it("isError:true → 两路径统一抛错（Error 形态）", () => {
    // isError:true → 两路径统一抛错（错误契约同构：Error 形态，非裸对象；
    // 具体文案是 handler 注入差异面，不强匹配）
    for (const handlers of [supervisorHandlers, middlewareHandlers]) {
      expect(
        () => projectCallToolResult({ content: [{ type: "text", text: "boom" }], isError: true }, handlers),
      ).toThrow(Error);
      expect(() => projectCallToolResult({ isError: true }, handlers)).toThrow(Error);
    }
  });
});

describe("两路径同构：args 面（middleware 归一化；supervisor 直传——同构点）", () => {
  it('normalizeArguments 解析 JSON 字符串为对象', () => {
    expect(normalizeArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("B14 数组归一无害空态", () => {
    expect(normalizeArguments("[1,2]")).toEqual({});
  });

  it("object 输入经 supervisor 对象化原样透传", () => {
    // supervisor 路径契约：execute 侧对象化（typeof args === object ? args : {}）——
    // 对 normalizeArguments 产物两路同构（object 输入原样透传）。
    const supShape = (args) => (typeof args === "object" && args !== null ? args : {});
    expect(supShape(normalizeArguments({ a: 1 }))).toEqual({ a: 1 });
  });

  it("JSON 字符串经两路归一后同构", () => {
    const supShape = (args) => (typeof args === "object" && args !== null ? args : {});
    expect(supShape(normalizeArguments('{"a":1}'))).toEqual({ a: 1 });
  });

  it("数组经两路同样归一无害空态", () => {
    const supShape = (args) => (typeof args === "object" && args !== null ? args : {});
    expect(supShape(normalizeArguments("[1,2]"))).toEqual({});
  });
});

describe("supervisor 路径 stats 埋点契约（行为扩展声明，红测：现状未埋点）", () => {
  async function executeOnce() {
    const statsCalls = [];
    const manager = {
      ctx: { tools: { register: () => () => {} } },
      logger: { info: () => {}, warn: () => {} },
      enhancement: {},
      emitStatus: () => {},
      recordCatalogTools: async () => {},
      stats: {
        isEnabled: () => true,
        recordCall: (server, tool, durationMs, success, errorMsg) => {
          statsCalls.push({ server, tool, durationMs, success, errorMsg });
        },
      },
    };
    const client = fakeMCPClient({
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const def = buildToolDefinition(
      client,
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "srv", transport: "stdio", command: "echo", enabled: true },
      { stats: manager.stats },
    );
    const res = await def.execute({ text: "hi" }, { signal: undefined });
    return { res, statsCalls };
  }

  it("supervisor 路径 execute 正常", async () => {
    const { res } = await executeOnce();
    expect(res.content[0].text).toBe("ok");
  });

  it("supervisor execute 成功应 recordCall（现状缺失 → 红测）", async () => {
    const { statsCalls } = await executeOnce();
    expect(statsCalls.length).toBe(1);
  });

  it("recordCall 记录 server 名", async () => {
    const { statsCalls } = await executeOnce();
    expect(statsCalls[0].server).toBe("srv");
  });

  it("recordCall 记录 tool 名", async () => {
    const { statsCalls } = await executeOnce();
    expect(statsCalls[0].tool).toBe("echo");
  });

  it("recordCall 记录 success=true", async () => {
    const { statsCalls } = await executeOnce();
    expect(statsCalls[0].success).toBe(true);
  });
});
