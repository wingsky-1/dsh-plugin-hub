/**
 * dsh-web-file-preview — Markdown 渲染后引用重写（U8 v2 + issue #45）。
 *
 * 在 DOMPurify 清洗链路上把 md 输出中的引用改写为可安全点击的形态：
 *  - `<a href>` 相对且可预览 → 预览 API URL + data-fp-ref 标记（点击在 Modal 内
 *    跳转预览，D1(b)）+ rel 追加 noopener noreferrer / target=_blank（防 SPA 整页
 *    导航）；带 #fragment 时另写 data-fp-frag（Modal 打开后定位小节）；
 *  - `<a href>` 绝对路径且可预览（issue #45）→ 同上，Modal 内原地跳转；
 *  - `<a href="#section">` 纯锚点（issue #45）→ data-fp-anchor 标记，由 overlay
 *    处理器拦截后在 Modal 正文内平滑滚动定位（不改 location.hash、不新开标签）；
 *  - 其余不可重写的 <a>（外域 http(s)、不可预览后缀 zip 等，issue #45 加重因素）
 *    → 一律追加 target=_blank + noopener noreferrer 兜底：点击最多新标签打开，
 *    绝不在当前页整页导航离开 dsh web；
 *  - `<img src>` 相对/绝对且可预览 → 预览 API URL + data-fp-ref 标记（渲染后由
 *    客户端 blob 化，复用 fetch→blob 高优先级通道，规避 HTTP/1.1 + SSE 低优先级
 *    图片排队）；
 *  - 幂等：已有 data-fp-ref 或 /api/ 前缀不重复重写。
 *
 * 重写决策（能否重写、重写成什么）抽在无 DOM 的 src/client/rewrite-target.ts，
 * 可被 node smoke 直测；本模块是「对成熟库 DOMPurify 扩展点的正确使用」而非自造
 * 轮子——采用「清洗后 DOM 后处理」：先 DOMPurify 清洗，再在临时容器遍历 img/a
 * 重写（当前 DOMPurify 版本不支持 per-call hooks、实例级 addHook 在无完整 window
 * 的契约环境加载期抛错）。路径展开纯函数见 src/relpath.ts。
 */

import DOMPurify from "dompurify";
import { splitReferenceFragment } from "../relpath.ts";
import { rewriteTarget, type RewriteOpts } from "./rewrite-target.ts";

/**
 * 清洗并重写 md 渲染产物。
 * @param html - marked 渲染输出。
 * @param opts - 重写上下文（cwd/basePath）。
 * @returns 清洗后的 HTML（相对/绝对引用已改写为预览 URL，锚点已标记兜底）。
 */
export function sanitizePreview(html: string, opts: RewriteOpts): string {
  const clean = DOMPurify.sanitize(html);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = clean;
  for (const img of Array.from(wrapper.querySelectorAll("img"))) rewriteImage(img as HTMLElement, opts);
  for (const a of Array.from(wrapper.querySelectorAll("a"))) rewriteAnchor(a as HTMLElement, opts);
  return wrapper.innerHTML;
}

/** rel 追加 noopener noreferrer（保留既有值；noopener 阻断 window.opener 泄露）。 */
function appendRelNoopener(node: HTMLElement): void {
  const rel = node.getAttribute("rel") ?? "";
  node.setAttribute("rel", rel === "" ? "noopener noreferrer" : `${rel} noopener noreferrer`);
}

/** <a>：改预览 URL + data-fp-ref/-frag + 外开语义（Modal 内跳转由 overlay 处理器接管）。 */
function rewriteAnchor(node: HTMLElement, opts: RewriteOpts): void {
  const href = node.getAttribute("href");
  if (href === null) return;
  if (node.hasAttribute("data-fp-ref")) return;
  // 纯锚点（#section）：不改 href、不加 target——overlay 处理器按 data-fp-anchor
  // 拦截默认 hash 导航，在 Modal 正文内滚动定位（目标不存在则忽略，issue #45）。
  if (href.startsWith("#")) {
    const { fragment } = splitReferenceFragment(href);
    if (fragment !== null) node.setAttribute("data-fp-anchor", fragment);
    return;
  }
  const target = rewriteTarget(href, opts);
  if (target === null) {
    // issue #45 兜底：不可重写的链接（外域网页/不可预览文件等）绝不整页导航——
    // 新标签打开，当前 dsh web 页面保持不动。
    node.setAttribute("target", "_blank");
    appendRelNoopener(node);
    return;
  }
  node.setAttribute("href", target.url);
  node.setAttribute("data-fp-ref", target.path);
  if (target.fragment !== null) node.setAttribute("data-fp-frag", target.fragment);
  if (opts.cwd !== undefined && opts.cwd !== "") node.setAttribute("data-fp-cwd", opts.cwd);
  appendRelNoopener(node);
  node.setAttribute("target", "_blank");
}

/** <img>：改预览 API URL + data-fp-ref（blob 化交由客户端渲染后处理）。 */
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
