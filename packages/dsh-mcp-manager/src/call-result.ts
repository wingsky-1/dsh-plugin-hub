/**
 * dsh-mcp-manager — CallToolResult 投影（单一事实源，#512）。
 *
 * MCP 协议对 tools/call 成功应答是宽容的：content / structuredContent /
 * isError / _meta 均为 optional 字段，各语言 SDK 序列化习惯不一——如 Python
 * SDK 的 pydantic `exclude_none` 剔不掉合法值 `isError: False`，wire 上必带
 * （#512）；Node SDK 习惯不带。而 dsh 工具系统契约要求 execute 返回值精确
 * 匹配 output schema（additionalProperties: false，仅 content /
 * structuredContent），远端结果的任何多余字段都会让校验失败。
 *
 * 本模块承担「协议结果 → 工具契约」的收敛投影，架构对齐官方
 * @deepseek-ai/dsh-mcp-client createExecutor（协议层宽松拿 + 投影层白名单）：
 *  - isError === true → throw（ToolRuntime catch 路径产出 isError 结果）；
 *  - 白名单返回 { content, ...structuredContent 有值才带 } —— 其余字段
 *    （isError / _meta / 未来协议新增字段）一律丢弃，不外泄进工具契约；
 *  - content 缺失或非数组 → 兜底文本（toolResult 形态渲染 JSON，否则
 *    "(no output)"），防 required content 校验失败（#381 lossless 同源纪律：
 *    不产生 undefined 值键）。
 *
 * supervisor（mcp__ 直呼路径）与 middleware（ws_mcp_call 远端转发）共用，
 * 投影语义只此一份；调用方差异（文本截断/提取、错误文案风格）经
 * CallResultTextHandlers 注入。
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
  const fallbackText = handlers.fallbackText !== undefined
    ? handlers.fallbackText(result)
    : defaultCallResultFallbackText(result);
  const structured = resultObj?.structuredContent;
  if (!Array.isArray(resultObj?.content)) {
    // 无 content / 非数组 content：兜底文本分支（toolResult JSON 或占位符）。
    if (resultObj?.isError === true) throw new Error(fallbackText);
    return {
      content: [{ type: "text", text: fallbackText }],
      ...(structured !== undefined ? { structuredContent: structured } : {}),
    };
  }
  if (resultObj?.isError === true) {
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
