/**
 * dsh-mcp-manager — pipeline/project：CallToolResult 投影（单一事实源，#512，#664 阶段 2 迁入）。
 *
 * 原自 call-result.ts（全量迁移，含类型面）。MCP 协议对 tools/call 成功应答宽容
 * （content / structuredContent / isError / _meta 均 optional，各 SDK 序列化习惯
 * 不一——Python pydantic exclude_none 剔不掉合法值 isError:false）；dsh 工具契约
 * 要求 execute 返回精确匹配 output schema（additionalProperties:false），故在此
 * 收敛白名单投影（对齐官方 dsh-mcp-client createExecutor）。
 *
 * supervisor（mcp__ 直呼路径）与 middleware（ws_mcp_call 远端转发）共用；
 * 调用方差异（文本截断/提取、错误文案风格）经 CallResultTextHandlers 注入。
 */

/** 投影文本渲染回调（调用方差异面）。 */
export interface CallResultTextHandlers {
  /**
   * isError:true 的抛错文案（入参为 content 块数组，调用方按自身文案风格
   * 渲染；缺省用兜底文本抛错）。
   */
  errorText?: (content: unknown[]) => string;
  /**
   * content 缺失/非数组时的兜底文本渲染；缺省 defaultCallResultFallbackText
   * （supervisor 额外叠加截断）。
   */
  fallbackText?: (result: unknown) => string;
}

/** 投影产物：恰好落在 ws_mcp_call / mcp__ 工具的 output schema 契约内。 */
export interface ProjectedCallResult {
  content: unknown[];
  structuredContent?: unknown;
}

/**
 * 默认兜底文本：toolResult 形态渲染 JSON，否则 "(no output)"
 * （对齐官方 dsh-mcp-client 的 no-content 分支）。
 */
export function defaultCallResultFallbackText(result: unknown): string {
  const rendered =
    result !== undefined && result !== null && typeof result === "object" && "toolResult" in result
      ? JSON.stringify((result as { toolResult?: unknown }).toolResult)
      : "(no output)";
  return typeof rendered === "string" ? rendered : "(no output)";
}

/**
 * 默认错误文案：优先取 content 内 text 块 join（保留远端错误信息），
 * 无 text 块时退化兜底文本。轻量提取，不做占位符渲染（那是调用方
 * extractText 的差异面）。
 */
function defaultErrorText(content: unknown[], fallbackText: string): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : fallbackText;
}

/**
 * 把远端 CallToolResult 投影为 dsh 工具契约形状。
 * @param result protocol.callTool 的原始返回（宽松 ResultSchema，未定形）。
 * @param handlers 可选的文本渲染差异面。
 * @returns 白名单化的 { content, structuredContent? }（无 undefined 值键）。
 * @throws Error 当 result.isError === true（文案经 handlers.errorText 或兜底文本）。
 */
export function projectCallToolResult(
  result: unknown,
  handlers: CallResultTextHandlers = {},
): ProjectedCallResult {
  const resultObj = (typeof result === "object" && result !== null ? result : undefined) as
    | { content?: unknown; isError?: unknown; structuredContent?: unknown; toolResult?: unknown }
    | undefined;
  // 兜底文本惰性求值（F3）：仅缺省分支实际消费，正常 content 路径零开销。
  const resolveFallbackText = (): string =>
    handlers.fallbackText !== undefined
      ? handlers.fallbackText(result)
      : defaultCallResultFallbackText(result);
  const structured = resultObj?.structuredContent;
  if (!Array.isArray(resultObj?.content)) {
    // 无 content / 非数组 content：兜底文本分支（toolResult JSON 或占位符）。
    if (resultObj?.isError === true) throw new Error(resolveFallbackText());
    const fallbackText = resolveFallbackText();
    return {
      content: [{ type: "text", text: fallbackText }],
      ...(structured !== undefined ? { structuredContent: structured } : {}),
    };
  }
  if (resultObj?.isError === true) {
    const fallbackText = resolveFallbackText();
    throw new Error(
      handlers.errorText !== undefined
        ? handlers.errorText(resultObj.content)
        : defaultErrorText(resultObj.content, fallbackText),
    );
  }
  return {
    content: resultObj.content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}