/**
 * dsh-web-file-preview — 客户端预览 Modal 生命周期。
 *
 * Modal 打开/关闭/返回导航/焦点管理/键盘事件。
 * fileUrl 仅被 openPreview 使用，故归本模块（避免跨模块循环依赖）。
 */

import { el, copyPathText, ensureStyle } from "./dom.ts";
import type { FilePreviewState, NavEntry } from "./state.ts";
import { fetchText, renderTabBody, probeDiff } from "./text.ts";
import { renderImage } from "./image.ts";
import { closeLightbox } from "./viewer.ts";
import { renderGroupFor } from "./renderer.ts";
import { scrollToFragment } from "./anchor.ts";
import { t } from "../../../../shared/client/i18n.js";
import { renderHtmlPreview, releaseUrl } from "./html.ts";
import {
  fullscreenSupported,
  isFullscreenActive,
  fullscreenLabel,
  shouldInterceptEscapeAsFullscreenExit,
  exitFullscreenQuiet,
} from "./fullscreen-math.ts";
import { textFitsSnapshot } from "./render-limit.ts";
import { normalizeBasePath } from "../relpath.ts";

/** 文件预览 URL（F2-B）。 */
export function fileUrl(path: string, cwd: string | undefined, state: FilePreviewState): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", path);
  return `${state.API.file}?${params.toString()}`;
}

/** 关闭 Modal 并清理资源（导航式重建用，不清栈、不动焦点）。 */
export function closeModal(state: FilePreviewState): void {
  // issue #344：全屏态清理——仅当全屏元素是本插件 overlay（或其子树）时才退全屏，
  // 避免越权退出与插件无关的页面全屏（评审 F5：closeModal 被首次打开/导航重建/
  // 卸载共用，无条件 exitFullscreen 会误伤第三方插件的全屏）。幂等（非全屏无副作用）；
  // 导航重建（openPreview 内调用）同样在此退全屏——「导航即退全屏」语义。
  const fullscreenEl = document.fullscreenElement;
  if (fullscreenEl !== null && fullscreenEl !== undefined &&
      state.overlay !== undefined && fullscreenEl.contains(state.overlay)) {
    exitFullscreenQuiet(document);
  }
  state.fsActive = false;
  closeLightbox(state);
  // 使所有在途请求代数失效并取消，防止旧请求覆写新打开的状态或回写被移除的 DOM。
  state.openSeq++;
  state.activeAbort?.abort();
  state.activeAbort = undefined;
  if (state.overlay !== undefined && state.overlay.parentElement !== null) state.overlay.remove();
  state.overlay = undefined;
  if (state.trackedObjectUrl !== undefined) {
    URL.revokeObjectURL(state.trackedObjectUrl);
    state.trackedObjectUrl = undefined;
  }
  // U8 v2：释放 md 内嵌图 blob URL 与排队任务（内存受控）。
  for (const url of state.trackedBlobUrls) {
    try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
  }
  state.trackedBlobUrls = [];
  state.imgQueue.length = 0;
  // 评审（返回栈 S2）：导航式重建（openPreview 内调用）会把旧代在途的 md 内嵌图
  // fetch 打断，但其 .finally 仍会 imgInFlight-- / 触发 pump；这里把计数归零，
  // 防止旧代请求与新代泵图共用同一计数器造成并发上限错乱。
  state.imgInFlight = 0;
  state.previewMode = "preview";
  state.rawText = undefined;
  state.diffText = undefined;
  state.diffUntracked = false;
  state.currentGroup = undefined;
  // 注（issue #73 评审 P2-6）：serveToken/serveSrc **不在此清理**——closeModal 是
  // 导航式重建（openPreview 内调用）与终态关闭共用的清理函数，release 只发生在
  // finalizeSession（终态关闭，见下）；导航重建时 token 随 backStack 快照保留，
  // 返回可复用 iframe；残留 token 由宿主 TTL/LRU 兜底回收。
  // issue #104：清空 mermaid hydration 注册表（旧 Modal 的已渲染块引用不跨
  // Modal 残留；在途重渲染由 openSeq 代数校验自行中止，见 mermaid.ts）。
  state.activeMermaidHydration = undefined;
  // 还原背景滚动（与 openPreview 的 body 锁配对，评审 U1）。
  document.body.style.overflow = "";
  // 注：焦点还原 / 返回栈清空不在此处——这是导航式重建（openPreview 内调用）与
  // 终态关闭共用的"资源清理"函数；焦点还原与栈复位放在 finalizeSession()（终态入口）。
}

