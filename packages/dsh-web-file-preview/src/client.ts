// dsh-web-file-preview — 浏览器端。
//
// 拦截对话中"可点击的文件链接"（deliverables 的产出文件 chip / 正文行内文件
// 引用，特征：元素带 title=完整路径，或 <a href=相对路径>），点击不再走桌面
// 原生打开，而是弹出一个 web 端预览 Modal：
//  - 图片 → 同源 <img> 直接加载；
//  - 文本 → fetch 后以等宽 <pre> 渲染（明暗主题自适应 CSS 变量）；
//  - 附「复制路径」「在新标签打开」动作，Esc / 点遮罩关闭。
//
// 实现要点：document 捕获阶段委托（先于 React 在 root 的委托），对命中的
// 文件链接 preventDefault + stopPropagation，从而既拦截原生打开、又不会误伤
// 其它普通点击。零依赖纯 DOM，数组型约定见文件尾。

// 客户端 bundle 注册契约：web shell 的 client-modules 要求脚本执行时通过
// window.__ModuleLoader__.load 注册自身 factory（id = 包名），factory 返回
// module.exports（导出 apply / inject）。

import { renderMarkdown } from "./md.js";
import { highlightCode } from "./code.js";
import { renderGroupFor, type GroupResult } from "./renderer.js";
import { groupOfPath } from "./grouping.js";
import { html as diffToHtml } from "diff2html";
import DOMPurify from "dompurify";

declare var module: { exports: Record<string, any> };
declare var __DSH_PLUGIN_ID__: string; // 构建注入：bundle-host 以 --define 注入完整 npm 包名（load id 契约 = 包名）
interface Window {
  __ModuleLoader__: { load(entry: { id: string; factory: (require: any) => unknown }): void };
}

