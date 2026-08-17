/**
 * dsh-opencode-usage — OpenCode Go 套餐用量悬浮框（客户端）。
 *
 * 右上角悬浮胶囊：常驻显示三窗口消耗百分比，颜色随消耗程度变化；
 * 点击展开下拉面板：rolling / weekly / monthly 三张独立迷你图卡片（取代
 * 原「合并波浪图 + 进度条」）：每张卡片标题行 = 色点 + 窗口名 + 当前百分比
 * + Δ 趋势箭头 + 限额与重置时间，下方为时间面积图。每图 x 轴范围按窗口
 * 观察周期独立动态切片（rolling 5h 滑动窗口看最近 24h 使用模式 / weekly
 * 自然周看最近 7d / monthly 看全部采样期），y 轴按各窗口数据独立自适应
 * （nice 刻度域，逼近上限时纳入 100% 红色参考虚线），每图自带 x 轴时间
 * 刻度（跨度自适应格式）；重置点画灰色竖虚线 + 顶部三角（解释固定周期
 * 窗口断崖式归零）；面板底部显示数据新鲜度（相对时间）。
 * 历史连续性：宿主端低频后台采样（sampleIntervalMs 默认 5 分钟）保证浏览器
 * 关闭时也持续记录（本端只负责展示）。
 *
 * 数据流：一律走宿主 /api 路由（GET /api/dsh-opencode-usage/stats 与
 * /api/dsh-opencode-usage/history，与 host 端 ROUTES 一致——smoke 断言两端
 * 不漂移），宿主调官方 /v1/usage 接口并累积采样历史；本端不做任何业务计算。
 * 刷新策略：打开面板/胶囊点击时立即刷新 + 60s 轮询 + 页面重新可见时刷新；
 * 面板开着时轮询成功后顺带重拉历史（≥30s 间隔）刷新波浪图。
 *
 * 挂载策略（dsh-ui-dev 规范）：胶囊挂在会话滚动容器
 * [data-conversation-scroll] 内 absolute 定位并随滚动同步；容器晚渲染时
 * 先挂 body，MutationObserver 每次 DOM 变化重新求最佳宿主并迁移（绝不用
 * isConnected 短路）；下拉面板 fixed 挂 body，按胶囊 getBoundingClientRect
 * 定位，scroll/resize 重定位。全部颜色走 --dsw-alias-* 主题变量。
 */
