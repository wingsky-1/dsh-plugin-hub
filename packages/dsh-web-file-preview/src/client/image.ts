/**
 * dsh-web-file-preview — 客户端图片渲染。
 *
 * 图片 fetch → Blob → objectURL 渲染；点击缩略图打开全屏查看器（原灯箱）。
 * issue #293：灯箱逻辑（openViewer / closeLightbox / 变换状态）已泛化迁移到
 * viewer.ts + viewer-math.ts——本模块只保留图片获取与渲染，openLightbox 转调
 * 通用 openViewer（行为逐字节不变，B1 零回归）。
 */

import { el, errorView } from "./dom.ts";
import { t } from "../../../../shared/client/i18n.js";
import type { FilePreviewState } from "./state.ts";
import { resolvedFromFileResponse, applyResolvedPath } from "./resolved-path.ts";
import { openViewer } from "./viewer.ts";

/**
 * 全屏灯箱（图片路径）：创建 <img> 后转调通用查看器（aria-label 恒为「图片预览」）。
 * trigger 为触发元素（预览正文中的缩略图），关闭后焦点还原（issue #293 C7）。
 */
export function openLightbox(src: string, state: FilePreviewState, trigger?: HTMLElement): void {
  const img = el("img", { alt: "preview" });
  img.src = src;
  openViewer(img, state, { ariaLabel: t("imageAria"), restoreFocusTo: trigger });
}

/** 把已获取的图片 blob 渲染进正文（建 objectURL + 灯箱点击）。 */
export function renderBlobImage(blob: Blob, body: HTMLElement, url: string, state: FilePreviewState): void {
  const objectUrl = URL.createObjectURL(blob);
  state.trackedObjectUrl = objectUrl;
  body.textContent = "";
  const img = el("img", { class: "fwp-preview-img" });
  img.alt = "preview";
  img.title = t("imageZoomHint");
  img.addEventListener("error", () => errorView(body, t("imageDecodeFail"), url));
  img.addEventListener("click", () => openLightbox(objectUrl, state, img));
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
      // issue #486：resolved 落地（先设 currentPath 再渲染，评审 P0-2）。图片组
      // 扩展名不会被搜索纠正到其它组（入口即 image 才走本分支），分组变化恒 false。
      const resolved = resolvedFromFileResponse(res, state.currentPath);
      applyResolvedPath(state, resolved);
      state.onResolved?.();
      const blob = await res.blob();
      if (seq !== state.openSeq) return;
      renderBlobImage(blob, body, url, state);
    })
    .catch(() => { if (seq === state.openSeq) errorView(body, t("fetchFail"), url); });
}