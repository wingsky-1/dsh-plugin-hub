/**
 * dsh-web-file-preview — 客户端 DOM 工具函数。
 *
 * DOM 元素创建、样式注入、剪贴板操作、错误视图等纯 DOM 操作。
 * 仅 export 纯函数；i18n 文案经共享 i18n.ts 的 t（活绑定）。
 */
import { t } from "../../../../shared/client/i18n.js";

/** 创建带属性/子节点的 DOM 元素。 */
export function el(tag: string, attrs: any = {}, children?: any[]): any {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value as string;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value as any);
    else if (key.startsWith("data-")) node.setAttribute(key, String(value));
    else (node as any)[key] = value;
  }
  for (const child of children ?? []) {
    if (child !== null && child !== undefined) node.appendChild(child);
  }
  return node;
}

/** 注入样式 <style>（仅首次）。 */
export function ensureStyle(): void {
  if (document.querySelector("style[data-dsh-web-file-preview-style]") !== null) return;
  const style = document.createElement("style");
  style.setAttribute("data-dsh-web-file-preview-style", "");
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * 复制文本到剪贴板（评审 U2）：安全上下文优先 navigator.clipboard（带 then/catch
 * 反馈），明文 HTTP（非安全上下文）降级 textarea + execCommand，两端都给出
 * 「已复制 / 复制失败」按钮态反馈，不再静默失败。
 */
export function copyPathText(text: string, btn: HTMLElement): void {
  const flash = (label: string): void => {
    btn.textContent = label;
    window.setTimeout(() => { btn.textContent = t("copyPath"); }, 1200);
  };
  try {
    if (typeof navigator.clipboard?.writeText === "function" && window.isSecureContext === true) {
      navigator.clipboard.writeText(text).then(() => flash(t("copied")), () => flash(t("copyFail")));
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand("copy");
    ta.remove();
    flash(copied ? t("copied") : t("copyFail"));
  } catch {
    flash(t("copyFail"));
  }
}

/** 统一样式错误态：文案 + 可选「在新标签打开」兜底。 */
export function errorView(body: HTMLElement, msg: string, url: string | undefined): void {
  body.textContent = "";
  body.appendChild(el("div", { class: "fwp-state fwp-err", text: msg }));
  if (url !== undefined) {
    const open = el("button", { class: "fwp-err-open", text: t("openRawTab") });
    open.addEventListener("click", () => { window.open(url, "_blank", "noopener"); });
    body.appendChild(open);
  }
}

// 样式：构建期 text-loader 内联（见 src/client/style.css）
import STYLE from "./style.css";