// ---- issue #344：全屏按钮状态同步（真全屏 + 视口放大降级态共用）----

/**
 * 同步 overlay 的降级态 class（.fwp-fs）与按钮文案/aria：
 * - 真全屏（fullscreenchange 触发）：浏览器原声渲染 fullscreenElement（overlay），
 *   .fwp-fs 不需要；降级态（能力缺失/请求被拒）靠 .fwp-fs 撑满视口。
 * - state.fsActive 为「当前是否全屏（含降级）」的单一事实源，供 Esc 协调与同步用。
 */
export function syncFullscreenState(state: FilePreviewState): void {
  const active = isFullscreenActive(document) || state.fsActive;
  const supported = state.fsSupported;
  if (state.overlay !== undefined) {
    state.overlay.classList.toggle("fwp-fs", active && !isFullscreenActive(document));
  }
  const btn = state.overlay?.querySelector<HTMLButtonElement>(".fwp-fs-btn");
  const label = fullscreenLabel(active, supported, t);
  if (btn !== null && btn !== undefined) {
    btn.textContent = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.setAttribute("aria-pressed", String(active));
    btn.classList.toggle("fwp-fs-on", active);
  }
}

/**
 * 全屏按钮点击：在全屏/退出全屏（能力缺失降级为视口放大态）之间切换。
 * - 进入：能力探测通过 → 同步手势栈内调用 overlay.requestFullscreen()（可被拒 →
 *   .catch 降级为 .fwp-fs 视口放大态）；能力缺失 → 直接降级 .fwp-fs。
 * - 退出：exitFullscreen（原生）或摘除 .fwp-fs（降级态），并同步 state.fsActive。
 */
function toggleFullscreen(state: FilePreviewState, btn: HTMLButtonElement): void {
  const overlay = state.overlay;
  if (overlay === undefined) return;
  const supported = fullscreenSupported(document, overlay);
  state.fsSupported = supported;
  const alreadyActive = isFullscreenActive(document) || state.fsActive;
  if (alreadyActive) {
    // 退出全屏：原生路径 exitFullscreen（fullscreenchange 会同步）；降级路径摘 class。
    state.fsActive = false;
    exitFullscreenQuiet(document);
    syncFullscreenState(state);
    return;
  }
  if (supported) {
    // 异步请求可能在 Modal 导航重建/关闭后才 settle——capture 发起时的 overlay
    // 引用做守卫，避免把「新打开的预览」误置为降级放大态（评审 F4）。
    const requestOverlay = overlay;
    try {
      const p = overlay.requestFullscreen();
      if (p !== undefined && typeof (p as Promise<void>).catch === "function") {
        void (p as Promise<void>).catch(() => {
          // 请求被拒（策略/手势丢失/iframe 无 allow-fullscreen）→ 降级为视口放大态；
          // 同时回落 fsSupported=false——否则按钮误显「退出全屏」而非「退出放大」
          //（fullscreenLabel(true,true) 与降级态语义不符，评审 F4 文案错误）。
          if (state.overlay !== requestOverlay) return;
          state.fsSupported = false;
          state.fsActive = true;
          syncFullscreenState(state);
        });
      }
    } catch {
      if (state.overlay !== requestOverlay) return;
      // requestFullscreen 本身抛错（如 DOM 非法）→ 降级，文案同步回落。
      state.fsSupported = false;
      state.fsActive = true;
      syncFullscreenState(state);
    }
    return;
  }
  // 能力缺失（iOS Safari 非 video / fullscreenEnabled=false）→ 视口放大降级态。
  state.fsActive = true;
  syncFullscreenState(state);
}

/**
 * 终态关闭：还原焦点到首次触发元素、清空返回栈，再走 closeModal 清理资源。
 * 只在真正的关闭语义入口调用（关闭按钮 / 遮罩 / Esc 非灯箱 / 插件卸载），
 * 与 openPreview 内部的导航式重建（closeModal 不清栈、不动焦点）区分开来。
 * issue #73：仅在此上报 release 当前 html 预览 token（B5）——导航式重建不清
 * token（随 backStack 快照保留供返回复用）；未释放由宿主 TTL/LRU 兜底回收。
 */
