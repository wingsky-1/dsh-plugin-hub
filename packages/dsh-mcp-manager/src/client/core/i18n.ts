/**
 * dsh-mcp-manager — 客户端 i18n 渲染辅助（core 层）。
 *
 * 阶段 7 分层：本文件拆出自 locales.ts（字典数据与 McpLocaleKey 类型留在
 * 根目录 locales.ts 供 LocaleNamespaceMap 声明合并；渲染期文案求值辅助收
 * 到本文件，与状态映射 constants.ts 协作）。
 */

import { t } from "../../../../../shared/client/i18n.js";
import { STATUS_TEXT } from "./constants.ts";

/**
 * 状态文案求值：已知状态取字典翻译，未知状态回落原始 key 原样显示
 * （C13：未知状态按 stopped 投影、不丢卡——文案层同样不丢原文案）。
 */
export function tStatus(status: string): string {
  return STATUS_TEXT[status] !== undefined ? t(STATUS_TEXT[status]) : status;
}
