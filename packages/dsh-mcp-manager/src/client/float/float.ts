/**
 * dsh-mcp-manager — 客户端右上角浮窗。
 *
 * 浮窗胶囊（状态点 + 摘要计数）挂在会话滚动容器右上角，点击展开下拉面板
 * 展示项目/全局 MCP 服务器列表 + 快捷操作（连接/断开/禁用）。
 * 跨模块动作（showPanel / refresh）经 actions 注入，不直接引用 panel 模块。
 */

import { el, pangu } from "../core/dom.ts";
import { api, toolDisableServerKey, cwdQueryOf } from "../core/api.ts";
import { STATUS_ORDER, statusDot } from "../core/constants.ts";
import { tStatus } from "../core/i18n.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { McpClientContext, McpServerListEntry, McpState, UiActions } from "../core/state.ts";
import type { ClientUiConfig, FloatBreakpoint, ViewportPoint } from "../../shared/interface.ts";
import {
  DEFAULT_Z_INDEX_BASE,
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  panelAnchorForPosition,
  composerDockedAtBottom,
  bottomAnchorEdge,
} from "../../shared/interface.ts";

/** 重播 CSS animation：强制 reflow 后再挂 class。 */
function replayAnim(node: Element): void {
  const style = (node as HTMLElement).style;
  style.animation = "none";
  void (node as HTMLElement).offsetWidth;
  style.animation = "";
}

/** 胶囊状态点配色：失败红 / 有连接绿 / 否则中性灰（与历史三态一致）。 */
export function pillDotColor(fail: boolean, connected: number): string {
  if (fail) return "var(--dsw-alias-state-error-primary,#e0483e)";
  if (connected > 0) return "var(--dsw-alias-state-success-primary,#0f9d6e)";
  return "var(--dsw-alias-label-tertiary,#9aa1ad)";
}

/**
 * 胶囊的 title / aria-label：一台服务器都没有时不设（保留宿主默认 tooltip），
 * 有失败时追加失败计数，否则 aria 给出「已连/总数」（无总数时 title 保持朴素）。
 */
export function pillHints(
  total: number,
  bad: number,
  connected: number,
): { title: string; aria: string } {
  const failed = t("healthFailed", { n: bad });
  return {
    title: bad > 0 ? `${t("floatTitle")} · ${failed}` : t("floatTitle"),
    aria:
      bad > 0
        ? `${t("floatAriaLabel")} · ${failed}`
        : `${t("floatAriaLabel")} · ${connected}/${total}`,
  };
}

/** 渲染浮窗胶囊（状态点 + 摘要计数 + 失败/中性态）。 */
export function renderPill(state: McpState): void {
  if (state.floatPill === undefined) return;
  const ok = state.counts.connected ?? 0;
  const bad = (state.counts.failed ?? 0) + (state.counts.reconnecting ?? 0);
  const total = state.servers.length;
  const fail = bad > 0;
  state.floatPill.classList.toggle("dm-float--fail", fail);
  state.floatPill.textContent = "";
  state.floatPill.appendChild(
    el("span", { class: "dm-dot", style: `background:${pillDotColor(fail, ok)}` }),
  );
  if (fail) state.floatPill.appendChild(el("span", { class: "dm-float-fail", text: "!" }));
  state.floatPill.appendChild(el("span", { text: total > 0 ? `MCP ${ok}/${total}` : "MCP" }));
  if (total === 0) return;
  const hints = pillHints(total, bad, ok);
  state.floatPill.title = hints.title;
  state.floatPill.setAttribute("aria-label", hints.aria);
}

/**
 * 工具级禁用开关（PATCH /api/dsh-mcp/tool-disable）。
 * 语义（#362 交互拍板 2b）：折叠式 details 展开后 checkbox 列表，逐个启停；
 * 点击调宿主 API 持久化 + 刷新。单池（#767）后全部服务器（含全局）都经中间层，
 * 项目组与全局组一律渲染 checkbox。
 */
