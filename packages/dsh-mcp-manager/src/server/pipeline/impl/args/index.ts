/**
 * dsh-mcp-manager — pipeline/impl/args/index.ts：ws_mcp_call 参数归一化（#664 阶段 2 迁入）。
 *
 * 原自 middleware-utils.ts normalizeArguments；B14（数组形态拒绝）已在阶段 1 修复，
 * 本文件为同语义迁移（零行为变更）。
 */

/** 单步解包判定：回答「这串文本是 JSON 参数吗？」——空串/数组归一、对象即得、
 * 引用串内视容器再定去留；调用方只看结论，不问迭代预算（depth 上限在外层）。
 *
 * @returns `result` 到结论（直接返回）；`bail` 不可解（原样返回入值）；
 *   `next` 剥掉一层引用串（外层喂回下一轮并计 depth）。 */
function unwrapArgumentString(
  trimmed: string,
): { kind: "result"; result: unknown } | { kind: "bail" } | { kind: "next"; next: unknown } {
  if (trimmed.length === 0) return { kind: "result", result: {} };
  const head = trimmed.charCodeAt(0);
  const isContainerJson = head === 123 /* { */ || head === 91; /* [ */
  const isQuotedJson = head === 34; /* " */
  if (!isContainerJson && !isQuotedJson) return { kind: "bail" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "bail" };
  }
  if (parsed !== null && typeof parsed === "object") {
    if (Array.isArray(parsed)) return { kind: "result", result: {} }; // B14：解包出数组同样拒绝
    return { kind: "result", result: parsed };
  }
  const inner = typeof parsed === "string" ? parsed.trim() : "";
  const innerLooksContainer = inner.startsWith("{") || inner.startsWith("[");
  if (!isQuotedJson || !innerLooksContainer) return { kind: "bail" };
  return { kind: "next", next: parsed };
}

/** 归一化 ws_mcp_call 的 arguments 参数（模型可能把参数字典填成 JSON 字符串）。 */
export function normalizeArguments(raw: unknown): unknown {
  let value: unknown = raw ?? {};
  // B14：arguments 按 MCP 规范应为 object，数组形态归一无害空态
  // （含顶层数组入参与 JSON 解包解出数组两种路径）。
  if (Array.isArray(value)) return {};
  let depth = 0;
  while (typeof value === "string" && depth < 4) {
    const step = unwrapArgumentString(value.trim());
    if (step.kind === "result") return step.result;
    if (step.kind === "bail") break;
    value = step.next;
    depth += 1;
  }
  return value;
}
