/**
 * dsh-idle-archive — 会话闲置归档提醒（浏览器端，自包含）。
 *
 * 行为：
 * - 周期性扫描会话列表：超过 X 小时未对话（updatedAt 距今 > idleHours）、
 *   且非 blank / 非 running / 非子代理 / 非已归档 / 非当前会话 / 不在静默期的
 *   会话，弹窗询问是否归档；
 * - 弹窗内每行可「归档」（官方 workspace.archiveSession）或「暂不归档」
 *   （宿主持久化 snooze，Y 小时内不再提示该会话）；
 * - 弹窗 × 与「全部暂不归档」= 对当前列表全部会话 snooze Y 小时；
 * - 配置（X / Y / 扫描间隔 / 开关）在设置面板插件项里维护，宿主持久化。
 *
 * 提醒克制原则：仅页面可见时弹、同一时刻最多一个弹窗、snooze 按会话独立、
 * 扫描间隔可调、可整体禁用。
 */

// ---- 浏览器端全局声明（dsh web 运行时提供）----
declare var React: any;
declare var module: { exports: Record<string, any> };
declare var __DSH_PLUGIN_ID__: string; // 构建注入：bundle-host 以 --define 注入完整 npm 包名（load id 契约 = 包名）
interface Window {
  __ModuleLoader__: { load(entry: { id: string; factory: (require: any) => unknown }): void };
}