function toolCheckbox(
  server: McpServerListEntry,
  tool: string,
  disabled: boolean,
  state: McpState,
  actions: UiActions,
): HTMLElement {
  const label = el("label", { class: "dm-float-tool" });
  const input = el("input", {
    type: "checkbox",
    checked: disabled,
    dataset: { dshMcpTool: tool },
  });
  input.addEventListener("change", () => {
    // C6：全名形态经 toolDisableServerKey 归一（@@global/<name> 或 @<绝对路径>/<name>），
    // projectRoot 缺失时跳过提交（防御非法 @/name）。
    const serverKey = toolDisableServerKey(server, state);
    if (serverKey === undefined) {
      input.checked = !input.checked;
      console.warn("[dsh-mcp-manager] projectRoot 缺失，跳过 tool-disable（非法 @/name 防御）");
      return;
    }
    void api<unknown>(state.API.toolDisable, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: serverKey,
        tool,
        disabled: input.checked,
      }),
    })
      .then(() => actions.refresh())
      .catch((error: unknown) => {
        input.checked = !input.checked;
        console.warn("[dsh-mcp-manager] tool-disable failed:", error);
      });
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode(tool));
  return label;
}

/** 折叠式工具清单（方案 2b）：summary 显示「工具（N）」，展开后 checkbox 列表。
 * openTools：C8 折叠态恢复集合（渲染前由 renderFloatPanel 收集，按 server 名）。 */
function renderFloatTools(
  server: McpServerListEntry,
  state: McpState,
  actions: UiActions,
  openTools: Set<string>,
): HTMLElement {
  const tools = Array.isArray(server.tools) ? server.tools : [];
  const disabledSet = new Set(Array.isArray(server.disabledTools) ? server.disabledTools : []);
  const details = el("details", { class: "dm-float-tools", dataset: { dmServer: server.name } });
  if (openTools.has(server.name)) details.open = true;
  details.appendChild(el("summary", { text: t("toolsCount", { n: tools.length }) }));
  const list = el("div", { class: "dm-float-tool-list" });
  for (const tool of tools) {
    list.appendChild(toolCheckbox(server, tool, disabledSet.has(tool), state, actions));
  }
  details.appendChild(list);
  return details;
}

/** 操作主次：按 status 判定（可连接 → primary），不依赖文案字面量。 */
function floatActionClass(server: McpServerListEntry): string {
  if (server.status === "failed" || server.status === "stopped")
    return "dm-float-action dm-primary";
  return "dm-float-action";
}

/**
 * 一行上的动作描述：按钮外观 + 打到哪个口 + 请求形状 + 失败告警的稳定标识。
 * tag 是 console 文案用的动作名（与 i18n 文案解耦：翻界面不改日志）。
 */
interface RowAction {
  className: string;
  label: string;
  url: string;
  method: "POST" | "PATCH";
  tag: string;
  /** 只有 PATCH 动作带载荷（连接/断开是纯 POST，历史形状如此）。 */
  body?: string;
}

/** 主操作（每行恰好一个）：connected → 断开；disabled → 启用；其余 → 连接。 */
export function primaryRowAction(
  server: McpServerListEntry,
  state: McpState,
  cwdQuery: string,
): RowAction {
  const query = `name=${encodeURIComponent(server.name)}&scope=${server.scope}${cwdQuery}`;
  const className = floatActionClass(server);
  if (server.status === "connected") {
    return {
      className,
      label: t("disconnect"),
      url: `${state.API.disconnect}?${query}`,
      method: "POST",
      tag: "disconnect",
    };
  }
  if (server.status === "disabled") {
    return {
      className,
      label: t("enable"),
      url: `${state.API.servers}?${query}`,
      method: "PATCH",
      tag: "enable",
      body: JSON.stringify({ enabled: true }),
    };
  }
  return {
    className,
    label: t("connect"),
    url: `${state.API.connect}?${query}`,
    method: "POST",
    tag: "connect",
  };
}

/** 禁用动作（仅非 disabled 行有）：URL 不带 cwd（历史形状如此，勿补）。 */
export function disableRowAction(server: McpServerListEntry, state: McpState): RowAction {
  return {
    className: "dm-float-action",
    label: t("disable"),
    url: `${state.API.servers}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`,
    method: "PATCH",
    tag: "disable",
    body: JSON.stringify({ enabled: false }),
  };
}

/** 请求 init：带载荷的 PATCH 补 content-type；纯 POST 不带头（历史形状）。 */
export function rowRequestInit(action: RowAction): {
  method: string;
  headers?: Record<string, string>;
  body?: string;
} {
  if (action.body === undefined) return { method: action.method };
  return {
    method: action.method,
    headers: { "content-type": "application/json" },
    body: action.body,
  };
}

