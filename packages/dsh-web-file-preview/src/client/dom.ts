/**
 * dsh-web-file-preview — 客户端 DOM 工具函数。
 *
 * DOM 元素创建、样式注入、剪贴板操作、错误视图等纯 DOM 操作。
 * 仅 export 纯函数；i18n 文案经共享 i18n.ts 的 t（活绑定）。
 */
import { t } from "../../../../shared/client/i18n.js";
// 样式注入实现收敛 shared/client/ensure-style.js（issue #477）：本模块只保留
// STYLE cssText 装配点（style.css 仍被本文件 import，esbuild 不摇树）。
import { ensureStyle as ensureStyleShared } from "../../../../shared/client/ensure-style.js";

/** 创建带属性/子节点的 DOM 元素。 */
export function el(tag: string, attrs: any = {}, children?: any[]): any {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value as string;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value as any);
    else if (key === "attrs") {
      // issue #564：attrs 嵌套键 = 逐键显式属性装配（setAttribute）。此前该键
      // 落入 else 分支被赋成 node["attrs"] 无效属性而**静默丢失**——tab 的
      // data-mode（syncTabActive 高亮依据，tab 高亮从未工作）、backBtn/fsBtn 的
      // aria-label、.fwp-title 的 title、toast 的 role=status 全部未落 DOM。
      // 一律 setAttribute（与 data-* 分支同语义），role/aria-*/title 等走标准属性。
      for (const [attr, attrValue] of Object.entries(value as Record<string, string>)) {
        node.setAttribute(attr, String(attrValue));
      }
    }
    else if (key.startsWith("data-")) node.setAttribute(key, String(value));
    else (node as any)[key] = value;
  }
  for (const child of children ?? []) {
    if (child !== null && child !== undefined) node.appendChild(child);
  }
  return node;
}

/**
 * 注入样式 <style>（仅首次；issue #477 收敛 shared/client/ensure-style.js 后的
 * 无参薄 facade：本包 id/cssText 在此单点装配，index.ts / preview.ts 两调用点
 * 与 import 面零改动。行为契约见 ensure-style.js 头注释：head 缺失静默 no-op、
 * 同 id 幂等、disposer 卸载）。
 */
export function ensureStyle(): void {
  ensureStyleShared({ id: "dsh-web-file-preview-style", cssText: STYLE });
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

/**
 * 轻量 toast 提示（issue #479 P2 复用）：role=status 底部居中、自动消失、可点关闭。
 * 样式走 .fwp-folder-notice（触控目标 ≥44px 由样式表 coarse 媒体查询保证）。
 * 文案由调用方给出（外部输入按文本注入，无 HTML 面）。
 */
export function showToast(text: string): void {
  const existing = document.querySelector(".fwp-folder-notice");
  if (existing !== null && existing.parentElement !== null) {
    existing.parentElement.removeChild(existing);
  }
  const notice = el("div", {
    class: "fwp-folder-notice",
    text,
    attrs: { role: "status", "data-dsh-web-file-preview-notice": "" },
  });
  notice.addEventListener("click", () => { notice.remove(); });
  document.body.appendChild(notice);
  window.setTimeout(() => { if (notice.parentElement !== null) notice.remove(); }, 4000);
}

// 样式：构建期 text-loader 内联（见 src/client/style.css）
import STYLE from "./style.css";