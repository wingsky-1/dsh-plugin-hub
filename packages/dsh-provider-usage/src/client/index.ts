/**
 * dsh-provider-usage — 按 Provider 适配的用量悬浮框（客户端入口）。
 *
 * 架构（R2）：
 * - 核心层（core.ts）：渲染器注册表（含 adapterId 配对）+ provider 检测 + 数据拉取。
 * - 内置 opencode-go 渲染器（renderers/opencode-go.ts）：绘制浮窗展开面板卡片。
 * - 本文件 = 编排层：悬浮胶囊/面板挂载与定位、provider 变化与 adapterId 变化重渲染
 *   （渲染代 token 防竞态）、60s 轮询 + 可见性刷新、无启用适配器隐藏 + 探测恢复。
 *
 * R2 语义分层（D8）：
 * - 胶囊（按钮）内容 = 宿主 /stats 响应的 `summary` 子树（text/level/hint），可选
 *   叠加渲染器 `pill()` 钩子自定义；不再从 windows 推导。
 * - 面板内容 = 渲染器 `render(ctx)`（按 provider + adapterId 配对分派）。
 *
 * 无启用适配器（D11）：`summary.hasAdapter === false` → 浮窗隐藏，60s 轻量轮询
 * 探测直到有启用适配器再恢复显示。
 *
 * 契约：干净模块，只导出 apply/inject；样式经 build-client 内联。
 */
import {
  makeRendererRegistry,
  installGlobalBridge,
  resolveProviderFromSession,
  fetchStats,
  fetchHistory,
  loadUserRenderers,
} from "./core.js";
import type { SessionsServiceLike, ConnectionHandleLike, RendererRegistry } from "./core.js";
import { openCodeGoClientRenderer, injectStyle, el, fmtAge } from "./renderers/opencode-go.js";
import type { OpenCodeGoRenderContext } from "./renderers/opencode-go.js";
import { SettingsPage } from "./settings.js";
// React externals 路径（M3b settings.section）：运行时由 dsh web factory require("react") 注入
import * as React from "react";
import type { ProviderUsage, UsageWindow, ProviderSummary, SummaryLevel } from "../contracts.js";

/** 无会话时回落 provider（内置 opencode-go，无感升级）。 */
const FALLBACK_PROVIDER = "opencode-go";

const REFRESH_MS = 60000; // 轮询间隔
const HISTORY_MIN_GAP_MS = 30000; // 历史重拉最小间隔
const PILL_PREFIX = "dou-"; // 样式类名前缀
const MAX_HISTORY_DAYS = 30; // 历史请求天数

// ------------------------------------------------------------------ 状态

let sessions: SessionsServiceLike | undefined;
let connection: ConnectionHandleLike | undefined;
let registry: RendererRegistry | undefined;

/** 当前生效 provider（检测结果，未检测到回落 opencode-go）。 */
let currentProvider: string = FALLBACK_PROVIDER;
/** 最近一次成功检测到的 provider（undefined = 未检测到会话）。 */
let detectedProvider: string | undefined;
/** 归一化用量数据（面板）。 */
let lastData: ProviderUsage | null = null;
/** 当前启用适配器 id（来自 /stats 响应）。 */
let lastAdapterId: string | undefined;
/** 是否有启用适配器（summary.hasAdapter）。 */
let hasAdapter = false;
/** 轻量摘要（胶囊内容）。 */
let lastSummary: ProviderSummary | null = null;
/** 历史采样响应。 */
let lastHistory: { samples?: number[][]; columns?: import("../contracts.js").SampleColumn[] } | null = null;
/** 渲染代 token。 */
let renderGeneration = 0;
/** 当前渲染器 disposer。 */
let renderDisposer: (() => void) | null = null;

// ------------------------------------------------------------------ 浮窗 chrome

let floatPill: HTMLElement | undefined;
let floatPanel: HTMLElement | undefined;
let floatOpen = false;
let chartsBox: HTMLElement | undefined;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastHistoryAt = 0;

function conversationHost(): HTMLElement {
  return (
    document.querySelector("[data-conversation-scroll]")
    ?? document.querySelector('[data-pane="conversation"]')
    ?? document.body
  );
}

// ------------------------------------------------------------------ 胶囊（读 summary 子树 + pill 钩子）

/** 窗口短名（胶囊兜底用）。 */
function shortName(w: UsageWindow | string): string {
  const name = typeof w === "string" ? w : w.name ?? w.key;
  if (name === "rolling") return "5h";
  if (name === "weekly") return "周";
  if (name === "monthly") return "月";
  if (typeof w === "string") return w;
  if (name.length > 4) return name.slice(0, 4);
  return name;
}