/** 动作按钮：点一下打口 → 成功后整面板刷新；失败只 warn（面板下次刷新自然回正）。 */
function rowActionButton(action: RowAction, actions: UiActions): HTMLElement {
  const button = el("button", { class: action.className });
  button.textContent = action.label;
  button.addEventListener("click", () => {
    void api<unknown>(action.url, rowRequestInit(action))
      .then(() => actions.refresh())
      .catch((error: unknown) => console.warn(`[dsh-mcp-manager] ${action.tag} failed:`, error));
  });
  return button;
}

/** 浮窗面板里的一行服务器。 */
function renderFloatRow(
  server: McpServerListEntry,
  state: McpState,
  actions: UiActions,
  opts: { tools: boolean; openTools?: Set<string>; stagger?: number } = { tools: true },
): HTMLElement {
  const failed = server.status === "failed" || server.status === "reconnecting";
  const row = el("div", {
    class: `dm-float-row${failed ? " dm-float-row--fail" : ""}${opts.stagger !== undefined ? " dm-stagger" : ""}`,
  });
  if (opts.stagger !== undefined) {
    row.style.animationDelay = `${Math.min(opts.stagger, 5) * 30}ms`;
  }
  row.appendChild(el("span", { class: "dm-dot", style: `background:${statusDot(server.status)}` }));
  row.appendChild(el("span", { class: "dm-float-name", text: server.name, title: server.name }));
  const tools = Array.isArray(server.tools) ? server.tools.length : 0;
  row.appendChild(
    el("span", {
      class: "dm-float-meta",
      text: pangu(t("serverMeta", { status: tStatus(server.status), tools })),
    }),
  );
  const actionsEl = el("div", { class: "dm-float-actions" });
  actionsEl.appendChild(
    rowActionButton(primaryRowAction(server, state, cwdQueryOf(state)), actions),
  );
  if (server.status !== "disabled") {
    actionsEl.appendChild(rowActionButton(disableRowAction(server, state), actions));
  }
  row.appendChild(actionsEl);
  if (opts.tools)
    row.appendChild(renderFloatTools(server, state, actions, opts.openTools ?? new Set()));
  return row;
}

/** 浮窗健康摘要（一行：运行/连接/失败）。 */
function renderFloatHealth(state: McpState): HTMLElement {
  const connected = state.counts.connected ?? 0;
  const connecting = (state.counts.connecting ?? 0) + (state.counts.reconnecting ?? 0);
  const failed = state.counts.failed ?? 0;
  const stopped = state.counts.stopped ?? 0;
  const parts: Node[] = [];
  parts.push(
    el("span", { class: "dm-health-ok", text: pangu(t("healthRunning", { n: connected })) }),
  );
  if (connecting > 0)
    parts.push(document.createTextNode(pangu(t("healthConnecting", { n: connecting }))));
  if (stopped > 0) parts.push(document.createTextNode(pangu(t("healthStopped", { n: stopped }))));
  if (failed > 0)
    parts.push(
      el("span", { class: "dm-health-bad", text: pangu(t("healthFailed", { n: failed })) }),
    );
  const line = el("div", { class: "dm-float-health" });
  parts.forEach((part, index) => {
    if (index > 0) line.appendChild(document.createTextNode(" · "));
    line.appendChild(part);
  });
  return line;
}

/**
 * 按状态分桶（桶序 = STATUS_ORDER，固定六态先建空桶）。未知状态归 stopped 桶——
 * 六态是唯一合法取值域，落到兜底桶而不是丢弃该行。
 */
export function bucketServersByStatus(
  list: McpServerListEntry[],
): Map<string, McpServerListEntry[]> {
  const byStatus = new Map<string, McpServerListEntry[]>();
  for (const group of STATUS_ORDER) byStatus.set(group.key, []);
  for (const server of list) {
    const bucket = byStatus.get(server.status) ?? byStatus.get("stopped");
    if (bucket !== undefined) bucket.push(server);
  }
  return byStatus;
}

/** 行级 stagger 序号：动画关闭返回 undefined（该行不加 dm-stagger、不进序）。 */
export function nextStagger(staggerBase: { n: number }, animate: boolean): number | undefined {
  if (!animate) return undefined;
  const current = staggerBase.n;
  staggerBase.n += 1;
  return current;
}

