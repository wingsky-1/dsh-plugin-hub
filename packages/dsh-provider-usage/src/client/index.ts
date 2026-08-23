/**
 * dsh-provider-usage — 用量悬浮框（客户端入口，v2）。
 *
 * v2 架构：渲染在宿主端完成（formatCapsule/formatPanel 返回 HTML），客户端只做：
 * - 胶囊框架挂载与定位（dou-float 按钮：状态点 + HTML 内容区）
 * - 面板框架挂载（head/内容区/foot，内容区注入宿主返回的 panelHtml）
 * - 60s 轮询 /stats + 可见性刷新 + provider 会话检测
 * - 设置面板 section 注册（settings.ts React 组件）
 *
 * 纪律：任何异常只 warn，绝不让 GUI 启动失败；请求带超时不挂起。
 */
import {
  resolveProviderFromSession,
  fetchStats,
  fetchHistory,
  fetchUiConfig,
  EVENTS_URL,
} from "./core.js";
import type { SessionsServiceLike, ConnectionHandleLike, StatsResponseV2, HistoryResponseV2, UiPlacementConfig } from "./core.js";
import { SettingsPage } from "./settings.js";
// React externals 路径：运行时由 dsh web factory require("react") 注入
import * as React from "react";
import STYLE from "./style.css";

/** 无会话时回落 provider（内置 opencode-go）。 */
const FALLBACK_PROVIDER = "opencode-go";

const REFRESH_MS = 60000; // 轮询间隔
const PILL_PREFIX = "dou-"; // 样式类名前缀
const MAX_HISTORY_DAYS = 30; // 历史请求天数

// ------------------------------------------------------------------ 工具

/** el() helper：children / attrs.children、dataset、onX、class/text 等。 */
function el(tag: string, attrs: Record<string, unknown> | undefined, children?: unknown): HTMLElement {
  const node = document.createElement(tag);
  if (attrs !== undefined && attrs !== null) {
    let kids = attrs.children;
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (key === "children" || value === undefined || value === null) continue;
      if (key === "class") node.className = String(value);
      else if (key === "text") node.textContent = String(value);
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
      else if (key === "hidden") node.hidden = Boolean(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else node.setAttribute(key, String(value));
    }
    if (Array.isArray(attrs.children)) kids = attrs.children;
  }
  const list = Array.isArray(children) ? children : [children];
  for (const item of list) {
    if (item === undefined || item === null) continue;
    node.appendChild(typeof item === "string" ? document.createTextNode(item) : (item as Node));
  }
  return node;
}

