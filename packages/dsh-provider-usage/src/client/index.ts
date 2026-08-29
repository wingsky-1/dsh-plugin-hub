/**
 * dsh-provider-usage — 用量悬浮框（客户端入口，v2）。
 *
 * v2 架构：渲染在宿主端完成（formatCapsule/formatPanel 返回 HTML），客户端只做：
 * - 胶囊框架挂载与定位（dou-float 按钮：状态点 + HTML 内容区）
 * - 面板框架挂载（head/内容区/foot，内容区注入宿主返回的 panelHtml）
 * - 60s 轮询 /stats + 可见性刷新（每次取数前先复检会话当前 provider，#71 A1 自愈）
 * - provider 会话检测（宿主 currentProvideInfo 订阅：切换会话即时跟随）
 * - 设置面板 section 注册（settings.ts React 组件）
 *
 * 纪律：任何异常只 warn，绝不让 GUI 启动失败；请求带超时不挂起。
 */
import {
  resolveProviderFromSession,
  decideProviderAfterDetect,
  currentSessionId,
  fetchStats,
  fetchHistory,
  fetchUiConfig,
  DEFAULT_CLIENT_UI_CONFIG,
  FALLBACK_PROVIDER,
  UNKNOWN_PROVIDER_HINT,
} from "./core.ts";
import type { SessionsServiceLike, ConnectionHandleLike, StatsResponseV2, HistoryResponseV2, UiPlacementConfig } from "./core.ts";
import { SettingsPage } from "./settings.ts";
import {
  BREAKPOINT_NARROW_MAX,
  BREAKPOINT_TABLET_MAX,
  DEFAULT_Z_INDEX_BASE,
  breakpointForWidth,
  clampPointToViewport,
  clampZIndexBase,
  panelAnchorForPlacement,
  panelZIndexFor,
} from "../placement-math.ts";
// React externals 路径：运行时由 dsh web factory require("react") 注入
import * as React from "react";
import STYLE from "./style.css";

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
/** 最近一次成功检测的 provider（issue #69 方案 B：全链失败时的保持值；undefined = 从未成功）。 */
let detectedProvider: string | undefined;
/** true = 有会话但 provider 未能确认（胶囊 title 标注「提供商未识别」）。 */
let providerUnknown = false;
/** 最近一次 /stats 响应。 */
let lastStats: StatsResponseV2 | null = null;
/** 最近一次 /history 响应。 */
let lastHistory: HistoryResponseV2 | null = null;
/** 渲染代 token（防竞态）。 */
let renderGeneration = 0;
/** 用户适配器版本（变化即全量重置，防新数据旧模板混搭）。 */
let lastAdapterVersion = 0;

/** 胶囊/面板位置配置（设置页保存后经 60s 轮询 + 回前台即时刷新）。 */
let uiConfig: UiPlacementConfig = { ...DEFAULT_CLIENT_UI_CONFIG };

/** 按当前配置重算胶囊位置（模块级：mountFloat 与配置变更共用）。
 *  固定定位（fixed）：胶囊钉在会话容器视口（rect）内，滚动内容滑动不改变其位置，
 *  无动态避让（不再探测 MCP 浮窗做偏移），彻底消除滚动时频繁位移造成的 jitter/闪烁。
 *  位置完全由配置的 placement/offset 决定（配置值即最终位置，滚动稳定）。 */