/** 按 scope 过滤并按状态序渲染一组服务器。 */
function appendScopeGroup(
  panel: Element,
  scope: string,
  list: McpServerListEntry[],
  state: McpState,
  actions: UiActions,
  openTools: Set<string>,
  staggerBase: { n: number },
  animateRows: boolean,
  titleOverride?: string,
  alert?: boolean,
): void {
  if (list.length === 0) return;
  const section = el("section", { class: "dm-float-group" });
  section.appendChild(
    el("div", {
      class: `dm-float-group-title${alert === true ? " dm-float-group-title--alert" : ""}`,
      text: titleOverride ?? (scope === "project" ? t("groupProject") : t("groupGlobal")),
    }),
  );
  const byStatus = bucketServersByStatus(list);
  for (const group of STATUS_ORDER) {
    const bucket = byStatus.get(group.key) ?? [];
    if (bucket.length === 0) continue;
    const ordered = [...bucket].sort((a: McpServerListEntry, b: McpServerListEntry) =>
      a.name.localeCompare(b.name),
    );
    for (const server of ordered) {
      section.appendChild(
        renderFloatRow(server, state, actions, {
          tools: true,
          openTools,
          stagger: nextStagger(staggerBase, animateRows),
        }),
      );
    }
  }
  panel.appendChild(section);
}

