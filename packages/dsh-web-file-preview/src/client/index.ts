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

// 客户端干净模块：只导出 apply/inject，契约外壳（IIFE/load/Symbol.toStringTag 装配）
// 由 scripts/build-client.ts 统一生成——源码不写任何 loader 痕迹。
// 第三方库（DOMPurify/diff2html/marked/highlight.js）经 build-client 内联进产物
// （package.json 声明 dsh.client.inlineBareImports: true，非宿主注入 external）。

import { renderMarkdown } from "./md.js";
import { highlightCode } from "./code.js";
import { renderGroupFor, type GroupResult } from "./renderer.js";
import { groupOfPath, isLikelySingleFilePath } from "../grouping.js";
import { html as diffToHtml } from "diff2html";
import DOMPurify from "dompurify";
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";

      /** 与宿主 ROUTES 一致的路径（单一来源见宿主 src/routes.ts）。 */
      const API = {
        file: "/api/dsh-file-preview/file",
        diff: "/api/dsh-file-preview/diff",
        health: "/api/dsh-file-preview/health",
      };

      /** 预览 Modal 样式（fwp- 前缀避免与 shell / 其它插件冲突）。 */

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

      // 预览代数：每次打开/关闭自增；在途请求落地时校验代数，不匹配即丢弃，
      // 杜绝「快速开关预览后旧文件内容覆写新文件」的串文件竞态（评审 C1）。
      let openSeq = 0;
      // 当前预览的在途请求取消句柄：关闭 / 重开 / 插件卸载时 abort 全部在途请求，
      // 避免慢速网络下请求悬空继续回写被移除的 DOM（评审 C2）。
      let activeAbort: AbortController | undefined;

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

      /**
       * 复制文本到剪贴板（评审 U2）：安全上下文优先 navigator.clipboard（带 then/catch
       * 反馈），明文 HTTP（非安全上下文）降级 textarea + execCommand，两端都给出
       * 「已复制 / 复制失败」按钮态反馈，不再静默失败。
       */
      function copyPathText(text: string, btn: HTMLElement): void {
        const flash = (label: string): void => {
          btn.textContent = label;
          window.setTimeout(() => { btn.textContent = "复制路径"; }, 1200);
        };
        try {
          if (typeof navigator.clipboard?.writeText === "function" && window.isSecureContext === true) {
            navigator.clipboard.writeText(text).then(() => flash("已复制"), () => flash("复制失败"));
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
          flash(copied ? "已复制" : "复制失败");
        } catch {
          flash("复制失败");
        }
      }

      // ------------------------------------------------------ 文件识别

      /** 是否属于可 web 预览的分组（A：openPath 收口判定；B：静态路径判定；单一事实源 src/grouping.ts）。 */
      function isPreviewablePath(value: string): boolean {
        return groupOfPath(String(value)).group !== "other";
      }

      /** 路径形如（结构性判定，单一事实源 src/grouping.ts）。 */
      function isPathLike(value: string): boolean {
        return isLikelySingleFilePath(String(value));
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
          // 评审 U5：文本嗅探范围扩到 BUTTON（chip / 工具卡都是 <button>，与 A 机制双保险；
          // 不扩 DIV——父容器 textContent 常是多段拼接，保留它防误拦）；长度上限 200→1024
          // （monorepo 绝对路径常态超 200）。
          if (node.tagName === "CODE" || node.tagName === "SPAN" || node.tagName === "A" || node.tagName === "BUTTON") {
            const text = (node.textContent || "").trim();
            if (text.length > 0 && text.length <= 1024 && isPathLike(text)) {
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
        // 使所有在途请求代数失效并取消，防止旧请求覆写新打开的状态或回写被移除的 DOM。
        openSeq++;
        activeAbort?.abort();
        activeAbort = undefined;
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
        // 还原背景滚动（与 openPreview 的 body 锁配对，评审 U1）。
        document.body.style.overflow = "";
        // a11y（评审 U11）：焦点还原到打开预览前的元素。
        if (lastFocused !== undefined) {
          try { if (document.contains(lastFocused)) lastFocused.focus(); } catch { /* 忽略 */ }
          lastFocused = undefined;
        }
      }

      function openPreview(path: string, cwd: string | undefined): void {
        ensureStyle();
        closeModal();
        // a11y（评审 U11）：聚焦元素在关闭 Modal 后被还原。
        lastFocused = (document.activeElement as HTMLElement | undefined) || undefined;
        // 本次预览的代数与取消句柄：所有 fetch 共用，落地前校验代数。
        const seq = ++openSeq;
        const abort = new AbortController();
        activeAbort = abort;

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
        copyBtn.addEventListener("click", () => copyPathText(path, copyBtn));
        const newTabBtn = el("button", { text: "在新标签打开原文" });
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
        // 评审 U9：探测失败不再静默——tab 栏给出「Diff 不可用」禁用态，避免用户误以为
        // 「没有变化」；与「确实无 diff（不出现 tab）」区分开。
        let unavailableDiffTab: any;
        const addUnavailableDiffTab = () => {
          if (diffTab !== undefined || unavailableDiffTab !== undefined) return;
          unavailableDiffTab = el("button", {
            class: "fwp-tab fwp-tab-disabled",
            text: "Diff 不可用",
            disabled: true,
            title: "git diff 探测失败（网络或仓库异常），可能无法显示变更",
          });
          tabs.appendChild(unavailableDiffTab);
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
        // a11y（评审 U11）：dialog 语义 + 打开聚焦 + Tab 陷阱配合 onKeyDown。
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-modal", "true");
        card.setAttribute("aria-label", `预览：${path}`);
        card.setAttribute("tabindex", "-1");
        // 兜底内联：宿主环境可能不把注入样式表首部的 .fwp-overlay 规则纳入 CSSOM（position:fixed 失效，
        // Modal 会掉到对话框下方）；这里直接内联关键定位/遮罩/居中，确保任意访问形态都浮层居中弹出
        // （样式表正常解析时同值、互不冲突）。
        const ov: HTMLElement = el("div", { class: "fwp-overlay" });
        ov.setAttribute(
          "style",
          "position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(8,10,16,.45));display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif",
        );
        overlay = ov;
        ov.appendChild(card);
        ov.addEventListener("click", (event: any) => {
          if (event.target === ov) closeModal();
        });
        document.addEventListener("keydown", onKeyDown);
        document.body.appendChild(ov);
        // a11y：焦点进入 Modal（role="dialog" 容器）。
        card.focus();
        // 锁背景滚动（评审 U1）：Modal 打开期间 iOS 触摸不会滚到背景页面，
        // 由 closeModal 还原；配合样式表 overscroll-behavior:contain。
        document.body.style.overflow = "hidden";

        if (group.group === "image") {
          renderImage(url, body, seq, abort.signal);
        } else {
          fetchText(url, body, seq, abort.signal);
          probeDiff(path, cwd, seq, addDiffTab, addUnavailableDiffTab, abort.signal);
        }
      }

      /** 打开预览前的聚焦元素（关闭/卸载后还原焦点，评审 U11）。 */
      let lastFocused: HTMLElement | undefined;

      function onKeyDown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
          if (lboxEl !== undefined) closeLightbox();
          else closeModal();
          return;
        }
        // Tab 焦点陷阱（评审 U11）：焦点在灯箱/Modal 内循环，不穿到背景页面。
        if (event.key !== "Tab") return;
        const container = lboxEl ?? overlay;
        if (container === undefined) return;
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>('button,[href],input,[tabindex]:not([tabindex="-1"])')
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = active !== null && active !== container && container.contains(active);
        if (event.shiftKey && (!inside || active === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || active === last)) {
          event.preventDefault();
          first.focus();
        }
      }

      /** 统一样式错误态：文案 + 可选「在新标签打开」兜底。 */
      function errorView(body: HTMLElement, msg: string, url: string | undefined): void {
        body.textContent = "";
        body.appendChild(el("div", { class: "fwp-state fwp-err", text: msg }));
        if (url !== undefined) {
          const open = el("button", { class: "fwp-err-open", text: "在新标签打开原文" });
          open.addEventListener("click", () => { window.open(url, "_blank", "noopener"); });
          body.appendChild(open);
        }
      }

      /**
       * 文本/代码/Markdown：fetch 全文后按当前「预览 / 原始」模式渲染。
       * 原文存入 rawText，切换模式不重新请求。
       */
      function fetchText(url: string, body: HTMLElement, seq: number, signal: AbortSignal): void {
        void fetch(url, { signal })
          .then(async (res) => {
            if (seq !== openSeq) return;
            if (!res.ok) {
              let msg = `加载失败（HTTP ${res.status}）`;
              try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
              errorView(body, msg, url);
              return;
            }
            rawText = await res.text();
            if (seq !== openSeq) return;
            renderTabBody(body);
          })
          .catch(() => { if (seq === openSeq) errorView(body, "请求失败（无法访问文件预览服务）", url); });
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
      function probeDiff(path: string, cwd: string | undefined, seq: number, onAvailable: () => void, onUnavailable: () => void, signal: AbortSignal): void {
        const diffUrl = fileDiffUrl(path, cwd);
        void fetch(diffUrl, { signal })
          .then(async (res) => {
            if (seq !== openSeq) return;
            if (!res.ok) {
              // 评审 U9：HTTP 失败（服务异常/围栏拒绝）→ 显式「不可用」而非静默
              onUnavailable();
              return;
            }
            const data = await res.json().catch(() => null);
            if (seq !== openSeq) return;
            if (data && data.ok && data.hasDiff) {
              diffText = typeof data.diff === "string" ? data.diff : undefined;
              diffUntracked = !!data.untracked;
              onAvailable();
            }
          })
          .catch(() => { if (seq === openSeq) onUnavailable(); });
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
      function renderBlobImage(blob: Blob, body: HTMLElement, url: string): void {
        const objectUrl = URL.createObjectURL(blob);
        trackedObjectUrl = objectUrl;
        body.textContent = "";
        const img = el("img", { class: "fwp-preview-img" });
        img.alt = "preview";
        img.title = "点击放大";
        img.addEventListener("error", () => errorView(body, "图片解码失败（文件已获取，但无法作为图片显示）", url));
        img.addEventListener("click", () => openLightbox(objectUrl));
        img.src = objectUrl;
        body.appendChild(img);
      }

      function renderImage(url: string, body: HTMLElement, seq: number, signal: AbortSignal): void {
        void fetch(url, { signal })
          .then(async (res) => {
            if (seq !== openSeq) return;
            if (!res.ok) {
              let msg = `加载失败（HTTP ${res.status}）`;
              try { const data = await res.json(); if (data && data.error) msg = String(data.error); } catch { /* 忽略 */ }
              errorView(body, msg, url);
              return;
            }
            const blob = await res.blob();
            if (seq !== openSeq) return;
            renderBlobImage(blob, body, url);
          })
          .catch(() => { if (seq === openSeq) errorView(body, "请求失败（无法访问文件预览服务）", url); });
      }

      // ------------------------------------------------- 图片灯箱（放大/平移）

      function clampy(v: number, min: number, max: number): number {
        return Math.min(max, Math.max(min, v));
      }

      /** 两点欧氏距离（双指捏合用，评审 U6）。 */
      function distance2(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
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
        zoomIn.setAttribute("aria-label", "放大");
        zoomIn.setAttribute("title", "放大");
        zoomIn.addEventListener("click", () => { lboxScale = clampy(lboxScale * 1.25, 0.2, 8); applyLboxTransform(); });
        const zoomOut = el("button", { text: "－" });
        zoomOut.setAttribute("aria-label", "缩小");
        zoomOut.setAttribute("title", "缩小");
        zoomOut.addEventListener("click", () => { lboxScale = clampy(lboxScale / 1.25, 0.2, 8); applyLboxTransform(); });
        const reset = el("button", { text: "重置" });
        reset.setAttribute("aria-label", "重置缩放");
        reset.addEventListener("click", () => { lboxScale = 1; lboxTx = 0; lboxTy = 0; applyLboxTransform(); });
        const closeBtn = el("button", { text: "×" });
        closeBtn.setAttribute("aria-label", "关闭灯箱");
        closeBtn.addEventListener("click", closeLightbox);
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
        lboxEl = lbox;
        // 焦点移入灯箱（a11y）：默认落在关闭按钮，Esc/按钮均可退出。
        closeBtn.focus();

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
        // 指针交互（评审 U6）：单指/鼠标拖拽平移 + 双指捏合缩放并存；配合
        // touch-action:none 与 setPointerCapture。滚轮缩放保留在下文。
        const pointers = new Map<number, { x: number; y: number }>();
        let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };
        let pinchStart = { dist: 1, scale: 1 };
        img.addEventListener("pointerdown", (e: PointerEvent) => {
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          try { img.setPointerCapture(e.pointerId); } catch { /* 兼容 */ }
          if (pointers.size === 1) {
            dragStart = { x: e.clientX, y: e.clientY, tx: lboxTx, ty: lboxTy };
            lbox.classList.add("dragging");
          } else if (pointers.size === 2) {
            const pts = Array.from(pointers.values());
            pinchStart = { dist: distance2(pts[0], pts[1]) || 1, scale: lboxScale };
          }
        });
        img.addEventListener("pointermove", (e: PointerEvent) => {
          if (!pointers.has(e.pointerId)) return;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 2) {
            const pts = Array.from(pointers.values());
            lboxScale = clampy(pinchStart.scale * (distance2(pts[0], pts[1]) / pinchStart.dist), 0.2, 8);
            applyLboxTransform();
          } else if (pointers.size === 1) {
            lboxTx = dragStart.tx + (e.clientX - dragStart.x);
            lboxTy = dragStart.ty + (e.clientY - dragStart.y);
            applyLboxTransform();
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

      // ------------------------------------------------------ 点击拦截

      function onClickCapture(event: any): void {
        if (disposed) return;
        // 命中我们自己的预览 Modal 内部时不再重复拦截（避免点标题又开一次）。
        if (overlay !== undefined && overlay.contains(event.target)) return;
        // 页面存在文本选区（长按选择 / 鼠标划选）时不拦截，避免打断「我要复制文字」的
        // 意图（评审 U5；移动端长按选中后松手产生的 click 不再误弹预览）。
        const selection = window.getSelection ? window.getSelection() : null;
        if (selection !== null && selection.toString() !== "") return;
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

export function apply(ctx: any): void {
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

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，第三方内联）----
// 需要 sessions 服务以跟随当前会话（cwd 用于拼预览 URL）。
export const inject: string[] = ["sessions"];
