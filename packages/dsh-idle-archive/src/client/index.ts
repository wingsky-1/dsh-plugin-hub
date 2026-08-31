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

// ---- 浏览器半区（干净模块）：React 由构建期 external 注入 ----
// React 经 build-client externals 路径——运行时由 dsh web 的 factory require("react")
// 注入（loader 模块表），源码不写任何 load/IIFE 外壳（外壳由构建生成）。类型 shim 见 react-shim.d.ts。
import * as React from "react";
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";
// i18n（issue #348）：复用官方 dsh-client-locale——zh/en 双语字典，LocaleNamespaceMap
// 声明合并进官方 ui-slots 类型面；仅 import type（编译期擦除，无运行时依赖）。
import { zh, en, type IdleArchiveLocaleKey } from "./locales.ts";
// 显式类型导入，先把 @deepseek-ai/dsh-client-ui-slots 拉进模块解析图：上游发布物
// lib/types/*.d.ts 相对导入保留 .ts 后缀（renderer.ts / store.ts，磁盘只有 .d.ts），
// declare module 增强的模块名解析（不走过 import 的解析缓存）会判 TS2664 cannot be
// found（microsoft/TypeScript#63960 顺序依赖同类问题；TS 5.9/6/7 实测一致）。待上游
// 修复发布物后此行可删。
import type { LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-idle-archive 弹窗/设置卡文案。 */
    "settings.idleArchive": IdleArchiveLocaleKey;
  }
}

