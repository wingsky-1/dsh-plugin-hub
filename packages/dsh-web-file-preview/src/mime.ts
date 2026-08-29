/**
 * dsh-web-file-preview — 文件类型分组判定（纯函数，可单测）。
 *
 * 后缀→预览分组复用 `src/grouping.ts` 单一事实源（与浏览器端共用）；图片组
 * Content-Type 由成熟开源库 `mime` 提供（mime-db 全表，issue #12 / 决策 #47
 * approved：消除自写映射表的维护漂移；构建期由 esbuild 内联进产物，仍保持
 * 零运行时依赖）。
 *  - image        → 浏览器可解码的图片（直接 <img>）
 *  - renderedMd   → Markdown（marked 渲染，可切原始）
 *  - renderedCode → 代码类（highlight.js 高亮，可切原始）
 *  - renderedHtml → HTML（issue #73：客户端走 serve 路由 iframe sandbox 渲染；
 *                   /file 仍以 text/plain 直出源码，防止顶层访问成为同源脚本通道）
 *  - text         → 其它纯文本（等宽 <pre>）
 *  - other        → 其余二进制，提示不可预览
 */

import mime from "mime";

import { groupOfPath } from "./grouping.ts";

/** 预览分组。 */
export type PreviewGroup = "image" | "text" | "renderedMd" | "renderedCode" | "renderedHtml" | "other";

/** 判定结果。 */
export interface PreviewKind {
  group: PreviewGroup;
  ext: string;
  /** 实际 Content-Type（图片用精确映射；文本类一律 text/plain 供按文本读取）。 */
  contentType: string;
}

/**
 * 按文件路径（或其 basename）判定预览分组与 Content-Type。
 * @param path - 请求的文件路径（只看扩展名）。
 */
export function previewKindOf(path: string): PreviewKind {
  const { group, ext } = groupOfPath(path);
  if (group === "image") {
    // mime.getType 自带小写归一；未知后缀回退 octet-stream（与原自写表兜底一致）。
    // 注：ico 由自写表的 image/x-icon 变为 mime-db 标准值 image/vnd.microsoft.icon，
    // 浏览器 <img> 与 Content-Type 嗅探均兼容，无行为回归。
    return { group: "image", ext, contentType: mime.getType(ext) ?? "application/octet-stream" };
  }
  if (group === "md") {
    return { group: "renderedMd", ext, contentType: "text/markdown; charset=utf-8" };
  }
  if (group === "html") {
    // E2（issue #73）：/file 对 .html/.htm 必须保持 text/plain——若改为 text/html，
    // 新标签/顶层直接访问 file?path=foo.html 会变成同源顶层脚本执行通道。
    // HTML 的真实渲染走 serve 路由（text/html + iframe sandbox，见 routes.ts）。
    return { group: "renderedHtml", ext, contentType: "text/plain; charset=utf-8" };
  }
  if (group === "code") {
    return { group: "renderedCode", ext, contentType: "text/plain; charset=utf-8" };
  }
  if (group === "text") {
    return { group: "text", ext, contentType: "text/plain; charset=utf-8" };
  }
  return { group: "other", ext, contentType: "application/octet-stream" };
}
