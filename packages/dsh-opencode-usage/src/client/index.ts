/**
 * dsh-opencode-usage — 按 Provider 适配的用量悬浮框（客户端入口）。
 *
 * 架构（M1）：
 * - 核心层核心（core.ts）：渲染器注册表 + provider 检测 + 数据拉取。
 * - 内置 opencode-go 渲染器（renderers/opencode-go.ts）：绘制浮窗展开面板的
 *   三窗口迷你图卡片（行为与旧版一致）。
 * - 本文件 = 编排层：悬浮胶囊/面板的挂载与定位（沿用旧 DOM 挂载、MutationObserver
 *   迁移、MCP 浮窗避让）、provider 变化重渲染（渲染代 token 防竞态）、60s 轮询、
 *   可见性刷新、挂载/卸载清理。胶囊本体为**通用**展示（由 ProviderUsage.windows
 *   汇总），展开面板为**渲染器专属**（按 provider 分派）。
 *
 * provider 检测走 M0 探针①结论路径：sessions.currentProvideInfo.sessionId →
 * connection.api.sessions.models({sessionId}) → current.provider；检测不到则
 * 回落内置 opencode-go（旧配置无感升级）。
 *
 * 契约：干净模块，只导出 apply/inject；样式经 build-client 内联。
 */
import {
  makeRendererRegistry,
  installGlobalBridge,
  resolveProviderFromSession,
  fetchStats,
  fetchHistory,
} from "./core.js";
import type { SessionsServiceLike, ConnectionHandleLike, RendererRegistry } from "./core.js";
import { openCodeGoClientRenderer, injectStyle, el, fmtAge } from "./renderers/opencode-go.js";
import type { OpenCodeGoRenderContext } from "./renderers/opencode-go.js";
import type { ProviderUsage, UsageWindow } from "../contracts.js";

/** 旧 provider 无会话时的回落 provider（内置 opencode-go，无感升级）。 */
const FALLBACK_PROVIDER = "opencode-go";

const REFRESH_MS = 60000; // 轮询间隔
const HISTORY_MIN_GAP_MS = 30000; // 历史重拉最小间隔
const PILL_PREFIX = "dou-"; // 样式类名前缀
const MAX_HISTORY_DAYS = 30; // 历史请求天数（覆盖 monthly 观察周期）

// ------------------------------------------------------------------ 状态

let sessions: SessionsServiceLike | undefined;
let connection: ConnectionHandleLike | undefined;
let registry: RendererRegistry | undefined;

/** 当前生效 provider（检测结果，未检测到回落 opencode-go）。 */
let currentProvider: string = FALLBACK_PROVIDER;
/** 最近一次成功检测到的 provider（null = 未检测到会话）。 */
let detectedProvider: string | undefined;
/** 归一化用量数据。 */
let lastData: ProviderUsage | null = null;
/** 历史采样响应。 */
let lastHistory: { samples?: number[][] } | null = null;
/** 渲染代 token：只有最新一代渲染落地（快速切换会话防竞态）。 */
let renderGeneration = 0;
/** 当前渲染器 disposer（provider 切换/卸载时先调用）。 */
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

/** 通用胶囊文案：各窗口百分比并排。 */
function pillLabel(): string {
  if (lastData === null || !lastData.ok || !Array.isArray(lastData.windows)) return `${shortName(currentProvider)} --%`;
  const parts: string[] = [];
  for (const w of lastData.windows) {
    if (typeof w.percent === "number") parts.push(`${shortName(w)} ${w.percent}%`);
  }
  return parts.length > 0 ? parts.join(" · ") : `${shortName(currentProvider)} --%`;
}

/** 窗口短名（胶囊用）：rolling→5h 滚动取前缀，weekly→周，monthly→月。 */
function shortName(w: UsageWindow | string): string {
  const name = typeof w === "string" ? w : w.name ?? w.key;
  if (name === "rolling") return "5h";
  if (name === "weekly") return "周";
  if (name === "monthly") return "月";
  if (typeof w === "string") return w;
  if (name.length > 4) return name.slice(0, 4);
  return name;
}

function levelOf(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "off";
  if (pct >= 95) return "err";
  if (pct >= 80) return "warn";
  return "ok";
}

/** 状态点：取所有窗口消耗最高者（最保守告警）。 */
function pillDot(): string {
  if (lastData === null || !lastData.ok || !Array.isArray(lastData.windows)) return "off";
  let worst: number | null = null;
  for (const w of lastData.windows) {
    if (typeof w.percent === "number" && (worst === null || w.percent > worst)) worst = w.percent;
  }
  return levelOf(worst);
}

function pillTitle(): string {
  const label = lastData && lastData.label ? lastData.label : currentProvider;
  if (lastData === null) return `${label} 用量（加载中…）`;
  if (!lastData.ok) return `${label} 用量获取失败：${lastData.error ?? "未知错误"}`;
  if (!Array.isArray(lastData.windows) || lastData.windows.length === 0) return `${label} 用量（暂无数据）`;
  const parts: string[] = [];
  for (const w of lastData.windows) {
    if (typeof w.percent === "number") parts.push(`${shortName(w)} ${w.percent}%`);
  }
  return `${label} 用量：${parts.join(" · ")}`;
}

