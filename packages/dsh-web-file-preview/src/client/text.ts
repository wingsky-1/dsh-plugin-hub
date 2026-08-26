/**
 * dsh-web-file-preview — 客户端文本/代码/Markdown 渲染与 diff。
 *
 * 文本内容 fetch、按模式渲染正文、md 内嵌图 blob 化、git diff 探测与渲染。
 * fileDiffUrl 仅被 probeDiff 使用，故归本模块（避免跨模块循环依赖）。
 */

import { renderMarkdown } from "./md.js";
import { highlightCode } from "./code.js";
import { sanitizePreview } from "./rewrite.js";
import { hydrateMermaid } from "./mermaid.js";
import { applyHeadingIds, scrollToFragment } from "./anchor.js";
import { el, errorView } from "./dom.js";
import type { FilePreviewState } from "./state.js";
import { html as diffToHtml } from "diff2html";
import DOMPurify from "dompurify";

/** git diff 探测 URL（F2-B）。 */
export function fileDiffUrl(path: string, cwd: string | undefined, state: FilePreviewState): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", path);
  return `${state.API.diff}?${params.toString()}`;
}

/**
 * 文本/代码/Markdown：fetch 全文后按当前「预览 / 原始」模式渲染。
 * 原文存入 rawText，切换模式不重新请求。
 */
export function fetchText(url: string, body: HTMLElement, seq: number, signal: AbortSignal, state: FilePreviewState): void {
  void fetch(url, { signal })
    .then(async (res) => {
      if (seq !== state.openSeq) return;
      if (!res.ok) {
        let msg = `加载失败（HTTP ${res.status}）`;
        try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
        errorView(body, msg, url);
        return;
      }
      state.rawText = await res.text();
      if (seq !== state.openSeq) return;
      renderTabBody(body, state);
    })
    .catch(() => { if (seq === state.openSeq) errorView(body, "请求失败（无法访问文件预览服务）", url); });
}

/** 按当前模式渲染文本类正文（预览=md渲染/代码高亮；原始=等宽 pre；Diff=git diff）。 */
export function renderTabBody(body: HTMLElement, state: FilePreviewState): void {
  const group = state.currentGroup;
  if (group === undefined) return;
  body.textContent = "";
  if (state.previewMode === "diff") {
    renderDiff(body, state);
    return;
  }
  const text = state.rawText;
  if (text === undefined) {
    body.appendChild(el("div", { class: "fwp-state", text: "加载中…" }));
    return;
  }
  if (state.previewMode === "raw" || group.group === "text") {
    body.appendChild(el("pre", { text }));
    return;
  }
  try {
    if (group.group === "md") {
      // U8 v2：md 渲染经 sanitizePreview 重写相对引用（图片/链接），
      // 内嵌图随后 blob 化（upgradePreviewImages），规避直连低优先级排队。
      const rendered = el("div", {
        class: "fwp-rendered fwp-rendered-md",
        html: sanitizePreview(renderMarkdown(text), { cwd: state.currentCwd, basePath: state.currentPath }),
      });
      // issue #45：marked v18 不产 heading id——按 GFM slug 规则补齐，纯锚点
      // （data-fp-anchor / data-fp-frag）才有 Modal 内滚动落点。
      applyHeadingIds(rendered);
      body.appendChild(rendered);
      upgradePreviewImages(rendered, state);
      // issue #104：mermaid 代码块懒加载渲染（链尾后处理；无 mermaid 块零开销）。
      // 放 sanitizePreview 之后——mermaid 生成的 SVG 是清洗后单独插入的，
      // 不经过前置 DOMPurify（否则 <svg> 会被默认配置剥掉）；自身再过 svg profile
      // 二次消毒（见 mermaid.ts）。竞态由 openSeq + isConnected 校验兜住。
      hydrateMermaid(rendered, state);
      // issue #45：带 fragment 的文件引用（./f.md#g）在首次 md 渲染后定位小节；
      // 消费即清（切 tab / 返回不重复滚动；目标不存在则忽略）。
      const frag = state.pendingFrag;
      if (frag !== undefined && frag !== "") {
        state.pendingFrag = undefined;
        window.requestAnimationFrame(() => scrollToFragment(body, frag));
      }
    } else {
      const highlighted = `<pre><code class="hljs">${highlightCode(text, group.ext)}</code></pre>`;
      body.appendChild(el("div", { class: "fwp-rendered fwp-rendered-code", html: DOMPurify.sanitize(highlighted) }));
    }
  } catch {
    // 渲染失败降级原始，不静默空 HTML。
    body.appendChild(el("pre", { text }));
  }
}