function repositionPill(pill: HTMLElement, target: HTMLElement): void {
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  // 断点判定基准 = conversationHost rect 宽度（JS 判定，非 @media——防桌面窄窗 /
  // iPad Slide Over 误触发）；data 属性驱动 CSS 档位样式（胶囊与面板同步）。
  const bp = breakpointForWidth(rect.width);
  if (pill.dataset.douBp !== bp) pill.dataset.douBp = bp;
  if (floatPanel !== undefined && floatPanel.dataset.douBp !== bp) floatPanel.dataset.douBp = bp;
  // 层级：胶囊取配置基准（clamp 1-9000），面板派生基准+30。
  const zBase = clampZIndexBase(uiConfig.zIndexBase, DEFAULT_Z_INDEX_BASE);
  pill.style.zIndex = String(zBase);
  if (floatPanel !== undefined) floatPanel.style.zIndex = String(panelZIndexFor(zBase));
  const isBottom = panelAnchorForPlacement(uiConfig.placement) === "bottom";
  const isLeft = uiConfig.placement === "top-left" || uiConfig.placement === "bottom-left";
  pill.style.position = "fixed";
  pill.style.bottom = "auto";
  // 水平：left 锚点 → 容器左缘 + offsetX；right 锚点 → 容器右缘 - 宽 - offsetX（右侧对齐贴右缘）
  const rawLeft = isLeft
    ? Math.max(0, rect.left + uiConfig.offsetX)
    : Math.max(0, rect.right - pill.offsetWidth - uiConfig.offsetX);
  // 垂直：bottom 锚点 → 容器底 - 高 - offsetY（clamp 到视口上缘防溢出）；top 锚点 → 容器顶 + offsetY
  const rawTop = isBottom
    ? Math.max(6, rect.bottom - pill.offsetHeight - uiConfig.offsetY)
    : Math.max(0, rect.top + uiConfig.offsetY);
  // 终坐标视口 clamp（safe-area 语义：宿主无 viewport-fit=cover → inset 恒 0，
  // 自然退化为普通 clamp，桌面行为不回归）。
  const point = clampPointToViewport(
    rawLeft, rawTop, pill.offsetWidth, pill.offsetHeight,
    window.innerWidth, window.innerHeight,
  );
  pill.style.left = `${Math.round(point.x)}px`;
  pill.style.top = `${Math.round(point.y)}px`;
  pill.style.right = "auto";
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
    let title: string;
    if (!stats.configured) {
      title = `${currentProvider} · 未配置适配器，点击查看接入引导`;
    } else if (stats.error !== null && stats.error !== undefined) {
      title = `用量获取失败：${stats.error}`;
    } else if ((stats as { reason?: string | null }).reason === "busy") {
      title = `${stats.adapterName} · 取数进行中，稍候自动刷新`;
    } else {
      title = `${stats.adapterName} · ${stats.status === "stale" ? "数据陈旧" : stats.status === "cached" ? "缓存" : "实时"} · 更新于 ${fmtAge(stats.fetchedAt)}`;
    }
    // issue #69 方案 B：有会话但 provider 未确认 → title 显式标注（不再静默展示可能不对的数据）
    if (providerUnknown) title += ` · ${UNKNOWN_PROVIDER_HINT}`;
    floatPill.title = title;
  }
  if (labelEl !== null) {
    if (stats?.capsuleHtml) labelEl.innerHTML = stats.capsuleHtml;
    else if (stats !== null) labelEl.textContent = currentProvider;
    else labelEl.textContent = "";
  }
  if (dotEl !== null) dotEl.className = `${PILL_PREFIX}dot dou-dot-${pillDotLevel(stats)}`;
}

// ------------------------------------------------------------------ 数据拉取

/**
 * A1（issue #71）：从会话现场复检 provider——detect 与 refreshStats 共用的检测半区。
 * 解析当前会话实际 provider/model（沿祖先链，#69 语义不变），与 currentProvider 不同则
 * 就地切换并重置渲染状态（代 token 前进防旧响应回写），返回是否发生变化。
 * 不主动拉数（由调用方决定），避免 refreshStats 内部递归。
 */
async function revalidateProvider(): Promise<boolean> {
  if (sessions === undefined) return false;
  // 先同步取会话在场快照（区分「无任何会话」与「有会话但不可解析」，await 前读取防竞态）
  const hadSession = currentSessionId(sessions) !== undefined;
  const resolved = await resolveProviderFromSession(sessions, connection);
  const decision = decideProviderAfterDetect({
    resolved,
    hadSession,
    previousDetected: detectedProvider,
  });
  if (resolved !== undefined) detectedProvider = resolved;
  providerUnknown = decision.unknown;
  if (decision.provider === currentProvider) return false;
  currentProvider = decision.provider;
  renderGeneration += 1;
  lastStats = null;
  lastHistory = null;
  lastAdapterVersion = 0;
  return true;
}

