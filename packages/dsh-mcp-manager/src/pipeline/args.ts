/**
 * dsh-mcp-manager — pipeline/args：ws_mcp_call 参数归一化（#664 阶段 2 迁入）。
 *
 * 原自 middleware-utils.ts normalizeArguments；B14（数组形态拒绝）已在阶段 1 修复，
 * 本文件为同语义迁移（零行为变更）。
 */

/** 归一化 ws_mcp_call 的 arguments 参数（模型可能把参数字典填成 JSON 字符串）。 */
export function normalizeArguments(raw: unknown): unknown {
  let value: unknown = raw ?? {};
  // B14：arguments 按 MCP 规范应为 object，数组形态归一无害空态
  // （含顶层数组入参与 JSON 解包解出数组两种路径）。
  if (Array.isArray(value)) return {};
  let depth = 0;
  while (typeof value === "string" && depth < 4) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    const head = trimmed.charCodeAt(0);
    const isContainerJson = head === 123 /* { */ || head === 91 /* [ */;
    const isQuotedJson = head === 34 /* " */;
    if (!isContainerJson && !isQuotedJson) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break;
    }
    if (parsed !== null && typeof parsed === "object") {
      if (Array.isArray(parsed)) return {}; // B14：解包出数组同样拒绝
      return parsed;
    }
    const inner = typeof parsed === "string" ? parsed.trim() : "";
    const innerLooksContainer = inner.startsWith("{") || inner.startsWith("[");
    if (!isQuotedJson || !innerLooksContainer) break;
    value = parsed;
    depth += 1;
  }
  return value;
}