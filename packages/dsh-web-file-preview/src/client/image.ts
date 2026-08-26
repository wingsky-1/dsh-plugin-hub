/**
 * dsh-web-file-preview — 客户端图片渲染与灯箱。
 *
 * 图片 fetch → Blob → objectURL 渲染、全屏灯箱（缩放/平移/双指捏合）。
 * 灯箱状态（lboxEl/lboxImg/lboxScale/lboxTx/lboxTy）归入 state，不设模块级全局。
 */

import { el, errorView } from "./dom.ts";
import type { FilePreviewState } from "./state.ts";

function clampy(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 两点欧氏距离（双指捏合用，评审 U6）。 */
function distance2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function applyLboxTransform(state: FilePreviewState): void {
  if (state.lboxImg) state.lboxImg.style.transform = `translate(${state.lboxTx}px, ${state.lboxTy}px) scale(${state.lboxScale})`;
}

/** 关闭灯箱。 */
export function closeLightbox(state: FilePreviewState): void {
  if (state.lboxEl !== undefined && state.lboxEl.parentElement !== null) state.lboxEl.remove();
  state.lboxEl = undefined;
  state.lboxImg = undefined;
  state.lboxScale = 1; state.lboxTx = 0; state.lboxTy = 0;
}

/** 全屏灯箱：黑色遮罩 + 缩放/重置/关闭工具栏 + 滚轮缩放 + 指针拖拽平移。 */
export function openLightbox(src: string, state: FilePreviewState): void {
  closeLightbox(state);
  state.lboxScale = 1; state.lboxTx = 0; state.lboxTy = 0;

  const img = el("img", { class: "fwp-lbox-img" });
  img.src = src;
  img.alt = "preview";
  state.lboxImg = img;

  const stage = el("div", { class: "fwp-lbox-stage" });
  stage.appendChild(img);

  const zoomIn = el("button", { text: "＋" });
  zoomIn.setAttribute("aria-label", "放大");
  zoomIn.setAttribute("title", "放大");
  zoomIn.addEventListener("click", () => { state.lboxScale = clampy(state.lboxScale * 1.25, 0.2, 8); applyLboxTransform(state); });
  const zoomOut = el("button", { text: "－" });
  zoomOut.setAttribute("aria-label", "缩小");
  zoomOut.setAttribute("title", "缩小");
  zoomOut.addEventListener("click", () => { state.lboxScale = clampy(state.lboxScale / 1.25, 0.2, 8); applyLboxTransform(state); });
  const reset = el("button", { text: "重置" });
  reset.setAttribute("aria-label", "重置缩放");
  reset.addEventListener("click", () => { state.lboxScale = 1; state.lboxTx = 0; state.lboxTy = 0; applyLboxTransform(state); });
  const closeBtn = el("button", { text: "×" });
  closeBtn.setAttribute("aria-label", "关闭灯箱");
  closeBtn.addEventListener("click", () => closeLightbox(state));
  const toolbar = el("div", { class: "fwp-lbox-toolbar" }, [zoomIn, zoomOut, reset, closeBtn]);

  // 与预览 Modal 相同的兜底：确保图片灯箱也始终浮层全屏（不依赖样式表首部规则是否被解析）。
  const lbox = el("div", { class: "fwp-lbox" });
  lbox.setAttribute(
    "style",
    "position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10000;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif",
  );
  lbox.setAttribute("role", "dialog");
  lbox.setAttribute("aria-modal", "true");
  lbox.setAttribute("aria-label", "图片预览");
  lbox.appendChild(toolbar);
  lbox.appendChild(stage);
  state.lboxEl = lbox;
  // 焦点移入灯箱（a11y）：默认落在关闭按钮，Esc/按钮均可退出。
  closeBtn.focus();

  // 点空白/遮罩关闭
  lbox.addEventListener("click", (event: any) => {
    if (event.target === lbox || event.target === stage) closeLightbox(state);
  });
  // 滚轮以中心缩放
  lbox.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    state.lboxScale = clampy(state.lboxScale * (event.deltaY < 0 ? 1.12 : 0.9), 0.2, 8);
    applyLboxTransform(state);
  }, { passive: false });
  // 指针交互（评审 U6）：单指/鼠标拖拽平移 + 双指捏合缩放并存；配合
  // touch-action:none 与 setPointerCapture。滚轮缩放保留在下文。
  const pointers = new Map<number, { x: number; y: number }>();
  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };
  let pinchStart = { dist: 1, scale: 1 };
  img.addEventListener("pointerdown", (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { img.setPointerCapture(e.pointerId); } catch { /* 兼容 */ }
    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, tx: state.lboxTx, ty: state.lboxTy };
      lbox.classList.add("dragging");
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      pinchStart = { dist: distance2(pts[0], pts[1]) || 1, scale: state.lboxScale };
    }
  });
  img.addEventListener("pointermove", (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      state.lboxScale = clampy(pinchStart.scale * (distance2(pts[0], pts[1]) / pinchStart.dist), 0.2, 8);
      applyLboxTransform(state);
    } else if (pointers.size === 1) {
      state.lboxTx = dragStart.tx + (e.clientX - dragStart.x);
      state.lboxTy = dragStart.ty + (e.clientY - dragStart.y);
      applyLboxTransform(state);
    }
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) lbox.classList.remove("dragging");
  };
  img.addEventListener("pointerup", endPointer);
  img.addEventListener("pointercancel", endPointer);

  document.body.appendChild(lbox);
}

/** 把已获取的图片 blob 渲染进正文（建 objectURL + 灯箱点击）。 */
export function renderBlobImage(blob: Blob, body: HTMLElement, url: string, state: FilePreviewState): void {
  const objectUrl = URL.createObjectURL(blob);
  state.trackedObjectUrl = objectUrl;
  body.textContent = "";
  const img = el("img", { class: "fwp-preview-img" });
  img.alt = "preview";
  img.title = "点击放大";
  img.addEventListener("error", () => errorView(body, "图片解码失败（文件已获取，但无法作为图片显示）", url));
  img.addEventListener("click", () => openLightbox(objectUrl, state));
  img.src = objectUrl;
  body.appendChild(img);
}

/** 图片预览：fetch → Blob → objectURL 渲染。 */
export function renderImage(url: string, body: HTMLElement, seq: number, signal: AbortSignal, state: FilePreviewState): void {
  void fetch(url, { signal })
    .then(async (res) => {
      if (seq !== state.openSeq) return;
      if (!res.ok) {
        let msg = `加载失败（HTTP ${res.status}）`;
        try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
        errorView(body, msg, url);
        return;
      }
      const blob = await res.blob();
      if (seq !== state.openSeq) return;
      renderBlobImage(blob, body, url, state);
    })
    .catch(() => { if (seq === state.openSeq) errorView(body, "请求失败（无法访问文件预览服务）", url); });
}