export function finalizeSession(state: FilePreviewState, reason: "close" | "unmount"): void {
  if (state.serveToken !== undefined) {
    const token = state.serveToken;
    state.serveToken = undefined;
    state.serveSrc = undefined;
    void fetch(releaseUrl(token, state), { method: "GET" }).catch(() => { /* 忽略 */ });
  }
  if (reason === "unmount") {
    // 卸载时 overlay 仍可还原焦点到会话（若在 DOM 中）。
    if (state.sessionOriginFocus !== undefined) {
      try { if (document.contains(state.sessionOriginFocus)) state.sessionOriginFocus.focus(); } catch { /* 忽略 */ }
    }
    state.sessionOriginFocus = undefined;
    state.backStack = [];
    closeModal(state);
    return;
  }
  if (state.sessionOriginFocus !== undefined) {
    try {
      // 仅当触发元素仍存在且当前不是刚被卸载的上下文时才还原。
      if (document.body !== null && document.contains(state.sessionOriginFocus)) state.sessionOriginFocus.focus();
    } catch { /* 忽略 */ }
    state.sessionOriginFocus = undefined;
  }
  state.backStack = [];
  closeModal(state);
}

/** 打开文件预览 Modal。 */
export function openPreview(
  state: FilePreviewState,
  path: string,
  cwd: string | undefined,
  isBack = false,
  prev?: NavEntry,
  frag?: string,
): void {
  ensureStyle();
  // issue #479：把相对入参 path 用会话 cwd 归并为绝对形态——md 渲染以
  // state.currentPath 作 basePath 解析文内相对引用，相对路径会令
  // resolveRelativePath 把首段解析为 host 而全军覆没；归一后 basePath 恒为
  // 绝对，下游（md 渲染 / 返回栈 / data-fp-cwd / fileUrl）天然正确。
  // 幂等：绝对形态 / 纯裸名 / 无 cwd 均原样返回（详见 relpath.normalizeBasePath）。
  path = normalizeBasePath(path, cwd);
  // issue #45：带 fragment 的文件引用（./f.md#g）——待定位锚点只随「前进打开」
  // 设置一次，md 首次渲染后消费；返回（isBack）不带锚点语义。
  // 注意：此处无条件赋值（含 undefined）是 pendingFrag 的唯一写入点之一，
  // closeModal 不得清理它——openPreview 内部先赋值后调 closeModal，清理会把
  // 本次锚点意图抹掉（实测踩坑）。
  state.pendingFrag = isBack ? undefined : (frag ?? undefined);
  // 返回栈：进入"新文件"（非返回触发、当前已有活跃 Modal、目标不同）→ 把当前
  // 文件与预览态快照压栈，供「← 返回」还原。返回触发（isBack）不再重复压栈；
  // 以 overlay !== undefined（当前是否已有打开的 Modal）判断"是否在浏览链内"，
  // 避免重开会话时（overlay 为 undefined）把上次残留路径误压栈。
  if (!isBack && state.overlay !== undefined && state.currentPath !== "" && state.currentPath !== path) {
    // issue #344：返回栈快照防御——超大 rawText/diffText 不入栈（仅存 path，返回时
    // 重新拉取），防 MAX_BACK=32 × 20M 常驻内存。rawText 长度超出阈值时整个快照
    // 退化为「仅路径」条目（返回分支按 rawText/diffText === undefined 重新拉取）。
    const rawLen = typeof state.rawText === "string" ? state.rawText.length : 0;
    const diffLen = typeof state.diffText === "string" ? state.diffText.length : 0;
    const keepRaw = textFitsSnapshot(rawLen);
    const keepDiff = textFitsSnapshot(diffLen);
    state.backStack.push({
      path: state.currentPath, cwd: state.currentCwd,
      previewMode: state.previewMode,
      rawText: keepRaw ? state.rawText : undefined,
      diffText: keepDiff ? state.diffText : undefined,
      diffUntracked: state.diffUntracked,
      // issue #344（评审 F2）：跳转前 Diff tab 是否已存在——基于「当时是否有 diff
      // 内容」判定（diffText 有值 或 未跟踪），与是否入栈（keepDiff）无关；返回时
      // 据此决定是否补一次 probeDiff（大 diff 未入栈时重探恢复）。
      hadDiff: (typeof state.diffText === "string" && state.diffText.length > 0) || state.diffUntracked,
      // issue #73：html 预览 token/src 快照——返回时 iframe 直接复用（免重新 alloc）
      serveToken: state.serveToken, serveSrc: state.serveSrc,
    });
    if (state.backStack.length > state.MAX_BACK) state.backStack.shift();
  }
  // a11y（评审 U11 / 返回栈 S3）：仅"首次打开"（当前无活跃 Modal）捕获触发元素，
  // 内跳/返回（overlay 已存在）不覆盖——确保整条浏览链关闭后焦点回到最初的文件链接。
  const firstOpen = state.overlay === undefined;
  if (firstOpen && !isBack) {
    state.sessionOriginFocus = (document.activeElement as HTMLElement | undefined) || undefined;
  }
  closeModal(state);
  // 本次预览的代数与取消句柄：所有 fetch 共用，落地前校验代数。
  const seq = ++state.openSeq;
  const abort = new AbortController();
  state.activeAbort = abort;

  const url = fileUrl(path, cwd, state);
  const group = renderGroupFor(path);
  state.currentGroup = group;
  // U8 v2：记录当前文件与会话 cwd（md 相对引用解析基 + Modal 内跳转）。
  state.currentPath = path;
  state.currentCwd = cwd;
  // issue #73：html 组默认「预览」tab（iframe sandbox），与 md/code 同语义。
  state.previewMode = group.group === "md" || group.group === "code" || group.group === "html" ? "preview" : "raw";
  state.rawText = undefined;
  state.diffText = undefined;
  state.diffUntracked = false;

  const body = el("div", { class: "fwp-body" });
  body.appendChild(el("div", { class: "fwp-state", text: t("loading") }));

  // 返回栈：顶栏「← 返回」按钮——栈非空才显示；点击弹出上一文件，用 isBack 重开
  //（openPreview 不再压栈），并按保存的快照还原预览态（tab/原文/diff 免重新拉取）。
  const backBtn = el("button", {
    class: "fwp-nav-back", text: t("navBack"),
    attrs: { "aria-label": t("navBackAria") },
  });
  backBtn.style.display = state.backStack.length > 0 ? "" : "none";
  backBtn.addEventListener("click", () => {
    const prevEntry = state.backStack.pop();
    if (prevEntry === undefined) { backBtn.style.display = "none"; return; }
    backBtn.style.display = state.backStack.length > 0 ? "" : "none";
    openPreview(state, prevEntry.path, prevEntry.cwd, true, prevEntry);
  });

  const copyBtn = el("button", { text: t("copyPath") });
  copyBtn.addEventListener("click", () => copyPathText(path, copyBtn));
  const newTabBtn = el("button", { text: t("openRawTab") });
  newTabBtn.addEventListener("click", () => { window.open(url, "_blank", "noopener"); });
  // issue #344：全屏按钮——置顶于关闭前，点击在全屏/视口放大降级态之间切换；
  // 全屏目标为父文档 overlay（非 iframe），文档级 fullscreenchange 同步按钮态。
  // 初始文案按能力探测设定（document.documentElement 作探针，requestFullscreen 挂
  // Element.prototype；overlay 此时尚未创建，用 documentElement 等价探测）。
  state.fsSupported = fullscreenSupported(document, document.documentElement as any);
  const fsBtn = el("button", {
    text: fullscreenLabel(false, state.fsSupported, t),
    attrs: { "aria-label": fullscreenLabel(false, state.fsSupported, t), title: fullscreenLabel(false, state.fsSupported, t) },
  });
  fsBtn.classList.add("fwp-fs-btn");
  fsBtn.addEventListener("click", () => toggleFullscreen(state, fsBtn));
  const closeBtn = el("button", { text: t("close") });
  closeBtn.addEventListener("click", () => finalizeSession(state, "close"));

  // 三态 tab 栏：预览 / 原始 / Diff（Diff 仅当 git 有变化时动态追加）。
  const tabs = el("div", { class: "fwp-tabs" });
  const tabDefs: Array<{ label: string; mode: "preview" | "raw" }> = [];
  if (group.group === "md" || group.group === "code" || group.group === "html") {
    // issue #73：html 组与 md/code 同三-tab（预览=iframe sandbox / 原始=/file 源码）。
    tabDefs.push({ label: t("tabPreview"), mode: "preview" }, { label: t("tabRaw"), mode: "raw" });
  }
  if (group.group === "text") {
    tabDefs.push({ label: t("tabContent"), mode: "raw" });
  }
  const syncTabActive = () => {
    for (const raw of Array.from(tabs.children)) {
      const b = raw as HTMLElement;
      b.classList.toggle("fwp-tab-active", b.dataset.mode === state.previewMode);
    }
  };
  let diffTab: any;
  const addDiffTab = () => {
    if (diffTab !== undefined) return;
    diffTab = el("button", { class: "fwp-tab", text: "Diff", attrs: { "data-mode": "diff" } });
    diffTab.addEventListener("click", () => {
      state.previewMode = "diff";
      syncTabActive();
      renderTabBody(body, state);
    });
    tabs.appendChild(diffTab);
    syncTabActive();
    // issue #344（评审 F3）：探测完成时若用户已在 diff 模式（返回恢复场景、大 diff
    // 重探后），立即用刚拉到的 diffText 重渲染正文，避免残留「无可用 diff」陈旧内容。
    if (state.previewMode === "diff") renderTabBody(body, state);
  };
  // 评审 U9：探测失败不再静默——tab 栏给出「Diff 不可用」禁用态，避免用户误以为
  // 「没有变化」；与「确实无 diff（不出现 tab）」区分开。
  let unavailableDiffTab: any;
  const addUnavailableDiffTab = () => {
    if (diffTab !== undefined || unavailableDiffTab !== undefined) return;
    unavailableDiffTab = el("button", {
      class: "fwp-tab fwp-tab-disabled",
      text: t("diffUnavailable"),
      disabled: true,
      title: t("diffProbeFail"),
    });
    tabs.appendChild(unavailableDiffTab);
  };
  for (const def of tabDefs) {
    const b = el("button", { class: "fwp-tab", text: def.label, attrs: { "data-mode": def.mode } });
    b.addEventListener("click", () => {
      state.previewMode = def.mode;
      syncTabActive();
      renderTabBody(body, state);
    });
    tabs.appendChild(b);
  }
  syncTabActive();

  const head = el("div", { class: "fwp-head" }, [
    el("div", { class: "fwp-title", text: path, attrs: { title: path } }),
    el("div", { class: "fwp-actions" }, [backBtn, copyBtn, newTabBtn, fsBtn, closeBtn]),
  ]);
  const card = el("div", { class: "fwp-card" }, [head, tabs, body]);
  // issue #388：卡片固定 id——宿主 dsh-web-mobile（≤1023px）的 [aria-modal] 对话框
  // 模板规则（带 !important，:has/:not 参数计入实为 (0,8,1)）会劫持本卡片的定位/
  // 尺寸并把 .fwp-title display:none，插件全屏态规则 (0,3,0) 打不过 →「点全屏整个
  // 预览框没全屏」。id (1,0,0) 稳压，配合 style.css 末尾「布局主权对轰块」恢复
  // 设计值。Modal 单例（state.overlay 同时刻至多一个，openPreview 先 closeModal
  // 后重建），id 随元素移除，卸载无需清理。
  card.id = "fwp-dialog-card";
  // a11y（评审 U11）：dialog 语义 + 打开聚焦 + Tab 陷阱配合 onKeyDown。
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", `预览：${path}`);
  card.setAttribute("tabindex", "-1");
  // 兜底内联：宿主环境可能不把注入样式表首部的 .fwp-overlay 规则纳入 CSSOM（position:fixed 失效，
  // Modal 会掉到对话框下方）；这里直接内联关键定位/遮罩/居中，确保任意访问形态都浮层居中弹出
  //（样式表正常解析时同值、互不冲突）。
  const ov: HTMLElement = el("div", { class: "fwp-overlay" });
  ov.setAttribute(
    "style",
    "position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(8,10,16,.45));display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif",
  );
  state.overlay = ov;
  ov.appendChild(card);
  ov.addEventListener("click", (event: any) => {
    // U8 v2（D1-b）：md 内相对链接 → Modal 内跳转预览（不新标签、不整页导航）。
    const targetEl = event.target instanceof Element ? (event.target as Element) : null;
    // issue #45：纯锚点（#section，rewriteAnchor 已标 data-fp-anchor）→ 拦截默认
    // hash 导航（不改 location.hash、SPA 路由不受扰），在 Modal 正文内平滑滚动定位。
    if (targetEl !== null) {
      let anchorLink: Element | null = null;
      try { anchorLink = targetEl.closest("a[data-fp-anchor]"); } catch { anchorLink = null; }
      if (anchorLink !== null && anchorLink !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        scrollToFragment(state.overlay, anchorLink.getAttribute("data-fp-anchor") ?? "");
        return;
      }
    }
    const link = targetEl === null ? null : targetEl.closest?.("a[data-fp-ref]");
    if (link !== null && link !== undefined) {
      const target = link.getAttribute("data-fp-ref");
      if (target !== null && target !== "") {
        event.preventDefault();
        event.stopPropagation();
        openPreview(
          state,
          target,
          link.getAttribute("data-fp-cwd") || state.currentCwd,
          false,
          undefined,
          link.getAttribute("data-fp-frag") || undefined,
        );
        return;
      }
    }
    if (event.target === ov) finalizeSession(state, "close");
  });
  document.addEventListener("keydown", onKeyDown);
  document.body.appendChild(ov);
  // a11y：焦点进入 Modal（role="dialog" 容器）。
  card.focus();
  // 锁背景滚动（评审 U1）：Modal 打开期间 iOS 触摸不会滚到背景页面，
  // 由 closeModal 还原；配合样式表 overscroll-behavior:contain。
  document.body.style.overflow = "hidden";

  if (group.group === "image") {
    renderImage(url, body, seq, abort.signal, state);
  } else if (group.group === "html") {
    // issue #73：html 组「预览」tab = serve 虚拟伺服 iframe；原始/Diff 仍走
    // fetchText/probeDiff（原始 tab 首次 fetch /file 时惰性拉取原文）。
    renderHtmlPreview(body, state, seq, abort.signal);
    probeDiff(path, cwd, seq, addDiffTab, addUnavailableDiffTab, abort.signal, state);
  } else if (isBack && prev !== undefined) {
    // 返回：直接用快照还原预览态（tab/原文/diff），免重新拉取、无闪烁。
    state.previewMode = prev.previewMode;
    state.rawText = prev.rawText;
    state.diffText = prev.diffText;
    state.diffUntracked = prev.diffUntracked ?? false;
    // issue #73：返回还原 html 预览 token/src 快照——iframe 直接复用（免重新 alloc）。
    state.serveToken = prev.serveToken;
    state.serveSrc = prev.serveSrc;
    // Diff tab 重建（评审 F2）：快照有 diffText/untracked → 直接重建；大 diff 未入栈
    //（hadDiff=true 且 diffText/diffUntracked 均缺）→ 补一次 probeDiff 重探，防止
    // 跳转前存在的 Diff 永久丢失（旧逻辑两者都漏，导致 diff tab 静默消失）。
    if (prev.diffText !== undefined || prev.diffUntracked) {
      addDiffTab();
    } else if (prev.hadDiff) {
      probeDiff(path, cwd, seq, addDiffTab, addUnavailableDiffTab, abort.signal, state);
    }
    syncTabActive();
    // issue #344：返回栈快照防御——大文件 rawText 未入栈（undefined）时不能直接
    // renderTabBody（会卡「加载中…」），改为重新拉取（与前进打开同一路径）。
    // 仅文本类分组（md/code/text）需要 rawText；image/html 走各自分支（html 预览
    // 用 iframe、rawText 本可为 undefined 由惰性拉取兜底），不在此干预。
    if (state.rawText === undefined && (group.group === "md" || group.group === "code" || group.group === "text")) {
      fetchText(url, body, seq, abort.signal, state);
      return;
    }
    renderTabBody(body, state);
  } else {
    fetchText(url, body, seq, abort.signal, state);
    probeDiff(path, cwd, seq, addDiffTab, addUnavailableDiffTab, abort.signal, state);
  }
}

