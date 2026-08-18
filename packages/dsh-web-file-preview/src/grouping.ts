/**
 * dsh-web-file-preview — 文件预览分组判定（双端共用单一事实源）。
 *
 * 宿主（src/mime.ts）与浏览器端（src/renderer.ts、src/client.ts）统一复用
 * 本模块：后缀 → 预览分组，杜绝双端各写一份后缀表导致的漂移。
 * 纯逻辑、无 node/browser 特定 API，宿主 tsc 与浏览器 esbuild 均可打包。
 */

/** 预览分组：web 端能否渲染 + 渲染方式。 */
export type PreviewGroupKind = "image" | "md" | "code" | "text" | "other";

/** 分组判定结果。 */
export interface GroupOfResult {
  group: PreviewGroupKind;
  /** 归一化小写扩展名（不含点）。 */
  ext: string;
}

/** web 端可解码的图片后缀（收窄到浏览器能直接放的集合）。 */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);

/** Markdown 渲染组。 */
export const MD_EXTS = new Set(["md", "markdown"]);

/** 代码渲染组（与客户端语言映射一致，见 src/code.ts）。 */
export const CODE_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "cc", "cpp",
  "h", "hh", "hpp", "cs", "go", "rs", "php", "rb", "kotlin", "kt", "swift",
  "dart", "scala", "sh", "bash", "zsh", "sql", "diff", "patch", "dockerfile",
  "ini", "toml", "yaml", "yml", "json", "jsonl", "xml", "html", "htm", "css",
  "scss", "less", "vue", "svelte", "groovy", "perl", "r",
]);

/** 其它纯文本后缀。 */
export const TEXT_EXTS = new Set([
  "txt", "log", "conf", "cfg", "csv", "tsv", "env", "gitignore", "npmrc",
  "properties", "text", "plain", "me", "license", "todo",
]);

/** 本地扩展名提取（不依赖 node:path，供浏览器端打包）。 */
export function extOf(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? "").trim();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 按扩展名判定预览分组（未知 → other）。 */
export function groupOfExt(ext: string): PreviewGroupKind {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MD_EXTS.has(ext)) return "md";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}

/** 按路径（basename 扩展名）判定预览分组。 */
export function groupOfPath(path: string): GroupOfResult {
  const ext = extOf(path);
  return { group: groupOfExt(ext), ext };
}

/** 是否属于 web 端可预览分组（image | md | code | text）。 */
export function isPreviewablePath(path: string): boolean {
  return groupOfPath(path).group !== "other";
}
