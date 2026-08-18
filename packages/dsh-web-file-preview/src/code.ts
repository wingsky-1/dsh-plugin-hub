/**
 * dsh-web-file-preview — 代码语法高亮（highlight.js 子集封装）。
 *
 * 用社区成熟库 `highlight.js`（按需核 + 语言子集），按扩展名推断语言并高亮；
 * 未注册/未知语言降级纯文本（转义后原样输出，不报错）。
 * 高亮产出带 `.hljs-*` token class 的 HTML，配色由客户端 CSS 以 --dsw-* token 提供。
 */

import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import plaintext from "highlight.js/lib/languages/plaintext";

// 注册语言子集（语言 id 即 hljs 子路径模块名）。
const LANGUAGE_REGISTRY: Record<string, unknown> = {
  javascript, typescript, json, xml, css, scss, markdown, yaml, bash,
  python, java, c, cpp, csharp, go, rust, php, ruby, kotlin, swift, dart,
  diff, dockerfile, ini, plaintext,
};

for (const [langId, mod] of Object.entries(LANGUAGE_REGISTRY)) {
  hljs.registerLanguage(langId, mod as never);
}

/** 后缀 → highlight.js 语言 id（与宿主 mime.ts CODE_EXTS 对应）。 */
const EXT_TO_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", jsonl: "json",
  xml: "xml", html: "xml", htm: "xml", svg: "xml",
  css: "css", scss: "scss", less: "css",
  md: "markdown", markdown: "markdown",
  yaml: "yaml", yml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python", java: "java", c: "c", cc: "cpp", cpp: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", go: "go", rs: "rust", php: "php", rb: "ruby",
  kotlin: "kotlin", kt: "kotlin", swift: "swift", dart: "dart",
  diff: "diff", patch: "diff", dockerfile: "dockerfile", ini: "ini", toml: "ini",
  txt: "plaintext", plain: "plaintext", log: "plaintext", csv: "plaintext",
};

/** 按扩展名取 highlight.js 语言 id（无映射 → "plaintext"）。 */
export function languageForExt(ext: string): string {
  return EXT_TO_LANG[ext] || "plaintext";
}

function escapeHtml(src: string): string {
  return src.replace(/[&<>]/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    return "&gt;";
  });
}

/**
 * 高亮代码 → HTML（含 .hljs-* token）。
 * @param src - 源码。
 * @param ext - 文件扩展名，用于推断语言。
 * @returns 高亮后的 HTML；语言未注册/失败时返回转义后的纯文本。
 */
export function highlightCode(src: string, ext: string): string {
  const lang = EXT_TO_LANG[ext];
  try {
    if (lang !== undefined && hljs.getLanguage(lang) !== undefined) {
      return hljs.highlight(src, { language: lang, ignoreIllegals: true }).value;
    }
  } catch {
    /* 高亮失败降级 */
  }
  return `<span class="hljs-plain">${escapeHtml(src)}</span>`;
}
