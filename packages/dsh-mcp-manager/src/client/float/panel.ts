/**
 * dsh-mcp-manager — 客户端模态面板生命周期。
 *
 * 面板的打开/关闭/tab 切换/数据刷新。
 * 跨模块渲染（renderServers / buildQuickAdd / renderPill / renderFloatPanel）
 * 直接 import 用到的模块——本模块是 feature 模块的汇聚点，构成单向依赖图：
 * panel → servers / quick-add / float。
 */

import { el } from "../core/dom.ts";
import { api } from "../core/api.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { McpState, UiActions } from "../core/state.ts";
import { renderServers } from "./servers.ts";
import { buildQuickAdd } from "./quick-add.ts";
import { renderPill, renderFloatPanel } from "./float.ts";

/** 模块级单飞去重句柄（invalidate 单飞：同一时刻只有一个 in-flight 拉取）。 */
let inflight: Promise<boolean> | undefined;

/** C4：Escape keydown 清理回调登记（WeakMap 避免污染 McpState 接口）。 */
const keydownCleanups = new WeakMap<McpState, () => void>();

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
      if (state.counts.connected > 0)
        parts.push(t("countsConnected", { n: state.counts.connected }));
      if (state.counts.connecting > 0 || state.counts.reconnecting > 0)
        parts.push(
          t("countsConnecting", {
            n: (state.counts.connecting ?? 0) + (state.counts.reconnecting ?? 0),
          }),
        );
      if (state.counts.failed > 0) parts.push(t("countsFailed", { n: state.counts.failed }));
      const summary =
        parts.length > 0
          ? t("countsSummary", { n: state.servers.length, parts: parts.join(" · ") })
          : t("countsSummaryOnly", { n: state.servers.length });
      // 失败计数标红（健康摘要与浮窗同语义）。
      if (state.counts.failed > 0 && typeof summary === "string") {
        const failedText = t("countsFailed", { n: state.counts.failed });
        countsEl.textContent = "";
        const chunks = summary.split(failedText);
        chunks.forEach((chunk, index) => {
          if (index > 0) {
            countsEl.appendChild(el("span", { class: "dm-health-bad", text: failedText }));
          }
          if (chunk !== "") countsEl.appendChild(document.createTextNode(chunk));
        });
      } else {
        countsEl.textContent = summary;
      }
    }
    if (state.bodyEl !== undefined && state.activeTab === "servers") renderServers(state, actions);
    return true;
  } catch (error) {
    if (state.bodyEl !== undefined && state.activeTab === "servers") {
      state.bodyEl.textContent = "";
      state.bodyEl.appendChild(
        el("div", {
          class: "dm-status",
          text: t("loadFail", { msg: error instanceof Error ? error.message : String(error) }),
        }),
      );
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

/** 关闭模态面板（Fluid：卡片中心收束 + 遮罩淡出；完成后再 hidden）。
 *
 * R1 状态同翻：state.open=false 的同一同步块内摘除 aria-modal（不经 300ms
 * 动画回调——动画被打断/定时器漂移时标记与状态永久错位，见 #947）。
 * R2 常驻壳无标记：hidden 元素仍被 querySelector 命中，故必须摘属性而非
 * 置 "false"（裸 [aria-modal] 存在检查仍命中 "false"，且关闭态留 "false"
 * 语义错误）。R6 关还焦：同步把焦点还给打开者（便宜且安全）。
 */
export function close(state: McpState): void {
  if (state.overlay === undefined) return;
  state.open = false;
  // 与 state.open 同步翻转：card 缺失属创建/销毁不对称，显式分支不断言静默。
  if (state.card !== undefined) state.card.removeAttribute("aria-modal");
  // R6 还焦：opener 仍在文档内才恢复（已卸载/非元素则跳过，不抛）。
  const opener = state.panelOpener;
  state.panelOpener = undefined;
  if (opener !== undefined && opener !== null && typeof opener.focus === "function") {
    try {
      if (typeof opener.isConnected !== "boolean" || opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    } catch {
      // 焦点恢复失败不影响关闭语义，只 warn 不抛（绝不让 GUI 挂掉）。
      console.warn("[dsh-mcp-manager] panel opener focus restore skipped");
    }
  }
  const overlay = state.overlay;
  overlay.classList.remove("dm-overlay--open");
  const finish = () => {
    if (state.open) return;
    overlay.classList.remove("dm-overlay--closing");
    overlay.hidden = true;
  };
  if (typeof requestAnimationFrame === "function") {
    overlay.style.animation = "none";
    void overlay.offsetWidth;
    overlay.style.animation = "";
    overlay.classList.add("dm-overlay--closing");
    // 与 CSS .dm-overlay--closing .dm-card 的 300ms 对齐
    window.setTimeout(finish, 300);
  } else {
    finish();
  }
}

/** 打开模态面板（首次调用时创建 DOM 结构；Fluid：中心 scale 0.78→1）。 */
export function showPanel(state: McpState, actions: UiActions): void {
  if (state.overlay === undefined) {
    state.overlay = el("div", { class: "dm-overlay", hidden: true });
    state.overlay.addEventListener("click", (event: any) => {
      if (event.target === state.overlay) close(state);
    });
    state.card = el("div", { class: "dm-card" });

    const head = el("div", { class: "dm-head" });
    head.appendChild(el("h2", { text: t("panelTitle") }));
    head.appendChild(el("span", { class: "dm-counts", text: "" }));
    head.appendChild(
      el("button", { text: t("refresh"), onclick: () => void refresh(state, actions) }),
    );
    // C10：首次构建面板头后立刻拉一次（与打开路径 refresh 同源，单飞去重）。
    void refresh(state, actions);
    head.appendChild(el("button", { text: t("close"), onclick: () => close(state) }));
    state.card.appendChild(head);
    // role 保留（静态语义；hidden 子树 AT-irrelevant）。aria-modal 不在此写：
    // 单点写入见本函数公共路径（state.open=true 后无条件 set），与 close() 的
    // 同步 removeAttribute 配对（R1），两处写同一值会漂移。
    state.card.setAttribute("role", "dialog");
    state.card.setAttribute("aria-label", t("panelTitle"));

    const tabs = el("div", { class: "dm-tabs" });
    tabs.appendChild(
      el("button", {
        class: "dm-tab",
        dataset: { tab: "servers" },
        text: t("tabServers"),
        onclick: () => switchTab(state, actions, "servers"),
      }),
    );
    tabs.appendChild(
      el("button", {
        class: "dm-tab",
        dataset: { tab: "quick" },
        text: t("tabQuickAdd"),
        onclick: () => switchTab(state, actions, "quick"),
      }),
    );
    state.card.appendChild(tabs);

    state.bodyEl = el("div", { class: "dm-body" });
    state.card.appendChild(state.bodyEl);
    state.overlay.appendChild(state.card);
    document.body.appendChild(state.overlay);

    // C4 keydown 泄漏修复：Escape 监听改具名函数并经 WeakMap 登记清理
    // 回调（disposePanel 配对 removeEventListener）——匿名监听器在 HMR/重复
    // apply 下无移除路径，会随每次 apply 累积。
    const onKeyDown = (event: KeyboardEvent) => {
      // R4 共享键让位：他人已 preventDefault 即不再关（多弹窗可组合）。
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && state.open) close(state);
    };
    document.addEventListener("keydown", onKeyDown);
    keydownCleanups.set(state, () => document.removeEventListener("keydown", onKeyDown));
  }
  // R6 记录 opener（当前聚焦元素；body/非元素由 close() 侧守卫过滤）。
  // 进焦不做（R6：聚关闭按钮以外的文本控件会唤起移动端键盘+布局跳动）。
  // 已 open 时重入不覆写：焦点已在面板内，重记会把还焦落到 hidden 子树节点。
  if (!state.open) {
    state.panelOpener =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
  }
  state.open = true;
  // R1 单点写入：重开路径（含 close→300ms 内重开竞态）一律恢复 true，与
  // close() 的同步摘除配对，幂等。
  if (state.card !== undefined) state.card.setAttribute("aria-modal", "true");
  state.overlay.hidden = false;
  state.overlay.classList.remove("dm-overlay--closing");
  const armOpen = () => {
    if (!state.open || state.overlay === undefined) return;
    state.overlay.style.animation = "none";
    void state.overlay.offsetWidth;
    state.overlay.style.animation = "";
    state.overlay.classList.add("dm-overlay--open");
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(armOpen);
  else armOpen();
  // C10：面板打开主动刷新（refresh 单飞去重，与 switchTab 的空列表刷新重叠无害）——
  // 面板可能停在关闭期间的旧快照上；打开即拉最新数据消除该窗口。
  void refresh(state, actions);
  switchTab(state, actions, "servers");
}

/** C4：卸载配对清理（index.ts effect disposer 调用）——移除 Escape keydown 监听。 */
export function disposePanel(state: McpState): void {
  const cleanup = keydownCleanups.get(state);
  if (cleanup !== undefined) {
    cleanup();
    keydownCleanups.delete(state);
  }
}
