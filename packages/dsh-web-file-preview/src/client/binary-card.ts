/**
 * dsh-web-file-preview — 二进制占位卡组件（issue #630 改动 B3）。
 *
 * 业界兜底形态（GitHub "View raw" / GitLab Download viewer 同款）：二进制文件
 * 不渲染内容，给出「是什么（文件名）+ 多大（人类可读大小）+ 怎么拿到（下载）」
 * 三件套，替代原 415 错误文案 + 指向 415 JSON 页的死胡同「新标签打开」按钮。
 * 复制路径/关闭由 Modal 顶栏既有按钮承担，卡内不重复。
 *
 * 安全：动态值（文件名/大小/后缀）一律走 el 的 text（textContent），零 HTML 面；
 * 样式复用 --dsw-alias-* token（明暗自适应）与既有触控目标约定。
 */

import { el, copyPathText } from "./dom.ts";
import { t } from "../../../../shared/client/i18n.js";
import type { FilePreviewState } from "./state.ts";
import { formatBytes, downloadUrlOf } from "../binary-info.ts";

export interface BinaryCardPayload {
  size?: number;
  ext?: string;
}

/**
 * 渲染二进制占位卡（fetchText 在 415 + binary:true 时调用）。
 * @param url - 当前 /file 请求地址（下载按钮在其上追加 dl=1）。
 */
export function renderBinaryCard(body: HTMLElement, state: FilePreviewState, payload: BinaryCardPayload, url: string): void {
  body.textContent = "";
  const name = state.currentPath.split(/[\\/]/).pop() ?? state.currentPath;
  const sizeText = typeof payload.size === "number" ? formatBytes(payload.size) : "";
  const card = el("div", { class: "fwp-state fwp-binary-card" });
  card.appendChild(el("div", { class: "fwp-binary-note", text: t("binaryNoPreview") }));
  // 文件名/大小一律 textContent（el text 分支），外部输入无注入面。
  const meta = el("div", { class: "fwp-binary-meta" });
  meta.appendChild(el("div", { class: "fwp-binary-name", text: name }));
  if (sizeText !== "") meta.appendChild(el("div", { class: "fwp-binary-size", text: sizeText }));
  card.appendChild(meta);
  const actions = el("div", { class: "fwp-actions fwp-binary-actions" });
  const dl = el("button", { text: t("binaryDownload") });
  dl.addEventListener("click", () => { window.open(downloadUrlOf(url), "_blank", "noopener"); });
  actions.appendChild(dl);
  const copy = el("button", { text: t("copyPath") });
  copy.addEventListener("click", () => copyPathText(state.currentPath, copy));
  actions.appendChild(copy);
  card.appendChild(actions);
  body.appendChild(card);
}