// 构建注入：bundle-host 以 esbuild --define 注入完整 npm 包名（load id 契约 = 包名）
declare var __DSH_PLUGIN_ID__: string;
(function () {
  "use strict";

  /** 与 host 端 ROUTES.stats 一致（单一来源，smoke 校验）。 */
  var STATS_URL = "/api/dsh-opencode-usage/stats";
  /** 与 host 端 ROUTES.history 一致（历史采样序列，波浪图数据源）。 */
  var HISTORY_URL = "/api/dsh-opencode-usage/history";

  /** 三窗口图卡片配置：[key, 中文名, 颜色（主题变量 + 回退）, 展示限额,
   * x 轴观察周期（毫秒；null = 全量采样期）, 重置周期（毫秒，重置线反推用；
   * monthly 按 30d 近似，订阅日不定，图内 ≤1-2 条误差可接受）]。
   * x 范围按窗口语义动态切片：rolling 是 5h 滑动窗口，看最近 12h（约 2.4
   * 个滚动周期）的使用模式；weekly 自然周一整周期看 7d；monthly 月重置，看
   * 最近 30d（覆盖完整订阅月，看清月初清零→月末逼近的完整形态）。 */
  var CHART_SERIES: any[] = [
    ["rolling", "5h 滚动", "var(--dsw-alias-state-business-primary,#3b82f6)", "$12", 12 * 3600000, 5 * 3600000],
    ["weekly", "每周", "var(--dsw-alias-state-warn-primary,#c9820b)", "$30", 7 * 86400000, 7 * 86400000],
    ["monthly", "每月", "var(--dsw-alias-state-success-primary,#0f9d6e)", "$60", 30 * 86400000, 30 * 86400000],
  ];

  /** 波浪图降采样上限（约每像素一点，保证万点级秒出图）。 */
  var CHART_MAX_POINTS = 300;

  var REFRESH_MS = 60000; // 轮询间隔
  var HISTORY_MIN_GAP_MS = 30000; // 历史重拉最小间隔（面板开着时防刷）
  var PILL_PREFIX = "dou-"; // 样式类名前缀（防与 shell 冲突）

  var styleText =
    "[" +
    PILL_PREFIX +
    'conversation]{position:relative}' +
    "." +
    PILL_PREFIX +
    'float{position:absolute;top:8px;right:14px;z-index:40;display:flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-radius:99px;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.10);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.2;white-space:nowrap}' +
    "." +
    PILL_PREFIX +
    'float:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f6)}' +
    "." +
    PILL_PREFIX +
    'dot{width:7px;height:7px;border-radius:50%;flex:none}' +
    "." +
    PILL_PREFIX +
    'dot-ok{background:var(--dsw-alias-state-success-primary,#0f9d6e)}' +
    "." +
    PILL_PREFIX +
    'dot-warn{background:var(--dsw-alias-state-warn-primary,#c9820b)}' +
    "." +
    PILL_PREFIX +
    'dot-err{background:var(--dsw-alias-state-error-primary,#d64545)}' +
    "." +
    PILL_PREFIX +
    'dot-off{background:var(--dsw-alias-label-tertiary,#9aa0ab)}' +
    "." +
    PILL_PREFIX +
    'panel{position:fixed;top:44px;right:14px;width:min(340px,calc(100vw - 36px));max-height:min(72vh,560px);overflow:auto;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);border:1px solid var(--dsw-alias-border-l1,#e2e4ea);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18);z-index:70;padding:12px 14px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px}' +
    "." +
    PILL_PREFIX +
    "panel[hidden]{display:none!important}" +
    "." +
    PILL_PREFIX +
    'head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}' +
    "." +
    PILL_PREFIX +
    'title{font-size:14px;font-weight:600;margin:0}' +
    "." +
    PILL_PREFIX +
    'card{border:1px solid var(--dsw-alias-border-l2,#e8eaf0);background:var(--dsw-alias-bg-layer-1,#f8f9fb);border-radius:8px;padding:10px 12px;margin-bottom:8px}' +
    "." +
    PILL_PREFIX +
    'cardHead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px}' +
    "." +
    PILL_PREFIX +
    'cardName{font-size:13px;font-weight:600;margin:0}' +
    "." +
    PILL_PREFIX +
    'cardLimit{color:var(--dsw-alias-label-tertiary,#9aa0ab);font-size:11px;margin:0}' +
    "." +
    PILL_PREFIX +
    'label{white-space:nowrap}' +
    "." +
    PILL_PREFIX +
    'cardMeta{display:flex;align-items:center;gap:5px;min-width:0}' +
    "." +
    PILL_PREFIX +
    'cardCur{font-weight:700;font-size:14px;color:var(--dsw-alias-label-primary,#1c1e26)}' +
    "." +
    PILL_PREFIX +
    'trend-up{color:var(--dsw-alias-state-error-primary,#d64545);font-weight:600;font-size:11px}' +
    "." +
    PILL_PREFIX +
    'trend-down{color:var(--dsw-alias-state-success-primary,#0f9d6e);font-weight:600;font-size:11px}' +
    "." +
    PILL_PREFIX +
    'trend-flat{color:var(--dsw-alias-label-tertiary,#9aa0ab);font-size:11px}' +
    "." +
    PILL_PREFIX +
    'foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;color:var(--dsw-alias-label-tertiary,#9aa0ab);font-size:11px}' +
    "." +
    PILL_PREFIX +
    'btn{border:1px solid var(--dsw-alias-border-l2,#e8eaf0);background:transparent;color:var(--dsw-alias-label-primary,#1c1e26);font:inherit;font-size:12px;border-radius:6px;padding:4px 10px;cursor:pointer}' +
    "." +
    PILL_PREFIX +
    'btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f6)}' +
    "." +
    PILL_PREFIX +
    'error{color:var(--dsw-alias-state-error-primary,#d64545);font-size:12px;line-height:1.6;margin:4px 0 8px}' +
    "." +
    PILL_PREFIX +
    'hint{color:var(--dsw-alias-label-tertiary,#9aa0ab);font-size:11px;line-height:1.6;margin:4px 0 8px}' +
    "." +
    PILL_PREFIX +
    'miniChart svg{display:block;width:100%;height:auto}' +
    "." +
    PILL_PREFIX +
    "miniChart svg text{font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#9aa0ab)}" +
    "." +
    PILL_PREFIX +
    'chartEmpty{color:var(--dsw-alias-label-tertiary,#9aa0ab);font-size:11px;line-height:1.7;padding:18px 6px;text-align:center}' +
    "." +
    PILL_PREFIX +
    'legendDot{width:8px;height:8px;border-radius:50%;flex:none}' +
    "." +
    PILL_PREFIX +
    'miniChart{margin-top:6px}';

  /**
   * el() helper（dsh-ui-dev 三坑已规避）：
   * - children 同时支持第三位置参数与 attrs.children
   * - dataset 键用 Object.assign(node.dataset, value)
   * - onX 事件键与 class / text / checked / disabled 键
   */
  function el(tag: any, attrs: any, children?: any) {
    var node = document.createElement(tag);
    if (attrs !== undefined && attrs !== null) {
      var kids = attrs.children;
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (key === "children") continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key === "checked") node.checked = value;
        else if (key === "disabled") node.disabled = value;
        else if (key === "hidden") node.hidden = value;
        else if (key.slice(0, 2) === "on" && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value !== undefined && value !== null) node.setAttribute(key, value);
      }
      if (kids !== undefined) children = kids;
    }
    if (children !== undefined) {
      var list = Array.isArray(children) ? children : [children];
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i];
        if (item === undefined || item === null) continue;
        node.appendChild(typeof item === "string" ? document.createTextNode(item) : item);
      }
    }
    return node;
  }

  /** 注入样式（一次性，data 标记防重复；head 未就绪时挂 DOMContentLoaded
   * 重试——apply 执行过早会静默漏注入，导致浮窗无样式裸奔）。 */
  function injectStyle() {
    if (document.head === null) {
      document.addEventListener("DOMContentLoaded", injectStyle, { once: true });
      return;
    }
    if (document.querySelector("style[data-dou-style]") !== null) return;
    var style = document.createElement("style");
    style.setAttribute("data-dou-style", "");
    style.textContent = styleText;
    document.head.appendChild(style);
  }

  var floatPill: any; // 悬浮胶囊（挂在会话滚动容器）
  var floatPanel: any; // 下拉面板（fixed 挂 body）
  var floatOpen = false;
  var lastData: any = null; // 最近一次 stats 响应（渲染用）
  var lastHistory: any = null; // 最近一次 history 响应（波浪图渲染用）
  var lastHistoryAt = 0; // 上次成功拉取 history 的时刻（防刷间隔）
  var chartsBox: any; // 三窗口迷你图卡片区（renderPanel 时创建）
  var chartsResizeObs: any = null; // 迷你图容器 ResizeObserver（手机端字号补偿重排）
  var refreshTimer: any = null;

  /** 会话滚动容器：聊天消息实际滚动的区域（shell 的 data-conversation-scroll）。 */
  function conversationHost() {
    return document.querySelector('[data-conversation-scroll]')
      ?? document.querySelector('[data-pane="conversation"]')
      ?? document.body;
  }

  /** 拉取用量统计（宿主权威源）。失败已内部消化为 UI 错误态，不向上抛。 */
  function fetchStats() {
    return fetch(STATS_URL, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (body) {
        lastData = body;
        renderPill();
        if (floatOpen) renderPanel();
        // 面板开着时顺带刷新波浪图（≥HISTORY_MIN_GAP_MS 间隔，防刷）
        if (floatOpen && Date.now() - lastHistoryAt >= HISTORY_MIN_GAP_MS) void fetchHistory();
        return body;
      })
      .catch(function () {
        lastData = { ok: true, configured: true, error: "network", usage: null };
        renderPill();
        if (floatOpen) renderPanel();
        return null;
      });
  }

  /** 消耗程度 → 状态点/进度条色：>95% 红，>80% 黄，否则绿。 */
  function levelOf(pct: any) {
    if (pct === null || pct === undefined) return "off";
    if (pct >= 95) return "err";
    if (pct >= 80) return "warn";
    return "ok";
  }

  /** 胶囊文案：三个窗口百分比并排（5h 滚动 / 周 / 月），无需展开面板即可
   * 总览全部额度；未配置/失败显示占位。 */
  function pillLabel() {
    var data = lastData;
    if (data === null) return "Go --%";
    if (data.configured !== true || data.error !== null || data.usage === null) return "Go --%";
    var parts: any = [];
    var u = data.usage;
    if (u.rolling && typeof u.rolling.percent === "number") parts.push("5h " + u.rolling.percent + "%");
    if (u.weekly && typeof u.weekly.percent === "number") parts.push("周 " + u.weekly.percent + "%");
    if (u.monthly && typeof u.monthly.percent === "number") parts.push("月 " + u.monthly.percent + "%");
    return parts.length > 0 ? parts.join(" · ") : "Go --%";
  }

  /** 状态点：取三个窗口中消耗最高者（最保守的告警）。 */
  function pillDot() {
    var data = lastData;
    if (data === null) return "off";
    if (data.configured !== true) return "off";
    if (data.error !== null || data.usage === null) return "err";
    var worst: any = null;
    var u = data.usage;
    for (var i = 0; i < CHART_SERIES.length; i += 1) {
      var win = u[CHART_SERIES[i][0]];
      if (win && typeof win.percent === "number" && (worst === null || win.percent > worst)) worst = win.percent;
    }
    return levelOf(worst);
  }

  function pillTitle() {
    var data = lastData;
    if (data === null) return "OpenCode Go 用量（加载中…）";
    if (data.configured !== true) return "OpenCode Go：未配置 API Key（OPENCODE_GO_API_KEY）";
    if (data.error !== null) return "OpenCode Go 用量获取失败：" + data.error;
    if (data.usage === null) return "OpenCode Go 用量（暂无数据）";
    var m = data.usage.monthly;
    var w = data.usage.weekly;
    var r = data.usage.rolling;
    var parts: any = [];
    if (r && typeof r.percent === "number") parts.push("5h " + r.percent + "%");
    if (w && typeof w.percent === "number") parts.push("周 " + w.percent + "%");
    if (m && typeof m.percent === "number") parts.push("月 " + m.percent + "%");
    return "OpenCode Go 用量：" + parts.join(" · ");
  }

  function renderPill() {
    if (floatPill === undefined) return;
    floatPill.title = pillTitle();
    floatPill.querySelector("." + PILL_PREFIX + "label").textContent = pillLabel();
    var dot = floatPill.querySelector("." + PILL_PREFIX + "dot");
    dot.className = PILL_PREFIX + "dot dou-dot-" + pillDot();
  }

  /** 重置时间本地化展示。 */
  function fmtReset(iso: any) {
    if (typeof iso !== "string" || iso === "") return "未知";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  /** x 轴时间标签（跨度自适应格式）：≥7d 仅日期 MM-dd；≥24h 带日期
   * MM-dd HH:mm；其余仅 HH:mm。 */
  function fmtAxisTime(ts: any, spanMs: any) {
    var d = new Date(ts);
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate()).padStart(2, "0");
    var hh = String(d.getHours()).padStart(2, "0");
    var mi = String(d.getMinutes()).padStart(2, "0");
    if (spanMs >= 7 * 86400000) return mm + "-" + dd;
    if (spanMs >= 86400000) return mm + "-" + dd + " " + hh + ":" + mi;
    return hh + ":" + mi;
  }

  /** nice 刻度步长（业界标准 1/2/5 × 10^k，Grafana/matplotlib 风格）。 */
  function niceStep(raw: any) {
    if (!(raw > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    if (norm < 1.5) return mag;
    if (norm < 3.5) return 2 * mag;
    if (norm < 7.5) return 5 * mag;
    return 10 * mag;
  }

  /**
   * y 轴自适应域（每窗口独立，突出各自波动——业界多面板 dashboard 惯例）：
   * 下界下取整、上界上取整到 nice 刻度；域宽至少 3 格且 ≥2%（防常量/微波动
   * 数据把噪声放大或标签过密，平线以数据中点居中）；数据逼近上限（≥90%）
   * 时顶到 100，让 100% 参考线可见。
   */
  function niceDomain(pcts: any) {
    var vals: any = [];
    for (var i = 0; i < pcts.length; i += 1) {
      var v = pcts[i];
      if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) return [0, 100];
    var dmin = vals[0];
    var dmax = vals[0];
    for (var j = 1; j < vals.length; j += 1) {
      if (vals[j] < dmin) dmin = vals[j];
      if (vals[j] > dmax) dmax = vals[j];
    }
    var step = niceStep((dmax - dmin) / 3);
    var lo = Math.max(0, Math.floor(dmin / step) * step);
    var hi = Math.ceil(dmax / step) * step;
    var minSpan = Math.max(3 * step, 2);
    if (hi - lo < minSpan) {
      var mid = (dmin + dmax) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
      if (lo < 0) {
        hi += -lo;
        lo = 0;
      }
      if (hi > 100) {
        lo = Math.max(0, lo - (hi - 100));
        hi = 100;
      }
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
    }
    if (dmax >= 90 && hi < 100) hi = 100;
    if (hi > 100) hi = 100;
    if (lo >= hi) lo = Math.max(0, hi - 5);
    return [lo, hi];
  }

  /** y 轴刻度标签：整数直出，小数保留 1 位。 */
  function fmtPctTick(v: any) {
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "%";
  }

  /** x 轴时间刻度步长（跨度自适应：2/5/15 分钟、1/3/6 小时、1 天…）。 */
  function timeTickStep(spanMs: any) {
    if (spanMs <= 10 * 60000) return 2 * 60000;
    if (spanMs <= 45 * 60000) return 5 * 60000;
    if (spanMs <= 3 * 3600000) return 15 * 60000;
    if (spanMs <= 12 * 3600000) return 3600000;
    if (spanMs <= 3 * 86400000) return 3 * 3600000;
    if (spanMs <= 7 * 86400000) return 6 * 3600000;
    if (spanMs <= 30 * 86400000) return 86400000;
    return 7 * 86400000;
  }

  /** 时间轴刻度序列（nice 对齐；过密时步长倍增，刻度数 ≤6；不足 2 个补端点）。 */
  function timeTicks(t0: any, t1: any) {
    var step = timeTickStep(t1 - t0);
    for (var guard = 0; guard < 6; guard += 1) {
      var first = Math.ceil(t0 / step) * step;
      var count = 0;
      for (var t = first; t <= t1 + 1; t += step) count += 1;
      if (count <= 6) break;
      step *= 2;
    }
    var out: any = [];
    var start = Math.ceil(t0 / step) * step;
    for (var tt = start; tt <= t1 + 1; tt += step) out.push(tt);
    if (out.length < 2) out = [t0, t1];
    return out;
  }

  /** 区间趋势：末点 - 首点（首个/末个非 null 点），±0.05% 内视为持平。 */
  function trendOf(pcts: any) {
    var first: any = null;
    var last: any = null;
    for (var i = 0; i < pcts.length; i += 1) {
      if (typeof pcts[i] === "number") {
        first = pcts[i];
        break;
      }
    }
    for (var j = pcts.length - 1; j >= 0; j -= 1) {
      if (typeof pcts[j] === "number") {
        last = pcts[j];
        break;
      }
    }
    if (first === null || last === null) return null;
    var d = last - first;
    return { delta: Math.round(d * 10) / 10, up: d > 0.05, down: d < -0.05 };
  }

  /**
   * 历史重置点序列：从 resetsAt（下一次重置时刻）按周期反推 k 个周期，
   * 返回落在 [t0, t1] 内的时刻（升序）。用于画重置标记竖线——解释曲线
   * 断崖式归零（固定周期窗口重置，如 weekly 自然周 / monthly 订阅日）。
   */
  function resetTicks(resetsAt: any, periodMs: any, t0: any, t1: any) {
    if (typeof resetsAt !== "string" || resetsAt === "" || !(periodMs > 0)) return [];
    var r = new Date(resetsAt).getTime();
    if (Number.isNaN(r)) return [];
    var out: any = [];
    if (r >= t0 && r <= t1) out.push(r);
    var ts = r - periodMs;
    for (var guard = 0; guard < 40 && ts >= t0; guard += 1) {
      out.push(ts);
      ts -= periodMs;
    }
    out.sort(function (a: any, b: any) { return a - b; });
    return out;
  }

  /** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前（数据新鲜度提示）。 */
  function fmtAge(ts: any) {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
    var diff = Date.now() - ts;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    return Math.floor(diff / 86400000) + " 天前";
  }

  /** 降采样：超出上限时按 bucket 抽稀，每 bucket 取峰值（保留尖峰形态）。 */
  function downsample(points: any, maxPoints: any) {
    if (points.length <= maxPoints) return points;
    var step = points.length / maxPoints;
    var out: any = [];
    for (var i = 0; i < points.length; i += step) {
      var start = Math.floor(i);
      var end = Math.min(points.length - 1, Math.floor(i + step));
      var best = start;
      for (var j = start + 1; j <= end; j += 1) {
        if (points[j].y > points[best].y) best = j;
      }
      out.push(points[best]);
    }
    var lastPt = points[points.length - 1];
    if (out[out.length - 1] !== lastPt) out.push(lastPt);
    return out;
  }

  /** Catmull-Rom → cubic Bezier 平滑路径（波浪质感）。 */
  function smoothPath(pts: any) {
    if (pts.length < 2) return "";
    var d = "M " + pts[0].x.toFixed(1) + " " + pts[0].y.toFixed(1);
    for (var i = 0; i < pts.length - 1; i += 1) {
      var p0 = pts[Math.max(0, i - 1)];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[Math.min(pts.length - 1, i + 2)];
      var c1x = p1.x + (p2.x - p0.x) / 6;
      var c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6;
      var c2y = p2.y - (p3.y - p1.y) / 6;
      d += " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + ", " + c2x.toFixed(1) + " " + c2y.toFixed(1) + ", " + p2.x.toFixed(1) + " " + p2.y.toFixed(1);
    }
    return d;
  }

  /**
   * 单窗口迷你图 SVG（时间面积图）：
   * - x 轴：按本窗口观察周期切片后的时间域，每图都绘制自适应刻度
   * - y 轴：按本窗口数据自适应域 [lo, hi]，画 lo/mid/hi 网格；域内含 100%
   *   时画红色参考虚线（配额上限语义，业界阈值线惯例）
   * - 重置线：从 resetsAt 反推历史重置时刻，画灰色竖虚线 + 顶部三角标记
   *   （解释固定周期窗口的断崖式归零）
   * - 曲线：平滑描边 + 半透明面积填充 + 末端当前值圆点高亮（sparkline 惯例）
   * 注意：SVG presentation attribute 不解析 CSS var()，颜色一律走 style 属性。
   */
  function miniChartSvgMarkup(samples: any, col: any, color: any, lo: any, hi: any, drawXAxis: any, resetAt: any, resetPeriodMs: any, fontScale: any) {
    var t0 = samples[0][0];
    var t1 = samples[samples.length - 1][0];
    if (t1 <= t0) t1 = t0 + 60000;
    var spanMs = t1 - t0;
    var W = 320;
    var H = 100;
    var PL = 34;
    var PR = 6;
    var PT = 14;
    var PB = 16;
    var xw = W - PL - PR;
    var plotH = H - PT - PB;
    // 手机端字号补偿：SVG 是 viewBox 等比缩放，可视字号 = 字号 × 缩放比
    // (容器宽/320)。窄屏（如 iOS 分享成桌面 app）会缩到近 7px 难读，故按
    // 缩放比倒数放大 viewBox 内字号，保持可视 ~9.5px 恒定。fontScale 缺省 1
    // （桌面 320px 无感）；<=0 时回落 1。
    var fsBase = 9.5;
    var sf = typeof fontScale === "number" && fontScale > 0 ? fontScale : 1;
    var fs = (fsBase / sf).toFixed(2);
    var fs100 = (9 / sf).toFixed(2);
    function xOf(ts: any) { return PL + ((ts - t0) / spanMs) * xw; }
    function yOf(pct: any) { return PT + ((hi - pct) / (hi - lo)) * plotH; }

    var parts: any = [];
    // 重置标记竖线（灰色虚线 + 顶部三角；悬浮提示「窗口重置」）
    var resets = resetTicks(resetAt, resetPeriodMs, t0, t1);
    for (var rr = 0; rr < resets.length; rr += 1) {
      var rx = xOf(resets[rr]);
      parts.push('<line x1="' + rx.toFixed(1) + '" y1="' + PT + '" x2="' + rx.toFixed(1) + '" y2="' + (PT + plotH) + '" style="stroke:var(--dsw-alias-label-tertiary,#9aa0ab);stroke-width:1;stroke-dasharray:2 3;stroke-opacity:.55"><title>窗口重置点</title></line>');
      parts.push('<path d="M ' + rx.toFixed(1) + " " + PT + " l 3.5 3.5 l -7 0 z\" style=\"fill:var(--dsw-alias-label-tertiary,#9aa0ab);fill-opacity:.55\"/>");
    }
    // y 轴网格 + 标签（下/中/上三线）
    var gridVals = [lo, (lo + hi) / 2, hi];
    for (var g = 0; g < gridVals.length; g += 1) {
      var gy = yOf(gridVals[g]);
      parts.push('<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '" style="stroke:var(--dsw-alias-border-l2,#e8eaf0);stroke-width:1;stroke-dasharray:3 3"/>');
      parts.push('<text x="' + (PL - 4) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" style="font-size:' + fs + 'px">' + fmtPctTick(gridVals[g]) + "</text>");
    }
    // 100% 配额上限参考线（域内含 100 时）
    if (lo <= 100 && 100 <= hi && hi - lo > 0.01) {
      var ly = yOf(100);
      parts.push('<line x1="' + PL + '" y1="' + ly.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + ly.toFixed(1) + '" style="stroke:var(--dsw-alias-state-error-primary,#d64545);stroke-width:1;stroke-dasharray:4 3;stroke-opacity:.65"/>');
      parts.push('<text x="' + (W - PR - 2) + '" y="' + (ly - 3).toFixed(1) + '" text-anchor="end" style="fill:var(--dsw-alias-state-error-primary,#d64545);font-size:' + fs100 + 'px">100%</text>');
    }
    // 数据线（钳制进域内，防御越界值）
    var line: any = [];
    for (var i = 0; i < samples.length; i += 1) {
      var pct = samples[i][col];
      if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
      var clamped = Math.min(Math.max(pct, lo), hi);
      line.push({ x: xOf(samples[i][0]), y: yOf(clamped) });
    }
    if (line.length >= 2) {
      var lpts = downsample(line, CHART_MAX_POINTS);
      var d = smoothPath(lpts);
      var first = lpts[0];
      var lastPt = lpts[lpts.length - 1];
      var bottom = PT + plotH;
      var areaD = d + " L " + lastPt.x.toFixed(1) + " " + bottom + " L " + first.x.toFixed(1) + " " + bottom + " Z";
      parts.push('<path d="' + areaD + '" style="fill:' + color + ";fill-opacity:.13\"/>");
      parts.push('<path d="' + d + '" style="fill:none;stroke:' + color + ";stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round\"/>");
      parts.push('<circle cx="' + lastPt.x.toFixed(1) + '" cy="' + lastPt.y.toFixed(1) + '" r="2.6" style="fill:' + color + ";stroke:var(--dsw-alias-bg-base,#fdfdfd);stroke-width:1.2\"/>");
    }
    // x 轴时间刻度（仅底部图绘制，三图共享同一时间域所以天然对齐）
    if (drawXAxis) {
      var ticks = timeTicks(t0, t1);
      for (var k = 0; k < ticks.length; k += 1) {
        var tx = xOf(ticks[k]);
        var anchor = k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle";
        parts.push('<text x="' + tx.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + anchor + '" style="font-size:' + fs + 'px">' + fmtAxisTime(ticks[k], spanMs) + "</text>");
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '">' + parts.join("") + "</svg>";
  }

  /** 趋势箭头元素（较区间首采样点）：上升红（消耗升高警示）/ 下降绿 / 持平灰。 */
  function trendEl(pcts: any) {
    var t = trendOf(pcts);
    if (t === null) return null;
    var cls: any;
    var txt: any;
    if (t.up) {
      cls = "dou-trend-up";
      txt = "▲ +" + t.delta + "%";
    } else if (t.down) {
      cls = "dou-trend-down";
      txt = "▼ " + t.delta + "%";
    } else {
      cls = "dou-trend-flat";
      txt = "— " + t.delta + "%";
    }
    return el("span", { class: cls, text: txt, title: "较区间首个采样点" });
  }

  /** 单窗口图卡片标题行：色点 + 窗口名 + 当前百分比 + Δ 趋势 + 限额/重置。 */
  function usageChartHead(s: any, win: any, pcts: any) {
    var pct = win && typeof win.percent === "number" ? win.percent : null;
    var reset = win && win.resetsAt ? "重置 " + fmtReset(win.resetsAt) : "";
    return el("div", { class: PILL_PREFIX + "cardHead" }, [
      el("div", { class: PILL_PREFIX + "cardMeta" }, [
        el("span", { class: PILL_PREFIX + "legendDot", style: { background: s[2] } }),
        el("h4", { class: PILL_PREFIX + "cardName", text: s[1] }),
        el("span", { class: PILL_PREFIX + "cardCur", text: pct === null ? "--" : pct + "%" }),
        trendEl(pcts),
      ]),
      el("p", { class: PILL_PREFIX + "cardLimit", text: "限额 " + s[3] + (reset !== "" ? " · " + reset : "") }),
    ]);
  }

  /** 填充迷你图（DOM 已就位后调用）：据容器实测宽度算 fontScale（手机端
   * 字号补偿），渲染 SVG。jobs 由 renderCharts 收集，RO 尺寸变化时复用。 */
  function paintCharts(jobs: any) {
    for (var j = 0; j < jobs.length; j += 1) {
      var job = jobs[j];
      var w = job.box.clientWidth || 320;
      var fontScale = w / 320;
      job.box.innerHTML = miniChartSvgMarkup(
        job.winSamples, job.col, job.color, job.domain[0], job.domain[1], true,
        job.resetsAt, job.period, fontScale
      );
    }
  }

  /**
   * 渲染三窗口迷你图卡片区：每窗口独立 y 轴（自适应域，突出各自波动），
   * x 轴范围按窗口观察周期独立动态切片（锚定采样尾端），每图自带 x 轴
   * 时间刻度。全量采样不足 2 点 / 切片后不足 2 点 / 该窗口无采样各有占位。
   * 先建骨架并 append 到 DOM，再据实测容器宽填充 SVG + 挂 ResizeObserver：
   * iOS PWA（分享为桌面 app）窄屏时 SVG 文字会随 viewBox 等比缩小，故按
   * 实际宽度补偿字号，尺寸变化时自动重排。
   */
  function renderCharts(container: any) {
    // 断开旧 ResizeObserver（每次重建骨架前释放，防泄漏）
    if (chartsResizeObs !== null) {
      try { chartsResizeObs.disconnect(); } catch (e) { /* 忽略 */ }
      chartsResizeObs = null;
    }
    container.textContent = "";
    var samples = lastHistory !== null && Array.isArray(lastHistory.samples) ? lastHistory.samples : null;
    var allEnough = samples !== null && samples.length >= 2;
    var jobs: any = [];
    for (var k = 0; k < CHART_SERIES.length; k += 1) {
      var s = CHART_SERIES[k];
      var win = lastData !== null && lastData.usage ? lastData.usage[s[0]] : null;
      // x 轴动态切片：锚定采样尾端，取该窗口观察周期内的点（null = 全量）
      var winSamples = samples;
      if (allEnough && s[4] !== null && s[4] > 0) {
        var tail = samples[samples.length - 1][0];
        var cut = tail - s[4];
        winSamples = samples.filter(function (sp: any) { return sp[0] >= cut; });
      }
      var pcts = winSamples === null ? [] : winSamples.map(function (sp: any) { return sp[k + 1]; });
      var card = el("div", { class: PILL_PREFIX + "card" });
      card.appendChild(usageChartHead(s, win, pcts));
      if (winSamples !== null && winSamples.length >= 2) {
        var hasPoint = false;
        for (var m = 0; m < pcts.length; m += 1) {
          if (typeof pcts[m] === "number") {
            hasPoint = true;
            break;
          }
        }
        var box = el("div", { class: PILL_PREFIX + "miniChart" });
        if (hasPoint) {
          // 骨架先行，SVG 延后填充（DOM 就位后实测宽度）
          jobs.push({
            box: box,
            winSamples: winSamples,
            col: k + 1,
            color: s[2],
            domain: niceDomain(pcts),
            resetsAt: win && win.resetsAt,
            period: s[5],
          });
        } else {
          box.appendChild(el("p", { class: PILL_PREFIX + "chartEmpty", text: "该窗口暂无历史采样" }));
        }
        card.appendChild(box);
      } else if (allEnough) {
        // 切片后不足 2 点（如 rolling 24h 内刚起步）：给引导而非空白
        card.appendChild(el("p", { class: PILL_PREFIX + "chartEmpty", text: "该时间范围内采样不足（<2 点），随时间积累后显示。" }));
      } else {
        var msg = lastHistory === null
          ? "加载中…"
          : "数据采集中：每次刷新记录一个采样点（约每分钟一次），≥2 个点后显示趋势。";
        card.appendChild(el("p", { class: PILL_PREFIX + "chartEmpty", text: msg }));
      }
      container.appendChild(card);
    }
    // DOM 就位后一次性填充（此时 clientWidth 有效）
    paintCharts(jobs);
    // ResizeObserver：容器尺寸变化（横竖屏切换 / 分屏 / iOS PWA 宽变）时重排
    if (typeof ResizeObserver === "function" && container.isConnected) {
      chartsResizeObs = new ResizeObserver(function () { paintCharts(jobs); });
      chartsResizeObs.observe(container);
    }
  }

  /** 拉取历史采样序列（宿主权威源）并刷新波浪图（面板开着时）。
   * 请求带 ?days=观察周期最大值（钳制 1..maxAgeDays），让宿主先裁一层，
   * 渲染时再按各窗口观察周期二次切片（双层防御，语义一致）。 */
  function fetchHistory() {
    var reqDays = 1;
    for (var di = 0; di < CHART_SERIES.length; di += 1) {
      var obs = CHART_SERIES[di][4];
      if (typeof obs === "number" && obs > 0) {
        var d = Math.ceil(obs / 86400000);
        if (d > reqDays) reqDays = d;
      }
    }
    return fetch(HISTORY_URL + "?days=" + reqDays, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (body) {
        lastHistory = body;
        lastHistoryAt = Date.now();
        if (floatOpen && chartsBox !== undefined) renderCharts(chartsBox);
        return body;
      })
      .catch(function () {
        lastHistory = null;
        if (floatOpen && chartsBox !== undefined) renderCharts(chartsBox);
        return null;
      });
  }

  function renderPanel() {
    if (floatPanel === undefined) return;
    floatPanel.textContent = "";
    var data = lastData;
    var head = el("div", { class: PILL_PREFIX + "head" }, [
      el("h3", { class: PILL_PREFIX + "title", text: "OpenCode Go 用量" }),
      el("button", { class: PILL_PREFIX + "btn", type: "button", text: "刷新", onClick: function () { void fetchStats(); } }),
    ]);
    floatPanel.appendChild(head);
    // 三窗口迷你图卡片区（每窗口独立 y 轴，取代原合并波浪图 + 进度条）
    chartsBox = el("div", { class: PILL_PREFIX + "charts" });
    floatPanel.appendChild(chartsBox);
    renderCharts(chartsBox);
    if (data === null) {
      floatPanel.appendChild(el("p", { class: PILL_PREFIX + "hint", text: "加载中…" }));
      return;
    }
    if (data.configured !== true) {
      floatPanel.appendChild(el("p", { class: PILL_PREFIX + "error", text: "未找到 OpenCode Go API Key（OPENCODE_GO_API_KEY / auth.json）。" }));
      return;
    }
    if (data.error !== null || data.usage === null) {
      var msg = data.error === "unauthorized" ? "API Key 无效或已过期（401）。" : "用量获取失败：" + (data.error || "未知错误") + "。";
      floatPanel.appendChild(el("p", { class: PILL_PREFIX + "error", text: msg }));
      return;
    }
    var foot = el("div", { class: PILL_PREFIX + "foot" }, [
      el("span", { text: "数据来自 opencode.ai 官方用量接口" }),
      el("span", {
        text: data.fetchedAt ? "更新于 " + fmtAge(data.fetchedAt) : "",
        title: data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN") : "",
      }),
    ]);
    floatPanel.appendChild(foot);
  }

  function toggleFloat(force?: any) {
    if (floatPanel === undefined) return;
    var next = force !== undefined ? force : !floatOpen;
    floatOpen = next;
    floatPanel.hidden = !next;
    if (next) {
      placePanel();
      renderPanel();
      void fetchStats();
      void fetchHistory();
    }
  }

  /** 下拉面板定位（fixed 跟随胶囊，避免被滚动容器裁剪）。 */
  function placePanel() {
    if (floatPill === undefined || floatPanel === undefined) return;
    var rect = floatPill.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    floatPanel.style.top = Math.max(6, rect.bottom + 6) + "px";
    floatPanel.style.right = Math.max(10, Math.round(window.innerWidth - rect.right)) + "px";
    floatPanel.style.left = "auto";
  }

  /** 挂载浮窗：胶囊挂会话滚动容器钉住右上角，面板 fixed 挂 body；返回清理函数。 */
  function mountFloat() {
    injectStyle(); // 幂等：确保挂载时样式必注入（apply 过早场景的双保险）
    var pill = el("button", {
      type: "button",
      class: PILL_PREFIX + "float",
      "aria-label": "OpenCode Go 用量",
    });
    pill.dataset.douFloat = "";
    pill.appendChild(el("span", { class: PILL_PREFIX + "dot dou-dot-off" }));
    pill.appendChild(el("span", { class: PILL_PREFIX + "label", text: "Go --%" }));
    pill.addEventListener("click", function () { toggleFloat(); });

    var panel = el("div", { class: PILL_PREFIX + "panel" });
    panel.hidden = true;
    floatPill = pill;
    floatPanel = panel;
    if (panel.parentElement !== document.body) document.body.appendChild(panel);

    var host: any;
    var listeners: any = [];

    /** 上下排列定位：MCP 管理器浮窗在场时，本胶囊固定在其正下方（MCP
     * top 8px + 高 26px + 8px 间隙 = 42px），垂直堆叠、右侧对齐，第一帧即
     * 确定、零重叠竞态；MCP 不在场时回到右上角第一行（8px）。MCP 后挂载由
     * place() 的 MutationObserver 修正。依赖 var 提升：attachListeners 内的
     * onScroll/onResize 闭包引用本函数。 */
    var repositionPill = function (target: any) {
      if (target === null || target === undefined) return;
      var scrollTop = target === document.body ? window.scrollY : target.scrollTop;
      var topBase = target.querySelector("[data-dsh-mcp-float]") !== null ? 42 : 8;
      pill.style.top = scrollTop + topBase + "px";
    };

    var attachListeners = function (target: any) {
      for (var i = 0; i < listeners.length; i += 1) {
        try { listeners[i](); } catch (e) { /* 忽略 */ }
      }
      listeners = [];
      var onScroll = function () {
        repositionPill(target);
        if (floatOpen) placePanel();
      };
      var onResize = function () {
        repositionPill(target);
        if (floatOpen) placePanel();
      };
      target.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onResize);
      listeners.push(function () {
        target.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onResize);
      });
      onScroll();
    };

    /** 放置/迁移：每次重新求最佳宿主（scrollBody 优先），出现即迁移，不用 isConnected 短路。 */
    var place = function () {
      var best = conversationHost();
      if (best === null || best === undefined) return false;
      if (host !== best || pill.parentElement !== best) {
        host = best;
        if (pill.parentElement !== null) pill.remove();
        best.appendChild(pill);
        attachListeners(best);
      }
      // 每次 DOM 变化都重算避让：MCP 浮窗可能比本胶囊晚挂载
      repositionPill(host);
      return true;
    };

    var observer = new MutationObserver(function () { place(); });
    if (place()) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      var wait = new MutationObserver(function () {
        if (place()) {
          wait.disconnect();
          observer.observe(document.body, { childList: true, subtree: true });
        }
      });
      wait.observe(document.body, { childList: true, subtree: true });
    }

    renderPill();
    void fetchStats();

    // 轮询刷新 + 页面重新可见时立即刷新
    refreshTimer = setInterval(function () {
      void fetchStats();
    }, REFRESH_MS);
    var onVisible = function () {
      if (document.visibilityState === "visible") void fetchStats();
    };
    document.addEventListener("visibilitychange", onVisible);

    return function () {
      observer.disconnect();
      if (chartsResizeObs !== null) {
        try { chartsResizeObs.disconnect(); } catch (e) { /* 忽略 */ }
        chartsResizeObs = null;
      }
      for (var i = 0; i < listeners.length; i += 1) {
        try { listeners[i](); } catch (e) { /* 忽略 */ }
      }
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
      lastData = null;
      lastHistory = null;
      lastHistoryAt = 0;
      chartsBox = undefined;
    };
  }

  /**
   * 插件入口：注入样式 + 挂载浮窗；任何异常只 warn，绝不让 GUI 启动失败。
   * 挂载失败不重试（DOM 自愈由 MutationObserver 处理）。
   */
  function apply(ctx: any) {
    try {
      injectStyle();
      if (document.body === null) return;
      var dispose = mountFloat();
      ctx.effect(function () { return dispose; }, "dsh-opencode-usage: float");
    } catch (error) {
      console.warn("dsh-opencode-usage: 悬浮框挂载失败", error);
    }
  }

  (window as any).__ModuleLoader__.load({
    id: __DSH_PLUGIN_ID__,
    factory: function (require: any) {
      var module: { exports: Record<string, any> } = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var inject: any = []; // 悬浮框纯 DOM，无需 ctx 服务
      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();
