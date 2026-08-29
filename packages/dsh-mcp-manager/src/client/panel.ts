/**
 * dsh-mcp-manager — 客户端模态面板生命周期。
 *
 * 面板的打开/关闭/tab 切换/数据刷新。
 * 跨模块渲染（renderServers / buildQuickAdd / renderPill / renderFloatPanel）
 * 直接 import 用到的模块——本模块是 feature 模块的汇聚点，构成单向依赖图：
 * panel → servers / quick-add / float。
 */

import { el, api } from "./dom.ts";
import type { McpState, UiActions } from "./state.ts";
import { renderServers } from "./servers.ts";
import { buildQuickAdd } from "./quick-add.ts";
import { renderPill, renderFloatPanel } from "./float.ts";

/** 模块级单飞去重句柄（invalidate 单飞：同一时刻只有一个 in-flight 拉取）。 */
let inflight: Promise<boolean> | undefined;

/**
 * 刷新服务器列表与浮窗摘要（单飞：in-flight 复用；#111 变更点驱动）。
 * 返回 true=成功；false=失败（调用方按退避重试）。
 */
export function refresh(state: McpState, actions: UiActions): Promise<boolean> {
  if (inflight !== undefined) return inflight;
  inflight = doRefresh(state, actions).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

/** 实际拉取（单飞内部）。 */
async function doRefresh(state: McpState, actions: UiActions): Promise<boolean> {
  try {
    // #324：GET /servers 不再带 cwd——服务端已忽略该参数（纯读快照，零副作用），
    // 会话切换只走 POST /api/dsh-mcp/session（bindSession cwd 变化时触发）。
    // 带 cwd 曾触发服务端 setSession → 广播 → 客户端再刷新的自激循环。
    const payload = await api(state.API.servers);
    state.servers = payload.servers ?? [];
    state.counts = payload.counts ?? {};
    state.projectRoot = payload.projectRoot;
    renderPill(state);
    if (state.floatOpen) renderFloatPanel(state, actions);
    const countsEl = document.querySelector(".dm-counts");
    if (countsEl !== null) {
      const parts = [];
      if (state.counts.connected > 0) parts.push(`运行中 ${state.counts.connected}`);
      if (state.counts.connecting > 0 || state.counts.reconnecting > 0) parts.push(`连接中 ${(state.counts.connecting ?? 0) + (state.counts.reconnecting ?? 0)}`);
      if (state.counts.failed > 0) parts.push(`失败 ${state.counts.failed}`);
      countsEl.textContent = parts.length > 0 ? `共 ${state.servers.length} 台 · ${parts.join(" · ")}` : `共 ${state.servers.length} 台`;
    }
    if (state.bodyEl !== undefined && state.activeTab === "servers") renderServers(state, actions);
    return true;
  } catch (error) {
    if (state.bodyEl !== undefined && state.activeTab === "servers") {
      state.bodyEl.textContent = "";
      state.bodyEl.appendChild(el("div", { class: "dm-status", text: `加载失败：${error instanceof Error ? error.message : String(error)}` }));
    }
    return false;
  }
}

/** 切换面板 tab（servers / quick）。 */
export function switchTab(state: McpState, actions: UiActions, tab: any): void {
  state.activeTab = tab;
  for (const tabEl of document.querySelectorAll<HTMLElement>(".dm-tab")) {
    tabEl.dataset.active = tabEl.dataset.tab === tab ? "true" : "";
  }
  if (state.bodyEl === undefined) return;
  state.bodyEl.textContent = "";
  if (tab === "servers") {
    if (state.servers.length === 0) void refresh(state, actions);
    else renderServers(state, actions);
  } else {
    const page = buildQuickAdd(state, actions);
    state.bodyEl.appendChild(page);
  }
}

/** 关闭模态面板。 */
export function close(state: McpState): void {
  if (state.overlay === undefined) return;
  state.open = false;
  state.overlay.hidden = true;
}

/** 打开模态面板（首次调用时创建 DOM 结构）。 */
export function showPanel(state: McpState, actions: UiActions): void {
  if (state.overlay === undefined) {
    state.overlay = el("div", { class: "dm-overlay", hidden: true });
    state.overlay.addEventListener("click", (event: any) => {
      if (event.target === state.overlay) close(state);
    });
    state.card = el("div", { class: "dm-card" });

    const head = el("div", { class: "dm-head" });
    head.appendChild(el("h2", { text: "MCP 管理器" }));
    head.appendChild(el("span", { class: "dm-counts", text: "" }));
    head.appendChild(el("button", { text: "刷新", onclick: () => void refresh(state, actions) }));
    head.appendChild(el("button", { text: "关闭", onclick: () => close(state) }));
    state.card.appendChild(head);

    const tabs = el("div", { class: "dm-tabs" });
    tabs.appendChild(el("button", { class: "dm-tab", dataset: { tab: "servers" }, text: "服务器", onclick: () => switchTab(state, actions, "servers") }));
    tabs.appendChild(el("button", { class: "dm-tab", dataset: { tab: "quick" }, text: "快速接入", onclick: () => switchTab(state, actions, "quick") }));
    state.card.appendChild(tabs);

    state.bodyEl = el("div", { class: "dm-body" });
    state.card.appendChild(state.bodyEl);
    state.overlay.appendChild(state.card);
    document.body.appendChild(state.overlay);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) close(state);
    });
  }
  state.open = true;
  state.overlay.hidden = false;
  switchTab(state, actions, "servers");
}