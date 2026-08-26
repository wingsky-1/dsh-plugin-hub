/**
 * dsh-mcp-manager — 客户端右上角浮窗。
 *
 * 浮窗胶囊（状态点 + 摘要计数）挂在会话滚动容器右上角，点击展开下拉面板
 * 展示项目/全局 MCP 服务器列表 + 快捷操作（连接/断开/禁用）。
 * 跨模块动作（showPanel / refresh）经 actions 注入，不直接引用 panel 模块。
 */

import { el, api } from "./dom.js";
import { STATUS_ORDER, STATUS_TEXT, statusDot } from "./constants.js";
import type { McpState, UiActions } from "./state.js";
import {
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  panelAnchorForPosition,
  panelZIndexFor,
} from "../placement-math.js";

/** 渲染浮窗胶囊（状态点 + 摘要计数）。 */
export function renderPill(state: McpState): void {
  if (state.floatPill === undefined) return;
  const ok = state.counts.connected ?? 0;
  const bad = (state.counts.failed ?? 0) + (state.counts.reconnecting ?? 0);
  const dot = bad > 0
    ? "var(--dsw-alias-state-error-primary,#e0483e)"
    : ok > 0
      ? "var(--dsw-alias-state-success-primary,#0f9d6e)"
      : "var(--dsw-alias-label-tertiary,#9aa1ad)";
  const label = state.servers.length > 0 ? `MCP ${ok}/${state.servers.length}` : "MCP";
  state.floatPill.innerHTML = `<span class="dm-dot" style="background:${dot}"></span><span>${label}</span>`;
}

/** 浮窗面板里的一行服务器。 */
function renderFloatRow(server: any, state: McpState, actions: UiActions): any {
  const row = el("div", { class: "dm-float-row" });
  row.appendChild(el("span", { class: "dm-dot", style: `background:${statusDot(server.status)}` }));
  row.appendChild(el("span", { class: "dm-float-name", text: server.name, title: server.name }));
  const tools = Array.isArray(server.tools) ? server.tools.length : 0;
  row.appendChild(el("span", { class: "dm-float-meta", text: `${STATUS_TEXT[server.status] ?? server.status} · ${tools} 工具` }));
  const actionsEl = el("div", { class: "dm-float-actions" });
  const action = el("button", { class: "dm-float-action" });
  if (server.status === "connected") {
    action.textContent = "断开";
    action.addEventListener("click", () => {
      void api(`${state.API.disconnect}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, { method: "POST" })
        .then(() => actions.refresh())
        .catch((error: any) => console.warn("[dsh-mcp-manager] disconnect failed:", error));
    });
  } else if (server.status === "disabled") {
    action.textContent = "启用";
    action.addEventListener("click", () => {
      void api(`${state.API.servers}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }).then(() => actions.refresh())
        .catch((error: any) => console.warn("[dsh-mcp-manager] enable failed:", error));
    });
  } else {
    action.textContent = "连接";
    action.addEventListener("click", () => {
      void api(`${state.API.connect}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, { method: "POST" })
        .then(() => actions.refresh())
        .catch((error: any) => console.warn("[dsh-mcp-manager] connect failed:", error));
    });
  }
  actionsEl.appendChild(action);
  // 禁用开关：非 disabled 状态可一键禁用（PATCH enabled:false → 宿主断开并注销工具）
  if (server.status !== "disabled") {
    const disable = el("button", { class: "dm-float-action" });
    disable.textContent = "禁用";
    disable.addEventListener("click", () => {
      void api(`${state.API.servers}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }).then(() => actions.refresh())
        .catch((error: any) => console.warn("[dsh-mcp-manager] disable failed:", error));
    });
    actionsEl.appendChild(disable);
  }
  row.appendChild(actionsEl);
  return row;
}

