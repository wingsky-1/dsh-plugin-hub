/**
 * dsh-notifier — 浏览器端（自包含）。
 *
 * 行为（issue #76）：
 * - 在「设置」面板注册独立 tab「通知中心」（settings.section 插槽，issue #366
 *   M1：参照 provider-usage「用量统计」tab；不做 plugin.item 双插槽重复展示）
 *   ——侧边栏「通知」入口/浮层/角标/拖拽全部移除（B1-B6）；
 * - 通知半区（C1-C9）保留并与 DOM 解耦：SSE /events 订阅 + 60s 看门狗 +
 *   visibilitychange 重建 + 多标签租约 + 音频手势解锁，不依赖任何插件 DOM；
 * - 历史记录最近 10 条收进卡片（D1-D2）；卡片动作区含清理记录（两段式确认）/
 *   请求权限/发送测试通知（A6-A7）；三端降级文案迁入卡片（A5/A8）；
 * - 配置读取走 GET /config 包装体 {ok,user,revision,effective,writable}，保存走
 *   PUT {patch, expectedRevision}（基线 diff 只提变更键，F3/A4）。
 */
// 浏览器半区干净模块：只导出 apply/inject；React 由构建期 external 注入（经 factory
// 注入的 require("react") 解析，dsh web 不暴露全局 React）。契约外壳（IIFE/load/
// Symbol.toStringTag 装配）由 scripts/build/build-client.ts 统一生成——源码不写任何 loader。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";
import * as React from "react";

  var ROUTES = {
    config: "/api/dsh-notifier/config",
    events: "/api/dsh-notifier/events",
    health: "/api/dsh-notifier/health",
    test: "/api/dsh-notifier/test",
    history: "/api/dsh-notifier/history",
  };
  var STYLE_ID = "dsh-notifier-style";
  var CSS_VERSION = "76";
  // 浏览器通知图标（内联 SVG data URL，零外部资源；铃铛造型）。
  var NOTIFY_ICON =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0f9d6e"/><path fill="#fff" d="M12 4a1 1 0 0 1 1 1v.55A5.5 5.5 0 0 1 17.5 11v2.3l1.45 1.45a1 1 0 0 1-.7 1.7H5.75a1 1 0 0 1-.7-1.7L6.5 13.3V11A5.5 5.5 0 0 1 11 5.55V5a1 1 0 0 1 1-1zm-2.5 13a2.5 2.5 0 0 0 5 0h-5z"/></svg>'
    );

  var EVENT_KEYS = [
    ["notifyAsk", "审批等待"],
    ["notifyQuestion", "向你提问"],
    ["notifyTaskDone", "任务完成"],
    ["notifySubagentDone", "子任务完成"],
    ["notifyTaskError", "任务出错"],
    ["notifyTurnEnd", "轮次完成"],
  ];
  var CHANNEL_KEYS = [
    ["systemNotify", "系统通知"],
    ["browserNotify", "浏览器通知"],
    ["notifyWhenVisible", "页面可见时也弹"],
    ["notifySound", "通知声音"],
  ];
  var KIND_LABELS: Record<string, string> = {
    ask: "审批等待",
    question: "向你提问",
    done: "任务完成",
    "subagent-done": "子任务完成",
    error: "任务出错",
    "turn-end": "轮次完成",
    test: "测试",
  };

  function injectStyle() {
    var existing = document.getElementById(STYLE_ID);
    if (existing && existing.dataset.version === CSS_VERSION) return;
    if (existing) existing.remove();
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.version = CSS_VERSION;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  /** 页面内短提示（操作反馈）。 */
  function toast(message: any) {
    var el = document.createElement("div");
    el.className = "dn-toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3000);
  }

  /**
   * 403（loopback 围栏拒绝）时的可操作引导文案，供各处 catch 复用。
   * 非 403 错误返回空串，避免给普通失败粘贴无关提示。
   */
  function accessHint(error: any) {
    var text = String((error && error.message) || "");
    if (text.indexOf("403") === -1) return "";
    return "（若为局域网直连访问，通知服务仅允许回环调用而被拒：请用 dsh-lan-proxy 的 https://<局域网IP>:3443 或 ssh -L 3080:127.0.0.1:3080 隧道访问后刷新）";
  }

  /**
   * 请求浏览器通知权限（必须在用户手势内调用，Chrome 才接受）。
   * 完成后回调（无论结果），用于刷新卡片权限状态。
   */
  function requestPermission(onDone: any) {
    if (!("Notification" in window)) return;
    try {
      Notification.requestPermission().then(function () {
        if (onDone) onDone();
      }).catch(function () {
        if (onDone) onDone();
      });
    } catch (error) {
      if (onDone) onDone();
    }
  }

  // ------------------------------------------------------------ 通知显示（半区）

  var notified: any = [];

  // 多标签主从租约（仅「同 URL 的同浏览器多标签」有效；跨 host/IP、跨浏览器
  // 的 storage 域互不相交，去重自然失效）：收到通知帧的标签先 checkMaster：
  // 有效租约且属于自己 → 续租并展示；属于他人 → 静默；无主/已过期 → 抢占。
  var TAB_ID = Math.random().toString(36).slice(2);
  var MASTER_KEY = "dsh-notifier:master";
  var MASTER_LEASE_MS = 15000;
  function claimMaster() {
    try {
      var raw = localStorage.getItem(MASTER_KEY);
      var lease = raw ? JSON.parse(raw) : null;
      var now = Date.now();
      if (lease && typeof lease.id === "string" && typeof lease.ts === "number" && now - lease.ts < MASTER_LEASE_MS) {
        if (lease.id === TAB_ID) {
          lease.ts = now;
          localStorage.setItem(MASTER_KEY, JSON.stringify(lease));
          return true;
        }
        return false;
      }
      localStorage.setItem(MASTER_KEY, JSON.stringify({ id: TAB_ID, ts: now }));
      return true;
    } catch (error) {
      return true;
    }
  }

  /** 页面是否处于安全上下文（HTTPS 或 localhost）——系统级 Notification 的前提。 */
  function isSecureContext() {
    return window.isSecureContext === true;
  }

  /** 系统级浏览器通知是否可用（安全上下文 + 已授权）。 */
  function systemNotificationUsable() {
    if (!("Notification" in window)) return false;
    if (!isSecureContext()) return false;
    return Notification.permission === "granted";
  }

  var audioCtx: any = null;

  /** 解锁音频（必须在用户手势内调用）：后台播放提示音需要已解锁的 AudioContext。 */
  function unlockAudio() {
    try {
      if (audioCtx === null) {
        var AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      var buffer = audioCtx.createBuffer(1, 1, 22050);
      var source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(0);
    } catch (error) {
      // 音频不可用不阻塞通知
    }
  }

  var lastChimeAt = 0;
  function playChime() {
    if (audioCtx === null || audioCtx.state !== "running") return;
    var now = Date.now();
    if (now - lastChimeAt < 1500) return;
    lastChimeAt = now;
    try {
      var t = audioCtx.currentTime;
      for (var i = 0; i < 2; i += 1) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = i === 0 ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, t + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.18, t + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t + i * 0.18);
        osc.stop(t + i * 0.18 + 0.17);
      }
    } catch (error) {
      // 播放失败忽略
    }
  }

  var savedTitle: any = null;
  function flashTitle(title: any) {
    if (savedTitle === null) savedTitle = document.title;
    document.title = "🔔 " + String(title).slice(0, 40);
  }
  function restoreTitle() {
    if (savedTitle !== null) {
      document.title = savedTitle;
      savedTitle = null;
    }
  }

  function el(tag: any, attrs: any, children: any = undefined) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        var value = attrs[key];
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key === "onClick") node.addEventListener("click", value);
        else if (key === "style") node.style.cssText = value;
        else if (key in node && key !== "list") node[key] = value;
        else node.setAttribute(key, value);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i += 1) node.appendChild(children[i]);
    }
    return node;
  }

  /** 页面内横幅（非安全上下文降级通道；点击聚焦，8 秒自动消失，最多叠 3 条）。 */
  function showBanner(kind: any, title: any, message: any) {
    var existing = document.querySelector('.dn-banner[data-kind="' + kind + '"]');
    if (existing) existing.remove();
    var banners = document.querySelectorAll(".dn-banner");
    while (banners.length >= 3) banners[0].remove();
    var banner = el("div", {
      class: "dn-banner",
      dataset: { kind: kind },
      onClick: function () {
        window.focus();
        banner.remove();
      },
    });
    var head = el("div", { style: "display:flex;align-items:center;gap:6px" });
    head.appendChild(el("span", { text: "🔔" }));
    head.appendChild(el("span", { text: title, style: "font-weight:600" }));
    banner.appendChild(head);
    banner.appendChild(el("div", { text: message, style: "margin-top:4px;font-size:12px;line-height:1.5;white-space:pre-line" }));
    document.body.appendChild(banner);
    setTimeout(function () {
      banner.remove();
    }, 8000);
  }

  /**
   * 通知展示总入口：系统级 Notification 可用 → 弹系统通知；
   * 否则降级（页面内横幅 + 提示音 + 标题提醒）。
   */
  function showNotification(kind: any, title: any, message: any, soundEnabled: boolean) {
    // 多标签去重：仅主标签执行展示，副标签静默
    if (!claimMaster()) return;
    if (systemNotificationUsable()) {
      try {
        var notification = new Notification(title, { body: message, tag: "dsh-notifier-" + kind + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), icon: NOTIFY_ICON, silent: !soundEnabled });
        notification.onclick = function () {
          window.focus();
          notification.close();
        };
        notified.push(notification);
        if (notified.length > 5) notified.shift().close();
        return;
      } catch (error) {
        console.warn("[dsh-notifier] 浏览器通知失败，降级为页面内提醒：", error);
      }
    }
    // 降级通道
    if (document.visibilityState !== "hidden") {
      showBanner(kind, title, message);
    } else {
      flashTitle(title);
    }
    playChime();
  }

  // ---- 运行时配置镜像（GET /config 的 effective；SSE 展示与可见性判定用）----
  var runtimeConfig: any = null;

  function handleNotifyFrame(payload: any) {
    // 测试通知：无条件提醒（验证链路是它的目的，与可见性/权限之外的开关无关）。
    if (payload.kind === "test") {
      showNotification(payload.kind, payload.title, payload.message, runtimeConfig?.notifySound !== false);
      return;
    }
    // 页面聚焦时不提醒（用户在界面中）；除非配置了「页面可见时也弹」。
    if (document.visibilityState !== "hidden" && !(runtimeConfig && runtimeConfig.notifyWhenVisible === true)) return;
    showNotification(payload.kind, payload.title, payload.message, runtimeConfig?.notifySound !== false);
  }

  // ------------------------------------------------------------ SSE 半区（C1-C9）

  // 当前 SSE 句柄（visibilitychange 回前台重建时引用；卸载时置 null）
  var eventsHandle: { close: () => void; reconnect: () => void } | null = null;

  // 页面重新可见时：还原标题 + 强制重建 SSE（iOS 后台挂起后连接可能已失效，
  // 重建自动带 since 补拉，避免断线窗口漏通知）
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      restoreTitle();
      if (eventsHandle && eventsHandle.reconnect) eventsHandle.reconnect();
    }
  });

  /** SSE 半开连接看门狗：60s 无任何帧（notify 或心跳 ping）→ 主动重建。 */
  var WATCHDOG_MS = 60000;
  function startEvents() {
    var source: any = null;
    var lastActivity = 0;
    var lastSeq = 0;
    var watchdog: any = null;
    var lastReconnectAt = 0;

    function armWatchdog() {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        if (Date.now() - lastActivity > WATCHDOG_MS) {
          forceReconnect();
        } else {
          armWatchdog();
        }
      }, WATCHDOG_MS + 5000);
    }

    function forceReconnect() {
      var now = Date.now();
      if (now - lastReconnectAt < 5000) return;
      lastReconnectAt = now;
      closeSource();
      connect();
    }

    function closeSource() {
      if (source !== null) {
        try {
          source.close();
        } catch (error) {
          console.warn("[dsh-notifier] 关闭旧 SSE 连接失败：", error);
        }
        source = null;
      }
    }

    function connect() {
      closeSource();
      try {
        // 重连带 since：服务端先回放缓冲中 seq 更大的帧（断线补拉，不丢事件）
        var url = ROUTES.events + (lastSeq > 0 ? "?since=" + lastSeq : "");
        source = new EventSource(url);
        lastActivity = Date.now();
        source.onmessage = function (event: any) {
          try {
            var data = JSON.parse(event.data);
            lastActivity = Date.now();
            if (data.type === "ping") return;
            if (data.type === "notify") {
              if (typeof data.seq === "number") {
                if (lastSeq > 0 && data.seq <= lastSeq) return;
                lastSeq = data.seq;
              }
              handleNotifyFrame(data);
            }
          } catch (error) {
            console.warn("[dsh-notifier] 帧解析失败：", error);
          }
        };
        source.onerror = function () {
          // 主动重建（带 since 补拉）：EventSource 自动重连不带 query，无法回放
          forceReconnect();
        };
        armWatchdog();
      } catch (error) {
        console.warn("[dsh-notifier] EventSource 不可用：", error);
      }
    }

    connect();
    var handle = {
      close: function () {
        if (watchdog !== null) clearTimeout(watchdog);
        closeSource();
      },
      reconnect: forceReconnect,
    };
    eventsHandle = handle;
    return handle;
  }

  // ------------------------------------------------------------ 设置卡片

  /** 加载 GET /config 包装体 → 结构化 {user, revision, effective, writable}。 */
  function fetchConfig(): Promise<any> {
    return fetch(ROUTES.config, { headers: { accept: "application/json" } }).then(function (r: any) {
      return r.json().then(function (body: any) {
        if (!r.ok) {
          var err = (body && body.error) || {};
          throw new Error(err.details || err.error || ("HTTP " + r.status));
        }
        return body;
      });
    });
  }

  /** 拉取最近历史记录（最近 10 条，倒序）。 */
  function fetchHistory(): Promise<any[]> {
    return fetch(ROUTES.history, { headers: { accept: "application/json" } })
      .then(function (r: any) { return r.json(); })
      .then(function (data: any) {
        var records = (data && data.records) || [];
        return records.slice(-10).reverse();
      });
  }

  /**
   * 设置面板独立 tab「通知中心」（settings.section 插槽渲染的 React 卡片）。
   * 字段全量（A1）+ 基线 diff 只提变更键（A4）+ 历史最近 10 条（D1/D2）+
   * 动作区（清理记录两段式 / 请求权限 / 测试通知，A6/A7）+ 三端降级文案（A5/A8）。
   * 保存走 PUT {patch, expectedRevision}（乐观并发，冲突时提示刷新）。
   */
  function SettingsCard() {
    var ReactHooks = React;
    var useState = ReactHooks.useState;
    var useEffect = ReactHooks.useEffect;
    var draft = useState(null);
    var settings = draft[0];
    var setSettings = draft[1];
    var meta = useState(null); // { user, revision, effective, writable }
    var metaValue = meta[0];
    var setMeta = meta[1];
    var saved = useState("");
    var setSaved = saved[1];
    var historyDraft = useState(null);
    var history = historyDraft[0];
    var setHistory = historyDraft[1];
    var clearArmed = useState(false);
    var clearArmedValue = clearArmed[0];
    var setClearArmed = clearArmed[1];
    // 加载基线（A4）：保存时只提交与基线不同的键（增量 diff），未改动的键不提交
    var baseline: Record<string, any> | null = null;

    function loadHistory(alive: { value: boolean }) {
      fetchHistory().then(function (records) {
        if (alive.value) setHistory(records);
      }).catch(function () {
        if (alive.value) setHistory([]);
      });
    }

    function loadCard(alive: { value: boolean }) {
      fetchConfig()
        .then(function (v: any) {
          if (!alive.value) return;
          var effective = (v && v.effective) || {};
          setSettings(Object.assign({}, effective));
          baseline = Object.assign({}, effective);
          setMeta({ user: v.user || {}, revision: v.revision, effective: effective, writable: v.writable !== false });
          runtimeConfig = effective; // SSE 展示面同步
          if (v.writable === false) setSaved("设置服务不可用");
        })
        .catch(function (e: any) {
          if (!alive.value) return;
          setSaved("设置加载失败：" + ((e && e.message) || e) + accessHint(e));
        });
    }

    useEffect(function () {
      var alive = { value: true };
      loadCard(alive);
      loadHistory(alive);
      return function () { alive.value = false; };
    }, []);

    if (!settings) {
      return React.createElement("li", { className: "dn-set-card" }, "通知：加载中…");
    }

    function patch(p: any) {
      setSettings(Object.assign({}, settings, p));
      setSaved("");
    }

    /** 基线 diff：只提交与加载基线不同的键（A4，防组合层 base 被默认值回写覆盖）。 */
    function diffPayload(): Record<string, any> {
      var payload: Record<string, any> = {};
      for (var key in settings) {
        if (baseline === null) break;
        var cur = settings[key];
        var base = baseline[key];
        var same = JSON.stringify(cur) === JSON.stringify(base);
        if (!same) payload[key] = cur;
      }
      return payload;
    }

    function save() {
      var payload = diffPayload();
      if (Object.keys(payload).length === 0) {
        setSaved("未修改");
        return;
      }
      fetch(ROUTES.config, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: payload, expectedRevision: metaValue ? metaValue.revision : undefined }),
      }).then(function (r: any) {
        return r.json().then(function (body: any) {
          if (!r.ok) {
            var err = (body && body.error) || {};
            throw new Error(err.error || err.details || err.code || ("HTTP " + r.status));
          }
          return body;
        });
      }).then(function (body: any) {
        baseline = Object.assign({}, settings);
        setMeta({ user: (body && body.user) || {}, revision: (body && body.revision) || undefined, effective: settings, writable: true });
        setSaved("已保存");
        setTimeout(function () { setSaved(""); }, 2200);
      }).catch(function (e: any) {
        var msg = (e && e.message) || e;
        setSaved(String(msg).indexOf("版本冲突") >= 0
          ? "保存失败：" + msg + "（请关闭本卡片重新打开后重试）"
          : "保存失败：" + msg);
      });
    }

    function sendTest() {
      fetch(ROUTES.test, { method: "POST" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          // 服务端返回 {ok, sseConnections}：连接数语义 = 未释放句柄（#334 诊断保留）
          toast("测试通知已发送（服务端未释放句柄 " + (data && data.sseConnections) + " 条）");
        })
        .catch(function (error) {
          toast("发送测试通知失败：" + error.message + accessHint(error));
        });
    }

    function confirmClear() {
      if (!clearArmedValue) {
        setClearArmed(true);
        setTimeout(function () { setClearArmed(false); }, 3000);
        return;
      }
      setClearArmed(false);
      fetch(ROUTES.history, { method: "DELETE" })
        .then(function (r: any) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data: any) {
          toast("已清空 " + (data.removed || 0) + " 条通知记录");
          loadHistory({ value: true });
        })
        .catch(function (error) {
          toast("清空失败：" + error.message + accessHint(error));
        });
    }

    var rows: any[] = [];
    var sectionCount = 0;
    function section(title: string, children: any[]) {
      sectionCount += 1;
      return React.createElement("div", { className: "dn-set-section", key: "sec" + sectionCount },
        React.createElement("div", { className: "dn-set-title" }, title),
        children,
      );
    }

    function row(label: string, control: any, hint?: string) {
      sectionCount += 1;
      return React.createElement("div", { className: "dn-set-row", key: "row" + sectionCount },
        React.createElement("span", { className: "dn-set-label" }, label),
        control,
        hint ? React.createElement("span", { className: "dn-set-hint" }, hint) : null,
      );
    }

    function switchControl(key: string) {
      return React.createElement("input", {
        type: "checkbox",
        checked: settings[key] === true,
        onChange: function (e: any) {
          var next = Object.assign({}, settings);
          next[key] = e.target.checked;
          setSettings(next);
        },
      });
    }

    var eventChildren = EVENT_KEYS.map(function (kv) { return row(kv[1], switchControl(kv[0])); });
    var channelChildren = CHANNEL_KEYS.map(function (kv) { return row(kv[1], switchControl(kv[0])); });
    var numberChildren = [
      row("错误合并窗口（ms，0=关）", React.createElement("input", {
        type: "number", min: 0, step: 1000, className: "dn-set-input",
        value: settings.errorMergeWindowMs,
        onChange: function (e: any) { patch({ errorMergeWindowMs: Number(e.target.value) }); },
      })),
      row("完成聚合窗口（ms，0=关）", React.createElement("input", {
        type: "number", min: 0, step: 1000, className: "dn-set-input",
        value: settings.doneMergeWindowMs,
        onChange: function (e: any) { patch({ doneMergeWindowMs: Number(e.target.value) }); },
      })),
      row("审批二次提醒（分钟，0=关）", React.createElement("input", {
        type: "number", min: 0, step: 1, className: "dn-set-input",
        value: settings.askRemindMin,
        onChange: function (e: any) { patch({ askRemindMin: Number(e.target.value) }); },
      })),
      row("历史保留天数（0=不按天清理）", React.createElement("input", {
        type: "number", min: 0, step: 1, className: "dn-set-input",
        value: settings.historyMaxAgeDays,
        onChange: function (e: any) { patch({ historyMaxAgeDays: Number(e.target.value) }); },
      })),
      row("最大连接数（条，超出淘汰最老）", React.createElement("input", {
        type: "number", min: 1, max: 1024, step: 1, className: "dn-set-input",
        value: settings.maxConnections,
        onChange: function (e: any) { patch({ maxConnections: Number(e.target.value) }); },
      })),
    ];

    var qh = settings.quietHours || {};
    var quietChildren = [
      row("启用免打扰", React.createElement("input", {
        type: "checkbox",
        checked: qh.enabled === true,
        onChange: function (e: any) { patch({ quietHours: Object.assign({}, qh, { enabled: e.target.checked }) }); },
      })),
      row("开始时间", React.createElement("input", {
        type: "time", className: "dn-set-input",
        value: qh.start || "22:00",
        onChange: function (e: any) { patch({ quietHours: Object.assign({}, qh, { start: e.target.value }) }); },
      })),
      row("结束时间", React.createElement("input", {
        type: "time", className: "dn-set-input",
        value: qh.end || "08:00",
        onChange: function (e: any) { patch({ quietHours: Object.assign({}, qh, { end: e.target.value }) }); },
      })),
    ];
    var ALLOW_CHOICES = [["ask", "审批"], ["question", "提问"], ["error", "出错"]];
    quietChildren.push(React.createElement("div", { className: "dn-set-row", key: "allow" },
      React.createElement("span", { className: "dn-set-label" }, "免打扰仍提醒"),
      React.createElement("div", { className: "dn-set-allows" },
        ALLOW_CHOICES.map(function (ac) {
          var kindText = ac[0], kindLabel = ac[1];
          var allows = qh.allowKinds || [];
          return React.createElement("label", { className: "dn-set-allow", key: kindText },
            React.createElement("input", {
              type: "checkbox",
              checked: allows.indexOf(kindText) !== -1,
              onChange: function (e: any) {
                var next = allows.slice();
                if (e.target.checked && next.indexOf(kindText) === -1) next.push(kindText);
                else if (!e.target.checked && next.indexOf(kindText) !== -1) next.splice(next.indexOf(kindText), 1);
                patch({ quietHours: Object.assign({}, qh, { allowKinds: next }) });
              },
            }),
            React.createElement("span", null, kindLabel),
          );
        }),
      ),
    ));

    // 三端降级文案（A5/A8）
    var degradation: any[] = [];
    if (metaValue && metaValue.writable === false) {
      degradation.push(React.createElement("div", { className: "dn-set-note", key: "settings-unavailable" },
        "设置服务不可用：当前无法保存配置（settings 服务未挂载）。插件通知功能不受影响，但更改将被拒绝。"));
    }
    if ("Notification" in window) {
      if (!isSecureContext()) {
        degradation.push(React.createElement("div", { className: "dn-set-note", key: "insecure" },
          "当前为局域网 HTTP 访问（非安全上下文），浏览器禁止系统级弹窗，已启用「页面内横幅 + 提示音 + 标题提醒」降级通道。如需系统弹窗，请改用 dsh-lan-proxy 的 https://<局域网IP>:3443 或 localhost 隧道访问（如 ssh -L 3080:127.0.0.1:3080）后刷新页面。"));
      } else {
        var permText = "";
        if (Notification.permission === "granted") permText = "浏览器通知权限：已授权 ✓";
        else if (Notification.permission === "denied") permText = "浏览器通知权限：已拒绝（请在浏览器站点设置中允许本页通知）";
        else permText = "浏览器通知权限：未授权（点击下方按钮在浏览器弹窗中允许）";
        degradation.push(React.createElement("div", { className: "dn-set-note", key: "perm" }, permText));
      }
    } else {
      degradation.push(React.createElement("div", { className: "dn-set-note", key: "noapi" },
        "当前设备不支持系统级通知（如 iOS Safari 普通标签页无 Web Notifications）。可用通道：页面可见时的横幅 + 提示音（需保持页面打开），或经 dsh-lan-proxy 的 https://<局域网IP>:3443 访问并「添加到主屏幕」后获得 PWA 级通知能力。"));
    }

    // 动作区（A6/A7）
    var actions = React.createElement("div", { className: "dn-set-actions" },
      React.createElement("button", { type: "button", className: "dn-set-btn" + (clearArmedValue ? " dn-set-btnDanger" : ""), onClick: confirmClear },
        clearArmedValue ? "确认清理记录？" : "清理记录"),
      ("Notification" in window && Notification.permission === "default")
        ? React.createElement("button", { type: "button", className: "dn-set-btn", onClick: function () {
            requestPermission(function () { setSaved("权限请求完成，请刷新查看状态"); });
          } }, "请求通知权限")
        : null,
      React.createElement("button", { type: "button", className: "dn-set-btn", onClick: sendTest }, "发送测试通知"),
    );

    // 历史列表（D1/D2）
    var historyEl = React.createElement("div", { className: "dn-set-section" },
      React.createElement("div", { className: "dn-set-title" }, "通知记录（最近 10 条）"),
      React.createElement("button", {
        type: "button", className: "dn-set-btn dn-set-btnSmall",
        onClick: function () { loadHistory({ value: true }); },
      }, "刷新"),
      !history || history.length === 0
        ? React.createElement("div", { className: "dn-set-note" }, "暂无通知记录（点「发送测试通知」可生成一条）")
        : React.createElement("ul", { className: "dn-set-history" },
            history.map(function (r: any, i: number) {
              var d = new Date(r.ts);
              var pad = function (n: number) { return n < 10 ? "0" + n : String(n); };
              var time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
              return React.createElement("li", { className: "dn-set-historyItem", key: String(r.ts) + "-" + i },
                React.createElement("div", { className: "dn-set-historyHead" },
                  React.createElement("span", { className: "dn-set-historyTime" }, time),
                  React.createElement("span", { className: "dn-set-historyKind" }, KIND_LABELS[r.kind] || r.kind),
                  r.suppressed === "quiet"
                    ? React.createElement("span", { className: "dn-set-historySuppressed" }, "免打扰拦截未发出")
                    : null,
                ),
                React.createElement("div", { className: "dn-set-historyText" }, r.title + "：" + r.message),
              );
            }),
          ),
    );

    return React.createElement("li", { className: "dn-set-card" },
      React.createElement("div", { className: "dn-set-head" },
        React.createElement("span", { className: "dn-set-name" }, "通知（dsh-notifier）"),
        React.createElement("span", { className: "dn-set-description" }, "审批/完成/错误事件通知 · 事件开关 / 通道 / 合并去重 / 免打扰 / 历史清理"),
      ),
      React.createElement("div", { className: "dn-set-body" },
        section("通知事件", eventChildren),
        section("通知通道", channelChildren),
        section("合并/去重", numberChildren),
        section("免打扰时段", quietChildren),
        historyEl,
        section("动作", actions),
        React.createElement("div", { className: "dn-set-notes" }, degradation),
        React.createElement("div", { className: "dn-set-foot" },
          saved ? React.createElement("span", { className: saved.indexOf("失败") >= 0 || saved.indexOf("不可用") >= 0 ? "dn-set-error" : "dn-set-saved" }, saved) : null,
          React.createElement("button", { type: "button", className: "dn-set-save", onClick: save }, "保存"),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ 装配

export function apply(ctx: any) {
    try {
      injectStyle();

      // 通知半区（SSE / 浏览器通知）：不依赖任何插件 DOM（C6），直接启动
      var disposeEvents: { close: () => void; reconnect: () => void } | null = startEvents();
      // 运行时配置预取：可见性判定与通知展示要用 notifyWhenVisible / notifySound
      fetchConfig().then(function (v: any) {
        if (v && v.effective) runtimeConfig = v.effective;
      }).catch(function () {
        // 失败静默（卡片打开时再拉）
      });

      // 首次任意点击解锁音频（浏览器自动播放策略要求手势）
      document.addEventListener("click", function onFirstClick() {
        unlockAudio();
        document.removeEventListener("click", onFirstClick);
      }, { capture: true });

      // 设置面板独立 tab「通知中心」（settings.section，issue #366 M1）。
      // 参照 dsh-provider-usage「用量统计」tab 的接线（slots.inject + register，
      // 独立顶层页）；label 为导航显示文本。旧运行时若不声明该插槽，inject
      // 回调不执行 → tab 不挂载、通知半区照常工作（与 provider-usage 同语义，
      // 不做 plugin.item 双插槽重复展示——评审 B P0）。
      var slots = ctx.get("slots");
      if (slots && typeof slots.inject === "function") {
        slots.inject("settings.section", function () {
          return slots.register(
            { name: "settings.section", id: "dsh-notifier", order: 70, label: "通知中心" },
            function () {
              return React.createElement(SettingsCard, null);
            }
          );
        });
      } else {
        console.warn("[dsh-notifier] 缺少 slots 服务，设置 tab 未挂载（通知半区照常工作）");
      }

      // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里。
      ctx.effect(function () {
        return function () {
          if (disposeEvents) {
            disposeEvents.close();
            disposeEvents = null;
            eventsHandle = null;
          }
          for (var i = 0; i < notified.length; i += 1) {
            try {
              notified[i].close();
            } catch (error) {
              // 忽略
            }
          }
          var style = document.getElementById(STYLE_ID);
          if (style) style.remove();
        };
      }, "dsh-notifier");
    } catch (error) {
      console.warn("[dsh-notifier] 挂载失败：", error);
    }
  }

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals）----
// 设置卡片是 React 组件（settings.section 独立 tab 插槽由宿主 React 渲染）；通知半区
// 不依赖任何 DOM（C6），slot 缺失时照常工作。
export const inject: string[] = ["slots"];