/** 拉取当前 provider 用量并刷新胶囊（失败落错误态，不向上抛）。 */
async function refreshStats(): Promise<void> {
  let gen = renderGeneration;
  try {
    // A1（issue #71）：取数前先复检会话当前 provider/model——60s 轮询、可见性恢复、
    // 手动刷新均在此自愈；会话内切模型虽无宿主信号触发 detect()，最长一个轮询周期内跟随
    if (await revalidateProvider()) {
      if (floatPill !== undefined) renderPill();
      if (floatOpen && floatPanel !== undefined) renderPanel();
    }
    gen = renderGeneration; // 复检可能推进代号，取数前再读
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

  // qa F1（#128 实测）：bottom-* 锚点下面板高度增长不会自动改写 top——打开瞬间以
  // 「加载中」小高度定位，异步数据撑高面板后若无重排路径则稳定向下溢出视口。
  // 内容更新完成即同步重定位（DOM 已构建，offsetHeight 即时正确；数据到达为低频
  // 路径，无需 rAF 合并），clampPointToViewport 继续兜底钳回视口内。
  if (floatOpen) applyUiPlacement();
}

// ------------------------------------------------------------------ provider 变化

/** provider 已切换（状态重置由 revalidateProvider 完成）→ 重渲染 + 立即取新数据。 */
function onProviderChanged(): void {
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
    // 先渲染再定位（F1 配套）：以真实内容高度定位，消除首帧小高度错位；
    // 后续异步数据撑高由 renderPanel 尾部的重定位兜底。
    renderPanel();
    placePanel();
    // 展开面板只拉历史（每次都调）；胶囊文案由轮询维护，不重复调 stats
    void refreshHistory();
  }
}