(function () {
  "use strict";

  /** React 由 factory 的 require("react") 注入（dsh web 不暴露全局 React）。 */
  var React: any;

  var CHANNEL = "/dsh-idle-archive";
  var MODAL_ID = "dsh-idle-archive-modal";
  var STYLE_ID = "dsh-idle-archive-style";
  var CSS_VERSION = "1";
  var DEFAULTS = { enabled: true, idleHours: 72, snoozeHours: 24, scanMinutes: 60, maxRows: 50 };

  /** 全局运行态（apply 内部使用）。 */
  var state: Record<string, any> = { settings: null, snoozed: {}, candidates: [], modalOpen: false };
  var rpc: any = null;
  var sessions: any = null;
  var workspaces: any = null;
  var timer: any = null;
  var rescanTimer: any = null;
  var disposed = false;
  var modalEl: any = null;

  // ------------------------------------------------------------ 样式

  /** 注入样式（显式版本号，热更新时旧 <style> 移除重建）。 */
  function injectStyle() {
    var css =
      "#" + MODAL_ID + "{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(15,17,21,.45);backdrop-filter:blur(2px);font-family:Inter,var(--dsw-font-family),system-ui,'Segoe UI',sans-serif}" +
      "#" + MODAL_ID + "[hidden]{display:none!important}" +
      "#" + MODAL_ID + " .dia-card{width:min(520px,calc(100vw - 48px));max-height:min(78vh,640px);display:flex;flex-direction:column;" +
      "background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e2e5ea);" +
      "border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.28);overflow:hidden}" +
      "#" + MODAL_ID + " .dia-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;" +
      "border-bottom:1px solid var(--dsw-alias-border-l1,#e2e5ea);font-weight:700;font-size:14px}" +
      "#" + MODAL_ID + " .dia-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);" +
      "font-size:18px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}" +
      "#" + MODAL_ID + " .dia-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2329)}" +
      "#" + MODAL_ID + " .dia-desc{padding:10px 16px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5f6672);" +
      "border-bottom:1px solid var(--dsw-alias-border-l1,#e2e5ea);line-height:1.6}" +
      "#" + MODAL_ID + " .dia-list{flex:1;min-height:0;overflow-y:auto;padding:8px 12px}" +
      "#" + MODAL_ID + " .dia-row{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);" +
      "border-radius:9px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1,#f5f6f8)}" +
      "#" + MODAL_ID + " .dia-row-main{flex:1;min-width:0}" +
      "#" + MODAL_ID + " .dia-row-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#" + MODAL_ID + " .dia-row-time{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919c);margin-top:2px}" +
      "#" + MODAL_ID + " .dia-btn{border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8);" +
      "color:var(--dsw-alias-label-primary,#1f2329);border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer;flex:none}" +
      "#" + MODAL_ID + " .dia-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
      "#" + MODAL_ID + " .dia-btn-archive{border-color:var(--dsw-alias-state-info-primary,#3b82f6);color:var(--dsw-alias-state-info-primary,#3b82f6)}" +
      "#" + MODAL_ID + " .dia-btn-archive:hover{background:var(--dsw-alias-state-info-tertiary,rgba(59,130,246,.08))}" +
      "#" + MODAL_ID + " .dia-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;" +
      "border-top:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-layer-1,#f5f6f8)}" +
      "#" + MODAL_ID + " .dia-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919c)}" +
      "#" + MODAL_ID + " .dia-all{border:1px solid var(--dsw-alias-border-l1,#e2e5ea);background:var(--dsw-alias-bg-base,#ffffff);" +
      "color:var(--dsw-alias-label-primary,#1f2329);border-radius:7px;padding:5px 14px;font-size:12px;cursor:pointer}" +
      "#" + MODAL_ID + " .dia-all:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
      // 深色模式
      "body[data-ds-dark-theme] #" + MODAL_ID + "{background:rgba(0,0,0,.55)}" +
      "body[data-ds-dark-theme] #" + MODAL_ID + " .dia-card{background:var(--dsw-alias-bg-base,#1b1c1e);color:var(--dsw-alias-label-primary,#e8e8ea);" +
      "border-color:var(--dsw-alias-border-l1,#33353a)}" +
      "body[data-ds-dark-theme] #" + MODAL_ID + " .dia-row{background:var(--dsw-alias-bg-layer-1,#26272a);border-color:var(--dsw-alias-border-l1,#33353a)}" +
      "body[data-ds-dark-theme] #" + MODAL_ID + " .dia-foot{background:var(--dsw-alias-bg-layer-1,#26272a);border-color:var(--dsw-alias-border-l1,#33353a)}" +
      // toast
      ".dia-toast{position:fixed;bottom:24px;right:24px;z-index:9999;padding:9px 16px;border-radius:9px;font-size:12.5px;color:#fff;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.22);max-width:min(420px,calc(100vw - 48px))}" +
      ".dia-toast-ok{background:var(--dsw-alias-state-success-primary,#16a34a)}" +
      ".dia-toast-err{background:var(--dsw-alias-state-error-primary,#d92d20)}" +
      // 设置卡片（settings.plugin.item 插槽）——官方 PluginCard 同款风格（dsw-alias 变量 + 折叠头）
      ".dia-set-card{border:1px solid var(--dsw-alias-border-l2,#e2e5ea);background:var(--dsw-alias-bg-layer-3,#fbfbfc);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}" +
      ".dia-set-card:hover{border-color:var(--dsw-alias-label-dimmed,#9ba1a6)}" +
      ".dia-set-cardOpen{background:var(--dsw-alias-bg-layer-2,#f5f6f8);border-color:var(--dsw-alias-label-dimmed,#9ba1a6)}" +
      ".dia-set-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}" +
      ".dia-set-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}" +
      ".dia-set-headText{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}" +
      ".dia-set-name{color:var(--dsw-alias-label-primary,#1f2329);font-size:15px;font-weight:600;line-height:1.4}" +
      ".dia-set-description{color:var(--dsw-alias-label-tertiary,#5f6672);font-size:13px;line-height:1.5}" +
      ".dia-set-chevron{color:var(--dsw-alias-label-tertiary,#5f6672);flex:none;transition:transform .16s;font-size:11px}" +
      ".dia-set-chevronOpen{transform:rotate(180deg)}" +
      ".dia-set-body{border-top:1px solid var(--dsw-alias-border-l2,#e2e5ea);margin:0 16px;padding:10px 0 8px;display:flex;flex-direction:column;gap:10px}" +
      ".dia-set-row{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
      ".dia-set-row label{color:var(--dsw-alias-label-secondary,#5f6672);font-size:13px}" +
      ".dia-set-input{width:92px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1,#e2e5ea);border-radius:8px;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font:inherit}" +
      ".dia-set-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l2,#e2e5ea);padding:10px 0 4px}" +
      ".dia-set-save,.dia-set-check{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}" +
      ".dia-set-check{border-color:var(--dsw-alias-border-l2,#e2e5ea);color:var(--dsw-alias-label-secondary,#5f6672);background:transparent}" +
      ".dia-set-check:hover{color:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-label-dimmed,#9ba1a6)}" +
      ".dia-set-save{background:var(--dsw-alias-label-primary,#1f2329);color:var(--dsw-alias-bg-layer-3,#fbfbfc)}" +
      ".dia-set-saved{color:var(--dsw-alias-state-success-primary,#16a34a);font-size:12px}";
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.dataset.cssVersion === CSS_VERSION) return;
    if (existing) existing.remove();
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.cssVersion = CSS_VERSION;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------ 工具

  /** 相对时间描述。 */
  function fmtRelative(ts: any) {
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return "刚刚";
    var min = Math.floor(diff / 60000);
    if (min < 60) return min + " 分钟前";
    var h = Math.floor(min / 60);
    if (h < 24) return h + " 小时前";
    var d = Math.floor(h / 24);
    if (d < 30) return d + " 天前";
    return new Date(ts).toLocaleDateString();
  }

  /** 底部提示条（写操作结果必须 UI 回显）。 */
  function toast(message: any, isError?: any) {
    var el = document.createElement("div");
    el.className = "dia-toast " + (isError ? "dia-toast-err" : "dia-toast-ok");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3200);
  }

  // ------------------------------------------------------------ 弹窗

  /** 关闭弹窗（不隐式 snooze；调用方决定是否 snooze）。 */
  function closeModal() {
    state.modalOpen = false;
    state.candidates = [];
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
  }

  /** 归档一个候选会话（官方 workspace.archiveSession）。 */
  function doArchive(id: any) {
    if (!workspaces) return;
    (workspaces as any).archiveSession(id).then(function () {
      toast("已归档会话");
      state.candidates = state.candidates.filter(function (c: any) { return c.id !== id; });
      // 归档后清掉该会话的静默标记（下次扫描不会再出现，已归档者天然跳过）。
      rpc("clearSnooze", { sessionId: id }).catch(function () {});
      renderModal();
    }).catch(function (e: any) {
      toast("归档失败：" + (e && e.message || e), true);
    });
  }

  /** 对一批会话 snooze（拒绝提醒 Y 小时）。 */
  /** 批量静默：hours 由调用方决定——显式按钮用配置 snoozeHours；×/Escape 关闭仅短静默 1 小时。 */
  function doSnooze(ids: any, hours: any) {
    if (!ids.length) { closeModal(); return; }
    var until = Date.now() + hours * 3600 * 1000;
    ids.forEach(function (id: any) { state.snoozed[id] = until; });
    rpc("snoozeMany", { sessionIds: ids, hours: hours }).catch(function (e: any) {
      console.warn("[dsh-idle-archive] snooze 持久化失败：", e);
    });
    state.candidates = state.candidates.filter(function (c: any) { return ids.indexOf(c.id) < 0; });
    renderModal();
  }

  /** 重建弹窗列表内容（保持已打开的弹窗）。 */
  function renderModal() {
    if (!modalEl) return;
    var list = modalEl.querySelector(".dia-list");
    if (!list) return;
    list.textContent = "";
    var rows = state.candidates;
    if (!rows.length) { closeModal(); return; }
    for (var i = 0; i < rows.length; i += 1) {
      (function (row) {
        var el = document.createElement("div");
        el.className = "dia-row";

        var main = document.createElement("div");
        main.className = "dia-row-main";
        var title = document.createElement("div");
        title.className = "dia-row-title";
        title.textContent = row.title;
        title.title = row.title;
        var time = document.createElement("div");
        time.className = "dia-row-time";
        time.textContent = "最后对话 " + fmtRelative(row.updatedAt) + "（" + new Date(row.updatedAt).toLocaleString() + "）";
        main.appendChild(title);
        main.appendChild(time);

        var archiveBtn = document.createElement("button");
        archiveBtn.type = "button";
        archiveBtn.className = "dia-btn dia-btn-archive";
        archiveBtn.textContent = "归档";
        archiveBtn.addEventListener("click", function () { doArchive(row.id); });

        var snoozeBtn = document.createElement("button");
        snoozeBtn.type = "button";
        snoozeBtn.className = "dia-btn";
        snoozeBtn.textContent = "暂不归档";
        snoozeBtn.addEventListener("click", function () { doSnooze([row.id], (state.settings && state.settings.snoozeHours) || DEFAULTS.snoozeHours); });

        el.appendChild(main);
        el.appendChild(snoozeBtn);
        el.appendChild(archiveBtn);
        list.appendChild(el);
      })(rows[i]);
    }
  }

  /** 打开弹窗（同一时刻最多一个）。 */
  function openModal(candidates: any) {
    if (state.modalOpen || disposed || !document.body) return;
    state.modalOpen = true;
    state.candidates = candidates.slice();

    var overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var card = document.createElement("div");
    card.className = "dia-card";

    var head = document.createElement("div");
    head.className = "dia-head";
    var headText = document.createElement("span");
    headText.textContent = "会话闲置提醒";
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dia-close";
    closeBtn.textContent = "×";
    closeBtn.title = "全部暂不归档（Y 小时内不再提醒）";
    closeBtn.addEventListener("click", function () { doSnooze(state.candidates.map(function (c: any) { return c.id; }), 1); });
    head.appendChild(headText);
    head.appendChild(closeBtn);

    var hours = (state.settings && state.settings.idleHours) || DEFAULTS.idleHours;
    var desc = document.createElement("div");
    desc.className = "dia-desc";
    desc.textContent = "以下 " + candidates.length + " 个会话超过 " + hours + " 小时未对话。归档后从会话列表隐藏，会话记录仍保留；" +
      "「暂不归档」后 " + ((state.settings && state.settings.snoozeHours) || DEFAULTS.snoozeHours) + " 小时内不再提醒该会话。";

    var list = document.createElement("div");
    list.className = "dia-list";

    var foot = document.createElement("div");
    foot.className = "dia-foot";
    var hint = document.createElement("span");
    hint.className = "dia-hint";
    hint.textContent = "× / Esc：仅关闭（1 小时内不重复提醒）；「全部暂不归档」：按静默时长不提醒";
    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "dia-all";
    allBtn.textContent = "全部暂不归档";
    allBtn.addEventListener("click", function () {
        var hours = (state.settings && state.settings.snoozeHours) || DEFAULTS.snoozeHours;
        doSnooze(state.candidates.map(function (c: any) { return c.id; }), hours);
      });
    foot.appendChild(hint);
    foot.appendChild(allBtn);

    card.appendChild(head);
    card.appendChild(desc);
    card.appendChild(list);
    card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    modalEl = overlay;

    function onKey(e: any) {
      if (e.key === "Escape" && modalEl) {
        doSnooze(state.candidates.map(function (c: any) { return c.id; }), 1);
      }
    }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("remove", function () { document.removeEventListener("keydown", onKey); });

    renderModal();
  }

  // ------------------------------------------------------------ 扫描

  /**
   * 计算当前应提醒的候选会话。
   * @param ignoreSnooze - 手动"立即检查"时忽略静默期（显式意图不受防打扰限制）。
   */
  function collectCandidates(ignoreSnooze: any) {
    if (!sessions || !workspaces) return [];
    var s = sessions.list.getSnapshot();
    var w = workspaces.list.getSnapshot();
    if (!s || !s.ids || !Array.isArray(s.ids)) return [];
    var archived = new Set(w.archivedSessionIds || []);
    var now = Date.now();
    var cutoff = now - ((state.settings && state.settings.idleHours) || DEFAULTS.idleHours) * 3600 * 1000;
    var out = [];
    for (var i = 0; i < s.ids.length; i += 1) {
      var id = s.ids[i];
      var row = s.byId[id];
      if (!row) continue;
      // 过滤：从未对话 / 正在运行 / 子代理会话 / 已归档 / 当前会话 / 无时间戳。
      if (row.blank || row.running || row.origin === "subagent") continue;
      if (id === s.current) continue;
      if (archived.has(id)) continue;
      if (typeof row.updatedAt !== "number" || row.updatedAt <= 0 || row.updatedAt > cutoff) continue;
      // 静默期：用户拒绝过，Y 小时内不再提示（手动"立即检查"忽略静默）。
      if (!ignoreSnooze && state.snoozed[id] && state.snoozed[id] > now) continue;
      out.push({ id: id, title: row.displayTitle || row.title || id, updatedAt: row.updatedAt });
    }
    out.sort(function (a, b) { return a.updatedAt - b.updatedAt; });
    var max = (state.settings && state.settings.maxRows) || DEFAULTS.maxRows;
    if (max > 0 && out.length > max) out.length = max;
    return out;
  }

  /**
   * 执行一次扫描：有候选且页面可见、无弹窗时弹出。
   * 弹窗前经 rpc titles 重新获取会话标题（列表快照的标题依赖事件同步，
   * 闲置会话可能滞后为工作区名——体验修复：展示真实标题）。
   */
  function scan() {
    if (disposed || state.modalOpen) return;
    if (!state.settings || !state.settings.enabled) return;
    if (document.visibilityState !== "visible") return;
    var list = collectCandidates(false);
    if (!list.length) return;
    var ids = list.map(function (c: any) { return c.id; });
    rpc("titles", { sessionIds: ids }).then(function (v: any) {
      if (disposed || state.modalOpen) return;
      var titles = v && v.titles ? v.titles : {};
      var enriched = list.map(function (c: any) {
        var t = titles[c.id];
        return { id: c.id, title: typeof t === "string" && t !== "" ? t : c.title, updatedAt: c.updatedAt };
      });
      openModal(enriched);
    }).catch(function () {
      // 标题获取失败不阻塞提醒（回落列表快照标题）。
      if (!disposed && !state.modalOpen) openModal(list);
    });
  }

  /** 下一轮定时扫描（间隔跟随当前设置）。 */
  function scheduleNext() {
    if (disposed) return;
    var minutes = (state.settings && state.settings.scanMinutes) || DEFAULTS.scanMinutes;
    timer = setTimeout(function () {
      if (disposed) return;
      scan();
      scheduleNext();
    }, minutes * 60 * 1000);
  }

  /** 列表变化/回到前台后延迟重扫（去抖，避免高频触发）。 */
  function scheduleSoon() {
    if (disposed) return;
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(function () {
      rescanTimer = null;
      scan();
    }, 5000);
  }

  // ------------------------------------------------------------ 设置卡片

  /**
   * 设置面板插件项：X（闲置阈值）/ Y（拒绝后静默）/ 扫描间隔 / 开关。
   * 改动只在点「保存」后生效并落盘（宿主持久化，多标签共享）。
   */
  function SettingsCard() {
    var ReactHooks = React;
    var useState = ReactHooks.useState;
    var useEffect = ReactHooks.useEffect;
    var draft = useState(null);
    var settings = draft[0];
    var setSettings = draft[1];
    var saved = useState("");
    var setSaved = saved[1];
    var openState = useState(false);
    var open = openState[0];
    var setOpen = openState[1];

    useEffect(function () {
      var alive = true;
      rpc("state", {}).then(function (st: any) {
        if (!alive) return;
        setSettings(st.settings || DEFAULTS);
      }).catch(function (e: any) {
        console.warn("[dsh-idle-archive] 设置加载失败：", e);
      });
      return function () { alive = false; };
    }, []);

    if (!settings) {
      return React.createElement("li", { className: "dia-set-card" }, "会话闲置提醒：加载中…");
    }

    function patch(p: any) {
      setSettings(Object.assign({}, settings, p));
      setSaved("");
    }

    function save() {
      rpc("config", { settings: settings }).then(function (v: any) {
        state.settings = v.settings;
        setSettings(v.settings);
        setSaved("已保存");
        scheduleSoon();
        setTimeout(function () { setSaved(""); }, 1800);
      }).catch(function (e: any) {
        setSaved("保存失败：" + (e && e.message || e));
      });
    }

    /** 立即检查：手动扫描（忽略静默期——显式意图）；有候选弹窗，无候选给出反馈。 */
    function checkNow() {
      setSaved("");
      if (disposed || state.modalOpen) return;
      if (!state.settings || !state.settings.enabled) {
        toast("会话闲置提醒已禁用");
        return;
      }
      var list = collectCandidates(true);
      if (!list.length) {
        toast("暂无需要归档的会话");
        return;
      }
      rpc("titles", { sessionIds: list.map(function (c: any) { return c.id; }) }).then(function (v: any) {
        if (disposed || state.modalOpen) return;
        var titles = v && v.titles ? v.titles : {};
        var enriched = list.map(function (c: any) {
          var t = titles[c.id];
          return { id: c.id, title: typeof t === "string" && t !== "" ? t : c.title, updatedAt: c.updatedAt };
        });
        openModal(enriched);
      }).catch(function () {
        if (!disposed && !state.modalOpen) openModal(list);
      });
    }

    return React.createElement("li", { className: "dia-set-card" + (open ? " dia-set-cardOpen" : "") },
      React.createElement("button", {
        type: "button",
        className: "dia-set-head",
        "aria-expanded": open,
        onClick: function () { setOpen(!open); },
      },
        React.createElement("span", { className: "dia-set-headText" },
          React.createElement("span", { className: "dia-set-name" }, "会话闲置提醒"),
          React.createElement("span", { className: "dia-set-description" }, "闲置阈值 / 静默时长 / 扫描间隔 / 立即检查"),
        ),
        React.createElement("span", { className: "dia-set-chevron" + (open ? " dia-set-chevronOpen" : "") }, "▾"),
      ),
      open ? React.createElement("div", { className: "dia-set-body" },
        React.createElement("div", { className: "dia-set-row" },
          React.createElement("label", null, "启用"),
          React.createElement("input", {
            type: "checkbox",
            checked: settings.enabled,
            onChange: function (e: any) { patch({ enabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "dia-set-row" },
          React.createElement("label", null, "闲置阈值（小时）"),
          React.createElement("input", {
            className: "dia-set-input",
            type: "number",
            min: 1,
            max: 8760,
            value: settings.idleHours,
            onChange: function (e: any) { patch({ idleHours: Number(e.target.value) }); },
          }),
        ),
        React.createElement("div", { className: "dia-set-row" },
          React.createElement("label", null, "拒绝后静默（小时）"),
          React.createElement("input", {
            className: "dia-set-input",
            type: "number",
            min: 1,
            max: 720,
            value: settings.snoozeHours,
            onChange: function (e: any) { patch({ snoozeHours: Number(e.target.value) }); },
          }),
        ),
        React.createElement("div", { className: "dia-set-row" },
          React.createElement("label", null, "扫描间隔（分钟）"),
          React.createElement("select", {
            className: "dia-set-input",
            value: settings.scanMinutes,
            onChange: function (e: any) { patch({ scanMinutes: Number(e.target.value) }); },
          },
            React.createElement("option", { value: 15 }, "15"),
            React.createElement("option", { value: 30 }, "30"),
            React.createElement("option", { value: 60 }, "60"),
            React.createElement("option", { value: 120 }, "120"),
          ),
        ),
        React.createElement("div", { className: "dia-set-foot" },
          React.createElement("span", { className: "dia-set-saved" }, saved),
          React.createElement("span", { style: { display: "flex", gap: 8 } },
            React.createElement("button", { type: "button", className: "dia-set-check", onClick: checkNow }, "立即检查"),
            React.createElement("button", { type: "button", className: "dia-set-save", onClick: save }, "保存"),
          ),
        ),
      ) : null,
    );
  }

  // ------------------------------------------------------------ 装配

  function apply(ctx: any) {
    try {
      var connection = ctx.get("connection");
      var slots = ctx.get("slots");
      sessions = ctx.get("sessions");
      workspaces = ctx.get("workspaces");
      if (!connection || !sessions || !workspaces) {
        console.warn("[dsh-idle-archive] 缺少 connection/sessions/workspaces 服务，插件未启用");
        return;
      }

      rpc = function (endpoint: any, payload: any) {
        return connection.rpc.call(CHANNEL, endpoint, payload || {}).then(function (result: any) {
          if (!result.ok) throw new Error((result.error && (result.error.details || result.error.code)) || "rpc failed");
          return result.value;
        });
      };

      injectStyle();

      // 先按默认配置可用，宿主状态加载后覆盖（配置/snooze 持久化在宿主）。
      state.settings = DEFAULTS;
      rpc("state", {}).then(function (st: any) {
        if (disposed) return;
        if (st && st.settings) state.settings = st.settings;
        if (st && st.snoozed) state.snoozed = st.snoozed;
        scheduleNext();
        scan();
      }).catch(function (e: any) {
        console.warn("[dsh-idle-archive] 初始化失败：", e);
        scheduleNext();
      });

      // 会话/工作区列表变化或回到前台 → 去抖重扫。
      var unsubSessions = sessions.list.subscribe(scheduleSoon);
      var unsubWorkspaces = workspaces.list.subscribe(scheduleSoon);
      function onVisibility() {
        if (document.visibilityState === "visible") scheduleSoon();
      }
      document.addEventListener("visibilitychange", onVisibility);

      // 设置面板插件项。
      if (slots) {
        slots.inject("settings.plugin.item", function () {
          return slots.register({ name: "settings.plugin.item", id: "dsh-idle-archive", order: 45 }, function () {
            return React.createElement(SettingsCard, null);
          });
        });
      }

      // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里。
      ctx.effect(function () {
        return function () {
          disposed = true;
          if (timer) clearTimeout(timer);
          if (rescanTimer) clearTimeout(rescanTimer);
          document.removeEventListener("visibilitychange", onVisibility);
          if (unsubSessions) unsubSessions();
          if (unsubWorkspaces) unsubWorkspaces();
          if (modalEl) modalEl.remove();
          var style = document.getElementById(STYLE_ID);
          if (style) style.remove();
        };
      }, "dsh-idle-archive");
    } catch (e) {
      console.warn("[dsh-idle-archive] 挂载失败：", e);
    }
  }

  (window as any).__ModuleLoader__.load({
    id: __DSH_PLUGIN_ID__,
    factory: function (require: any) {
      var module: { exports: Record<string, any> } = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      // 设置卡片是 React 组件（settings.plugin.item 插槽由宿主 React 渲染）。
      // ⚠️ 必须赋值顶层 React（SettingsCard 在 IIFE 顶层引用；局部 var 会因作用域错误而 ReferenceError）。
      React = require("react");
      var inject = ["slots"];
      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();