/** 本插件字典命名空间（宿主 locale 服务注册用）。 */
const NS = "settings.idleArchive";

  var CHANNEL = "/dsh-idle-archive";
  var MODAL_ID = "dsh-idle-archive-modal";
  var STYLE_ID = "dsh-idle-archive-style";
  var CSS_VERSION = "1";
  var DEFAULTS = { enabled: true, idleHours: 72, snoozeHours: 24, scanMinutes: 60, maxRows: 50 };

  /** i18n 翻译函数（apply 时由 ctx.locale.bind(NS) 装配；未装配回落 key 本体，行为零变化）。 */
  var t: any = function (key: string, params?: any) {
    if (params === undefined) return key;
    return String(key); // 未装配时占位插值忽略（正常路径早已装配）
  };

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
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.dataset.cssVersion === CSS_VERSION) return;
    if (existing) existing.remove();
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.cssVersion = CSS_VERSION;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------ 工具

  /** 相对时间描述。 */
  function fmtRelative(ts: any) {
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return t("justNow");
    var min = Math.floor(diff / 60000);
    if (min < 60) return t("minutesAgo", { n: min });
    var h = Math.floor(min / 60);
    if (h < 24) return t("hoursAgo", { n: h });
    var d = Math.floor(h / 24);
    if (d < 30) return t("daysAgo", { n: d });
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
      toast(t("archivedOk"));
      state.candidates = state.candidates.filter(function (c: any) { return c.id !== id; });
      // 归档后清掉该会话的静默标记（下次扫描不会再出现，已归档者天然跳过）。
      rpc("clearSnooze", { sessionId: id }).catch(function () {});
      renderModal();
    }).catch(function (e: any) {
      toast(t("archivedFail", { msg: (e && e.message || e) }), true);
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
        time.textContent = t("rowLastSeen", { rel: fmtRelative(row.updatedAt), abs: new Date(row.updatedAt).toLocaleString() });
        main.appendChild(title);
        main.appendChild(time);

        var archiveBtn = document.createElement("button");
        archiveBtn.type = "button";
        archiveBtn.className = "dia-btn dia-btn-archive";
        archiveBtn.textContent = t("archive");
        archiveBtn.addEventListener("click", function () { doArchive(row.id); });

        var snoozeBtn = document.createElement("button");
        snoozeBtn.type = "button";
        snoozeBtn.className = "dia-btn";
        snoozeBtn.textContent = t("snoozeRow");
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
    headText.textContent = t("modalTitle");
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dia-close";
    closeBtn.textContent = "×";
    closeBtn.title = t("closeTitle");
    closeBtn.addEventListener("click", function () { doSnooze(state.candidates.map(function (c: any) { return c.id; }), 1); });
    head.appendChild(headText);
    head.appendChild(closeBtn);

    var hours = (state.settings && state.settings.idleHours) || DEFAULTS.idleHours;
    var desc = document.createElement("div");
    desc.className = "dia-desc";
    desc.textContent = t("desc", {
      count: candidates.length,
      hours: hours,
      snooze: (state.settings && state.settings.snoozeHours) || DEFAULTS.snoozeHours,
    });

    var list = document.createElement("div");
    list.className = "dia-list";

    var foot = document.createElement("div");
    foot.className = "dia-foot";
    var hint = document.createElement("span");
    hint.className = "dia-hint";
    hint.textContent = t("hint");
    var allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "dia-all";
    allBtn.textContent = t("allSnooze");
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
    // 通知中心接入（issue #366 M1）：弹窗前 fire-and-forget 触发 notifyDue——
    // 通知中心未装 / kind 未确认时服务端自动 suppressed/静默，不影响弹窗主流程。
    try {
      rpc("notifyDue", { count: list.length }).catch(function () {
        // 通知失败静默（弹窗照常）
      });
    } catch (error) {
      // rpc 初始化异常（connection 未就绪）也静默
    }
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
      return React.createElement("li", { className: "dia-set-card" }, t("settingsLoading"));
    }

    function patch(p: any) {
      setSettings(Object.assign({}, settings, p));
      setSaved("");
    }

    function save() {
      rpc("config", { settings: settings }).then(function (v: any) {
        state.settings = v.settings;
        setSettings(v.settings);
        setSaved(t("savedOk"));
        scheduleSoon();
        setTimeout(function () { setSaved(""); }, 1800);
      }).catch(function (e: any) {
        setSaved(t("savedFail", { msg: (e && e.message || e) }));
      });
    }

    /** 立即检查：手动扫描（忽略静默期——显式意图）；有候选弹窗，无候选给出反馈。 */
    function checkNow() {
      setSaved("");
      if (disposed || state.modalOpen) return;
      if (!state.settings || !state.settings.enabled) {
        toast(t("disabledHint"));
        return;
      }
      var list = collectCandidates(true);
      if (!list.length) {
        toast(t("noCandidates"));
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
          React.createElement("span", { className: "dia-set-name" }, t("settingsName")),
          React.createElement("span", { className: "dia-set-description" }, t("settingsDescription")),
        ),
        React.createElement("svg", {
          className: "dia-set-chevron" + (open ? " dia-set-chevronOpen" : ""),
          width: 14,
          height: 14,
          viewBox: "0 0 14 14",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
        },
          React.createElement("path", {
            d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
            fill: "currentColor",
          }),
        ),
      ),
      open ? React.createElement("div", { className: "dia-set-body" },
        React.createElement("div", { className: "dia-set-row" },
          React.createElement("label", null, t("enable")),
          React.createElement("input", {
            type: "checkbox",
            checked: settings.enabled,
            onChange: function (e: any) { patch({ enabled: e.target.checked }); },
          }),
        ),
        React.createElement("div", { className: "dia-set-row" },
          React.createElement("label", null, t("idleHours")),
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
          React.createElement("label", null, t("snoozeHours")),
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
          React.createElement("label", null, t("scanMinutes")),
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
            React.createElement("button", { type: "button", className: "dia-set-check", onClick: checkNow }, t("checkNow")),
            React.createElement("button", { type: "button", className: "dia-set-save", onClick: save }, t("save")),
          ),
        ),
      ) : null,
    );
  }

  // ------------------------------------------------------------ 装配

  export function apply(ctx: any) {
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

      // i18n（issue #348）：注册本插件字典；t 绑定官方 locale 服务（未装配回落 key 本体）。
      var locale: any = ctx.get("locale");
      if (locale && typeof locale.register === "function") {
        try {
          locale.register(NS, { zh: zh, en: en });
          t = locale.bind(NS);
        } catch (e) {
          console.warn("[dsh-idle-archive] locale 注册失败：", e);
        }
      }

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
      // ⚠️ rc.7 起 settings.plugin.item 由 list(id) 改为 keyed(key)：
      //   - 旧版（<=rc.6）只看 `id`；
      //   - rc.7 只看 `key`，且要求与宿主 serve 的命名空间一致（dsh-idle-archive）。
      // 社区一致范式（见 ysr666/dsh-vision-router#165/#162）：**id 与 key 双写**，
      // 让新旧两代 slot 运行时都接受（多余字段被忽略）。key 必须等于宿主端
      // installSettingsNamespace 注册的命名空间，才会被 configurable 面板派发。
      if (slots) {
        slots.inject("settings.plugin.item", function () {
          return slots.register(
            { name: "settings.plugin.item", id: "dsh-idle-archive", key: "dsh-idle-archive", order: 45, locale: NS },
            function () {
              return React.createElement(SettingsCard, null);
            }
          );
        });
      }

      // i18n 切语言重绘：locale 快照变化 → 重绑 t 并重建弹窗（原生 DOM 通道按 revision 刷新）。
      var unsubLocale: any = null;
      if (locale && typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
        unsubLocale = locale.subscribe(function () {
          try { t = locale.bind(NS); } catch (e) { /* 忽略 */ }
          if (state.modalOpen) { closeModal(); state.candidates = state.candidates.slice(); }
          scheduleSoon();
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
          if (unsubLocale) unsubLocale();
          if (modalEl) modalEl.remove();
          var style = document.getElementById(STYLE_ID);
          if (style) style.remove();
        };
      }, "dsh-idle-archive");
    } catch (e) {
      console.warn("[dsh-idle-archive] 挂载失败：", e);
    }
  }

  // ---- 浏览器半区契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
  export const inject: string[] = ["slots", "locale"];
