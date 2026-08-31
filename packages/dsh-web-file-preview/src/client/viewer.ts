/**
 * dsh-web-file-preview — 通用全屏查看器（issue #293：openLightbox 泛化而来）。
 *
 * openViewer 接收任意 HTMLElement（<img> 或 mermaid 克隆 <svg>），提供与图片灯箱
 * 逐字节对齐的交互：黑色遮罩 + 工具栏（＋/－/重置/关闭）+ 滚轮缩放 + 指针/单指拖拽
 * 平移 + 双指捏合 + Esc/遮罩/关闭三通道退出 + clamp [0.2, 8] 防拖丢。纯逻辑
 * （clampScale / viewerTransform）在 viewer-math.ts，本模块只做 DOM 胶水。
 *
 * 安全（issue #293 D1）：stage 捕获阶段拦 <a> 点击——mermaid setLink 在 strict 下
 * 产出 <a xlink:href>（DOMPurify svg profile 放行 xlink:href、剥除 target），直接
 * 点击会同 tab 整页导航离开 DSH web；此处捕获阶段 preventDefault + 停传播，外链改
 * window.open("_blank","noopener")（不改导航）。命中判定走 isExternalClickableAnchor
 * 纯谓词（A4）。
 */

import { el } from "./dom.ts";
import { t } from "./i18n.ts";
import type { FilePreviewState } from "./state.ts";
import { clampScale, viewerTransform, isExternalClickableAnchor } from "./viewer-math.ts";

/** 两点欧氏距离（双指捏合用，评审 U6）。 */
function distance2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 查看器选项。 */
export interface ViewerOptions {
  /** 对话框 aria-label（图片路径恒为「图片预览」，mermaid 路径为「图表预览」）。 */
  ariaLabel: string;
  /** 关闭后焦点还原目标（触发元素，若仍在 DOM；issue #293 C7 a11y）。 */
  restoreFocusTo?: HTMLElement | undefined;
}

function applyLboxTransform(state: FilePreviewState): void {
  if (state.lboxContent) state.lboxContent.style.transform = viewerTransform(state.lboxTx, state.lboxTy, state.lboxScale);
}

/** 关闭查看器（Esc / 遮罩 / 关闭按钮三通道共用）。 */
export function closeLightbox(state: FilePreviewState): void {
  if (state.lboxEl !== undefined && state.lboxEl.parentElement !== null) state.lboxEl.remove();
  state.lboxEl = undefined;
  state.lboxContent = undefined;
  state.lboxScale = 1; state.lboxTx = 0; state.lboxTy = 0;
  // a11y（issue #293 C7）：关闭后焦点还原到触发元素（若仍在 DOM）——图片与 mermaid
  // 路径共用（泛化增强，不破坏图片路径既有的「打开即聚焦 / Esc 退出」）。
  if (state.lboxRestoreFocus !== undefined) {
    try {
      if (document.contains(state.lboxRestoreFocus)) state.lboxRestoreFocus.focus();
    } catch { /* 忽略 */ }
    state.lboxRestoreFocus = undefined;
  }
}

/**
 * 通用全屏查看器：接受任意内容元素（<img> / 克隆 <svg>，SVG 不在 HTML 命名空间，
 * 用 HTMLElement|SVGElement 联合类型），交互语义与图片灯箱逐字节一致（B1 零回归的
 * 可测接缝在 viewer-math.ts 的 viewerTransform）。
 */