function placePanel(): void {
  if (floatPill === undefined || floatPanel === undefined) return;
  const rect = floatPill.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  // 翻转逻辑：底部锚点（bottom-*）→ 面板向上弹出（以胶囊上缘为基准，留配置面板间距
  // 并 clamp 到视口上缘，不溢出）；顶部锚点（top-*）→ 向下弹出（历史行为）。
  const anchorBottom = panelAnchorForPlacement(uiConfig.placement) === "bottom";
  const isLeft = uiConfig.placement === "top-left" || uiConfig.placement === "bottom-left";
  const rawTop = anchorBottom
    ? Math.max(6, rect.top - floatPanel.offsetHeight - uiConfig.panelOffsetY)
    : Math.max(6, rect.bottom + uiConfig.panelOffsetY);
  // 水平：left 锚点面板左缘贴胶囊左缘；right 锚点等价换算为 left 后统一处理
  // （与旧 right 定位相同的视觉结果），再经视口终 clamp 兜底。
  const rawLeft = isLeft
    ? Math.max(10, Math.round(rect.left))
    : Math.max(10, Math.round(rect.right - floatPanel.offsetWidth));
  const point = clampPointToViewport(
    rawLeft, rawTop, floatPanel.offsetWidth, floatPanel.offsetHeight,
    window.innerWidth, window.innerHeight,
  );
  floatPanel.style.left = `${Math.round(point.x)}px`;
  floatPanel.style.top = `${Math.round(point.y)}px`;
  floatPanel.style.right = "auto";
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

  /** rAF 合并调度：同帧多次 scroll/resize/vv-resize/orientationchange 只重算一次（#128）。 */
  let placeRafId = 0;
  const scheduleReposition = (): void => {
    if (placeRafId !== 0) return;
    placeRafId = requestAnimationFrame(() => {
      placeRafId = 0;
      if (host === null) return;
      repositionPill(pill, host);
      if (floatOpen) placePanel();
    });
  };
  // orientationchange 后延迟一帧重算：横竖屏切换瞬间 rect 尚未更新（规格 #128 第 2 条）。
  const onOrientationChange = (): void => { scheduleReposition(); };
  // 软键盘弹出/收起：visualViewport resize 监听（iOS 13+ 全支持），fixed 元素跟随视口。
  const onVisualViewportResize = (): void => { scheduleReposition(); };

  const attachListeners = (target: HTMLElement): void => {
    for (const stop of listeners) { try { stop(); } catch { /* 忽略 */ } }
    listeners.length = 0;
    target.addEventListener("scroll", scheduleReposition, { passive: true });
    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("orientationchange", onOrientationChange);
    window.visualViewport?.addEventListener("resize", onVisualViewportResize);
    listeners.push(() => {
      target.removeEventListener("scroll", scheduleReposition);
      window.removeEventListener("resize", scheduleReposition);
      window.removeEventListener("orientationchange", onOrientationChange);
      window.visualViewport?.removeEventListener("resize", onVisualViewportResize);
    });
    repositionPill(pill, target);
    if (floatOpen) placePanel();
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

  // MutationObserver 去抖：宿主 DOM 批量变更合并到一帧处理（#128 第 7 条）。
  let observerRafId = 0;
  const schedulePlace = (): void => {
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

  renderPill();
  void refreshStats();

  // #308：胶囊位置配置改为「启动拉取一次 + 60s 轮询 + 回前台即时拉取」，
  // 移除常驻 SSE（/api/dsh-provider-usage/events）。动机：SSE 是 EventSource
  // 长连接，移动端切后台系统冻结 JS 并静默掐断 TCP 后形成半开连接——浏览器侧
  // 不触发 error/close，连接持续占用同源 6 连接池，回前台后新请求全部 stalled
  // 超时（与 mcp-manager 的 #268 同根因，此处直接不再持有长连接，从源头消除）。
  // ui-config 变更的即时性由「设置页保存后跨端同步」降级为≤60s 收敛，UI 可接受；
  // 拉取本身经 fetchTimeout 10s 兜底，半开时不悬挂。
  const syncUiConfig = (): void => {
    void fetchUiConfig()
      .then((cfg) => {
        uiConfig = cfg;
        applyUiPlacement();
      })
      .catch(() => { /* 网络/超时：保留旧配置，下次轮询重试 */ });
  };
  syncUiConfig();

  refreshTimer = setInterval(() => {
    void refreshStats();
    syncUiConfig();
  }, REFRESH_MS);
  const onVisible = (): void => {
    if (document.visibilityState === "visible") {
      void refreshStats();
      syncUiConfig();
    }
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    observer.disconnect();
    for (const stop of listeners) { try { stop(); } catch { /* 忽略 */ } }
    if (placeRafId !== 0) { cancelAnimationFrame(placeRafId); placeRafId = 0; }
    if (observerRafId !== 0) { cancelAnimationFrame(observerRafId); observerRafId = 0; }
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    document.removeEventListener("visibilitychange", onVisible);
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
    // （issue #69：子代理会话 models() 必拒（agent-busy），检测沿 parentId 上溯父会话；
    //   全链失败保持上次检测结果并标注未识别，仅「从未成功」才回落默认——不再无条件回落）
    // 检测半区已抽为 revalidateProvider（A1，issue #71）：与 refreshStats 取数前复检共用。
    let unsubSessions: (() => void) | undefined;
    const detect = (): void => {
      void (async () => {
        const changed = await revalidateProvider();
        if (changed) {
          onProviderChanged(); // provider 变了 → 立即重拉（切换会话即时跟随）
          return;
        }
        renderPill(); // provider 未变但未知标注可能变化 → 刷胶囊 title
        // 维护者补充需求（issue #71）：切换会话即使 provider 相同也立即刷一次 stats，
        // 不等 60s 轮询 / visibilitychange（浮窗在场才刷；roster 变化触发的 detect 同样受益）
        if (floatPill !== undefined) void refreshStats();
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
      detectedProvider = undefined;
      providerUnknown = false;
      sessions = undefined;
      connection = undefined;
    }, "dsh-provider-usage: float");
  } catch (error) {
    console.warn("[dsh-provider-usage] 悬浮框挂载失败", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
export const inject: string[] = [];