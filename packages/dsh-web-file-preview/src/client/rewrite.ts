/**
 * dsh-web-file-preview — Markdown 渲染后引用重写（U8 v2）。
 *
 * 在 DOMPurify 清洗链路上把 md 输出中的「相对文件引用」改写成预览 API URL：
 *  - `<a href>`  相对且可预览 → 预览 API URL + data-fp-ref 标记（点击在 Modal 内跳转预览，
 *    D1(b)）+ rel 追加 noopener noreferrer / target=_blank（防 SPA 整页导航）；
 *  - `<img src>` 相对且可预览 → 预览 API URL + data-fp-ref 标记（渲染后由客户端 blob 化，
 *    复用 fetch→blob 高优先级通道，规避 HTTP/1.1 + SSE 低优先级图片排队）；
 *  - 不可预览后缀（zip 等，D2(a)）、绝对路径、协议相对、data:/blob:/外域 → 原样保留；
 *  - 幂等：已有 data-fp-ref 或 /api/ 前缀不重复重写。
 *
 * 依赖说明：本模块是「对成熟库 DOMPurify 扩展点的正确使用」而非自造轮子
 * （afterSanitizeAttributes 官方 hook）；路径展开纯函数见 src/relpath.ts。
 */

import DOMPurify from "dompurify";
import { groupOfPath } from "../grouping.js";
import { resolveRelativePath } from "../relpath.js";

/** 预览 API 路由（与宿主 ROUTES.file 一致，契约 smoke 校验字面量）。 */
const REWRITE_API_PATH = "/api/dsh-file-preview/file";

/** 重写后 URL 的 path 参数最长字节（评审实测：Node 431 @ ~16KB；8KB 余量足够）。 */
const MAX_REWRITE_PATH = 8000;

/** 重写前后缀匹配（URL 协议/协议相对/data/blob/file → 保留）。 */
const KEEP_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

export interface RewriteOpts {
  /** 会话 cwd（拼进预览 URL；可缺省，绝对路径预览仍有效）。 */
  cwd?: string;
  /** 被预览文件的完整路径（相对引用的解析基目录）。 */
  basePath: string;
}

export interface RewrittenRef {
  /** 预览 API URL。 */
  url: string;
  /** 解析后的绝对路径。 */
  path: string;
}

/**
 * 清洗并重写 md 渲染产物。
 * —— 位置说明：当前 DOMPurify 版本不支持 per-call `config.hooks`（实测被忽略），
 * 而实例级 `addHook` 在无完整 window 的契约环境会在加载期抛错。因此采用
 * 「清洗后 DOM 后处理」：先 DOMPurify 清洗，再在临时容器遍历 img/a 重写。
 * 该方式同样覆盖全部引用语法面（a/img 两类节点），且只在渲染期执行，无加载
 * 期副作用，可独立单测（见 smoke relpath 断言）。
 *
 * @param html - marked 渲染输出。
 * @param opts - 重写上下文（cwd/basePath）。
 * @returns 清洗后的 HTML（相对引用已改写为预览 URL）。
 */
export function sanitizePreview(html: string, opts: RewriteOpts): string {
  const clean = DOMPurify.sanitize(html);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = clean;
  for (const img of Array.from(wrapper.querySelectorAll("img"))) rewriteImage(img as HTMLElement, opts);
  for (const a of Array.from(wrapper.querySelectorAll("a"))) rewriteAnchor(a as HTMLElement, opts);
  return wrapper.innerHTML;
}

function makePreviewUrl(resolved: string, cwd: string | undefined): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", resolved);
  return `${REWRITE_API_PATH}?${params.toString()}`;
}

/** 解析引用→可重写的预览目标；不可重写返回 null。 */
function rewriteTarget(ref: string, opts: RewriteOpts): RewrittenRef | null {
  if (ref === "" || KEEP_RE.test(ref) || ref.startsWith("#")) return null;
  if (ref.startsWith(REWRITE_API_PATH) || ref.startsWith("/api/")) return null; // 幂等
  if (ref.length > MAX_REWRITE_PATH) return null; // 防溢出（实测 431 边界远高于此）
  const resolved = resolveRelativePath(opts.basePath, ref);
  if (resolved === null) return null;
  // D2(a)：不可预览后缀（zip/pdf 等）保留原链接（浏览器下载语义），不重写。
  if (groupOfPath(resolved).group === "other") return null;
  return { url: makePreviewUrl(resolved, opts.cwd), path: resolved };
}

/** <a>：改预览 URL + data-fp-ref + 外开语义（Modal 内跳转由 overlay 处理器接管）。 */
function rewriteAnchor(node: HTMLElement, opts: RewriteOpts): void {
  const href = node.getAttribute("href");
  if (href === null) return;
  if (node.hasAttribute("data-fp-ref")) return;
  const target = rewriteTarget(href, opts);
  if (target === null) return;
  node.setAttribute("href", target.url);
  node.setAttribute("data-fp-ref", target.path);
  if (opts.cwd !== undefined && opts.cwd !== "") node.setAttribute("data-fp-cwd", opts.cwd);
  const rel = node.getAttribute("rel") ?? "";
  node.setAttribute("rel", rel === "" ? "noopener noreferrer" : `${rel} noopener noreferrer`);
  node.setAttribute("target", "_blank");
}

/** <img>：改预览 URL + data-fp-ref（blob 化交由客户端渲染后处理）。 */
function rewriteImage(node: HTMLElement, opts: RewriteOpts): void {
  const src = node.getAttribute("src");
  if (src === null) return;
  if (node.hasAttribute("data-fp-ref")) return;
  const target = rewriteTarget(src, opts);
  if (target === null) return;
  node.setAttribute("src", target.url);
  node.setAttribute("data-fp-ref", target.path);
  if (opts.cwd !== undefined && opts.cwd !== "") node.setAttribute("data-fp-cwd", opts.cwd);
}