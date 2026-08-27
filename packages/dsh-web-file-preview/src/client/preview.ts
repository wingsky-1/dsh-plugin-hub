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

/** 文件预览 URL（F2-B）。 */
export function fileUrl(path: string, cwd: string | undefined, state: FilePreviewState): string {
  const params = new URLSearchParams();
  if (cwd !== undefined && cwd !== "") params.set("cwd", cwd);
  params.set("path", path);
  return `${state.API.file}?${params.toString()}`;
}

/** 关闭 Modal 并清理资源（导航式重建用，不清栈、不动焦点）。 */
export function closeModal(state: FilePreviewState): void {
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
  // issue #104：清空 mermaid hydration 注册表（旧 Modal 的已渲染块引用不跨
  // Modal 残留；在途重渲染由 openSeq 代数校验自行中止，见 mermaid.ts）。
  state.activeMermaidHydration = undefined;
  // 还原背景滚动（与 openPreview 的 body 锁配对，评审 U1）。
  document.body.style.overflow = "";
  // 注：焦点还原 / 返回栈清空不在此处——这是导航式重建（openPreview 内调用）与
  // 终态关闭共用的"资源清理"函数；焦点还原与栈复位放在 finalizeSession()（终态入口）。
}

/**
 * 终态关闭：还原焦点到首次触发元素、清空返回栈，再走 closeModal 清理资源。
 * 只在真正的关闭语义入口调用（关闭按钮 / 遮罩 / Esc 非灯箱 / 插件卸载），
 * 与 openPreview 内部的导航式重建（closeModal 不清栈、不动焦点）区分开来。
 */
export function finalizeSession(state: FilePreviewState, reason: "close" | "unmount"): void {
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
    state.backStack.push({
      path: state.currentPath, cwd: state.currentCwd,
      previewMode: state.previewMode, rawText: state.rawText,
      diffText: state.diffText, diffUntracked: state.diffUntracked,
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
  state.previewMode = group.group === "md" || group.group === "code" ? "preview" : "raw";
  state.rawText = undefined;
  state.diffText = undefined;
  state.diffUntracked = false;

  const body = el("div", { class: "fwp-body" });
  body.appendChild(el("div", { class: "fwp-state", text: "加载中…" }));

  // 返回栈：顶栏「← 返回」按钮——栈非空才显示；点击弹出上一文件，用 isBack 重开
  //（openPreview 不再压栈），并按保存的快照还原预览态（tab/原文/diff 免重新拉取）。
  const backBtn = el("button", {
    class: "fwp-nav-back", text: "← 返回",
    attrs: { "aria-label": "返回上一个预览" },
  });
  backBtn.style.display = state.backStack.length > 0 ? "" : "none";
  backBtn.addEventListener("click", () => {
    const prevEntry = state.backStack.pop();
    if (prevEntry === undefined) { backBtn.style.display = "none"; return; }
    backBtn.style.display = state.backStack.length > 0 ? "" : "none";
    openPreview(state, prevEntry.path, prevEntry.cwd, true, prevEntry);
  });

  const copyBtn = el("button", { text: "复制路径" });
  copyBtn.addEventListener("click", () => copyPathText(path, copyBtn));
  const newTabBtn = el("button", { text: "在新标签打开原文" });
  newTabBtn.addEventListener("click", () => { window.open(url, "_blank", "noopener"); });
  const closeBtn = el("button", { text: "关闭" });
  closeBtn.addEventListener("click", () => finalizeSession(state, "close"));

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
      state.previewMode = def.mode;
      syncTabActive();
      renderTabBody(body, state);
    });
    tabs.appendChild(b);
  }
  syncTabActive();

  const head = el("div", { class: "fwp-head" }, [
    el("div", { class: "fwp-title", text: path, attrs: { title: path } }),
    el("div", { class: "fwp-actions" }, [backBtn, copyBtn, newTabBtn, closeBtn]),
  ]);
  const card = el("div", { class: "fwp-card" }, [head, tabs, body]);
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
  } else if (isBack && prev !== undefined) {
    // 返回：直接用快照还原预览态（tab/原文/diff），免重新拉取、无闪烁。
    state.previewMode = prev.previewMode;
    state.rawText = prev.rawText;
    state.diffText = prev.diffText;
    state.diffUntracked = prev.diffUntracked ?? false;
    // Diff tab 在跳转前可能已被探测/添加；返回时按其 snapshot 状态重建 tab 栏。
    if (prev.diffText !== undefined || prev.diffUntracked) addDiffTab();
    syncTabActive();
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