/** 浮窗标题的项目名：项目根末段；无项目根回落「全局会话」。 */
export function floatProjectName(state: McpState): string {
  const root = state.projectRoot;
  if (typeof root !== "string" || root === "") return t("floatGlobalSession");
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/** 收起浮窗并打开主面板（空态 CTA 与标题「管理」同动作）。 */
function openMainPanel(state: McpState, actions: UiActions): void {
  toggleFloat(state, actions, false);
  actions.showPanel();
}

/** 浮窗空态：一台服务器都没有时的说明 + 引导按钮。 */
function renderFloatEmpty(state: McpState, actions: UiActions): HTMLElement {
  const empty = el("div", { class: "dm-status" });
  empty.appendChild(el("div", { text: t("floatEmptyTitle") }));
  empty.appendChild(
    el("button", {
      class: "dm-float-action dm-primary",
      text: t("floatEmptyCta"),
      style: "margin-top:12px",
      onclick: () => openMainPanel(state, actions),
    }),
  );
  return empty;
}

/** 需要置顶提醒的服务器（失败 + 重连中）。 */
export function needsAttention(server: McpServerListEntry): boolean {
  return server.status === "failed" || server.status === "reconnecting";
}

/** 渲染浮窗下拉面板（健康摘要 + 失败优先 + scope 分组）。 */
export function renderFloatPanel(state: McpState, actions: UiActions): void {
  if (state.floatPanel === undefined) return;
  // C8：折叠态在重渲染前收集（details 重建会丢 open 属性）。
  const openTools = new Set<string>();
  for (const d of state.floatPanel.querySelectorAll<HTMLDetailsElement>("details.dm-float-tools")) {
    if (d.open && d.dataset.dmServer !== undefined) openTools.add(d.dataset.dmServer);
  }
  state.floatPanel.textContent = "";
  const head = el("div", { class: "dm-float-head" });
  const headText = el("div", { class: "dm-float-head-text" });
  headText.appendChild(el("div", { class: "dm-float-title", text: floatProjectName(state) }));
  headText.appendChild(renderFloatHealth(state));
  head.appendChild(headText);
  head.appendChild(
    el("button", { text: t("floatManage"), onclick: () => openMainPanel(state, actions) }),
  );
  state.floatPanel.appendChild(head);

  if (state.servers.length === 0) {
    state.floatPanel.appendChild(renderFloatEmpty(state, actions));
    if (state.floatOpen) placePanel(state);
    return;
  }

  const animateRows = state.floatPanel.dataset.dmStagger === "1";
  const staggerBase = { n: 0 };
  const attention = state.servers.filter(needsAttention);
  const rest = state.servers.filter((server: McpServerListEntry) => !needsAttention(server));
  appendScopeGroup(
    state.floatPanel,
    "attention",
    attention,
    state,
    actions,
    openTools,
    staggerBase,
    animateRows,
    t("groupAttention", { n: attention.length }),
    true,
  );
  for (const scope of ["project", "global"]) {
    appendScopeGroup(
      state.floatPanel,
      scope,
      rest.filter((server: McpServerListEntry) => server.scope === scope),
      state,
      actions,
      openTools,
      staggerBase,
      animateRows,
    );
  }
  delete state.floatPanel.dataset.dmStagger;
  if (state.floatOpen) placePanel(state);
}

/** 切换浮窗展开/收起（Apple Fluid：锚点→对角 scale；先渲染后定位）。 */
export function toggleFloat(state: McpState, actions: UiActions, force?: boolean): void {
  if (state.floatPanel === undefined) return;
  const next = force !== undefined ? force : !state.floatOpen;
  state.floatOpen = next;
  const panel = state.floatPanel;
  const pill = state.floatPill;
  if (next) {
    // F1：先渲染再定位。dataset 标记仅本次展开播行 stagger。
    panel.dataset.dmStagger = "1";
    panel.hidden = false;
    panel.classList.remove("dm-float-panel--closing", "dm-float-panel--open");
    renderFloatPanel(state, actions);
    placePanel(state);
    const armOpen = () => {
      if (!state.floatOpen) return;
      replayAnim(panel);
      panel.classList.add("dm-float-panel--open");
      pill?.classList.add("dm-float--open");
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(armOpen);
    else armOpen();
    panel.focus({ preventScroll: true });
    return;
  }
  pill?.classList.remove("dm-float--open");
  panel.classList.remove("dm-float-panel--open");
  const finish = () => {
    if (state.floatOpen) return;
    panel.classList.remove("dm-float-panel--closing");
    panel.hidden = true;
  };
  if (typeof requestAnimationFrame === "function") {
    replayAnim(panel);
    panel.classList.add("dm-float-panel--closing");
    window.setTimeout(finish, 300);
  } else {
    finish();
  }
}

/** 水平锚点判定：left-* 贴左缘，其余贴右缘（胶囊与面板共用同一口径）。 */
export function anchorsLeft(position: string | undefined): boolean {
  return position === "top-left" || position === "bottom-left";
}

/** Fluid 展开原点：锚点所在的那个角（胶囊贴边角 → 面板向对角展开）。 */
export function transformOriginFor(isLeft: boolean, anchorBottom: boolean): string {
  if (anchorBottom) return isLeft ? "bottom left" : "bottom right";
  return isLeft ? "top left" : "top right";
}

/** 下拉面板定位（fixed 跟随胶囊，避免被滚动容器裁剪；四角感知 + 视口终 clamp）。 */
export function placePanel(state: McpState): void {
  if (state.floatPill === undefined || state.floatPanel === undefined) return;
  const pillRect = state.floatPill.getBoundingClientRect();
  if (pillRect.width === 0 && pillRect.height === 0) return;
  const panel = state.floatPanel;
  const position = state.mcpUiConfig?.position;
  const anchorBottom = panelAnchorForPosition(position) === "bottom";
  const isLeft = anchorsLeft(position);
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
    rawLeft,
    rawTop,
    panel.offsetWidth,
    panel.offsetHeight,
    window.innerWidth,
    window.innerHeight,
  );
  panel.style.left = `${Math.round(point.x)}px`;
  panel.style.top = `${Math.round(point.y)}px`;
  panel.style.right = "auto";
  panel.style.transformOrigin = transformOriginFor(isLeft, anchorBottom);
}

/** 会话滚动容器：聊天消息实际滚动的区域（shell 的 data-conversation-scroll）。 */
export function conversationHost(): Element {
  return (
    document.querySelector("[data-conversation-scroll]") ??
    document.querySelector('[data-pane="conversation"]') ??
    document.querySelector(".pI_x6G_centerCol") ??
    document.body
  );
}

/** 全局 overlay 层：下拉面板挂这里（fixed 定位，避免被滚动容器裁剪）。 */
export function panelHost(): Element {
  return document.querySelector("[data-shell-overlay]") ?? document.body;
}

/** 当前会话是否空白会话（空白会话用另一档垂直偏移）。取不到会话面一律判非空白。 */
export function isBlankSession(ctx: McpClientContext): boolean {
  const snap = ctx?.sessions?.list?.getSnapshot?.();
  const current = snap?.current;
  if (current === undefined) return false;
  return snap?.byId?.[current]?.blank === true;
}

/** 从 settings.yaml 读取的配置决定新/老会话垂直偏移。 */
export function floatTopOffset(ctx: McpClientContext, state: McpState): number {
  const cfg = state.mcpUiConfig || {};
  const y = typeof cfg.offsetY === "number" ? cfg.offsetY : 8;
  const blankY = typeof cfg.blankY === "number" ? cfg.blankY : y;
  return isBlankSession(ctx) ? blankY : y;
}

/** 胶囊位置配置白名单：只认四个锚点，其余（含缺省）回落 top-right（历史行为）。 */
export function floatPositionOf(cfg: ClientUiConfig): ClientUiConfig["position"] {
  const position = cfg.position;
  if (position === "top-left" || position === "bottom-right" || position === "bottom-left")
    return position;
  return "top-right";
}

/** 胶囊定位入参（锚点 + 偏移）：位置白名单归一、水平偏移缺省 8、垂直偏移按会话形态。 */
export function pillAnchors(
  cfg: ClientUiConfig,
  ctx: McpClientContext,
  state: McpState,
): { isLeft: boolean; isBottom: boolean; offsetX: number; offsetY: number } {
  const position = floatPositionOf(cfg);
  return {
    isLeft: anchorsLeft(position),
    isBottom: panelAnchorForPosition(position) === "bottom",
    offsetX: typeof cfg.offsetX === "number" ? cfg.offsetX : 8,
    offsetY: floatTopOffset(ctx, state),
  };
}

/** 底部锚点是否改用 composer seat 上缘当下边界（#128：仅非 wide 断点）。 */
export function usesComposerSeat(isBottom: boolean, bp: FloatBreakpoint): boolean {
  return isBottom && bp !== "wide";
}

/** 底部锚点的容器下边界：composer seat 贴底时改用 seat 上缘（胶囊上移到输入区上方）。 */
export function dockedBottomEdge(containerRect: { top: number; bottom: number }): number {
  const seat = document.querySelector<HTMLElement>("[data-composer-seat]");
  const seatRect = seat !== null ? seat.getBoundingClientRect() : null;
  return bottomAnchorEdge(
    containerRect.bottom,
    seatRect?.top ?? null,
    composerDockedAtBottom(seatRect, containerRect),
  );
}

/** 胶囊定位纯计算的入参（DOM 读口在调用面，坐标算式在这里，可直测）。 */
interface PillPlacementInput {
  rect: { top: number; bottom: number; left: number; right: number };
  width: number;
  height: number;
  isLeft: boolean;
  isBottom: boolean;
  offsetX: number;
  offsetY: number;
  /** 底部锚点下边界（已含 composer seat 改写，见 dockedBottomEdge）。 */
  bottomEdge: number;
  viewportW: number;
  viewportH: number;
}

/**
 * 胶囊终坐标（纯计算）：水平按锚点贴容器左右缘、垂直按锚点（bottom 从下边界上推、
 * clamp 到视口上缘；top 从容器顶下移），最后统一走视口 clamp。
 */
export function pillPlacement(input: PillPlacementInput): ViewportPoint {
  const rawLeft = input.isLeft
    ? input.rect.left + input.offsetX
    : input.rect.right - input.width - input.offsetX;
  const rawTop = input.isBottom
    ? Math.max(6, input.bottomEdge - input.height - input.offsetY)
    : input.rect.top + input.offsetY;
  return clampPointToViewport(
    rawLeft,
    rawTop,
    input.width,
    input.height,
    input.viewportW,
    input.viewportH,
  );
}

/**
 * 挂载浮窗：胶囊继续挂在会话滚动容器（scrollBody）内并钉住右上角，下拉面板
 * fixed 跟随。返回 disposer 函数。
 */
export function mountFloat(ctx: McpClientContext, state: McpState, actions: UiActions): () => void {
  const pill = el("button", {
    type: "button",
    class: "dm-float",
    "aria-label": t("floatAriaLabel"),
    title: t("floatTitle"),
  });
  pill.dataset.dshMcpFloat = "";
  pill.addEventListener("click", () => toggleFloat(state, actions));
  const panel = el("div", { class: "dm-float-panel", role: "dialog" });
  panel.hidden = true;
  panel.tabIndex = -1;
  state.floatPill = pill;
  state.floatPanel = panel;
  // 胶囊挂会话滚动容器，下拉面板挂 shell.overlay（fixed 定位，仍与通知同一层）。
  const panelRoot = panelHost();
  if (panel.parentElement !== panelRoot) panelRoot.appendChild(panel);

  // 失去焦点后自动关闭：焦点离开胶囊/面板时收起下拉框。
  const onFocusOut = (event: FocusEvent) => {
    if (!state.floatOpen) return;
    const next = event.relatedTarget as Node | null;
    if (next !== null && (state.floatPanel?.contains(next) || state.floatPill?.contains(next)))
      return;
    toggleFloat(state, actions, false);
  };
  document.addEventListener("focusout", onFocusOut);
  // Esc 关闭下拉面板（与模态 panel.ts C4 同语义；具名函数配对清理防泄漏）。
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && state.floatOpen) toggleFloat(state, actions, false);
  };
  document.addEventListener("keydown", onKeyDown);

  let host: Element | null | undefined;

  /**
   * 按 settings.yaml 配置把胶囊定位到对话容器四角之一（双轴：left/right × top/bottom）。
   * 同时：按会话容器宽度判定断点档位写 data 属性（CSS 按档位切换触控/布局样式）、
   * 应用层级基准（胶囊与主面板同取配置值）、终坐标视口 clamp。
   */
  const updateFloat = () => {
    const best = conversationHost();
    if (best === null || best === undefined) return;
    const rect = best.getBoundingClientRect();
    const cfg = state.mcpUiConfig || {};
    // 断点判定基准 = conversationHost rect 宽度（JS 判定，非纯 @media——
    // 防桌面窄窗 / iPad Slide Over 误触发）；data 属性驱动 CSS 档位样式。
    const bp = breakpointForWidth(rect.width);
    if (pill.dataset.dmBp !== bp) pill.dataset.dmBp = bp;
    if (panel.dataset.dmBp !== bp) panel.dataset.dmBp = bp;
    // 层级：胶囊与点击后弹出的主面板 computed z-index 一律取配置基准（clamp 1-9000），
    // 不再派生 +30（维护者 2026-08-28 要求 #128，B2）；面板内子浮层可派生见 panelZIndexFor。
    const zBase = clampZIndexBase(cfg.zIndexBase, DEFAULT_Z_INDEX_BASE);
    pill.style.zIndex = String(zBase);
    panel.style.zIndex = String(zBase);
    const anchors = pillAnchors(cfg, ctx, state);
    pill.style.position = "fixed";
    // 垂直：bottom 锚点 → 下边界 - 高 - y（clamp 到视口上缘防溢出）；top 锚点 → 容器顶 + y。
    // #128 重开回归修复：bottom-* 在断点非 wide 且 composer seat 贴底时，下边界换成
    // seat.top（胶囊上移到输入区上方，避免遮挡输入卡片/底部状态条）；否则维持
    // container.bottom（桌面零回归）。水平：left 锚点 → 容器左缘 + offsetX；
    // right 锚点 → 容器右缘 - 宽 - offsetX。两者算式都在 pillPlacement 里。
    const bottomEdge = usesComposerSeat(anchors.isBottom, bp)
      ? dockedBottomEdge(rect)
      : rect.bottom;
    const point = pillPlacement({
      rect,
      width: pill.offsetWidth,
      height: pill.offsetHeight,
      ...anchors,
      bottomEdge,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    });
    pill.style.left = `${Math.round(point.x)}px`;
    pill.style.top = `${Math.round(point.y)}px`;
    pill.style.right = "auto";
    if (state.floatOpen) placePanel(state);
  };
  state.updateFloatState = updateFloat;

  const listeners: (() => void)[] = [];

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
  const onOrientationChange = () => {
    scheduleUpdate();
  };

  /** 软键盘弹出/收起：visualViewport resize 监听（iOS 13+ 全支持），fixed 元素跟随视口。 */
  const onVisualViewportResize = () => {
    scheduleUpdate();
  };

  const attachListeners = (target: Element) => {
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
    document.removeEventListener("keydown", onKeyDown);
    observer.disconnect();
    for (const detach of listeners.splice(0)) detach();
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (observerRafId !== 0) {
      cancelAnimationFrame(observerRafId);
      observerRafId = 0;
    }
    pill.remove();
    panel.remove();
    state.floatPill = undefined;
    state.floatPanel = undefined;
    state.floatOpen = false;
  };
}