/** 相对时间文案。 */
function fmtAge(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/** 样式注入（幂等）。 */
function injectStyle(): void {
  if (document.head === null) {
    document.addEventListener("DOMContentLoaded", () => injectStyle(), { once: true });
    return;
  }
  if (document.querySelector("style[data-dou-style]") !== null) return;
  const style = document.createElement("style");
  style.setAttribute("data-dou-style", "");
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// ------------------------------------------------------------------ 状态

let sessions: SessionsServiceLike | undefined;
let connection: ConnectionHandleLike | undefined;

/** 当前生效 provider。 */
let currentProvider: string = FALLBACK_PROVIDER;
/** 最近一次 /stats 响应。 */
let lastStats: StatsResponseV2 | null = null;
/** 最近一次 /history 响应。 */
let lastHistory: HistoryResponseV2 | null = null;
/** 渲染代 token（防竞态）。 */
let renderGeneration = 0;
/** 用户适配器版本（变化即全量重置，防新数据旧模板混搭）。 */
let lastAdapterVersion = 0;

/** 胶囊/面板位置配置（设置页保存后经 SSE 即时刷新）。 */
let uiConfig: UiPlacementConfig = { placement: "top-right", offsetX: 8, offsetY: 8, panelOffsetY: 44 };
/** SSE 事件通道（ui-config-changed 监听）。 */
let eventsSource: EventSource | null = null;

/** 按当前配置重算胶囊位置（模块级：mountFloat 与配置变更共用）。 */
function repositionPill(pill: HTMLElement, target: HTMLElement): void {
  const scrollTop = target === document.body ? window.scrollY : target.scrollTop;
  const viewH = target === document.body ? window.innerHeight : target.clientHeight;
  const isBottom = uiConfig.placement === "bottom-right" || uiConfig.placement === "bottom-left";
  const isLeft = uiConfig.placement === "top-left" || uiConfig.placement === "bottom-left";
  // MCP 浮窗自动避让：会话容器顶部存在 MCP 浮窗按钮时，胶囊在其下方（不重叠，
  // 与历史行为等效：原实现 top 42 而非 8，避让量 34 叠加在配置 offsetY 之上）
  const mcpClearance = target.querySelector("[data-dsh-mcp-float]") !== null ? 34 : 0;
  // 垂直：top 锚点 → 容器顶部 + offsetY（+MCP 避让）；bottom 锚点 → 可视区底部 - offsetY - 胶囊高
  const top = isBottom
    ? scrollTop + Math.max(0, viewH - uiConfig.offsetY - pill.offsetHeight)
    : scrollTop + uiConfig.offsetY + mcpClearance;
  pill.style.top = `${top}px`;
  pill.style.bottom = "auto";
  pill.style.right = isLeft ? "auto" : `${uiConfig.offsetX}px`;
  pill.style.left = isLeft ? `${uiConfig.offsetX}px` : "auto";
}

/** 按当前配置重算胶囊/面板位置（滚动/缩放/配置变更时调用）。 */
function applyUiPlacement(): void {
  const target = conversationHost();
  if (target === null || target === undefined) return;
  if (floatPill !== undefined) repositionPill(floatPill, target);
  if (floatOpen && floatPanel !== undefined) placePanel();
}

// ------------------------------------------------------------------ 浮窗 chrome

let floatPill: HTMLElement | undefined;
let floatPanel: HTMLElement | undefined;
let floatOpen = false;
let panelContentBox: HTMLElement | undefined;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function conversationHost(): HTMLElement {
  return (
    document.querySelector("[data-conversation-scroll]")
    ?? document.querySelector('[data-pane="conversation"]')
    ?? document.body
  );
}

/** 状态点等级：fresh/cached → ok；stale → warn；未配置/错误 → err。 */
function pillDotLevel(stats: StatsResponseV2 | null): "ok" | "warn" | "err" {
  if (stats === null) return "warn"; // 启动加载中：黄点（非错误）
  if (!stats.configured) return "err"; // 确实未配置/无启用适配器
  if (stats.status === "stale") return "warn"; // 降级陈旧（含 busy：取数进行中）
  return "ok";
}

/** 渲染胶囊：状态点 + 宿主端 formatCapsule 的 HTML。 */
function renderPill(): void {
  if (floatPill === undefined) return;
  const labelEl = floatPill.querySelector(`.${PILL_PREFIX}label`);
  const dotEl = floatPill.querySelector(`.${PILL_PREFIX}dot`);
  const stats = lastStats;
  // 仅在首帧（尚无任何响应）时隐藏；未配置适配器保留错误态胶囊（红点 + provider 名），
  // 点击展开面板可见接入引导（复制引导指令按钮可达）
  const hide = stats === null;
  floatPill.hidden = hide;
  if (stats !== null) {
    if (!stats.configured) {
      floatPill.title = `${currentProvider} · 未配置适配器，点击查看接入引导`;
    } else if (stats.error !== null && stats.error !== undefined) {
      floatPill.title = `用量获取失败：${stats.error}`;
    } else if ((stats as { reason?: string | null }).reason === "busy") {
      floatPill.title = `${stats.adapterName} · 取数进行中，稍候自动刷新`;
    } else {
      floatPill.title = `${stats.adapterName} · ${stats.status === "stale" ? "数据陈旧" : stats.status === "cached" ? "缓存" : "实时"} · 更新于 ${fmtAge(stats.fetchedAt)}`;
    }
  }
  if (labelEl !== null) {
    if (stats?.capsuleHtml) labelEl.innerHTML = stats.capsuleHtml;
    else if (stats !== null) labelEl.textContent = currentProvider;
    else labelEl.textContent = "";
  }
  if (dotEl !== null) dotEl.className = `${PILL_PREFIX}dot dou-dot-${pillDotLevel(stats)}`;
}

// ------------------------------------------------------------------ 数据拉取

/** 拉取当前 provider 用量并刷新胶囊（失败落错误态，不向上抛）。 */
async function refreshStats(): Promise<void> {
  const gen = renderGeneration;
  try {
    const r = await fetchStats(currentProvider);
    if (gen !== renderGeneration) return;
    // 适配器版本变化（热更新）→ 全量重置，防新数据旧模板混搭
    if (r.adapterVersion !== lastAdapterVersion) {
      lastAdapterVersion = r.adapterVersion;
      lastHistory = null;
    }
    lastStats = r;
    renderPill();
    if (floatOpen) {
      void refreshHistory(); // 面板开着：随轮询同步刷新历史
    }
  } catch {
    if (gen !== renderGeneration) return;
    renderPill();
    if (floatOpen) renderPanel();
  }
}

/** 拉取历史并刷新面板内容区。 */
async function refreshHistory(): Promise<void> {
  const gen = renderGeneration;
  try {
    const body = await fetchHistory(currentProvider, MAX_HISTORY_DAYS);
    if (gen !== renderGeneration) return;
    lastHistory = body;
    if (floatOpen) renderPanel();
  } catch {
    if (gen !== renderGeneration) return;
    if (floatOpen) renderPanel();
  }
}

/** 错误码/原因 → 面板提示文案（覆盖 error 码与 reason 降级码）。 */
function errorMessage(code: string | undefined | null): string {
  switch (code) {
    case "no-api-key": return "未找到 API Key（走 {PROVIDER}_API_KEY 环境变量或 .credentials.yaml）。";
    case "unauthorized": return "API Key 无效或已过期（401/403）。";
    case "timeout": return "请求超时，请重试。";
    case "network": return "网络错误，请检查连接后重试。";
    case "bad-data":
    case "bad-json": return "数据格式异常，请检查服务商接口或适配器返回。";
    case "adapter-load-failed": return "自定义适配器加载失败，请检查文件路径与契约（设置页可见错误明细）。";
    // reason 降级码（error 为 null 但 ok=false 的形态）
    case "busy": return "上一次取数仍在进行，稍候自动刷新。";
    case "no-enabled-adapter": return "该提供商有候选适配器但均未启用，请在设置面板「用量统计」启用。";
    case "no-adapter": return "该提供商未配置适配器，请在设置面板「用量统计」添加。";
    default:
      if (typeof code === "string" && code.startsWith("http-")) return `服务返回 ${code.slice(5)}，请检查中转站状态。`;
      return `用量获取失败：${code || "暂无数据"}。`;
  }
}

/** 无启用适配器引导（v1 D11 语义）：说明文案 + 复制一句话指令，让 Agent 按文档自主接入。 */
function showNoAdapterGuide(box: HTMLElement): void {
  box.appendChild(
    el("p", { class: PILL_PREFIX + "error", text: "该提供商暂无启用的适配器。" }),
  );
  box.appendChild(
    el("p", {
      class: PILL_PREFIX + "hint",
      text: "在设置面板「用量统计」的适配器管理中启用一个候选适配器；也可复制下方引导指令，让 Agent 帮你接入用量数据源。",
    }),
  );
  const guide = `请为提供商 ${currentProvider} 创建用量统计适配器（v2 契约）：以该提供商在模型配置中的 API 端点（baseUrl）为起点，自行确认用量接口与鉴权方式，自主设计适配器方案（name/展示名/接口路径），先给我审核方案（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在「用量统计」设置页添加适配器。按用量统计适配器开发引导文档（https://github.com/wingsky-1/dsh-plugin-hub/blob/main/packages/dsh-provider-usage/docs/adapter-guide.md）执行引导流程。`;
  const btn = el("button", {
    type: "button",
    class: PILL_PREFIX + "btn",
    text: "复制引导指令",
    onClick: () => {
      void navigator.clipboard
        .writeText(guide)
        .then(() => { btn.textContent = "已复制 ✓"; })
        .catch(() => { btn.textContent = "复制失败"; });
      setTimeout(() => { btn.textContent = "复制引导指令"; }, 2000);
    },
  });
  box.appendChild(btn);
}

/** 渲染展开面板（head + 内容区[panelHtml] + foot）。 */
function renderPanel(): void {
  if (floatPanel === undefined) return;
  floatPanel.textContent = "";
  const stats = lastStats;
  const label = stats?.adapterName ?? currentProvider;
  floatPanel.appendChild(
    el("div", { class: PILL_PREFIX + "head" }, [
      el("h3", { class: PILL_PREFIX + "title", text: `${label} 用量` }),
      el("button", { class: PILL_PREFIX + "btn", type: "button", text: "刷新", onClick: () => { void refreshStats(); } }),
    ]),
  );

  panelContentBox = el("div", { class: PILL_PREFIX + "charts" });
  floatPanel.appendChild(panelContentBox);

  // 优先级：面板内容（panelHtml）> 状态/历史错误 > 加载中
  // （stats 失败但历史有图时仍展示图表——数据可用性优先于错误提示）
  const histReason = lastHistory?.reason ?? null;
  const hasPanelHtml = lastHistory !== null && lastHistory !== undefined && !!lastHistory.panelHtml;
  // 「无启用适配器/未配置」→ 引导分支（说明文案 + 复制一句话指令）
  const unconfigured =
    histReason === "no-enabled-adapter" ||
    histReason === "no-adapter" ||
    (lastHistory === null && stats !== null && !stats.configured);
  if (hasPanelHtml) {
    panelContentBox.innerHTML = lastHistory!.panelHtml ?? "";
    if (lastHistory!.error) {
      panelContentBox.appendChild(el("p", { class: PILL_PREFIX + "hint", text: `提示：${errorMessage(lastHistory!.error)}` }));
    }
  } else if (unconfigured) {
    showNoAdapterGuide(panelContentBox);
  } else if (lastHistory !== undefined && lastHistory !== null && lastHistory.error) {
    panelContentBox.appendChild(el("p", { class: PILL_PREFIX + "error", text: errorMessage(lastHistory.error) }));
  } else if (stats !== null && stats.ok === false) {
    // stats 取数失败：error 有值给具体文案；无值的 reason 态（busy 等）也给明确提示
    const reason = (stats as { reason?: string | null }).reason;
    panelContentBox.appendChild(el("p", { class: PILL_PREFIX + "error", text: errorMessage(stats.error || reason) }));
  } else {
    panelContentBox.appendChild(el("p", { class: PILL_PREFIX + "hint", text: "加载中…" }));
  }

  // foot
  floatPanel.appendChild(
    el("div", { class: PILL_PREFIX + "foot" }, [
      el("span", { text: label }),
      el("span", {
        text: stats?.fetchedAt ? `更新于 ${fmtAge(stats.fetchedAt)}` : "",
        title: stats?.fetchedAt ? new Date(stats.fetchedAt).toLocaleString("zh-CN") : "",
      }),
    ]),
  );
}

// ------------------------------------------------------------------ provider 变化

function onProviderChanged(): void {
  renderGeneration += 1;
  lastStats = null;
  lastHistory = null;
  lastAdapterVersion = 0;
  if (floatPill !== undefined) renderPill();
  if (floatOpen && floatPanel !== undefined) renderPanel();
  void refreshStats();
}

// ------------------------------------------------------------------ 挂载

function toggleFloat(force?: boolean): void {
  if (floatPanel === undefined) return;
  const next = force !== undefined ? force : !floatOpen;
  floatOpen = next;
  floatPanel.hidden = !next;
  if (next) {
    placePanel();
    renderPanel();
    // 展开面板只拉历史（每次都调）；胶囊文案由轮询维护，不重复调 stats
    void refreshHistory();
  }
}

function placePanel(): void {
  if (floatPill === undefined || floatPanel === undefined) return;
  const rect = floatPill.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  floatPanel.style.top = `${Math.max(6, rect.bottom + uiConfig.panelOffsetY)}px`;
  if (uiConfig.placement === "top-left" || uiConfig.placement === "bottom-left") {
    floatPanel.style.left = `${Math.max(10, Math.round(rect.left))}px`;
    floatPanel.style.right = "auto";
  } else {
    floatPanel.style.right = `${Math.max(10, Math.round(window.innerWidth - rect.right))}px`;
    floatPanel.style.left = "auto";
  }
}

function mountFloat(): () => void {
  injectStyle();
  const pill = el("button", { type: "button", class: PILL_PREFIX + "float", "aria-label": "用量统计" });
  pill.dataset.douFloat = "";
  pill.hidden = true; // 初始隐藏，首次数据到达后显示
  pill.appendChild(el("span", { class: PILL_PREFIX + "dot dou-dot-off" }));
  pill.appendChild(el("span", { class: PILL_PREFIX + "label", text: "" }));
  pill.addEventListener("click", () => { toggleFloat(); });

  const panel = el("div", { class: PILL_PREFIX + "panel" });
  panel.hidden = true;
  floatPill = pill;
  floatPanel = panel;
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  let host: HTMLElement | null;
  const listeners: Array<() => void> = [];

  const attachListeners = (target: HTMLElement): void => {
    for (const stop of listeners) { try { stop(); } catch { /* 忽略 */ } }
    listeners.length = 0;
    const onScroll = (): void => {
      repositionPill(pill, target);
      if (floatOpen) placePanel();
    };
    const onResize = (): void => {
      repositionPill(pill, target);
      if (floatOpen) placePanel();
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    listeners.push(() => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    });
    onScroll();
  };

  const place = (): boolean => {
    const best = conversationHost();
    if (best === null || best === undefined) return false;
    if (host !== best || pill.parentElement !== best) {
      host = best;
      if (pill.parentElement !== null) pill.remove();
      best.appendChild(pill);
      attachListeners(best);
    }
    repositionPill(pill, host);
    return true;
  };

  const observer = new MutationObserver(() => { place(); });
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

  renderPill();
  void refreshStats();

  // 胶囊位置配置：启动拉取一次 + SSE 订阅即时热更新（设置页保存即生效，跨端同步）
  void fetchUiConfig().then((cfg) => {
    uiConfig = cfg;
    applyUiPlacement();
  });
  try {
    eventsSource = new EventSource(EVENTS_URL);
    eventsSource.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string };
        if (msg.type === "ui-config-changed") {
          void fetchUiConfig().then((cfg) => {
            uiConfig = cfg;
            applyUiPlacement();
          });
        }
      } catch { /* 忽略畸形帧 */ }
    };
  } catch { /* EventSource 不可用：静默降级，下次挂载重新拉取 */ }

  refreshTimer = setInterval(() => { void refreshStats(); }, REFRESH_MS);
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void refreshStats();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    observer.disconnect();
    for (const stop of listeners) { try { stop(); } catch { /* 忽略 */ } }
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    document.removeEventListener("visibilitychange", onVisible);
    if (eventsSource !== null) {
      eventsSource.close();
      eventsSource = null;
    }
    pill.remove();
    panel.remove();
    floatPill = undefined;
    floatPanel = undefined;
    floatOpen = false;
    lastStats = null;
    lastHistory = null;
  };
}

