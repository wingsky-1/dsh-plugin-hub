/**
 * dsh-web-file-preview — 文件类型分组判定（纯函数，可单测）。
 *
 * 后缀→预览分组复用 `src/grouping.ts` 单一事实源（与浏览器端共用）；Content-Type
 * 由本地小型映射提供（无需引入 mime-db 大表，避免宿主端第三方依赖被 esbuild 内联
 * 时的 ESM/CJS 兼容问题，保持零运行时依赖）。
 *  - image        → 浏览器可解码的图片（直接 <img>）
 *  - renderedMd   → Markdown（marked 渲染，可切原始）
 *  - renderedCode → 代码类（highlight.js 高亮，可切原始）
 *  - text         → 其它纯文本（等宽 <pre>）
 *  - other        → 其余二进制，提示不可预览
 */

import { groupOfPath } from "./grouping.js";

/** 预览分组。 */
export type PreviewGroup = "image" | "text" | "renderedMd" | "renderedCode" | "other";

/** 判定结果。 */
export interface PreviewKind {
  group: PreviewGroup;
  ext: string;
  /** 实际 Content-Type（图片用精确映射；文本类一律 text/plain 供按文本读取）。 */
  contentType: string;
}

/** 图片后缀 → Content-Type（与 grouping IMAGE_EXTS 对应）。 */
const IMAGE_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/**
 * 按文件路径（或其 basename）判定预览分组与 Content-Type。
 * @param path - 请求的文件路径（只看扩展名）。
 */
export function previewKindOf(path: string): PreviewKind {
  const { group, ext } = groupOfPath(path);
  if (group === "image") {
    return { group: "image", ext, contentType: IMAGE_CONTENT_TYPE[ext] ?? "application/octet-stream" };
  }
  if (group === "md") {
    return { group: "renderedMd", ext, contentType: "text/markdown; charset=utf-8" };
  }
  if (group === "code") {
    return { group: "renderedCode", ext, contentType: "text/plain; charset=utf-8" };
  }
  if (group === "text") {
    return { group: "text", ext, contentType: "text/plain; charset=utf-8" };
  }
  return { group: "other", ext, contentType: "application/octet-stream" };
}