/** 首次打开预览前的聚焦元素由 sessionOriginFocus 负责（评审 U11 / 返回栈 S3）。 */

/**
 * 键盘事件处理：Esc 关闭（灯箱优先），Tab 焦点陷阱。
 * 注意：作为 document 事件监听器，不接收 state 参数——通过闭包捕获。
 */
export function onKeyDown(this: any, event: KeyboardEvent): void {
  // onKeyDown 通过闭包捕获 state——由 apply 布线时绑定
  const state = (onKeyDown as any).__state as FilePreviewState | undefined;
  if (state === undefined) return;
  if (event.key === "Escape") {
    // issue #344：全屏态下第一次 Esc 只退出全屏（不关闭 Modal）——浏览器（Safari/
    // Firefox）会把 Esc keydown 派发给页面，本分支保证「先退全屏、再关」语义一致；
    // 原生全屏退出由 fullscreenchange 同步按钮态。
    if (shouldInterceptEscapeAsFullscreenExit(state.fsActive, event.key)) {
      state.fsActive = false;
      exitFullscreenQuiet(document);
      syncFullscreenState(state);
      return;
    }
    if (state.lboxEl !== undefined) closeLightbox(state);
    else finalizeSession(state, "close");
    return;
  }
  // Tab 焦点陷阱（评审 U11）：焦点在灯箱/Modal 内循环，不穿到背景页面。
  if (event.key !== "Tab") return;
  const container = state.lboxEl ?? state.overlay;
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