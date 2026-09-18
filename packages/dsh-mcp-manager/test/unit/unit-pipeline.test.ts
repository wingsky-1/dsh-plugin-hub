/**
 * dsh-mcp-manager — unit：执行管道域契约（#664 阶段 2）。
 *
 * projectCallToolResult（#512 单一事实源，pipeline/project.ts）的**结构投影**契约：同一远端
 * 结果在**任意 handler 注入面**下投影出的 content / structuredContent 键集与值必须一致——
 * handler 只提供文本渲染（错误文案 / 兜底文案），不得影响结构。#767 S1-5c 前本文件以
 *「supervisor 直呼 / ws_mcp_call 两路径同构」表述：自研栈退役后直连注册由官方
 * @deepseek-ai/dsh-mcp-client 承担，仓内只剩 ws_mcp_call 一条自持路径，故断言保留而口径
 * 改为「结构投影对 handler 注入解耦」（同一函数、两组 handler 的对照 #512 判据）。
 *
 * S1-5c 同笔删除：原「supervisor 路径 stats 埋点契约」5 例——被测实现（buildToolDefinition
 * 的 stats 注入）随四文件退役，工具调用埋点现只在 inject/middleware-register.ts 的
 * ws_mcp_call 路径上发生（由 unit-call-stats.test.ts 覆盖）。
 */
import { describe, expect, it } from "vitest";

// I8 导入面收窄：纯函数域，直引 pipeline 目录门面，不再经包根组合根。
const { defaultCallResultFallbackText, msgOf, normalizeArguments, projectCallToolResult } =
  await import("../../src/server/pipeline/interface.ts");
import type { CallResultTextHandlers } from "../../src/server/pipeline/interface.ts";

// 同一远端 CallToolResult 形态矩阵：两组 handler 差异（文本渲染风格）之外，
// 投影产物（content / structuredContent 键集与值）必须一致。
const results = [
  { content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 }, isError: false },
  { content: [], isError: false },
  { toolResult: { value: 42 }, isError: false }, // 无 content → 兜底分支
  { content: "not-an-array", isError: false }, // 协议违规形态 → 兜底分支
];
const directCallHandlers: CallResultTextHandlers = {
  // 直连风格（官方客户端路径时代的 handler 形态）：短占位符渲染（文本面差异，结构面同）
  errorText: (c) => `ERR:${c.length}`,
  fallbackText: (r) => JSON.stringify(r),
};
const wsCallHandlers: CallResultTextHandlers = {
  // ws_mcp_call 风格：msgOf + 保留远端原文
  errorText: (c) => `ws_mcp_call:远端错误:${msgOf(c)}`,
  fallbackText: (r) =>
    typeof r === "object" && r !== null && "content" in r && !Array.isArray(r.content)
      ? msgOf(r.content)
      : defaultCallResultFallbackText(r),
};

describe("结构投影对 handler 注入解耦（#512 单一事实源）", () => {
  it("两组 handler 投影键集合同构", () => {
    for (const result of results) {
      const viaDirectCall = projectCallToolResult(result, directCallHandlers);
      const viaWsCall = projectCallToolResult(result, wsCallHandlers);
      // 结构契约同构：键集合一致（structuredContent 只随输入存在）
      expect("structuredContent" in viaWsCall).toBe("structuredContent" in viaDirectCall);
    }
  });

  it("structuredContent 值同构", () => {
    for (const result of results) {
      const viaDirectCall = projectCallToolResult(result, directCallHandlers);
      const viaWsCall = projectCallToolResult(result, wsCallHandlers);
      if ("structuredContent" in viaDirectCall) {
        expect(viaWsCall.structuredContent).toEqual(viaDirectCall.structuredContent);
      }
    }
  });

  it("投影 content 为数组", () => {
    for (const result of results) {
      const viaDirectCall = projectCallToolResult(result, directCallHandlers);
      expect(Array.isArray(viaDirectCall.content)).toBeTruthy();
    }
  });

  it("投影 content 块数同构", () => {
    // content 形态同构：数组 + 块数 + 块类型一致（渲染文本是 handler 注入的
    // 文本差异面，允许不同——断言只比投影结构）
    for (const result of results) {
      const viaDirectCall = projectCallToolResult(result, directCallHandlers);
      const viaWsCall = projectCallToolResult(result, wsCallHandlers);
      expect(viaWsCall.content.length).toBe(viaDirectCall.content.length);
    }
  });

  it("投影 content 块类型同构", () => {
    for (const result of results) {
      const viaDirectCall = projectCallToolResult(result, directCallHandlers);
      const viaWsCall = projectCallToolResult(result, wsCallHandlers);
      if (viaDirectCall.content.length > 0) {
        // 内容块为 unknown 面：只比类型鉴别子（块形状本身是远端形态，不断言）。
        expect((viaWsCall.content[0] as { type: unknown }).type).toBe(
          (viaDirectCall.content[0] as { type: unknown }).type,
        );
      }
    }
  });

  it("直通路径 content 逐字同构", () => {
    // 正常 content 直通（无渲染差异）→ 内容逐字一致
    for (const result of results) {
      const viaDirectCall = projectCallToolResult(result, directCallHandlers);
      const viaWsCall = projectCallToolResult(result, wsCallHandlers);
      if (Array.isArray(result.content) && result.isError !== true) {
        expect(viaWsCall.content).toEqual(viaDirectCall.content);
      }
    }
  });

  it("isError:true → 两组 handler 一律抛错（Error 形态）", () => {
    // isError:true → 一律抛错（错误契约同构：Error 形态，非裸对象；
    // 具体文案是 handler 注入差异面，不强匹配）
    for (const handlers of [directCallHandlers, wsCallHandlers]) {
      expect(() =>
        projectCallToolResult(
          { content: [{ type: "text", text: "boom" }], isError: true },
          handlers,
        ),
      ).toThrow(Error);
      expect(() => projectCallToolResult({ isError: true }, handlers)).toThrow(Error);
    }
  });
});

describe("args 面归一契约（normalizeArguments）", () => {
  it("normalizeArguments 解析 JSON 字符串为对象", () => {
    expect(normalizeArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("B14 数组归一无害空态", () => {
    expect(normalizeArguments("[1,2]")).toEqual({});
  });

  it("object 输入对象化后原样透传", () => {
    // 执行侧对象化契约（typeof args === object ? args : {}）——
    // 对 normalizeArguments 产物同构（object 输入原样透传）。
    const supShape = (args: unknown) => (typeof args === "object" && args !== null ? args : {});
    expect(supShape(normalizeArguments({ a: 1 }))).toEqual({ a: 1 });
  });

  it("JSON 字符串归一后同构", () => {
    const supShape = (args: unknown) => (typeof args === "object" && args !== null ? args : {});
    expect(supShape(normalizeArguments('{"a":1}'))).toEqual({ a: 1 });
  });

  it("数组归一无害空态", () => {
    const supShape = (args: unknown) => (typeof args === "object" && args !== null ? args : {});
    expect(supShape(normalizeArguments("[1,2]"))).toEqual({});
  });
});