/** 渲染浮窗下拉面板（项目/全局分组 + 状态 + 快捷操作）。 */
export function renderFloatPanel(state: McpState, actions: UiActions): void {
  if (state.floatPanel === undefined) return;
  state.floatPanel.textContent = "";
  const head = el("div", { class: "dm-float-head" });
  const projectName = typeof state.projectRoot === "string" && state.projectRoot !== ""
    ? (state.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? state.projectRoot)
    : "全局会话";
  head.appendChild(el("span", { class: "dm-float-title", text: projectName }));
  head.appendChild(el("button", { text: "管理", onclick: () => { toggleFloat(state, actions, false); actions.showPanel(); } }));
  state.floatPanel.appendChild(head);

  if (state.servers.length === 0) {
    state.floatPanel.appendChild(el("div", { class: "dm-status", text: "没有 MCP 服务器，点「管理」添加" }));
    return;
  }
  for (const scope of ["project", "global"]) {
    const list = state.servers.filter((server: any) => server.scope === scope);
    if (list.length === 0) continue;
    const section = el("section", { class: "dm-float-group" });
    section.appendChild(el("div", { class: "dm-float-group-title", text: scope === "project" ? "项目级" : "全局" }));
    for (const server of [...list].sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      section.appendChild(renderFloatRow(server, state, actions));
    }
    state.floatPanel.appendChild(section);
  }
}

/** 切换浮窗展开/收起。 */
export function toggleFloat(state: McpState, actions: UiActions, force?: boolean): void {
  if (state.floatPanel === undefined) return;
  const next = force !== undefined ? force : !state.floatOpen;
  state.floatOpen = next;
  state.floatPanel.hidden = !next;
  if (next) {
    placePanel(state);
    renderFloatPanel(state, actions);
    // 聚焦面板本身，让后续点击外部时能通过 focusout 自动关闭。
    state.floatPanel.focus({ preventScroll: true });
  }
}

/** 下拉面板定位（fixed 跟随胶囊，避免被滚动容器裁剪；四角感知 + 视口终 clamp）。 */
export function placePanel(state: McpState): void {
  if (state.floatPill === undefined || state.floatPanel === undefined) return;
  const pillRect = state.floatPill.getBoundingClientRect();
  if (pillRect.width === 0 && pillRect.height === 0) return;
  const panel = state.floatPanel;
  const position = state.mcpUiConfig?.position;
  const anchorBottom = panelAnchorForPosition(position) === "bottom";
  const isLeft = position === "top-left" || position === "bottom-left";
  const gap = 6;
  // 垂直：底部锚点向上弹出（clamp 到视口上缘）/ 顶部锚点向下弹出（历史行为）。
  const rawTop = anchorBottom
    ? Math.max(6, pillRect.top - panel.offsetHeight - gap)
    : Math.max(6, pillRect.bottom + gap);
  // 水平：left 锚点面板左缘贴胶囊左缘；right 锚点面板右缘贴胶囊右缘
  // （等价换算为 left 后统一处理，保持与旧 right 定位相同的视觉结果）。
  const rawLeft = isLeft
    ? Math.max(10, Math.round(pillRect.left))
    : Math.max(10, Math.round(pillRect.right - panel.offsetWidth));
  // 终坐标视口 clamp（safe-area 语义：宿主无 viewport-fit=cover → inset 恒 0，
  // 自然退化为普通 clamp，桌面行为不回归）。
  const point = clampPointToViewport(
    rawLeft, rawTop, panel.offsetWidth, panel.offsetHeight,
    window.innerWidth, window.innerHeight,
  );
  panel.style.left = `${Math.round(point.x)}px`;
  panel.style.top = `${Math.round(point.y)}px`;
  panel.style.right = "auto";
}

/** 会话滚动容器：聊天消息实际滚动的区域（shell 的 data-conversation-scroll）。 */
export function conversationHost(): any {
  return document.querySelector('[data-conversation-scroll]')
    ?? document.querySelector('[data-pane="conversation"]')
    ?? document.querySelector('.pI_x6G_centerCol')
    ?? document.body;
}