export function openViewer(content: HTMLElement | SVGElement, state: FilePreviewState, opts: ViewerOptions): void {
  closeLightbox(state);
  state.lboxScale = 1; state.lboxTx = 0; state.lboxTy = 0;
  state.lboxRestoreFocus = opts.restoreFocusTo;

  // 泛化样式契约（E1）：img 与克隆 svg 共用同一 content 类
  // （touch-action:none / user-select:none / cursor:grab 等，见 style.css）。
  content.classList.add("fwp-lbox-content");
  state.lboxContent = content;

  const stage = el("div", { class: "fwp-lbox-stage" });
  stage.appendChild(content);

  const zoomIn = el("button", { text: "＋" });
  zoomIn.setAttribute("aria-label", t("zoomIn"));
  zoomIn.setAttribute("title", t("zoomIn"));
  zoomIn.addEventListener("click", () => { state.lboxScale = clampScale(state.lboxScale * 1.25); applyLboxTransform(state); });
  const zoomOut = el("button", { text: "－" });
  zoomOut.setAttribute("aria-label", t("zoomOut"));
  zoomOut.setAttribute("title", t("zoomOut"));
  zoomOut.addEventListener("click", () => { state.lboxScale = clampScale(state.lboxScale / 1.25); applyLboxTransform(state); });
  const reset = el("button", { text: t("reset") });
  reset.setAttribute("aria-label", t("resetZoom"));
  reset.addEventListener("click", () => { state.lboxScale = 1; state.lboxTx = 0; state.lboxTy = 0; applyLboxTransform(state); });
  const closeBtn = el("button", { text: "×" });
  closeBtn.setAttribute("aria-label", t("closeLightbox"));
  closeBtn.addEventListener("click", () => closeLightbox(state));
  const toolbar = el("div", { class: "fwp-lbox-toolbar" }, [zoomIn, zoomOut, reset, closeBtn]);

  // 与预览 Modal 相同的兜底：确保查看器始终浮层全屏（不依赖样式表首部规则是否被解析）。
  const lbox = el("div", { class: "fwp-lbox" });
  lbox.setAttribute(
    "style",
    "position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10000;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif",
  );
  lbox.setAttribute("role", "dialog");
  lbox.setAttribute("aria-modal", "true");
  lbox.setAttribute("aria-label", opts.ariaLabel);
  lbox.appendChild(toolbar);
  lbox.appendChild(stage);
  state.lboxEl = lbox;
  // 焦点移入查看器（a11y）：默认落在关闭按钮，Esc/按钮均可退出。
  closeBtn.focus();

  // 点空白/遮罩关闭
  lbox.addEventListener("click", (event: any) => {
    if (event.target === lbox || event.target === stage) closeLightbox(state);
  });
  // 滚轮以中心缩放
  lbox.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    state.lboxScale = clampScale(state.lboxScale * (event.deltaY < 0 ? 1.12 : 0.9));
    applyLboxTransform(state);
  }, { passive: false });
  // 指针交互（评审 U6）：单指/鼠标拖拽平移 + 双指捏合缩放并存；配合
  // touch-action:none 与 setPointerCapture。滚轮缩放保留在上文。
  const pointers = new Map<number, { x: number; y: number }>();
  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };
  let pinchStart = { dist: 1, scale: 1 };
  // content 为 HTMLElement|SVGElement 联合类型：addEventListener 泛型重载在联合
  // 类型下无法解析公共事件映射，回调显式断言为 EventListener（运行时无差异）。
  content.addEventListener("pointerdown", ((e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { content.setPointerCapture(e.pointerId); } catch { /* 兼容 */ }
    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, tx: state.lboxTx, ty: state.lboxTy };
      lbox.classList.add("dragging");
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      pinchStart = { dist: distance2(pts[0], pts[1]) || 1, scale: state.lboxScale };
    }
  }) as EventListener);
  content.addEventListener("pointermove", ((e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      state.lboxScale = clampScale(pinchStart.scale * (distance2(pts[0], pts[1]) / pinchStart.dist));
      applyLboxTransform(state);
    } else if (pointers.size === 1) {
      state.lboxTx = dragStart.tx + (e.clientX - dragStart.x);
      state.lboxTy = dragStart.ty + (e.clientY - dragStart.y);
      applyLboxTransform(state);
    }
  }) as EventListener);
  const endPointer = ((e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) lbox.classList.remove("dragging");
  }) as EventListener;
  content.addEventListener("pointerup", endPointer);
  content.addEventListener("pointercancel", endPointer);

  // D1 [硬性] 查看器 stage 捕获阶段拦 <a> 外链点击（安全，非功能）：
  // 克隆 SVG 内 mermaid 链接节点命中即 preventDefault + 停传播（同 tab 导航被掐断），
  // 外链改 window.open(url, "_blank", "noopener") 新标签打开。捕获阶段保证在
  // 链接默认行为与冒泡委托（如 Modal 遮罩关闭）之前执行。
  stage.addEventListener("click", (event: Event) => {
    const t = event.target instanceof Element ? (event.target as Element) : null;
    if (t === null || !isExternalClickableAnchor(t)) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = t.closest("a");
    const href = anchor !== null ? (anchor.getAttribute("xlink:href") || anchor.getAttribute("href")) : null;
    if (href !== null && href !== "") window.open(href, "_blank", "noopener");
  }, true);

  // issue #344：全屏态下灯箱挂载到全屏元素（overlay）内——元素全屏时浏览器只渲染
  // fullscreenElement 子树，挂 body 会黑屏不可见；非全屏保持 body（零回归）。
  const fullscreenTarget = document.fullscreenElement;
  if (fullscreenTarget !== null && fullscreenTarget !== undefined) {
    fullscreenTarget.appendChild(lbox);
  } else {
    document.body.appendChild(lbox);
  }
}