function renderPill(): void {
  if (floatPill === undefined) return;
  const labelEl = floatPill.querySelector(`.${PILL_PREFIX}label`);
  const dotEl = floatPill.querySelector(`.${PILL_PREFIX}dot`);
  floatPill.title = pillTitle();
  if (labelEl !== null) labelEl.textContent = pillLabel();
  if (dotEl !== null) dotEl.className = `${PILL_PREFIX}dot dou-dot-${pillDot()}`;
}

// ------------------------------------------------------------------ 数据与渲染

/** 拉取当前 provider 用量并渲染（失败落错误态 UI，不向上抛）。 */
async function refreshStats(): Promise<void> {
  const gen = renderGeneration;
  try {
    const data = await fetchStats(currentProvider);
    if (gen !== renderGeneration) return; // 已有新代渲染，丢弃
    lastData = data;
    renderPill();
    if (floatOpen) renderPanel();
    if (floatOpen && currentProvider === FALLBACK_PROVIDER && Date.now() - lastHistoryAt >= HISTORY_MIN_GAP_MS) {
      void refreshHistory();
    }
  } catch {
    if (gen !== renderGeneration) return;
    lastData = { ok: false, provider: currentProvider, label: currentProvider, fetchedAt: Date.now(), error: "network" };
    renderPill();
    if (floatOpen) renderPanel();
  }
}

/** 拉取历史（v1 单序列，仅内置 opencode-go 有图；其余 provider 无历史显示）。 */
async function refreshHistory(): Promise<void> {
  const gen = renderGeneration;
  try {
    const body = await fetchHistory(MAX_HISTORY_DAYS);
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
  const label = lastData && lastData.label ? lastData.label : currentProvider;
  const head = el("div", { class: PILL_PREFIX + "head" }, [
    el("h3", { class: PILL_PREFIX + "title", text: `${label} 用量` }),
    el("button", { class: PILL_PREFIX + "btn", type: "button", text: "刷新", onClick: () => { void refreshStats(); } }),
  ]);
  floatPanel.appendChild(head);

  chartsBox = el("div", { class: PILL_PREFIX + "charts" });
  floatPanel.appendChild(chartsBox);

  // 先调用上一次渲染器 disposer，再渲染新内容（防泄漏）
  if (renderDisposer !== null) {
    try { renderDisposer(); } catch { /* 忽略 */ }
    renderDisposer = null;
  }

  const renderer = registry?.get(currentProvider);
  if (currentProvider === FALLBACK_PROVIDER && detectedProvider === undefined) {
    // 未识别会话：回落内置展示（无感升级场景），直接渲染并提示
    rendererCharts(renderer);
    appendNoSessionHint();
    return;
  }
  if (renderer === undefined) {
    floatPanel.appendChild(el("p", { class: PILL_PREFIX + "error", text: `该提供商（${currentProvider}）未配置适配器。` }));
    floatPanel.appendChild(el("p", { class: PILL_PREFIX + "hint", text: "在配置中注入自定义适配器，或在设置面板「用量统计」中管理。" }));
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
      data: lastData,
      mount: chartsBox,
      history: lastHistory ?? undefined,
    };
    const disposed = renderer.render(ctx);
    if (typeof disposed === "function") renderDisposer = disposed;
  } catch (error) {
    console.warn("[dsh-opencode-usage] 渲染器运行出错", error);
    chartsBox.appendChild(el("p", { class: PILL_PREFIX + "error", text: "渲染器出错了。" }));
  }
}

function appendNoSessionHint(): void {
  floatPanel?.appendChild(el("p", { class: PILL_PREFIX + "hint", text: "当前未识别选中会话，暂按内置 OpenCode Go 展示；选中会话后将按会话 provider 分派。" }));
}

function appendFoot(): void {
  if (floatPanel === undefined) return;
  const foot = el("div", { class: PILL_PREFIX + "foot" }, [
    el("span", { text: currentProvider === FALLBACK_PROVIDER ? "数据来自 opencode.ai 官方用量接口" : `提供方：${currentProvider}` }),
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
  if (floatPill !== undefined) renderPill();
  if (floatOpen && floatPanel !== undefined) renderPanel();
  void refreshStats();
  if (currentProvider === FALLBACK_PROVIDER) void refreshHistory();
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
    if (currentProvider === FALLBACK_PROVIDER) void refreshHistory();
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
  if (currentProvider === FALLBACK_PROVIDER) void refreshHistory();

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
  };
}

// ------------------------------------------------------------------ 插件入口

/**
 * 插件入口：注入样式 + 注册渲染器 + provider 检测 + 挂载浮窗。
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
    installGlobalBridge(registry);

    const disposeFloat = mountFloat();

    // provider 检测（M0 路径）：会话变化 → 重新解析 provider → 重渲染
    let unsubSessions: (() => void) | undefined;
    const detect = (): void => {
      void (async () => {
        const detected = await resolveProviderFromSession(sessions, connection);
        const next = detected ?? FALLBACK_PROVIDER;
        // 会话消失 → detectedProvider=undefined 且回落内置，避免误判差异
        const prevDetected = detectedProvider;
        detectedProvider = detected;
        if (next !== currentProvider || (prevDetected !== undefined && detected === undefined)) {
          currentProvider = next;
          onProviderChanged();
        } else if (prevDetected === undefined && detected !== undefined) {
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
    }, "dsh-opencode-usage: float");
  } catch (error) {
    console.warn("[dsh-opencode-usage] 悬浮框挂载失败", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
export const inject: string[] = [];