/** 全局 overlay 层：下拉面板挂这里（fixed 定位，避免被滚动容器裁剪）。 */
export function panelHost(): any {
  return document.querySelector('[data-shell-overlay]')
    ?? document.body;
}

/** 从 settings.yaml 读取的配置决定新/老会话垂直偏移。 */
export function floatTopOffset(ctx: any, state: McpState): number {
  const snap = ctx?.sessions?.list?.getSnapshot?.();
  const current = snap?.current;
  const session = current === undefined ? undefined : snap?.byId?.[current];
  const blank = session?.blank === true;
  const cfg = state.mcpUiConfig || {};
  const y = typeof cfg.offsetY === "number" ? cfg.offsetY : 8;
  const blankY = typeof cfg.blankY === "number" ? cfg.blankY : y;
  return blank ? blankY : y;
}

/**
 * 挂载浮窗：胶囊继续挂在会话滚动容器（scrollBody）内并钉住右上角，下拉面板
 * fixed 跟随。返回 disposer 函数。
 */
export function mountFloat(ctx: any, state: McpState, actions: UiActions): () => void {
  const pill = el("button", {
    type: "button",
    class: "dm-float",
    "aria-label": "MCP 管理器",
    title: "MCP 管理器（点击展开）",
  });
  pill.dataset.dshMcpFloat = "";
  pill.addEventListener("click", () => toggleFloat(state, actions));
  const panel = el("div", { class: "dm-float-panel" });
  panel.hidden = true;
  panel.tabIndex = -1;
  state.floatPill = pill;
  state.floatPanel = panel;
  // 胶囊挂会话滚动容器，下拉面板挂 shell.overlay（fixed 定位，仍与通知同一层）。
  const panelRoot = panelHost();
  if (panel.parentElement !== panelRoot) panelRoot.appendChild(panel);

  // 失去焦点后自动关闭：焦点离开胶囊/面板时收起下拉框。
  const onFocusOut = (event: any) => {
    if (!state.floatOpen) return;
    const next = event.relatedTarget as Node | null;
    if (next !== null && (state.floatPanel?.contains(next) || state.floatPill?.contains(next))) return;
    toggleFloat(state, actions, false);
  };
  document.addEventListener("focusout", onFocusOut);

  let host: any;

  /**
   * 按 settings.yaml 配置把胶囊定位到对话容器四角之一（双轴：left/right × top/bottom）。
   * 同时：按会话容器宽度判定断点档位写 data 属性（CSS 按档位切换触控/布局样式）、
   * 应用层级基准（胶囊 base、面板派生 +30）、终坐标视口 clamp。
   */
  const updateFloat = () => {
    const best = conversationHost();
    if (best === null || best === undefined) return;
    const rect = best.getBoundingClientRect();
    const cfg = state.mcpUiConfig || {};
    const position = ["top-left", "bottom-right", "bottom-left"].includes(cfg.position)
      ? cfg.position
      : "top-right";
    // 断点判定基准 = conversationHost rect 宽度（JS 判定，非纯 @media——
    // 防桌面窄窗 / iPad Slide Over 误触发）；data 属性驱动 CSS 档位样式。
    const bp = breakpointForWidth(rect.width);
    if (pill.dataset.dmBp !== bp) pill.dataset.dmBp = bp;
    if (panel.dataset.dmBp !== bp) panel.dataset.dmBp = bp;
    // 层级：胶囊取配置基准（clamp 1-9000），下拉面板派生基准+30。
    const zBase = clampZIndexBase(cfg.zIndexBase, 10);
    pill.style.zIndex = String(zBase);
    panel.style.zIndex = String(panelZIndexFor(zBase));
    const isBottom = position === "bottom-right" || position === "bottom-left";
    const isLeft = position === "top-left" || position === "bottom-left";
    const offsetX = typeof cfg.offsetX === "number" ? cfg.offsetX : 8;
    const y = floatTopOffset(ctx, state);
    pill.style.position = "fixed";
    // 水平：left 锚点 → 容器左缘 + offsetX；right 锚点 → 容器右缘 - 宽 - offsetX。
    const rawLeft = isLeft
      ? rect.left + offsetX
      : rect.right - pill.offsetWidth - offsetX;
    // 垂直：bottom 锚点 → 容器底 - 高 - y（clamp 到视口上缘防溢出）；top 锚点 → 容器顶 + y。
    const rawTop = isBottom
      ? Math.max(6, rect.bottom - pill.offsetHeight - y)
      : rect.top + y;
    // 终坐标视口 clamp（safe-area 语义；inset 缺省 0 自然退化，桌面行为不回归）。
    const point = clampPointToViewport(
      rawLeft, rawTop, pill.offsetWidth, pill.offsetHeight,
      window.innerWidth, window.innerHeight,
    );
    pill.style.left = `${Math.round(point.x)}px`;
    pill.style.top = `${Math.round(point.y)}px`;
    pill.style.right = "auto";
    if (state.floatOpen) placePanel(state);
  };
  state.updateFloatState = updateFloat;

  let listeners: any[] = [];

  /** rAF 合并调度：同帧多次 scroll/resize/vv-resize 只重算一次（#128 第 7 条）。 */
  let rafId = 0;
  const scheduleUpdate = () => {
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      updateFloat();
    });
  };

  /** orientationchange 后延迟一帧重算：横竖屏切换瞬间 rect 尚未更新（规格第 2 条）。 */
  const onOrientationChange = () => { scheduleUpdate(); };

  /** 软键盘弹出/收起：visualViewport resize 监听（iOS 13+ 全支持），fixed 元素跟随视口。 */
  const onVisualViewportResize = () => { scheduleUpdate(); };

  const attachListeners = (target: any) => {
    for (const detach of listeners.splice(0)) detach();
    target.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("orientationchange", onOrientationChange);
    window.visualViewport?.addEventListener("resize", onVisualViewportResize);
    listeners.push(() => {
      target.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("orientationchange", onOrientationChange);
      window.visualViewport?.removeEventListener("resize", onVisualViewportResize);
    });
    updateFloat();
  };

  /**
   * 放置/迁移：每次调用都重新求最佳宿主（scrollBody 优先），胶囊跟着它走——
   * 即使初始化时 scrollBody 尚未渲染（退回 body），一旦出现就迁移。
   */
  const place = () => {
    const best = conversationHost();
    if (best === null || best === undefined) return false;
    if (host !== best || pill.parentElement !== best) {
      host = best;
      if (pill.parentElement !== null) pill.remove();
      best.appendChild(pill);
      attachListeners(best);
    }
    return true;
  };
  // MutationObserver 去抖：宿主 DOM 批量变更（会话切换渲染多帧）合并到一帧处理，
  // 避免高频 childList 变更下 place()/updateFloat() 空转（#128 第 7 条）。
  let observerRafId = 0;
  const schedulePlace = () => {
    if (observerRafId !== 0) return;
    observerRafId = requestAnimationFrame(() => {
      observerRafId = 0;
      place();
    });
  };
  const observer = new MutationObserver(schedulePlace);
  if (place()) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    const wait = new MutationObserver(() => {
      if (place()) {
        wait.disconnect();
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    wait.observe(document.body, { childList: true, subtree: true });
  }
  renderPill(state);
  return () => {
    state.updateFloatState = undefined;
    document.removeEventListener("focusout", onFocusOut);
    observer.disconnect();
    for (const detach of listeners.splice(0)) detach();
    if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
    if (observerRafId !== 0) { cancelAnimationFrame(observerRafId); observerRafId = 0; }
    pill.remove();
    panel.remove();
    state.floatPill = undefined;
    state.floatPanel = undefined;
    state.floatOpen = false;
  };
}