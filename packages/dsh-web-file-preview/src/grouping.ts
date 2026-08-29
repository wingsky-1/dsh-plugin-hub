/**
 * dsh-web-file-preview — 文件预览分组判定（双端共用单一事实源）。
 *
 * 宿主（src/mime.ts）与浏览器端（src/renderer.ts、src/client.ts）统一复用
 * 本模块：后缀 → 预览分组，杜绝双端各写一份后缀表导致的漂移。
 * 纯逻辑、无 node/browser 特定 API，宿主 tsc 与浏览器 esbuild 均可打包。
 */

/** 预览分组：web 端能否渲染 + 渲染方式。 */
export type PreviewGroupKind = "image" | "md" | "code" | "text" | "html" | "other";

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

/**
 * HTML 渲染组（issue #73）：`.html/.htm` 从代码组迁出——走「serve 路由 + iframe
 * sandbox」静态伺服渲染，而非高亮源码直出。`/file` 仍以 text/plain 服务原始源码
 * （E2：保持 text/plain，避免顶层导航成为同源脚本执行通道）。
 */
export const HTML_EXTS = new Set(["html", "htm"]);

/** 代码渲染组（与客户端语言映射一致，见 src/code.ts）。 */
export const CODE_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "cc", "cpp",
  "h", "hh", "hpp", "cs", "go", "rs", "php", "rb", "kotlin", "kt", "swift",
  "dart", "scala", "sh", "bash", "zsh", "sql", "diff", "patch", "dockerfile",
  "ini", "toml", "yaml", "yml", "json", "jsonl", "xml", "css",
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
  if (HTML_EXTS.has(ext)) return "html";
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

/**
 * 一个字符串是否呈现为"单个可预览文件路径"（供点击识别共用判定）。
 *
 * 识别"单个文件"而非"多个路径并列/拼接的展示标签"：逗号、换行、多段连续空白
 * 都是多文件并列的形态（如上下文注入折叠摘要 `~/.dsh/AGENTS.md, AGENTS.md`），
 * 误判会把它们当成一条路径去预览并拦截原生点击。http/#/mailto 与不可预览后缀
 * 一并排除。权威信号（元素 title / <a href>）与非权威文本嗅探共用此判定，
 * 保持双端一致、单一事实源。
 */
export function isLikelySingleFilePath(value: string): boolean {
  if (value === undefined || value === null) return false;
  if (/^https?:\/\//i.test(value) || value.startsWith("#") || value.startsWith("mailto:")) return false;
  if (value.includes(",")) return false;
  if (/[\n\r]/.test(value)) return false;
  if (/\s{2,}/.test(value)) return false;
  // 评审 U5：单空格分隔的多文件并列（`dir/a.md dir/b.md`）——每段都带路径分隔符时
  // 判定为拼接标签而非单路径，避免 stat 404 弹「打不开」。文件名本身含空格的
  // （`my file.md`）其后段无分隔符，不受影响。
  const spaceParts = value.split(" ");
  if (spaceParts.length > 1 && spaceParts.every((p) => p.length > 0 && /[\\/]/.test(p))) return false;
  if (!isPreviewablePath(value)) return false;
  return value.includes("/") || value.includes("\\") || !/\s/.test(value);
}

/**
 * 从对话渲染的 @-mention chip 标签还原干净文件路径（formatFileMention 的逆）。
 * dsh rc8 引入 `@` 引用后，对话气泡把 `@path` 渲染成带 `data-ref-chip` 的 span，
 * title 始终带前导 `@`（如 `@/abs/path/file.ts`）。
 * 本函数负责去掉前导 `@` 和可选的引号，还原出干净路径供预览引擎使用。
 *
 * @param raw - chip 的 title 属性，如 "@/abs/path/file.ts" 或 '@"a b/c.ts"'。
 * @param appearance - chip 的 data-ref-chip 取值。
 * @returns 干净路径；非文件类或无法解析 → null。
 */
export function cleanRefChipPath(raw: string, appearance: 'file' | 'folder' | 'session' | 'skill'): string | null {
  if (appearance === 'session' || appearance === 'skill') return null;
  if (typeof raw !== 'string' || raw === '') return null;
  let s = raw.startsWith('@') ? raw.slice(1) : raw;        // 去一个前导 @
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1); // 去引号（含空格路径）
  if (s === '') return null;
  return s; // folder 保留尾 /；file 由 formatFileMention 保证无尾 /
}