/** U8 v2：把重写后的 md 内嵌图转为 blob 通道——与主图同一条 fetch→blob 高优先级链路
 *（规避 HTTP/1.1 + SSE 占满连接池时低优先级 <img> 直连排队）；受 D4 并发上限约束，
 *objectURL 记入 trackedBlobUrls，closeModal 统一 revoke。失败保留原 src（可新标签/长按）。
 */
export function upgradePreviewImages(container: HTMLElement, state: FilePreviewState): void {
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>("img[data-fp-ref]"));
  if (imgs.length === 0) return;
  const signal = state.activeAbort !== undefined ? state.activeAbort.signal : undefined;
  for (const img of imgs) {
    const src = img.getAttribute("src") ?? "";
    img.removeAttribute("data-fp-ref"); // 防重复入队
    state.imgQueue.push({ img, src });
  }
  pumpPreviewImages(state, signal);
}

/** 泵出排队的内嵌图：受 MAX_IMG_CONCURRENCY 并发上限约束。 */
export function pumpPreviewImages(state: FilePreviewState, signal: AbortSignal | undefined): void {
  while (state.imgInFlight < state.MAX_IMG_CONCURRENCY && state.imgQueue.length > 0) {
    const job = state.imgQueue.shift();
    if (job === undefined) break;
    state.imgInFlight++;
    void fetch(job.src, signal !== undefined ? { signal } : undefined)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        state.trackedBlobUrls.push(objectUrl);
        if (job.img.isConnected) job.img.src = objectUrl;
      })
      .catch(() => { /* 内嵌图失败：保留 API 原 src，可新标签/长按查看 */ })
      .finally(() => { state.imgInFlight--; pumpPreviewImages(state, signal); });
  }
}

/** 探测该文件是否有 git diff；有则把 Diff tab 加到 tab 栏（否则不展示）。 */
export function probeDiff(path: string, cwd: string | undefined, seq: number, onAvailable: () => void, onUnavailable: () => void, signal: AbortSignal, state: FilePreviewState): void {
  const diffUrl = fileDiffUrl(path, cwd, state);
  void fetch(diffUrl, { signal })
    .then(async (res) => {
      if (seq !== state.openSeq) return;
      if (!res.ok) {
        // 评审 U9：HTTP 失败（服务异常/围栏拒绝）→ 显式「不可用」而非静默
        onUnavailable();
        return;
      }
      const data = await res.json().catch(() => null);
      if (seq !== state.openSeq) return;
      if (data && data.ok && data.hasDiff) {
        state.diffText = typeof data.diff === "string" ? data.diff : undefined;
        state.diffUntracked = !!data.untracked;
        onAvailable();
      }
    })
    .catch(() => { if (seq === state.openSeq) onUnavailable(); });
}

/** 渲染 git diff（diff2html：行号/折叠/配色。兜底用 pre 原样展示）。 */
export function renderDiff(body: HTMLElement, state: FilePreviewState): void {
  if (state.diffUntracked) {
    body.appendChild(el("div", { class: "fwp-state", text: "未跟踪的新文件（git 无基线，无法对比；完整内容见“内容/原始”）" }));
    return;
  }
  const d = state.diffText ?? "";
  if (d === "") {
    body.appendChild(el("div", { class: "fwp-state", text: "无可用 diff" }));
    return;
  }
  try {
    const out = diffToHtml(d, {
      drawFileList: false,
      matching: "lines",
      outputFormat: "line-by-line",
    });
    body.appendChild(el("div", { class: "fwp-rendered fwp-diff2html", html: DOMPurify.sanitize(out) }));
  } catch {
    // 兜底：原样展示，避免白屏。
    body.appendChild(el("pre", { class: "fwp-diff", text: d }));
  }
}