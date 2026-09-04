/**
 * dsh-provider-usage — 设置页共享片段（#532 拆分自 settings.ts）。
 *
 * 仅样式常量与微工具；组件各自独立文件。文案一律经 locales 字典。
 */
import * as React from "react";
import { fetchTimeout } from "../core.ts";

/** 设置页分区卡样式（浅色回退 + 主题变量）。 */
export const sectionStyle: Object = {
  marginBottom: 16,
  padding: "10px 12px",
  border: "1px solid var(--dsw-alias-border-l1,#e2e5ea)",
  borderRadius: 10,
  background: "var(--dsw-alias-bg-base,#ffffff)",
  fontSize: 12,
  lineHeight: 1.7,
};

/** 分区标题样式。 */
export const titleStyle: Object = {
  fontSize: 13,
  fontWeight: 600,
  margin: "0 0 6px",
};

/** JSON GET（设置页各面板共用；失败上抛由调用方兜底）。 */
export async function jsonGet(url: string): Promise<unknown> {
  const res = await fetchTimeout(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 复制文本到剪贴板（失败静默返回 false）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** React 兼容类型别名（settings 各文件共用，避免逐处 import type）。 */
export type ReactNode = React.ReactNode;