// ------------------------------------------------------------------ 插件入口

export function apply(ctx: any): void {
  try {
    injectStyle();
    if (document.body === null) return;

    sessions = ctx.get("sessions") as SessionsServiceLike | undefined;
    connection = ctx.get("connection") as ConnectionHandleLike | undefined;

    // 设置面板独立 tab「用量统计」（settings.section）；独立 try/catch 不连坐浮窗
    let disposeSettingsSection: (() => void) | undefined;
    try {
      const slots = ctx.get("slots");
      if (slots && typeof slots.inject === "function") {
        const injected: unknown = slots.inject("settings.section", function () {
          return slots.register(
            { name: "settings.section", id: "dsh-provider-usage", order: 90, label: "用量统计" },
            function () {
              return React.createElement(SettingsPage, null);
            },
          );
        });
        if (typeof injected === "function") disposeSettingsSection = injected as () => void;
      }
    } catch (error) {
      console.warn("[dsh-provider-usage] 设置面板 section 注册失败（跳过，不影响悬浮框）", error);
    }

    const disposeFloat = mountFloat();

    // provider 检测：会话变化 → 重新解析 provider → 重渲染
    let unsubSessions: (() => void) | undefined;
    const detect = (): void => {
      void (async () => {
        const detected = await resolveProviderFromSession(sessions, connection);
        const next = detected ?? FALLBACK_PROVIDER;
        if (next !== currentProvider) {
          currentProvider = next;
          onProviderChanged();
        }
      })();
    };
    const maybe = sessions?.currentProvideInfo;
    if (maybe !== undefined && typeof maybe.subscribe === "function") {
      unsubSessions = maybe.subscribe(detect);
    } else if (sessions?.list !== undefined && typeof sessions.list.subscribe === "function") {
      unsubSessions = sessions.list.subscribe(detect);
    }
    void detect();

    ctx.effect(() => () => {
      if (disposeSettingsSection !== undefined) {
        try { disposeSettingsSection(); } catch { /* 忽略 */ }
        disposeSettingsSection = undefined;
      }
      if (unsubSessions !== undefined) unsubSessions();
      disposeFloat();
      renderGeneration += 1;
      sessions = undefined;
      connection = undefined;
    }, "dsh-provider-usage: float");
  } catch (error) {
    console.warn("[dsh-provider-usage] 悬浮框挂载失败", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
export const inject: string[] = [];