/** 通用胶囊文案：优先渲染器 pill 钩子，回落 summary.text。 */
function pillLabel(): string {
  const renderer = registry?.get(currentProvider, lastAdapterId);
  if (renderer && typeof renderer.pill === "function" && lastSummary) {
    const custom = renderer.pill(lastSummary);
    if (custom !== null && custom !== undefined && custom.text) return custom.text;
  }
  if (lastSummary && typeof lastSummary.text === "string" && lastSummary.text !== "")
    return lastSummary.text;
  if (lastData && lastData.ok && Array.isArray(lastData.windows)) {
    const parts: string[] = [];
    for (const w of lastData.windows) {
      if (typeof w.percent === "number") parts.push(`${shortName(w)} ${w.percent}%`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  const label = lastSummary?.label ?? lastData?.label ?? currentProvider;
  return `${shortName(label)} --%`;
}

/** 状态点：优先 pill 钩子/ summary.level。 */
function pillDot(): SummaryLevel {
  const renderer = registry?.get(currentProvider, lastAdapterId);
  if (renderer && typeof renderer.pill === "function" && lastSummary) {
    const custom = renderer.pill(lastSummary);
    if (custom !== null && custom !== undefined) return custom.level;
  }
  if (lastSummary) return lastSummary.level ?? "off";
  return "off";
}

function pillTitle(): string {
  const label = lastSummary?.label ?? lastData?.label ?? currentProvider;
  if (!hasAdapter) return `${label} 用量：无启用适配器`;
  if (lastSummary) {
    const parts: string[] = [];
    if (lastSummary.text) parts.push(lastSummary.text);
    if (lastSummary.hint) parts.push(lastSummary.hint);
    return parts.length > 0 ? `${label} 用量：${parts.join(" · ")}` : `${label} 用量`;
  }
  if (lastData === null) return `${label} 用量（加载中…）`;
  if (!lastData.ok) return `${label} 用量获取失败：${lastData.error ?? "未知错误"}`;
  return `${label} 用量`;
}

function renderPill(): void {
  if (floatPill === undefined) return;
  const labelEl = floatPill.querySelector(`.${PILL_PREFIX}label`);
  const dotEl = floatPill.querySelector(`.${PILL_PREFIX}dot`);
  // D11：无启用适配器 → 隐藏浮窗（保留轮询探测恢复）
  floatPill.hidden = !hasAdapter;
  floatPill.title = pillTitle();
  if (labelEl !== null) labelEl.textContent = pillLabel();
  if (dotEl !== null) dotEl.className = `${PILL_PREFIX}dot dou-dot-${pillDot()}`;
}

// ------------------------------------------------------------------ 数据与渲染

/** 拉取当前 provider 用量并渲染（失败落错误态，不向上抛）。 */
async function refreshStats(): Promise<void> {
  const gen = renderGeneration;
  try {
    const r = await fetchStats(currentProvider);
    if (gen !== renderGeneration) return; // 已有新代渲染，丢弃

    // adapterId 变化（同一 provider 切换启用适配器）→ 视为数据源切换，重渲染
    if (r.adapterId !== lastAdapterId) {
      lastData = null;
      lastHistory = null;
      if (renderDisposer !== null) {
        try { renderDisposer(); } catch { /* 忽略 */ }
        renderDisposer = null;
      }
    }
    lastAdapterId = r.adapterId ?? undefined;
    hasAdapter = r.hasAdapter;
    lastSummary = r.summary;
    lastData = r.usage;
    renderPill();
    if (hasAdapter && floatOpen) {
      renderPanel();
      if (Date.now() - lastHistoryAt >= HISTORY_MIN_GAP_MS) void refreshHistory();
    }
  } catch {
    if (gen !== renderGeneration) return;
    lastData = { ok: false, provider: currentProvider, label: currentProvider, fetchedAt: Date.now(), error: "network" };
    renderPill();
    if (floatOpen) renderPanel();
  }
}

/** 拉取历史（按当前 provider + adapterId）。 */
async function refreshHistory(): Promise<void> {
  const gen = renderGeneration;
  const adapterId = lastAdapterId;
  try {
    const body = await fetchHistory(currentProvider, adapterId ?? FALLBACK_PROVIDER, MAX_HISTORY_DAYS);
    if (gen !== renderGeneration) return;
    lastHistory = body;
    lastHistoryAt = Date.now();
    if (floatOpen && chartsBox !== undefined) renderPanel();
  } catch {
    if (gen !== renderGeneration) return;
    lastHistory = null;
    if (floatOpen && chartsBox !== undefined) renderPanel();
  }
}

/** 错误码 → 面板提示文案。 */
function errorMessage(code: string | undefined | null, provider: string): string {
  switch (code) {
    case "no-api-key": return "未找到 API Key（内置 opencode-go 走 OPENCODE_GO_API_KEY / auth.json；自定义适配器自带鉴权）。";
    case "unauthorized": return "API Key 无效或已过期（401/403）。";
    case "timeout": return "请求超时，请重试。";
    case "network": return "网络错误，请检查连接后重试。";
    case "no-enabled-adapter": return "该提供商有候选适配器但均未启用，请在设置面板「用量统计」启用。";
    case "no-adapter": return "该提供商未配置适配器，请在设置面板「用量统计」配置。";
    case "bad-data":
    case "bad-json": return "数据格式异常，请检查服务商接口或适配器返回。";
    case "adapter-load-failed": return "自定义适配器加载失败，请检查文件路径与契约版本。";
    case "adapter-crash": return "适配器运行出错，已保留上一次成功数据。";
    default:
      if (typeof code === "string" && code.startsWith("http-")) return `服务返回 ${code.slice(5)}，请检查中转站状态。`;
      return `用量获取失败：${code ?? "未知错误"}。`;
  }
}

/** 渲染展开面板（head 通用 + 渲染器专属卡片区 + foot）。 */
function renderPanel(): void {
  if (floatPanel === undefined) return;
  floatPanel.textContent = "";
  const label = lastData && lastData.label ? lastData.label : (lastSummary?.label ?? currentProvider);
  const head = el("div", { class: PILL_PREFIX + "head" }, [
    el("h3", { class: PILL_PREFIX + "title", text: `${label} 用量` }),
    el("button", { class: PILL_PREFIX + "btn", type: "button", text: "刷新", onClick: () => { void refreshStats(); } }),
  ]);
  floatPanel.appendChild(head);

  chartsBox = el("div", { class: PILL_PREFIX + "charts" });
  floatPanel.appendChild(chartsBox);

  if (renderDisposer !== null) {
    try { renderDisposer(); } catch { /* 忽略 */ }
    renderDisposer = null;
  }

  // R2：渲染器按 (provider, adapterId) 配对分派
  const renderer = registry?.get(currentProvider, lastAdapterId);
  if (!hasAdapter) {
    floatPanel.appendChild(el("p", { class: PILL_PREFIX + "error", text: "该提供商暂无启用的适配器。" }));
    floatPanel.appendChild(el("p", { class: PILL_PREFIX + "hint", text: "在设置面板「用量统计」的适配器管理中启用一个候选适配器。" }));
    return;
  }
  if (renderer === undefined) {
    floatPanel.appendChild(el("p", { class: PILL_PREFIX + "error", text: `该提供商（${currentProvider}/${lastAdapterId ?? "-"}）无渲染器。` }));
    return;
  }
  rendererCharts(renderer);
  appendFoot();
}

function rendererCharts(renderer: { render(ctx: unknown): void | (() => void) } | undefined): void {
  if (chartsBox === undefined) return;
  if (renderer === undefined || lastData === null) return;
  if (lastData.ok === false) {
    chartsBox.appendChild(el("p", { class: PILL_PREFIX + "error", text: errorMessage(lastData.error, currentProvider) }));
    return;
  }
  try {
    const ctx: OpenCodeGoRenderContext = {
      provider: currentProvider,
      adapterId: lastAdapterId,
      data: lastData,
      mount: chartsBox,
      history: lastHistory ?? undefined,
    };
    const disposed = renderer.render(ctx);
    if (typeof disposed === "function") renderDisposer = disposed;
  } catch (error) {
    console.warn("[dsh-provider-usage] 渲染器运行出错", error);
    chartsBox.appendChild(el("p", { class: PILL_PREFIX + "error", text: "渲染器出错了。" }));
  }
}

function appendFoot(): void {
  if (floatPanel === undefined) return;
  const foot = el("div", { class: PILL_PREFIX + "foot" }, [
    el("span", { text: (lastSummary?.label ?? lastData?.label ?? currentProvider) }),
    el("span", {
      text: lastData && lastData.fetchedAt ? `更新于 ${fmtAge(lastData.fetchedAt)}` : "",
      title: lastData && lastData.fetchedAt ? new Date(lastData.fetchedAt).toLocaleString("zh-CN") : "",
    }),
  ]);
  floatPanel.appendChild(foot);
}

// ------------------------------------------------------------------ provider 变化

/** provider 变化：取消旧代渲染 → 清空数据 → 重新拉取。 */
function onProviderChanged(): void {
  renderGeneration += 1;
  if (renderDisposer !== null) {
    try { renderDisposer(); } catch { /* 忽略 */ }
    renderDisposer = null;
  }
  lastData = null;
  lastHistory = null;
  lastSummary = null;
  lastAdapterId = undefined;
  hasAdapter = false;
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
    void refreshStats();
  }
}

function placePanel(): void {
  if (floatPill === undefined || floatPanel === undefined) return;
  const rect = floatPill.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  floatPanel.style.top = Math.max(6, rect.bottom + 6) + "px";
  floatPanel.style.right = Math.max(10, Math.round(window.innerWidth - rect.right)) + "px";
  floatPanel.style.left = "auto";
}

function mountFloat(): () => void {
  injectStyle();
  const pill = el("button", { type: "button", class: PILL_PREFIX + "float", "aria-label": "用量统计" });
  pill.dataset.douFloat = "";
  pill.hidden = true; // 初始：未知适配器前隐藏
  pill.appendChild(el("span", { class: PILL_PREFIX + "dot dou-dot-off" }));
  pill.appendChild(el("span", { class: PILL_PREFIX + "label", text: pillLabel() }));
  pill.addEventListener("click", () => { toggleFloat(); });

  const panel = el("div", { class: PILL_PREFIX + "panel" });
  panel.hidden = true;
  floatPill = pill;
  floatPanel = panel;
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  let host: HTMLElement | null;
  const listeners: Array<() => void> = [];

  const repositionPill = (target: HTMLElement): void => {
    if (target === null || target === undefined) return;
    const scrollTop = target === document.body ? window.scrollY : target.scrollTop;
    const topBase = target.querySelector("[data-dsh-mcp-float]") !== null ? 42 : 8;
    pill.style.top = `${scrollTop + topBase}px`;
  };

  const attachListeners = (target: HTMLElement): void => {
    for (const stop of listeners) { try { stop(); } catch { /* 忽略 */ } }
    listeners.length = 0;
    const onScroll = (): void => {
      repositionPill(target);
      if (floatOpen) placePanel();
    };
    const onResize = (): void => {
      repositionPill(target);
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
    repositionPill(host);
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
    if (renderDisposer !== null) {
      try { renderDisposer(); } catch { /* 忽略 */ }
      renderDisposer = null;
    }
    pill.remove();
    panel.remove();
    floatPill = undefined;
    floatPanel = undefined;
    floatOpen = false;
    lastData = null;
    lastHistory = null;
    lastSummary = null;
  };
}

// ------------------------------------------------------------------ 插件入口

/**
 * 插件入口：注入样式 + 注册渲染器 + provider/adapter 检测 + 挂载浮窗。
 * 任何异常只 warn，绝不让 GUI 启动失败。
 */
export function apply(ctx: any): void {
  try {
    injectStyle();
    if (document.body === null) return;

    sessions = ctx.get("sessions") as SessionsServiceLike | undefined;
    connection = ctx.get("connection") as ConnectionHandleLike | undefined;
    registry = makeRendererRegistry();
    registry.register(openCodeGoClientRenderer, "builtin");
    // 桥接持 registry 句柄（而非闭包捕获）：热重载重建 apply 后新 registry 立即生效
    installGlobalBridge(() => registry);
    // M2: 加载用户客户端渲染器（fire-and-forget）
    loadUserRenderers(registry).catch(() => {});

    // M3b：设置面板独立 tab「用量统计」（settings.section；slots 服务缺失时跳过）
    const slots = ctx.get("slots");
    if (slots && typeof slots.inject === "function") {
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "dsh-provider-usage", order: 90, label: "用量统计" },
          function () {
            return React.createElement(SettingsPage, null);
          },
        );
      });
    }

    const disposeFloat = mountFloat();

    // provider 检测（M0 路径）：会话变化 → 重新解析 provider → 重渲染
    let unsubSessions: (() => void) | undefined;
    const detect = (): void => {
      void (async () => {
        const detected = await resolveProviderFromSession(sessions, connection);
        const next = detected ?? FALLBACK_PROVIDER;
        detectedProvider = detected;
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
      if (unsubSessions !== undefined) unsubSessions();
      disposeFloat();
      renderGeneration += 1;
      sessions = undefined;
      connection = undefined;
      registry = undefined;
    }, "dsh-provider-usage: float");
  } catch (error) {
    console.warn("[dsh-provider-usage] 悬浮框挂载失败", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
export const inject: string[] = [];