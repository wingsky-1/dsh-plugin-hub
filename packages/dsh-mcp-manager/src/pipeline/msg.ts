/**
 * dsh-mcp-manager — pipeline/msg：统一错误提取（#664 阶段 2 迁入）。
 *
 * 原自 middleware-utils.ts msgOf；执行管道错误文案的稳定取消息面
 * （Error/string/object 三态），两路径（supervisor 直呼 / ws_mcp_call）共用。
 */

/** 统一错误提取（Error/string/object 三态）。 */
export function msgOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}