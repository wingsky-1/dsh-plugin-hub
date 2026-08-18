/**
 * dsh-web-file-preview — Markdown 渲染（marked 封装，GFM 常用能力）。
 *
 * 用社区成熟库 `marked` 渲染，开启 GFM 常用能力（表格、删除线、任务列表、自动链接）。
 * md 渲染是「呈现方式」，由 marked 对正文做转义。
 */

import { marked } from "marked";

// 开启 GFM 常用能力（表格/删除线/任务列表/自动链接）；breaks 保持默认（不强制换行）。
marked.setOptions({ gfm: true, breaks: false });

/**
 * 渲染 Markdown → HTML。
 * @param src - 原始 markdown 文本。
 * @returns 渲染后的 HTML 字符串。
 */
export function renderMarkdown(src: string): string {
  const out = marked.parse(src, { async: false });
  return typeof out === "string" ? out : String(out);
}