(function () {
  "use strict";

  (window as any).__ModuleLoader__.load({
    id: __DSH_PLUGIN_ID__,
    factory: function (require: any) {
      var module: { exports: Record<string, any> } = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      /** 与宿主 ROUTES 一致的路径（单一来源见宿主 src/routes.ts）。 */
      const API = {
        file: "/api/dsh-file-preview/file",
        diff: "/api/dsh-file-preview/diff",
        health: "/api/dsh-file-preview/health",
      };

      /** 预览 Modal 样式（fwp- 前缀避免与 shell / 其它插件冲突）。 */
      const STYLE = `
.fwp-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(8,10,16,.45));display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.fwp-overlay[hidden]{display:none !important}
.fwp-card{width:min(860px,94vw);max-width:94vw;max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden}
.fwp-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f7f8fa);flex:none}
.fwp-title{flex:1;font-size:12px;font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#525866)}
.fwp-actions{display:flex;gap:6px;flex:none}
.fwp-actions button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;line-height:1.6}
.fwp-actions button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.fwp-body{overflow:auto;min-height:200px;display:flex;align-items:flex-start;justify-content:center;padding:14px;background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.fwp-body img{max-width:100%;max-height:70vh;object-fit:contain;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#eef0f3)}
.fwp-body pre{margin:0;padding:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#1c1e26);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;min-width:100%;box-sizing:border-box}
.fwp-state{padding:26px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;text-align:center;align-self:center}
.fwp-state.fwp-err{color:var(--dsw-alias-state-error-primary,#b42318)}
.fwp-err-open{margin-top:12px;border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;align-self:center}
.fwp-err-open:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.fwp-lbox{position:fixed;inset:0;background:rgba(0,0,0,.90);z-index:10000;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.fwp-lbox[hidden]{display:none}
.fwp-lbox-toolbar{position:absolute;top:12px;left:0;right:0;display:flex;justify-content:center;gap:8px;z-index:2}
.fwp-lbox-toolbar button{background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.32);border-radius:6px;padding:4px 12px;font-size:13px;cursor:pointer;line-height:1.5}
.fwp-lbox-toolbar button:hover{background:rgba(255,255,255,.3)}
.fwp-lbox-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:zoom-out}
.fwp-lbox-img{max-width:none;max-height:none;width:auto;height:auto;transform-origin:center center;transition:transform .1s ease-out;will-change:transform;cursor:grab;user-select:none;-webkit-user-drag:none;touch-action:none}
.fwp-lbox.dragging .fwp-lbox-img{cursor:grabbing;transition:none}
.fwp-rendered{overflow:auto;min-width:100%;box-sizing:border-box;width:100%}
.fwp-rendered-md{font-size:14px;line-height:1.65;color:var(--dsw-alias-label-primary,#1c1e26)}
.fwp-rendered-md h1,.fwp-rendered-md h2,.fwp-rendered-md h3,.fwp-rendered-md h4{margin:.6em 0 .3em;line-height:1.3}
.fwp-rendered-md p{margin:.45em 0}
.fwp-rendered-md a{color:var(--dsw-alias-brand-primary,#4f6ef7)}
.fwp-rendered-md ul,.fwp-rendered-md ol{margin:.45em 0;padding-left:1.4em}
.fwp-rendered-md blockquote{border-left:3px solid var(--dsw-alias-border-l2,#d4d8e0);margin:.5em 0;padding-left:.8em;color:var(--dsw-alias-label-secondary,#525866)}
.fwp-rendered-md code{background:var(--dsw-alias-bg-layer-2,#eef0f3);border-radius:4px;padding:.1em .35em;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.9em}
.fwp-rendered-md pre{background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:12px;overflow:auto;margin:.5em 0}
.fwp-rendered-md pre code{background:none;padding:0}
.fwp-rendered-md table{border-collapse:collapse;margin:.5em 0;font-size:.9em}
.fwp-rendered-md th,.fwp-rendered-md td{border:1px solid var(--dsw-alias-border-l1,#d4d8e0);padding:4px 8px}
.fwp-rendered-code{width:100%}
.fwp-rendered-code pre{margin:0;padding:12px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.55;background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;color:var(--dsw-alias-label-primary,#1c1e26)}
.hljs{background:transparent;color:var(--dsw-alias-label-primary,#1c1e26)}
.hljs-keyword,.hljs-selector-tag,.hljs-title,.hljs-section{color:var(--dsw-hljs-keyword,#a626a4)}
.hljs-string,.hljs-regexp,.hljs-addition{color:var(--dsw-hljs-string,#50a14f)}
.hljs-number,.hljs-symbol,.hljs-bullet{color:var(--dsw-hljs-number,#986801)}
.hljs-comment,.hljs-quote{color:var(--dsw-hljs-comment,#a0a1a7);font-style:italic}
.hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-type{color:var(--dsw-hljs-attr,#e45649)}
.hljs-built_in,.hljs-meta,.hljs-title.function_{color:var(--dsw-hljs-func,#0184bc)}
.hljs-literal{color:var(--dsw-hljs-number,#986801)}
.hljs-emphasis{font-style:italic}
.hljs-strong,.hljs-tag{font-weight:600}
.fwp-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f7f8fa);flex:none}
.fwp-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);padding:8px 12px;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.4}
.fwp-tab:hover{color:var(--dsw-alias-label-primary,#1c1e26)}
.fwp-tab-active{color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7)}
.fwp-diff{margin:0;padding:12px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;min-width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1c1e26);white-space:pre}
.fwp-diff-add{background:rgba(34,197,94,.16);color:#15803d}
.fwp-diff-del{background:rgba(239,68,68,.14);color:#b91c1c}
.fwp-diff-hunk{background:rgba(59,130,246,.12);color:#1d4ed8}
.fwp-diff-meta{color:var(--dsw-alias-label-secondary,#6b7280)}
.fwp-diff2html{max-width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;word-break:break-word;overflow-wrap:anywhere}
.fwp-diff2html .d2h-file-wrapper{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px}
.fwp-diff2html .d2h-file-header{padding:6px 10px;font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#eef0f3);color:var(--dsw-alias-label-secondary,#525866)}
.fwp-diff2html .d2h-diff-table{border-collapse:collapse;table-layout:fixed;width:100%}
.fwp-diff2html td{vertical-align:top;word-break:break-word;overflow-wrap:anywhere}
.fwp-diff2html .d2h-code-line{padding:0 8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#1c1e26)}
.fwp-diff2html .d2h-code-linenumber{width:44px;min-width:44px;text-align:right;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:clip;color:var(--dsw-alias-label-tertiary,#8a8f9c);user-select:none;border-right:1px solid var(--dsw-alias-border-l1,#e5e7eb);font-size:11px}
.fwp-diff2html td.d2h-ins{background:rgba(34,197,94,.16)}
.fwp-diff2html .d2h-ins .d2h-code-linenumber{background:rgba(34,197,94,.24)}
.fwp-diff2html td.d2h-del{background:rgba(239,68,68,.14)}
.fwp-diff2html .d2h-del .d2h-code-linenumber{background:rgba(239,68,68,.20)}
.fwp-diff2html .d2h-info{background:rgba(59,130,246,.10);color:#1d4ed8}
.fwp-diff2html .d2h-code-line-prefix{user-select:none}
.fwp-diff2html .d2h-emptyplaceholder{display:none}
@media (max-width:640px){.fwp-diff2html{font-size:11px}.fwp-diff2html .d2h-code-line,.fwp-diff2html .d2h-code-linenumber{font-size:11px}}
`;

      // ------------------------------------------------------------- 状态

      let overlay: HTMLElement | undefined;
      let disposed = false;
      /** 当前图片预览生成的 blob objectURL（关闭 Modal 时释放，避免内存泄漏）。 */
      let trackedObjectUrl: string | undefined;
      /** 文本/MD/代码预览：当前「预览 / 原始 / Diff」模式、已 fetch 的原文、diff 数据与分组。 */
      let previewMode: "preview" | "raw" | "diff" = "preview";
      let rawText: string | undefined;
      let diffText: string | undefined;
      let diffUntracked = false;
      let currentGroup: GroupResult | undefined;
      // 备注：不设 JS 内存缓存——文件常被会话/模型修改，缓存会显示陈旧内容；
      // 可靠性交给浏览器 HTTP 缓存 + 宿主 ETag（no-cache + 弱 ETag）自动协商：
      // 未变 → 304 秒回；已变 → 200 最新。

      // -------------------------------------------------------- DOM 工具

      function el(tag: string, attrs: any = {}, children?: any[]): any {
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

      function ensureStyle(): void {
        if (document.querySelector("style[data-dsh-web-file-preview-style]") !== null) return;
        const style = document.createElement("style");
        style.setAttribute("data-dsh-web-file-preview-style", "");
        style.textContent = STYLE;
        document.head.appendChild(style);
      }

      // ------------------------------------------------------ 文件识别

      /** 是否属于可 web 预览的分组（A：openPath 收口判定；B：静态路径判定；单一事实源 src/grouping.ts）。 */
      function isPreviewablePath(value: string): boolean {
        return groupOfPath(String(value)).group !== "other";
      }

      /** 路径形如（可预览后缀 + 含路径分隔符或纯 token，且非 http/#/mailto）。 */
      function isPathLike(value: string): boolean {
        if (value === undefined || value === null) return false;
        if (/^https?:\/\//i.test(value) || value.startsWith("#") || value.startsWith("mailto:")) return false;
        if (!isPreviewablePath(value)) return false;
        return value.includes("/") || value.includes("\\") || !/\s/.test(value);
      }

      /**
       * 向上找携带"文件路径"线索的可点击元素（B 静态拦截）：
       *  - title 属性 == 完整路径（产出文件 chip / 行内文件引用的权威信号）；
       *  - <a href> 指向本地文件；
       *  - 内联元素（code/span/a）文本本身就是完整可预览路径（覆盖"只输出、
       *    没有编辑/打开操作"的路径 token——这类不走 openPath，A 覆盖不到）。
       */
      function findFileLink(target: any): { path: string; node: Element } | null {
        let node: any = target;
        while (node && node !== document && node.nodeType === 1) {
          const title = node.getAttribute ? (node.getAttribute("title") || "").trim() : "";
          if (title !== "" && isPathLike(title)) return { path: title, node: node as Element };
          if (node.tagName === "A") {
            const href = (node.getAttribute("href") || "").trim();
            if (isPathLike(href)) return { path: href, node: node as Element };
          }
          if (node.tagName === "CODE" || node.tagName === "SPAN" || node.tagName === "A") {
            const text = (node.textContent || "").trim();
            if (text.length > 0 && text.length <= 200 && isPathLike(text)) {
              return { path: text, node: node as Element };
            }
          }
          node = node.parentNode;
        }
        return null;
      }

      // ---------------------------------------------------- 会话 cwd

      /** 从客户端 sessions 服务读取当前会话 cwd（拿不到返回 undefined）。 */
      function activeCwd(): string | undefined {
        try {
          const sessions = (window as any).__DSH_CWD_SESSIONS__;
          if (!sessions || !sessions.list) return undefined;
          const snap = sessions.list.getSnapshot();
          if (!snap || !snap.current || !snap.byId) return undefined;
          const entry = snap.byId[snap.current];
          return entry && entry.cwd ? entry.cwd : undefined;
        } catch {
          return undefined;
        }
      }

      // ------------------------------------------------------ 预览 URL

      function fileUrl(path: string, cwd: string | undefined): string {
        const params = new URLSearchParams();
        if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
        params.set("path", path);
        return `${API.file}?${params.toString()}`;
      }

      /** git diff 探测 URL（F2-B）。 */
      function fileDiffUrl(path: string, cwd: string | undefined): string {
        const params = new URLSearchParams();
        if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
        params.set("path", path);
        return `${API.diff}?${params.toString()}`;
      }

      // ------------------------------------------------------ 预览 Modal

      function closeModal(): void {
        closeLightbox();
        if (overlay !== undefined && overlay.parentElement !== null) overlay.remove();
        overlay = undefined;
        if (trackedObjectUrl !== undefined) {
          URL.revokeObjectURL(trackedObjectUrl);
          trackedObjectUrl = undefined;
        }
        previewMode = "preview";
        rawText = undefined;
        diffText = undefined;
        diffUntracked = false;
        currentGroup = undefined;
      }

      function openPreview(path: string, cwd: string | undefined): void {
        ensureStyle();
        closeModal();

        const url = fileUrl(path, cwd);
        const group = renderGroupFor(path);
        currentGroup = group;
        previewMode = group.group === "md" || group.group === "code" ? "preview" : "raw";
        rawText = undefined;
        diffText = undefined;
        diffUntracked = false;

        const body = el("div", { class: "fwp-body" });
        body.appendChild(el("div", { class: "fwp-state", text: "加载中…" }));

        const copyBtn = el("button", { text: "复制路径" });
        copyBtn.addEventListener("click", () => {
          try {
            void navigator.clipboard.writeText(path).then(() => {
              copyBtn.textContent = "已复制";
              setTimeout(() => { copyBtn.textContent = "复制路径"; }, 1200);
            });
          } catch { /* 剪贴板不可用时静默 */ }
        });
        const newTabBtn = el("button", { text: "在新标签打开" });
        newTabBtn.addEventListener("click", () => { window.open(url, "_blank", "noopener"); });
        const closeBtn = el("button", { text: "关闭" });
        closeBtn.addEventListener("click", closeModal);

        // 三态 tab 栏：预览 / 原始 / Diff（Diff 仅当 git 有变化时动态追加）。
        const tabs = el("div", { class: "fwp-tabs" });
        const tabDefs: Array<{ label: string; mode: "preview" | "raw" }> = [];
        if (group.group === "md" || group.group === "code") {
          tabDefs.push({ label: "预览", mode: "preview" }, { label: "原始", mode: "raw" });
        }
        if (group.group === "text") {
          tabDefs.push({ label: "内容", mode: "raw" });
        }
        const syncTabActive = () => {
          for (const raw of Array.from(tabs.children)) {
            const b = raw as HTMLElement;
            b.classList.toggle("fwp-tab-active", b.dataset.mode === previewMode);
          }
        };
        let diffTab: any;
        const addDiffTab = () => {
          if (diffTab !== undefined) return;
          diffTab = el("button", { class: "fwp-tab", text: "Diff", attrs: { "data-mode": "diff" } });
          diffTab.addEventListener("click", () => {
            previewMode = "diff";
            syncTabActive();
            renderTabBody(body);
          });
          tabs.appendChild(diffTab);
          syncTabActive();
        };
        for (const def of tabDefs) {
          const b = el("button", { class: "fwp-tab", text: def.label, attrs: { "data-mode": def.mode } });
          b.addEventListener("click", () => {
            previewMode = def.mode;
            syncTabActive();
            renderTabBody(body);
          });
          tabs.appendChild(b);
        }
        syncTabActive();

        const head = el("div", { class: "fwp-head" }, [
          el("div", { class: "fwp-title", text: path, attrs: { title: path } }),
          el("div", { class: "fwp-actions" }, [copyBtn, newTabBtn, closeBtn]),
        ]);
        const card = el("div", { class: "fwp-card" }, [head, tabs, body]);
        const ov: HTMLElement = el("div", { class: "fwp-overlay" });
        overlay = ov;
        ov.appendChild(card);
        ov.addEventListener("click", (event: any) => {
          if (event.target === ov) closeModal();
        });
        document.addEventListener("keydown", onKeyDown);
        document.body.appendChild(ov);

        if (group.group === "image") {
          renderImage(url, body);
        } else {
          fetchText(url, body);
          probeDiff(path, cwd, addDiffTab);
        }
      }

      function onKeyDown(event: KeyboardEvent): void {
        if (event.key !== "Escape") return;
        if (lboxEl !== undefined) closeLightbox();
        else closeModal();
      }

      /** 统一样式错误态：文案 + 可选「在新标签打开」兜底。 */
      function errorView(body: HTMLElement, msg: string, url: string | undefined): void {
        body.textContent = "";
        body.appendChild(el("div", { class: "fwp-state fwp-err", text: msg }));
        if (url !== undefined) {
          const open = el("button", { class: "fwp-err-open", text: "在新标签打开" });
          open.addEventListener("click", () => { window.open(url, "_blank", "noopener"); });
          body.appendChild(open);
        }
      }

      /**
       * 文本/代码/Markdown：fetch 全文后按当前「预览 / 原始」模式渲染。
       * 原文存入 rawText，切换模式不重新请求。
       */
      function fetchText(url: string, body: HTMLElement): void {
        void fetch(url)
          .then(async (res) => {
            if (!res.ok) {
              let msg = `加载失败（HTTP ${res.status}）`;
              try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
              errorView(body, msg, url);
              return;
            }
            rawText = await res.text();
            renderTabBody(body);
          })
          .catch(() => errorView(body, "请求失败（无法访问文件预览服务）", url));
      }

      /** 按当前模式渲染文本类正文（预览=md渲染/代码高亮；原始=等宽 pre；Diff=git diff）。 */
      function renderTabBody(body: HTMLElement): void {
        const group = currentGroup;
        if (group === undefined) return;
        body.textContent = "";
        if (previewMode === "diff") {
          renderDiff(body);
          return;
        }
        const text = rawText;
        if (text === undefined) {
          body.appendChild(el("div", { class: "fwp-state", text: "加载中…" }));
          return;
        }
        if (previewMode === "raw" || group.group === "text") {
          body.appendChild(el("pre", { text }));
          return;
        }
        try {
          if (group.group === "md") {
            body.appendChild(el("div", { class: "fwp-rendered fwp-rendered-md", html: DOMPurify.sanitize(renderMarkdown(text)) }));
          } else {
            const highlighted = `<pre><code class="hljs">${highlightCode(text, group.ext)}</code></pre>`;
            body.appendChild(el("div", { class: "fwp-rendered fwp-rendered-code", html: DOMPurify.sanitize(highlighted) }));
          }
        } catch {
          // 渲染失败降级原始，不静默空 HTML。
          body.appendChild(el("pre", { text }));
        }
      }

      /** 探测该文件是否有 git diff；有则把 Diff tab 加到 tab 栏（否则不展示）。 */
      function probeDiff(path: string, cwd: string | undefined, onAvailable: () => void): void {
        const diffUrl = fileDiffUrl(path, cwd);
        void fetch(diffUrl)
          .then(async (res) => {
            if (!res.ok) return;
            const data = await res.json().catch(() => null);
            if (data && data.ok && data.hasDiff) {
              diffText = typeof data.diff === "string" ? data.diff : undefined;
              diffUntracked = !!data.untracked;
              onAvailable();
            }
          })
          .catch(() => { /* 探测失败则无 Diff tab */ });
      }

      /** 渲染 git diff（diff2html：行号/折叠/配色。兜底用 pre 原样展示）。 */
      function renderDiff(body: HTMLElement): void {
        if (diffUntracked) {
          body.appendChild(el("div", { class: "fwp-state", text: "未跟踪的新文件（git 无基线，无法对比；完整内容见“内容/原始”）" }));
          return;
        }
        const d = diffText ?? "";
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

      /**
       * 图片预览：同样走 fetch → Blob → objectURL。
       * 与文本共用同一条高优先级网络通道（而非低优先级的 <img src> 直连），
       * 并在 HTTP/1.1 + SSE 长连接占满连接池时避免 <img> 低优先级 pending/
       * queueing（Windows Chrome 会排队、HTTP/2 的手机端不会的原帖问题根因）
       * —— 图片加载完成后 <img> 读取的是本地 blob，不再占网络连接。
       * 点击图片进入灯箱（放大/平移，见 openLightbox）。
       */
      /** 把已获取的图片 blob 渲染进正文（建 objectURL + 灯箱点击）。 */
      function renderBlobImage(blob: Blob, body: HTMLElement): void {
        const objectUrl = URL.createObjectURL(blob);
        trackedObjectUrl = objectUrl;
        body.textContent = "";
        const img = el("img", { class: "fwp-preview-img" });
        img.alt = "preview";
        img.title = "点击放大";
        img.addEventListener("error", () => errorView(body, "图片解码失败（文件已获取，但无法作为图片显示）", undefined));
        img.addEventListener("click", () => openLightbox(objectUrl));
        img.src = objectUrl;
        body.appendChild(img);
      }

      function renderImage(url: string, body: HTMLElement): void {
        void fetch(url)
          .then(async (res) => {
            if (!res.ok) {
              let msg = `加载失败（HTTP ${res.status}）`;
              try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
              errorView(body, msg, url);
              return;
            }
            const blob = await res.blob();
            renderBlobImage(blob, body);
          })
          .catch(() => errorView(body, "请求失败（无法访问文件预览服务）", url));
      }

      // ------------------------------------------------- 图片灯箱（放大/平移）

      function clampy(v: number, min: number, max: number): number {
        return Math.min(max, Math.max(min, v));
      }

      let lboxEl: HTMLElement | undefined;
      let lboxImg: any;
      let lboxScale = 1;
      let lboxTx = 0;
      let lboxTy = 0;

      function applyLboxTransform(): void {
        if (lboxImg) lboxImg.style.transform = `translate(${lboxTx}px, ${lboxTy}px) scale(${lboxScale})`;
      }

      function closeLightbox(): void {
        if (lboxEl !== undefined && lboxEl.parentElement !== null) lboxEl.remove();
        lboxEl = undefined;
        lboxImg = undefined;
        lboxScale = 1; lboxTx = 0; lboxTy = 0;
      }

      /** 全屏灯箱：黑色遮罩 + 缩放/重置/关闭工具栏 + 滚轮缩放 + 指针拖拽平移。 */
      function openLightbox(src: string): void {
        closeLightbox();
        lboxScale = 1; lboxTx = 0; lboxTy = 0;

        const img = el("img", { class: "fwp-lbox-img" });
        img.src = src;
        img.alt = "preview";
        lboxImg = img;

        const stage = el("div", { class: "fwp-lbox-stage" });
        stage.appendChild(img);

        const zoomIn = el("button", { text: "＋" });
        zoomIn.addEventListener("click", () => { lboxScale = clampy(lboxScale * 1.25, 0.2, 8); applyLboxTransform(); });
        const zoomOut = el("button", { text: "－" });
        zoomOut.addEventListener("click", () => { lboxScale = clampy(lboxScale / 1.25, 0.2, 8); applyLboxTransform(); });
        const reset = el("button", { text: "重置" });
        reset.addEventListener("click", () => { lboxScale = 1; lboxTx = 0; lboxTy = 0; applyLboxTransform(); });
        const closeBtn = el("button", { text: "×" });
        closeBtn.addEventListener("click", closeLightbox);
        const toolbar = el("div", { class: "fwp-lbox-toolbar" }, [zoomIn, zoomOut, reset, closeBtn]);

        const lbox = el("div", { class: "fwp-lbox" });
        lbox.appendChild(toolbar);
        lbox.appendChild(stage);
        lboxEl = lbox;

        // 点空白/遮罩关闭
        lbox.addEventListener("click", (event: any) => {
          if (event.target === lbox || event.target === stage) closeLightbox();
        });
        // 滚轮以中心缩放
        lbox.addEventListener("wheel", (event: WheelEvent) => {
          event.preventDefault();
          lboxScale = clampy(lboxScale * (event.deltaY < 0 ? 1.12 : 0.9), 0.2, 8);
          applyLboxTransform();
        }, { passive: false });
        // 指针拖拽平移
        let dragging = false, startX = 0, startY = 0, origTx = 0, origTy = 0;
        img.addEventListener("pointerdown", (e: PointerEvent) => {
          dragging = true; startX = e.clientX; startY = e.clientY; origTx = lboxTx; origTy = lboxTy;
          try { img.setPointerCapture(e.pointerId); } catch { /* 兼容 */ }
          lbox.classList.add("dragging");
        });
        img.addEventListener("pointermove", (e: PointerEvent) => {
          if (!dragging) return;
          lboxTx = origTx + (e.clientX - startX);
          lboxTy = origTy + (e.clientY - startY);
          applyLboxTransform();
        });
        const endDrag = () => { dragging = false; lbox.classList.remove("dragging"); };
        img.addEventListener("pointerup", endDrag);
        img.addEventListener("pointercancel", endDrag);

        document.body.appendChild(lbox);
      }

      // ------------------------------------------------------ 点击拦截

      function onClickCapture(event: any): void {
        if (disposed) return;
        // 命中我们自己的预览 Modal 内部时不再重复拦截（避免点标题又开一次）。
        if (overlay !== undefined && overlay.contains(event.target)) return;
        const hit = findFileLink(event.target);
        if (hit === null) return;
        // 命中文件链接：拦截原生打开，改走 web 预览。
        event.preventDefault();
        event.stopPropagation();
        const cwd = activeCwd();
        openPreview(hit.path, cwd);
      }

      // -------------------------------------------------------- 生命周期

      /**
       * A：在 `workspaces.openPath` 调用点统一收口。
       * conversation 的 `openFile()`（产出文件 chip + 行内文件引用）以及第三方
       * 壳（如文件树）最终都汇到这一个入口。包装其方法：路径命中后缀白名单 →
       * 走 web 预览且不触底 `host.openPath`；否则放行原方法（原生打开）。
       * 返回一个 thenable，兼容调用方 `.catch(() => {})` 写法。
       */
      function wrapOpenPath(ctx: any): () => void {
        let ws: any;
        let orig: ((path: string) => unknown) | undefined;
        try {
          ws = ctx && ctx.get ? ctx.get("workspaces") : undefined;
          if (ws && typeof ws.openPath === "function") {
            orig = ws.openPath.bind(ws);
            ws.openPath = function (path: string): unknown {
              const p = String(path);
              if (isPreviewablePath(p)) {
                openPreview(p, activeCwd());
                return Promise.resolve();
              }
              return orig!(p);
            };
          }
        } catch (error) {
          console.warn("[dsh-web-file-preview] wrap openPath failed:", error);
        }
        return () => {
          if (ws && orig && typeof ws.openPath === "function") {
            try { ws.openPath = orig; } catch { /* 还原失败忽略 */ }
          }
        };
      }

      function apply(ctx: any): void {
        try {
          ensureStyle();
          // B：document 捕获阶段拦截文件链接点击（含"只输出、无打开操作"的路径）。
          document.addEventListener("click", onClickCapture, true);
          // 暴露当前会话 cwd（通过 inject 的 sessions 服务，惰性读取）。
          try { (window as any).__DSH_CWD_SESSIONS__ = ctx && ctx.get ? ctx.get("sessions") : undefined; } catch { /* 兼容 */ }
          // A：openPath 调用点收口。
          const restoreOpenPath = wrapOpenPath(ctx);
          ctx.effect(() => () => {
            disposed = true;
            document.removeEventListener("click", onClickCapture, true);
            document.removeEventListener("keydown", onKeyDown);
            closeModal();
            restoreOpenPath();
            const style = document.querySelector("style[data-dsh-web-file-preview-style]");
            if (style !== null && style.parentElement !== null) style.remove();
            delete (window as any).__DSH_CWD_SESSIONS__;
          }, "dsh-web-file-preview: ui");
        } catch (error) {
          console.warn("[dsh-web-file-preview] mount failed:", error);
        }
      }

      // 客户端插件声明：需要 sessions 服务以跟随当前会话（cwd 用于拼预览 URL）。
      const inject = ["sessions"];
      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();
