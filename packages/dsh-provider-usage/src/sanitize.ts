/**
 * dsh-provider-usage — HTML 结构化净化（XSS 兜底）。
 *
 * 信任模型：用户自己的 format 函数返回的 HTML 是信任域，但流入其中的
 * 外部 API 数据不可信。本模块在宿主端渲染前做白名单式净化，作为结构性兜底
 * （用户 format 函数还应使用 esc() 助手进行自家数据的转义）。
 */

const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/giu;
const EVENT_HANDLER_RE = /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;
const IFRAME_RE = /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/giu;
const FRAME_RE = /<frame\b[^>]*>[\s\S]*?<\/frame\s*>/giu;
const OBJECT_RE = /<object\b[^>]*>[\s\S]*?<\/object\s*>/giu;
const EMBED_RE = /<embed\b[^>]*>[\s\S]*?<\/embed\s*>/giu;
const META_RE = /<meta\b[^>]*>/giu;
const LINK_RE = /<link\b[^>]*>/giu;
const BASE_RE = /<base\b[^>]*>/giu;
const STYLE_ON_SCRIPT_RE = /expression\s*\(/giu;
const JAVASCRIPT_URI_RE = /\bjavascript\s*:/giu;
const DATA_TEXT_HTML_RE = /\bdata\s*:\s*text\/html/giu;

/**
 * 白名单净化：移除脚本/事件处理器/危险元素，防御性净化用户 format HTML。
 *
 * 保持简单可靠（正则级）：我们的目标是移除 XSS 载体，而非完美 HTML 解析。
 * 后续如需更严格可换 DOMPurify（构建期 jsdom 不适用，保留正则方案）。
 */
export function sanitizeHtml(html: string): string {
  if (html === '') return '';
  // 1. 移除 script/frame/object/embed/meta/link/base 标签
  let out = html
    .replace(SCRIPT_TAG_RE, '')
    .replace(IFRAME_RE, '')
    .replace(FRAME_RE, '')
    .replace(OBJECT_RE, '')
    .replace(EMBED_RE, '')
    .replace(META_RE, '')
    .replace(LINK_RE, '')
    .replace(BASE_RE, '');
  // 2. 移除 on* 事件属性
  out = out.replace(EVENT_HANDLER_RE, '');
  // 3. 移除危险 URI 协议
  out = out
    .replace(JAVASCRIPT_URI_RE, '')
    .replace(DATA_TEXT_HTML_RE, '')
    .replace(STYLE_ON_SCRIPT_RE, '');
  return out;
}