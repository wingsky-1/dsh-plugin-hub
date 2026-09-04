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
// 样式注入收敛 shared/client/ensure-style.js（issue #477）：本包只补
// { id, cssText, version } 实参；STYLE_ID/CSS_VERSION 常量保留为调用实参来源，
// disposer（getElementById(STYLE_ID)）沿用常量。
import { ensureStyle } from "../../../../shared/client/ensure-style.js";
import * as React from "react";
// i18n（issue #348）：复用官方 dsh-client-locale——zh/en 双语字典，LocaleNamespaceMap
// 声明合并进官方 ui-slots 类型面；仅 import type（编译期擦除，无运行时依赖）。
import { zh, en, type NotifierLocaleKey } from "./locales.ts";
// 显式类型导入，先把 @deepseek-ai/dsh-client-ui-slots 拉进模块解析图：上游发布物
// lib/types/*.d.ts 相对导入保留 .ts 后缀，declare module 增强的模块名解析会判
// TS2664（microsoft/TypeScript#63960 同类；上游修复发布物后此行可删）。
import type { LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-notifier 设置卡/历史列表/权限降级说明文案。 */
    "notifier": NotifierLocaleKey;
  }
}

/** 本插件字典命名空间（宿主 locale 服务注册用）。 */
const NS = "notifier";

/**
 * 基线 diff 纯函数（issue #470 复核 P1-2）：返回 settings 相对 baseLine 中
 * **值不同**的键集合（增量 patch，只提交变更键——A4 防组合层 base 被默认值
 * 回写覆盖）。深比较用 JSON.stringify（值同序同即视为未变，UI 编辑对象字段
 * 时键序稳定）。settings 中不存在于 baseLine 的新增键（diff 语义下的新增）
 * 与值不同的既有键都会被提交；baseLine 中已删除的键不提交删除（增量 merge
 * patch 无删除语义）。
 *
 * 导出为纯函数供测试直测（与 save() 共用同一实现——routes.test 整链模拟不再
 * 手写近似）。
 * @param settings 当前 UI 编辑态（effective 深拷贝起点）。
 * @param baseLine 加载基线（loadCard 时的 effective 深拷贝）。
 */
function diffSettingsPayload(settings: Record<string, any>, baseLine: Record<string, any> | null): Record<string, any> {
  var payload: Record<string, any> = {};
  if (baseLine === null) return payload;
  for (var key in settings) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    var cur = settings[key];
    var base = baseLine[key];
    var same = JSON.stringify(cur) === JSON.stringify(base);
    if (!same) payload[key] = cur;
  }
  return payload;
}

  /** i18n 翻译函数（apply 时由 ctx.locale.bind(NS) 装配；未装配回落 key 本体，行为零变化）。 */
  var t: any = function (key: string, params?: any) {
    if (params === undefined) return key;
    return String(key); // 未装配时占位插值忽略（正常路径早已装配）
  };

  var ROUTES = {
    config: "/api/dsh-notifier/config",
    events: "/api/dsh-notifier/events",
    health: "/api/dsh-notifier/health",
    test: "/api/dsh-notifier/test",
    history: "/api/dsh-notifier/history",
    status: "/api/dsh-notifier/status",
    kinds: "/api/dsh-notifier/kinds",
  };
  var STYLE_ID = "dsh-notifier-style";
  // 合并 #418/#421/#426/#508 后统一 bump（保证新样式重注入；508-1 > 426-1）
  var CSS_VERSION = "508-1";
  // 浏览器通知图标（内联 SVG data URL，零外部资源；铃铛造型）。
  var NOTIFY_ICON =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0f9d6e"/><path fill="#fff" d="M12 4a1 1 0 0 1 1 1v.55A5.5 5.5 0 0 1 17.5 11v2.3l1.45 1.45a1 1 0 0 1-.7 1.7H5.75a1 1 0 0 1-.7-1.7L6.5 13.3V11A5.5 5.5 0 0 1 11 5.55V5a1 1 0 0 1 1-1zm-2.5 13a2.5 2.5 0 0 0 5 0h-5z"/></svg>'
    );

  // i18n：label 列存字典 key（渲染期 t 求值，模块加载时 t 尚未装配）。
  var EVENT_KEYS = [
    ["notifyAsk", "evtAsk"],
    ["notifyQuestion", "evtQuestion"],
    ["notifyTaskDone", "evtTaskDone"],
    ["notifySubagentDone", "evtSubagentDone"],
    ["notifyTaskError", "evtTaskError"],
    ["notifyTurnEnd", "evtTurnEnd"],
  ];
  /** 事件开关键 → 通知 kind（单一事实源；免打扰豁免候选/「跟随已启用」由此派生，
   *  与服务端 EVENT_KEYS 对应的事件源 kind 一致：ask/question/done/subagent-done/
   *  error/turn-end）。 */
  var EVENT_KIND_MAP: Record<string, string> = {
    notifyAsk: "ask",
    notifyQuestion: "question",
    notifyTaskDone: "done",
    notifySubagentDone: "subagent-done",
    notifyTaskError: "error",
    notifyTurnEnd: "turn-end",
  };
  /** kind → 字典 key（未知 kind 回落 kind 本体显示，数据不翻译）。 */
  var KIND_KEYS: Record<string, string> = {
    ask: "kAsk",
    question: "kQuestion",
    done: "kDone",
    "subagent-done": "kSubagentDone",
    error: "kError",
    "turn-end": "kTurnEnd",
    test: "kTest",
  };

  /**
   * kind → 展示强度（severity）css 修饰符（#508 M1：事件行/历史行色点）。
   * 与服务端 service.ts KIND_SEVERITY 同源复制（客户端不 import 宿主端模块——
   * 干净模块边界），两处由各自测试锁定；新增 kind 时同步维护。
   */
  var KIND_SEV: Record<string, string> = {
    ask: "warning",
    question: "info",
    done: "success",
    "subagent-done": "info",
    error: "failure",
    "turn-end": "info",
    test: "info",
  };

  /**
   * 频道实例 → 路由 id（#508 复核 4②：channelId 前缀单点化）。
   * 旧实现 "bark:"+id 三处硬编码（service resolveRoutes / 宿主 outboundChannels /
   * 客户端 routeToggle），webhook 频道引入后统一为 `type:id`——本 helper 为客户端
   * 单一事实源，宿主端同名单独维护（跨端无共享模块，注释互指）。
   */
  function channelIdFor(cfg: Record<string, any>): string {
    return String(cfg.type || "") + ":" + String(cfg.id || "");
  }

  /**
   * webhook 频道预设（#508 M2，拍板 r3）：选择预设填充认证方式与消息模板；URL 不自动
   * 覆盖（避免丢用户已填内容——对抗评审 P1-11 的「仅空值填充」变体：URL 只在为空时
   * 由用户填写，模板/认证随预设走且可再改）。模板渲染契约见 channel-webhook.ts：
   * 文本占位符 JSON-aware 转义、{{ts}} 数字直出、{{priority}} 频道感知映射。
   */
  var WEBHOOK_PRESETS: Record<string, { auth: string; template: string }> = {
    ntfy: {
      auth: "bearer",
      template: '{\n  "topic": "<topic>",\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "tags": ["{{kind}}"],\n  "priority": "{{priority}}"\n}',
    },
    gotify: {
      auth: "bearer",
      template: '{\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "priority": "{{priority}}"\n}',
    },
    custom: {
      auth: "header",
      template: '{\n  "event": "{{kind}}",\n  "title": "{{title}}",\n  "body": "{{message}}",\n  "severity": "{{severity}}",\n  "ts": {{ts}}\n}',
    },
  };

  /**
   * 频道类型图标（#508 拍板 ⑤ 保留；内联 SVG 零外部资源）。
   * browser=地球 / system=显示器 / webhook=闪电 / 其余（bark）=铃铛。
   */
  function iconEl(channelType: string) {
    var paths: any[];
    if (channelType === "browser") {
      paths = [
        React.createElement("circle", { cx: 12, cy: 12, r: 9, key: "c" }),
        React.createElement("path", { d: "M3 12h18M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z", key: "p" }),
      ];
    } else if (channelType === "system") {
      paths = [
        React.createElement("rect", { x: 3, y: 4, width: 18, height: 12, rx: 2, key: "r" }),
        React.createElement("path", { d: "M8 20h8M12 16v4", key: "p" }),
      ];
    } else if (channelType === "webhook") {
      paths = [React.createElement("path", { d: "M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8z", key: "p", strokeLinejoin: "round" })];
    } else {
      paths = [
        React.createElement("path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9", key: "a" }),
        React.createElement("path", { d: "M13.7 21a2 2 0 0 1-3.4 0", key: "b" }),
      ];
    }
    return React.createElement("span", { className: "dn-ch-icon" },
      React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 }, paths));
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
    return t("lanAccessHint");
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

  /** 拉取频道投递状态（M2：per-channel 最近投递终态）。 */
  function fetchStatus(): Promise<any> {
    return fetch(ROUTES.status, { headers: { accept: "application/json" } })
      .then(function (r: any) { return r.json(); })
      .then(function (data: any) { return (data && data.channels) || {}; })
      .catch(function () { return {}; });
  }

  /** 拉取动态 kind 清单（M2：注册表 + 确认态）。 */
  function fetchKinds(): Promise<any[]> {
    return fetch(ROUTES.kinds, { headers: { accept: "application/json" } })
      .then(function (r: any) { return r.json(); })
      .then(function (data: any) { return (data && data.kinds) || []; })
      .catch(function () { return []; });
  }

  /** 动态 kind 确认（M2：POST /kinds {kind, confirmed}）。 */
  function postKind(kind: string, confirmed: boolean): Promise<any> {
    return fetch(ROUTES.kinds, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: kind, confirmed: confirmed }),
    }).then(function (r: any) {
      return r.json().then(function (body: any) {
        if (!r.ok) throw new Error((body && body.error && (body.error.details || body.error.error)) || "HTTP " + r.status);
        return body;
      });
    });
  }

  /** 测试通知（M2：channelId 可选——per-channel 测试，收敛到 service 管线）。 */
  function sendTestReq(channelId?: string): Promise<any> {
    return fetch(ROUTES.test, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(channelId ? { channelId: channelId } : {}),
    }).then(function (r: any) {
      return r.json().then(function (body: any) {
        if (!r.ok) throw new Error((body && body.error) || "HTTP " + r.status);
        return body;
      });
    });
  }

  /**
   * 设置面板独立 tab「通知中心」（settings.section 插槽渲染的 React 卡片）。
   * M2 重设计（issue #366）：频道卡分区（browser/system/bark×n，状态灯 + per-channel
   * 测试）+ 事件路由复选组（kindRoutes 单源双向编辑）+ 动态 kind 确认清单 +
   * 高级参数折叠；字段全量 + 基线 diff 只提变更键 + 历史最近 10 条 + 动作区 +
   * 三端降级文案。保存走 PUT {patch, expectedRevision}（乐观并发，冲突提示刷新）。
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
    // 保存反馈（i18n 重构：msg + err 结构化状态，不能用文案内容判断错误态）
    var savedDraft = useState(null);
    var saved = savedDraft[0];
    var setSaved = function (msg: string, err?: boolean) { savedDraft[1](msg ? { msg: msg, err: err === true } : null); };
    var historyDraft = useState(null);
    var history = historyDraft[0];
    var setHistory = historyDraft[1];
    var clearArmed = useState(false);
    var clearArmedValue = clearArmed[0];
    var setClearArmed = clearArmed[1];
    // M2：频道投递状态（/status channels map，键=bark:<id>）/ 动态 kind 清单（/kinds）
    var statusDraft = useState({} as Record<string, any>);
    var statusMap = statusDraft[0];
    var setStatusMap = statusDraft[1];
    var kindsDraft = useState([] as any[]);
    var kindsList = kindsDraft[0];
    var setKindsList = kindsDraft[1];
    // M2：频道删除两段确认（实例 id）。#508 M1：路由编辑展开行（openRoute）随 chips
    // 直点形态移除——chips 无展开层，routeToggle 直接落草稿。
    var delArmedDraft = useState(null as string | null);
    var delArmedId = delArmedDraft[0];
    var setDelArmedId = delArmedDraft[1];
    // M2 levels：每个频道「待添加映射」草稿（kind + level；按频道 id 键控）
    var levelsNewDraft = useState({} as Record<string, { kind: string; level: string }>);
    var levelsNew = levelsNewDraft[0];
    var setLevelsNew = levelsNewDraft[1];
    // #508 M1：卡内三 tab（通知事件 / 通知频道 / 通知记录——历史独立成 tab，r4 样本）。
    // 切 tab 仅条件拼接 children——全部表单/瞬态 state 都在本组件顶层，切换零丢失。
    var activeTabDraft = useState("events" as "events" | "channels" | "history");
    var activeTab = activeTabDraft[0];
    var setActiveTab = activeTabDraft[1];
    // #418：浏览器通知权限状态行在频道卡内——Notification.permission 非 React state，
    // 请求权限完成后 bump 一次触发重渲染刷新状态行文案/隐藏按钮。
    var permTickDraft = useState(0);
    var permTick = permTickDraft[0];
    var setPermTick = permTickDraft[1];
    // #508 M2：webhook 凭据字段显隐态（键 = <channelId>:<field>；纯瞬态，不入配置、
    // 不影响基线 diff——掩码值本身不回显，显隐只影响「正在输入的新值」可见性）。
    var revealDraft = useState({} as Record<string, boolean>);
    var revealMap = revealDraft[0];
    var setRevealMap = revealDraft[1];
    // 加载基线（A4）：保存时只提交与基线不同的键（增量 diff），未改动的键不提交。
    // 用 useRef 持久化：组件每次渲染局部变量会重置为 null，导致 save() 闭包里读不到
    // 基线而永远判定「无变化」。
    var baselineRef = ReactHooks.useRef(null as Record<string, any> | null);

    function loadHistory(alive: { value: boolean }) {
      fetchHistory().then(function (records) {
        if (alive.value) setHistory(records);
      }).catch(function () {
        if (alive.value) setHistory([]);
      });
    }

    function loadStatus(alive: { value: boolean }) {
      fetchStatus().then(function (map: any) {
        if (alive.value) setStatusMap(map);
      });
    }

    function loadKinds(alive: { value: boolean }) {
      fetchKinds().then(function (list: any[]) {
        if (alive.value) setKindsList(list);
      });
    }

    function loadCard(alive: { value: boolean }) {
      fetchConfig()
        .then(function (v: any) {
          if (!alive.value) return;
          var effective = (v && v.effective) || {};
          setSettings(Object.assign({}, effective));
          baselineRef.current = Object.assign({}, effective);
          setMeta({ user: v.user || {}, revision: v.revision, effective: effective, writable: v.writable !== false });
          runtimeConfig = effective; // SSE 展示面同步
          if (v.writable === false) setSaved(t("settingsUnavailable"), true);
        })
        .catch(function (e: any) {
          if (!alive.value) return;
          setSaved(t("loadFail", { msg: (e && e.message) || e, hint: accessHint(e) }), true);
        });
    }

    useEffect(function () {
      var alive = { value: true };
      loadCard(alive);
      loadHistory(alive);
      loadStatus(alive);
      loadKinds(alive);
      return function () { alive.value = false; };
    }, []);

    if (!settings) {
      return React.createElement("li", { className: "dn-set-card" }, t("settingsLoading"));
    }

    /** 函数式 setState 写设置（防 stale closure：同帧多次 onChange 后写覆盖先写）。
     *  p 为对象时浅合并；为函数时以最新 prev 计算（prev => next）。 */
    function patch(p: any) {
      setSettings(function (prev: any) {
        if (typeof p === "function") return p(prev);
        return Object.assign({}, prev, p);
      });
      setSaved("");
    }

    /** 基线 diff：只提交与加载基线不同的键（A4，防组合层 base 被默认值回写覆盖）。
     *  逻辑收敛在模块级纯函数 diffSettingsPayload（#470 复核 P1-2，供测试直测）。 */
    function diffPayload(): Record<string, any> {
      return diffSettingsPayload(settings, baselineRef.current);
    }

    function save() {
      var payload = diffPayload();
      if (Object.keys(payload).length === 0) {
        setSaved(t("unchanged"));
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
        baselineRef.current = Object.assign({}, settings);
        setMeta({ user: (body && body.user) || {}, revision: (body && body.revision) || undefined, effective: settings, writable: true });
        setSaved(t("savedOk"));
        setTimeout(function () { setSaved(""); }, 2200);
      }).catch(function (e: any) {
        var msg = (e && e.message) || e;
        setSaved(String(msg).indexOf("版本冲突") >= 0
          ? t("saveFailConflict", { msg: msg })
          : t("saveFail", { msg: msg }), true);
      });
    }

    /** #508 M1：放弃更改——草稿回写加载基线（编辑态/运行时镜像同步还原）。 */
    function discardChanges() {
      if (baselineRef.current) {
        setSettings(Object.assign({}, baselineRef.current));
        runtimeConfig = baselineRef.current;
      }
      setSaved("");
      toast(t("discardOk"));
    }

    /** 发送测试通知（M2：channelId 可选——per-channel 测试；完成后刷新状态行）。 */
    function sendTest(channelId?: string) {
      sendTestReq(channelId)
        .then(function (data: any) {
          toast(t(channelId ? "testChannelOk" : "testSent", channelId ? undefined : { n: (data && data.sseConnections) }));
          loadStatus({ value: true });
        })
        .catch(function (error: any) {
          toast(t("testFail", { msg: error.message, hint: accessHint(error) }));
        });
    }

    // ---- M2 频道编辑（settings.channels 不可变操作；deviceKey 掩码语义见服务端）----

    /** 更新第 idx 个频道实例（浅合并 patch；函数式基于最新 channels，防后写覆盖）。 */
    function chPatch(idx: number, part: Record<string, any>) {
      patch(function (prev: any) {
        var list = (prev.channels || []).slice();
        list[idx] = Object.assign({}, list[idx], part);
        return Object.assign({}, prev, { channels: list });
      });
    }

    /** 写/删某实例的 levels 映射（kind→level；level 为空删除该 kind；函数式基于最新 channels）。 */
    function chLevelsSet(idx: number, kind: string, level: string) {
      if (!kind || kind === "__proto__" || kind === "constructor" || kind === "prototype") return;
      patch(function (prev: any) {
        var list = (prev.channels || []).slice();
        var ch = Object.assign({}, list[idx]);
        var levels = Object.assign({}, ch.levels || {});
        if (level) levels[kind] = level;
        else delete levels[kind];
        if (Object.keys(levels).length === 0) delete ch.levels;
        else ch.levels = levels;
        list[idx] = ch;
        return Object.assign({}, prev, { channels: list });
      });
    }

    /** 删除第 idx 个频道实例（函数式基于最新 channels）。 */
    function chRemove(idx: number) {
      patch(function (prev: any) {
        var list = (prev.channels || []).slice();
        list.splice(idx, 1);
        return Object.assign({}, prev, { channels: list });
      });
    }

    /** 新增频道实例（#508 M2：kind = "bark" | "webhook"）——自动分配未占用的 id
     *  （bark-1… / webhook-1…），默认禁用（出站授权显式授予；webhook 凭据/模板字段
     *  空白起步，超时缺省 10s 由服务端 normalize 兜底）。 */
    function chAdd(kind: string) {
      patch(function (prev: any) {
        var list = prev.channels || [];
        var seq = 1;
        var taken = new Set(list.map(function (c: any) { return String(c.id); }));
        while (taken.has(kind + "-" + seq)) seq += 1;
        var id = kind + "-" + seq;
        var base: Record<string, any> = kind === "webhook"
          ? {
              id: id,
              name: t("chNewWebhookName") + " " + seq,
              type: "webhook",
              url: "",
              auth: "none",
              token: "",
              username: "",
              password: "",
              headerName: "",
              headerValue: "",
              template: "",
              timeoutSec: 10,
              enabled: false,
            }
          : {
              id: id,
              name: t("chNewBarkName") + " " + seq,
              type: "bark",
              baseUrl: "",
              deviceKey: "",
              enabled: false,
            };
        return Object.assign({}, prev, { channels: list.concat([base]) });
      });
      setDelArmedId(null);
    }

    // ---- M2 路由（kindRoutes 单源；事件行与频道卡双向编辑同一份配置）----

    /** 当前 kind 的路由数组（undefined = 跟随默认广播）。 */
    function routeOf(kind: string): string[] | undefined {
      var routes = settings.kindRoutes || {};
      return routes[kind];
    }

    /** 写/清 kind 路由条目（ids=null 删除条目恢复默认；函数式基于最新 kindRoutes）。 */
    function routeSetKind(kind: string, ids: string[] | null) {
      patch(function (prev: any) {
        var routes = Object.assign({}, prev.kindRoutes || {});
        if (ids === null || ids.length === 0) delete routes[kind];
        else routes[kind] = ids;
        return Object.assign({}, prev, { kindRoutes: routes });
      });
    }

    /** 当前「跟随默认」投递面（路由 id 列表）：内置频道看开关、实例频道看 enabled。
     *  chips 点亮态（无条目时）与首次切换物化的快照都以本函数为准——所见即所得。
     *  实例频道 id 经 channelIdFor（type:id）生成，bark/webhook 通用（#508 复核 4②）。 */
    function defaultRouteIds(prev: any): string[] {
      var ids: string[] = [];
      if (prev.browserNotify === true) ids.push("browser");
      if (prev.systemNotify === true) ids.push("system");
      (prev.channels || []).forEach(function (c: any) {
        if (c.enabled === true) ids.push(channelIdFor(c));
      });
      return ids;
    }

    /** 路由候选（含停用频道——显式路由允许指向停用频道；点亮态由 defaultRouteIds /
     *  显式快照真实呈现，不美化）。 */
    function routeOptions(prev: any): Array<{ id: string; label: string }> {
      return [
        { id: "browser", label: t("chBrowserNotify") },
        { id: "system", label: t("chSystemNotify") },
      ].concat((prev.channels || []).map(function (c: any) {
        return { id: channelIdFor(c), label: c.name || String(c.id) };
      }));
    }

    /**
     * 路由 chips 单点切换（#508 M1：chips 直点形态，设计样本 r4；函数式基于最新
     * kindRoutes/channels 计算，防同帧勾选后写覆盖）。
     *
     * 语义（r4 拍板，替代旧「undefined=全选快照」歧义）：
     * - kindRoutes 无条目 = 跟随默认（投递到全部当前启用频道，随启停动态变化）；
     * - 任一 chip 切换即把当前默认投递面物化为显式快照（冻结），此后启停变化需显式维护；
     * - 清空（全灭）= 删除条目恢复跟随默认（与旧实现「空数组即 delete」一致）。
     */
    function routeToggle(kind: string, oid: string, checked: boolean) {
      patch(function (prev: any) {
        var routes = Object.assign({}, prev.kindRoutes || {});
        var cur = routes[kind] === undefined ? defaultRouteIds(prev).slice() : routes[kind].slice();
        var at = cur.indexOf(oid);
        if (checked && at === -1) cur.push(oid);
        else if (!checked && at !== -1) cur.splice(at, 1);
        if (cur.length === 0) delete routes[kind];
        else routes[kind] = cur;
        return Object.assign({}, prev, { kindRoutes: routes });
      });
    }

    /** 动态 kind 确认（POST /kinds；完成后刷新清单并提示）。 */
    function confirmOne(kind: string, confirmed: boolean) {
      postKind(kind, confirmed)
        .then(function () {
          toast(t("kindConfirmOk"));
          return loadKinds({ value: true }) as any;
        })
        .catch(function (e: any) {
          toast(t("kindConfirmFail", { msg: (e && e.message) || e }));
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
          toast(t("cleared", { n: (data.removed || 0) }));
          loadHistory({ value: true });
        })
        .catch(function (error) {
          toast(t("clearFail", { msg: error.message, hint: accessHint(error) }));
        });
    }

    /** #508 M1：频道卡体行（cap + 控件 + 可选 hint；CSS dn-ch-row/dn-ch-cap/dn-ch-ctl）。 */
    function chRow(cap: string, control: any, hint?: string) {
      return React.createElement("div", { className: "dn-ch-row" },
        React.createElement("span", { className: "dn-ch-cap" }, cap),
        React.createElement("span", { className: "dn-ch-ctl" }, control),
        hint ? React.createElement("span", { className: "dn-ch-hint" }, hint) : null,
      );
    }

    /** #508 M1：折叠区行（cap + 控件；CSS dn-adv-row）。 */
    function advRow(cap: string, control: any) {
      return React.createElement("div", { className: "dn-adv-row" },
        React.createElement("span", { className: "dn-adv-cap" }, cap),
        control,
      );
    }

    /** #508 M1：switch 开关底层（track 40×22 + 透明 input 覆盖 44×32 触控区；
     *  aria-label 提供可访问名——switch 无内联文本，WCAG 4.1.2）。 */
    function switchToggle(checked: boolean, onChange: (v: boolean) => void, ariaLabel: string) {
      return React.createElement("label", { className: "dn-switch" },
        React.createElement("input", {
          type: "checkbox",
          "aria-label": ariaLabel,
          checked: checked === true,
          onChange: function (e: any) { onChange(e.target.checked === true); },
        }),
        React.createElement("span", { className: "dn-switch-track" }),
      );
    }

    /** 顶层布尔设置键的 switch（switchToggle 的设置键薄封装）。 */
    function switchControl(key: string, ariaLabel: string) {
      return switchToggle(settings[key] === true, function (v: boolean) {
        setSettings(function (prev: any) {
          var next = Object.assign({}, prev);
          next[key] = v;
          return next;
        });
        setSaved("");
      }, ariaLabel);
    }

    function textInput(value: any, onChange: (v: string) => void, opts?: { type?: string; placeholder?: string; ariaLabel?: string }) {
      return React.createElement("input", {
        type: (opts && opts.type) || "text",
        className: "dn-set-input dn-set-inputText",
        value: value === undefined || value === null ? "" : String(value),
        placeholder: opts && opts.placeholder,
        "aria-label": (opts && opts.ariaLabel) || opts && opts.placeholder || undefined,
        onChange: function (e: any) { onChange(e.target.value); },
      });
    }

    function numInput(value: any, onChange: (v: number | undefined) => void, opts?: { ariaLabel?: string; min?: number; max?: number }) {
      return React.createElement("input", {
        type: "number", step: 1, className: "dn-set-input dn-set-numInput",
        min: opts && opts.min, max: opts && opts.max,
        "aria-label": opts && opts.ariaLabel,
        value: value === undefined || value === null ? "" : String(value),
        onChange: function (e: any) { onChange(e.target.value === "" ? undefined : Number(e.target.value)); },
      });
    }

    function padTime(ts: number) {
      var d = new Date(ts);
      var pad = function (n: number) { return n < 10 ? "0" + n : String(n); };
      return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    }

    /** 频道状态摘要（#508 M1：上提卡头 statusDot + statusTxt；完整错误经 title 提示）。 */
    function statusText(channelKey: string): string {
      var st = statusMap[channelKey];
      if (!st || !st.lastTs) return t("chNeverSent");
      if (st.lastStatus === "ok") return t("chLastOk") + " · " + padTime(st.lastTs);
      return t("chLastFail") + " · " + padTime(st.lastTs) + (st.lastError ? "：" + st.lastError : "");
    }
    function statusDotClass(channelKey: string): string {
      var st = statusMap[channelKey];
      if (!st || !st.lastTs) return "";
      return st.lastStatus === "ok" ? "ok" : "fail";
    }

    function testBtn(channelId?: string) {
      return React.createElement("button", {
        type: "button", className: "dn-set-btn dn-set-btnSmall",
        onClick: function () { sendTest(channelId); },
      }, t("chTest"));
    }

    /** 投递失败徽标（#402 第 1 条）：最近投递失败时上提至卡头 summary 行，收起态仍可见。 */
    function failBadge(channelKey: string) {
      var st = statusMap[channelKey];
      if (!st || !st.lastTs || st.lastStatus !== "failed") return null;
      return React.createElement("span", { className: "dn-ch-failBadge" },
        t("chLastFail") + " · " + padTime(st.lastTs));
    }

    /**
     * 浏览器通知权限状态行（#418：从全局降级区移入「浏览器通知」频道卡）。
     * 三态文案 + 未授权时的「请求通知权限」按钮（手势内请求，完成后刷新状态）；
     * 非安全上下文/无 Notification API 时返回 null（对应降级文案仍在全局 notes）。
     */
    function browserPermLine() {
      if (!("Notification" in window) || !isSecureContext()) return null;
      var text = "";
      var pending = false;
      if (Notification.permission === "granted") text = t("permGranted");
      else if (Notification.permission === "denied") text = t("permDenied");
      else {
        text = t("permDefault");
        pending = true;
      }
      return React.createElement("div", { className: "dn-ch-perm" },
        React.createElement("span", { className: "dn-ch-permText" }, text),
        pending ? React.createElement("button", {
          type: "button", className: "dn-set-btn dn-set-btnSmall",
          onClick: function () {
            requestPermission(function () {
              setSaved(t("permRequested"));
              setPermTick(permTick + 1); // 触发重渲染刷新权限状态行
            });
          },
        }, t("requestPerm")) : null,
      );
    }

    /**
     * 内置频道卡（browser/system）：开关 + 行为参数 + 状态行 + per-channel 测试。
     * #402 第 1 条：整卡 details 可折叠——非受控 + key remount 形态（key 含 enabled，
     * open 仅 mount 生效），未启用默认收起、启用默认展开；手动开合完全交 DOM，
     * 无受控时序坑；启停切换重挂载重置折叠态（预期行为）。summary 内 enable
     * checkbox 依赖 HTML 规范豁免（点击 interactive content 不触发 summary 激活）。
     */
    /**
     * 内置频道卡（#508 M1 r4 形态）：卡头 = 类型图标 + 名称 + 类型徽标 + 状态点/摘要 +
     * 启用 switch；卡体 = 行为参数 + （浏览器）权限状态行 + 测试按钮。
     * #418：浏览器通知权限状态行归入浏览器频道卡（契约锚点：channelId === "browser" ? browserPermLine()）。
     */
    function builtinCard(cfgKey: string, label: string, channelId: string) {
      var on = settings[cfgKey] === true;
      var extras: any[] = [];
      if (channelId === "browser") {
        extras.push(chRow(t("chWhenVisible"), switchControl("notifyWhenVisible", t("chWhenVisible"))));
      }
      if (channelId === "system") {
        extras.push(chRow(t("chSound"), switchControl("notifySound", t("chSound"))));
      }
      return React.createElement("details",
        {
          className: "dn-ch-card" + (on ? " dn-ch-onEdge" : " dn-ch-off"),
          key: "ch-" + channelId + ":" + on,
          open: on,
        },
        React.createElement("summary", null,
          iconEl(channelId),
          React.createElement("span", { className: "dn-ch-name" }, label),
          React.createElement("span", { className: "dn-ch-type" }, t("chTypeBuiltin")),
          React.createElement("span", { className: "dn-ch-statusDot " + statusDotClass(channelId) }),
          React.createElement("span", { className: "dn-ch-statusTxt", title: statusText(channelId) }, statusText(channelId)),
          failBadge(channelId),
          React.createElement("span", { className: "dn-ch-summaryRight" },
            switchToggle(on, function (v: boolean) {
              var p: Record<string, any> = {};
              p[cfgKey] = v;
              patch(p);
            }, (on ? t("chToggleOff") : t("chToggleOn")) + label),
          ),
        ),
        React.createElement("div", { className: "dn-ch-body" },
          extras,
          // #418：浏览器通知权限状态行归入浏览器频道卡（权限授权入口同卡就近可达）
          channelId === "browser" ? browserPermLine() : null,
          React.createElement("div", { className: "dn-ch-actions" }, testBtn(channelId)),
        ),
      );
    }

    /**
     * Bark 实例卡（#508 M1 r4 形态）：卡头 = 图标 + 名称 + 类型徽标 + 状态点/摘要 +
     * 失败徽标 + 启用 switch；卡体 = 基本行 + 高级参数折叠（含 levels 矩阵）+ 测试/删除。
     * #402 第 1 条：整卡 details 可折叠（非受控 + key remount），未启用默认收起。
     */
    function barkCard(ch: any, idx: number) {
      var channelKey = channelIdFor(ch);
      var armed = delArmedId === ch.id;
      var levelOpts: any[] = [React.createElement("option", { value: "", key: "auto" }, t("chLevelAuto"))];
      ["active", "timeSensitive", "passive", "critical"].forEach(function (lv: string) {
        levelOpts.push(React.createElement("option", { value: lv, key: lv }, lv));
      });
      // levels（kind→level）编辑：kind 建议 = 内置 7 kind + 动态已注册 kind；datalist id 按实例唯一
      var suggestKinds: string[] = Object.keys(KIND_KEYS);
      (kindsList || []).forEach(function (k: any) {
        if (suggestKinds.indexOf(String(k.id)) === -1) suggestKinds.push(String(k.id));
      });
      var dlId = "dn-levels-suggest-" + String(ch.id);
      var levels = ch.levels || {};
      var levelKeys = Object.keys(levels);
      var levelsRows: any[] = levelKeys.map(function (kind) {
        return React.createElement("div", { className: "dn-levels-row", key: "lv-" + kind },
          React.createElement("span", { className: "dn-levels-kind" },
            KIND_KEYS[kind] !== undefined ? t(KIND_KEYS[kind]) + " (" + kind + ")" : kind),
          React.createElement("select", {
            className: "dn-set-input dn-set-select",
            value: levels[kind] || "",
            onChange: function (e: any) { chLevelsSet(idx, kind, e.target.value); },
          }, levelOpts),
          React.createElement("button", {
            type: "button", className: "dn-set-btn dn-set-btnSmall",
            onClick: function () { chLevelsSet(idx, kind, ""); },
          }, t("chLevelsRemove")),
        );
      });
      var newRow = levelsNew[String(ch.id)] || { kind: "", level: "active" };
      var newKindKnown = suggestKinds.indexOf(newRow.kind) !== -1;
      var addRow = React.createElement("div", { className: "dn-levels-add", key: "lv-add" },
        React.createElement("input", {
          type: "text", className: "dn-set-input dn-set-inputText", list: dlId,
          placeholder: t("chLevelsKindPlaceholder"),
          value: newRow.kind,
          onChange: function (e: any) {
            setLevelsNew(Object.assign({}, levelsNew, { [String(ch.id)]: { kind: e.target.value, level: newRow.level } }));
          },
        }),
        React.createElement("select", {
          className: "dn-set-input dn-set-select",
          value: newRow.level,
          onChange: function (e: any) {
            setLevelsNew(Object.assign({}, levelsNew, { [String(ch.id)]: { kind: newRow.kind, level: e.target.value } }));
          },
        }, levelOpts),
        React.createElement("button", {
          type: "button", className: "dn-set-btn dn-set-btnSmall",
          onClick: function () {
            if (newRow.kind) {
              chLevelsSet(idx, newRow.kind, newRow.level);
              setLevelsNew(Object.assign({}, levelsNew, { [String(ch.id)]: { kind: "", level: "active" } }));
            }
          },
        }, t("chLevelsAdd")),
        newRow.kind && !newKindKnown
          ? React.createElement("span", { className: "dn-set-note-inline" }, t("chLevelsUnknown"))
          : null,
      );
      return React.createElement("details",
        {
          className: "dn-ch-card" + (ch.enabled ? " dn-ch-onEdge" : " dn-ch-off"),
          key: channelKey + ":" + (ch.enabled === true),
          open: ch.enabled === true,
        },
        React.createElement("summary", null,
          iconEl("bark"),
          React.createElement("span", { className: "dn-ch-name" }, ch.name || ch.id),
          React.createElement("span", { className: "dn-ch-type" }, "bark"),
          React.createElement("span", { className: "dn-ch-statusDot " + statusDotClass(channelKey) }),
          React.createElement("span", { className: "dn-ch-statusTxt", title: statusText(channelKey) }, statusText(channelKey)),
          failBadge(channelKey),
          React.createElement("span", { className: "dn-ch-summaryRight" },
            switchToggle(ch.enabled === true, function (v: boolean) { chPatch(idx, { enabled: v }); },
              (ch.enabled ? t("chToggleOff") : t("chToggleOn")) + (ch.name || ch.id)),
          ),
        ),
        React.createElement("div", { className: "dn-ch-body" },
          chRow(t("chBarkName"), textInput(ch.name, function (v: string) { chPatch(idx, { name: v }); }, { placeholder: t("chBarkNamePlaceholder"), ariaLabel: t("chBarkName") })),
          chRow(t("chBarkBaseUrl"), textInput(ch.baseUrl, function (v: string) { chPatch(idx, { baseUrl: v }); }, { placeholder: "https://api.day.app", ariaLabel: t("chBarkBaseUrl") }), t("chBarkBaseUrlHint")),
          chRow(t("chBarkDeviceKey"), textInput(ch.deviceKey, function (v: string) { chPatch(idx, { deviceKey: v }); }, { type: "password", placeholder: "********", ariaLabel: t("chBarkDeviceKey") }), t("chBarkDeviceKeyHint")),
          React.createElement("details", { className: "dn-ch-adv", key: "adv-" + ch.id },
            React.createElement("summary", null, t("chAdvanced")),
            React.createElement("div", { className: "dn-ch-adv-body" },
              advRow(t("chBarkSound"), textInput(ch.sound, function (v: string) { chPatch(idx, { sound: v }); }, { ariaLabel: t("chBarkSound") })),
              advRow(t("chBarkGroup"), textInput(ch.group, function (v: string) { chPatch(idx, { group: v }); }, { ariaLabel: t("chBarkGroup") })),
              React.createElement("div", { className: "dn-set-note-inline" }, t("chBarkGroupHint")),
              advRow(t("chBarkIcon"), textInput(ch.icon, function (v: string) { chPatch(idx, { icon: v }); }, { ariaLabel: t("chBarkIcon") })),
              React.createElement("div", { className: "dn-set-note-inline" }, t("chBarkIconHint")),
              advRow(t("chBarkUrl"), textInput(ch.url, function (v: string) { chPatch(idx, { url: v }); }, { ariaLabel: t("chBarkUrl") })),
              advRow(t("chBarkBadge"), numInput(ch.badge, function (v: number | undefined) { chPatch(idx, { badge: v }); }, { ariaLabel: t("chBarkBadge") })),
              advRow(t("chBarkLevel"), React.createElement("select", {
                className: "dn-set-input dn-set-select",
                value: ch.level || "",
                "aria-label": t("chBarkLevel"),
                onChange: function (e: any) { chPatch(idx, { level: e.target.value || undefined }); },
              }, levelOpts)),
              React.createElement("div", { className: "dn-set-note-inline" }, t("chBarkLevelHint")),
              React.createElement("div", { className: "dn-set-note-inline" }, t("chLevelsHint")),
              levelKeys.length === 0 ? React.createElement("div", { className: "dn-set-note-inline" }, t("chLevelsEmpty")) : levelsRows,
              addRow,
              React.createElement("datalist", { id: dlId },
                suggestKinds.map(function (k) { return React.createElement("option", { value: k, key: k }, k); }),
              ),
            ),
          ),
          React.createElement("div", { className: "dn-ch-actions" },
            testBtn(channelKey),
            React.createElement("button", {
              type: "button",
              className: "dn-set-btn dn-set-btnSmall" + (armed ? " dn-set-btnDanger" : ""),
              onClick: function () {
                if (armed) {
                  chRemove(idx);
                  setDelArmedId(null);
                } else {
                  setDelArmedId(ch.id);
                  setTimeout(function () { setDelArmedId(null); }, 3000);
                }
              },
            }, armed ? t("chDeleteConfirm") : t("chDelete")),
          ),
        ),
      );
    }

    /**
     * Webhook 实例卡（#508 M2 新增频道位，安卓经 ntfy / Gotify / 自建网关推送；默认停用）。
     * 卡头同 Bark r4 形态；卡体：预设（填充认证/模板，URL 不覆盖）/ 名称 / 目标 URL /
     * 认证（none|bearer|basic|header，动态字段凭据掩码）/ 投递超时（1-60s clamp）/
     * JSON 模板编辑器（占位符 chips 光标处插入）。渲染契约见 channel-webhook.ts。
     */
    function webhookCard(ch: any, idx: number) {
      var channelKey = channelIdFor(ch);
      var armed = delArmedId === ch.id;
      var authValue = ["none", "bearer", "basic", "header"].indexOf(String(ch.auth || "none")) !== -1 ? String(ch.auth || "none") : "none";
      var chId = String(ch.id);

      /** webhook 字段 patch（函数式基于最新 channels，防同帧后写覆盖）。 */
      function whPatch(part: Record<string, any>) { chPatch(idx, part); }

      /** 凭据输入 + 显隐按钮（掩码值不回显，显隐只作用于正在输入的新值）。 */
      function secretField(field: string, placeholderKey: string) {
        var key = chId + ":" + field;
        var shown = revealMap[key] === true;
        var part: Record<string, any> = {};
        return React.createElement("span", { className: "dn-secret", key: field },
          React.createElement("input", {
            type: shown ? "text" : "password",
            className: "dn-set-input dn-set-inputText",
            value: ch[field] || "",
            placeholder: t(placeholderKey),
            "aria-label": t(placeholderKey),
            onChange: function (e: any) { part[field] = e.target.value; whPatch(part); },
          }),
          React.createElement("button", {
            type: "button", className: "dn-secret-reveal",
            onClick: function () {
              var next: Record<string, boolean> = Object.assign({}, revealMap);
              next[key] = !shown;
              setRevealMap(next);
            },
          }, shown ? t("secretHide") : t("secretShow")),
        );
      }

      /** 占位符插入模板（光标处；受控值经 whPatch 回写）。 */
      function insertTpl(token: string) {
        var ta = document.getElementById("dn-tpl-" + chId) as HTMLTextAreaElement | null;
        if (!ta) { whPatch({ template: (ch.template || "") + token }); return; }
        var at = ta.selectionStart === null || ta.selectionStart === undefined ? ta.value.length : ta.selectionStart;
        whPatch({ template: ta.value.slice(0, at) + token + ta.value.slice(at) });
      }

      var authCtl: any[] = [React.createElement("select", {
        key: "auth-select",
        className: "dn-set-input dn-set-select",
        value: authValue,
        "aria-label": t("whAuth"),
        onChange: function (e: any) { whPatch({ auth: e.target.value }); },
      },
        React.createElement("option", { value: "none" }, t("whAuthNone")),
        React.createElement("option", { value: "bearer" }, t("whAuthBearer")),
        React.createElement("option", { value: "basic" }, t("whAuthBasic")),
        React.createElement("option", { value: "header" }, t("whAuthHeader")),
      )];
      if (authValue === "bearer") authCtl.push(secretField("token", "whAuthToken"));
      else if (authValue === "basic") {
        authCtl.push(React.createElement("input", {
          key: "username", type: "text", className: "dn-set-input dn-set-inputText",
          value: ch.username || "", placeholder: t("whAuthUsername"), "aria-label": t("whAuthUsername"),
          onChange: function (e: any) { whPatch({ username: e.target.value }); },
        }));
        authCtl.push(secretField("password", "whAuthPassword"));
      } else if (authValue === "header") {
        authCtl.push(React.createElement("input", {
          key: "headerName", type: "text", className: "dn-set-input dn-set-inputText",
          value: ch.headerName || "", placeholder: t("whAuthHeaderName"), "aria-label": t("whAuthHeaderName"),
          onChange: function (e: any) { whPatch({ headerName: e.target.value }); },
        }));
        authCtl.push(secretField("headerValue", "whAuthHeaderValue"));
      }

      var textTokens = ["{{title}}", "{{message}}", "{{kind}}", "{{severity}}", "{{priority}}", "{{source}}"];
      var tplChips: any[] = textTokens.map(function (tok: string) {
        return React.createElement("button", {
          type: "button", key: tok, className: "dn-tpl-chip",
          title: t("whTemplateHint"),
          onClick: function () { insertTpl(tok); },
        }, tok);
      });
      tplChips.push(React.createElement("button", {
        type: "button", key: "{{ts}}", className: "dn-tpl-chip is-raw",
        title: "{{ts}} → " + String(Date.now()) + "（数字直出，不加引号）",
        onClick: function () { insertTpl("{{ts}}"); },
      }, "{{ts}}"));

      return React.createElement("details",
        {
          className: "dn-ch-card" + (ch.enabled ? " dn-ch-onEdge" : " dn-ch-off"),
          key: channelKey + ":" + (ch.enabled === true),
          open: ch.enabled === true,
        },
        React.createElement("summary", null,
          iconEl("webhook"),
          React.createElement("span", { className: "dn-ch-name" }, ch.name || ch.id),
          React.createElement("span", { className: "dn-ch-type" }, "webhook"),
          React.createElement("span", { className: "dn-ch-statusDot " + statusDotClass(channelKey) }),
          React.createElement("span", { className: "dn-ch-statusTxt", title: statusText(channelKey) }, statusText(channelKey)),
          failBadge(channelKey),
          React.createElement("span", { className: "dn-ch-summaryRight" },
            switchToggle(ch.enabled === true, function (v: boolean) { whPatch({ enabled: v }); },
              (ch.enabled ? t("chToggleOff") : t("chToggleOn")) + (ch.name || ch.id)),
          ),
        ),
        React.createElement("div", { className: "dn-ch-body" },
          chRow(t("whPreset"), React.createElement("select", {
            className: "dn-set-input dn-set-select", value: "", "aria-label": t("whPreset"),
            onChange: function (e: any) {
              var p = WEBHOOK_PRESETS[e.target.value];
              if (!p) return;
              // #508 M2：preset 落配置（{{priority}} 频道感知映射的依据）；认证与模板随预设填充，URL 不覆盖（防丢已填内容）
              whPatch({ preset: e.target.value, auth: p.auth, template: p.template });
            },
          },
            React.createElement("option", { value: "" }, t("whPreset")),
            React.createElement("option", { value: "ntfy" }, t("whPresetNtfy")),
            React.createElement("option", { value: "gotify" }, t("whPresetGotify")),
            React.createElement("option", { value: "custom" }, t("whPresetCustom")),
          ), t("whPresetHint")),
          chRow(t("chBarkName"), textInput(ch.name, function (v: string) { whPatch({ name: v }); }, { placeholder: t("chBarkNamePlaceholder"), ariaLabel: t("chBarkName") })),
          chRow(t("whUrl"), textInput(ch.url, function (v: string) { whPatch({ url: v }); }, { placeholder: t("whUrlPlaceholder"), ariaLabel: t("whUrl") }), t("whUrlHint")),
          chRow(t("whAuth"), React.createElement("span", { className: "dn-authFields" }, authCtl), t("whAuthHint")),
          chRow(t("whTimeout"), numInput(ch.timeoutSec, function (v: number | undefined) {
            // UI 层先 clamp（1-60）；服务端 normalize 仍权威 clamp（防绕过 UI 的 PUT）
            whPatch({ timeoutSec: v === undefined ? undefined : Math.min(60, Math.max(1, Math.round(v))) });
          }, { ariaLabel: t("whTimeout"), min: 1, max: 60 }), t("whTimeoutHint")),
          React.createElement("div", { className: "dn-ch-row", style: { display: "block" } },
            React.createElement("div", { className: "dn-ch-cap", style: { marginBottom: "6px" } }, t("whTemplate")),
            React.createElement("textarea", {
              id: "dn-tpl-" + chId,
              className: "dn-tpl",
              spellCheck: false,
              "aria-label": t("whTemplate"),
              value: ch.template || "",
              onChange: function (e: any) { whPatch({ template: e.target.value }); },
            }),
            React.createElement("div", { className: "dn-tplChips" },
              React.createElement("span", { className: "dn-tplCap" }, t("routeCap") + ":"),
              tplChips,
              React.createElement("button", {
                type: "button", className: "dn-set-btn dn-set-btnSmall",
                onClick: function () {
                  // 恢复为当前预设（ch.preset 由预设下拉落配置；缺省 ntfy 与服务端默认一致）的默认模板
                  var p = WEBHOOK_PRESETS[String(ch.preset || "ntfy")];
                  if (p) whPatch({ template: p.template });
                },
              }, t("whTplRestore")),
            ),
            React.createElement("span", { className: "dn-ch-hint" }, t("whTemplateHint")),
            React.createElement("span", { className: "dn-ch-hint" }, t("whTemplateFailHint")),
          ),
          React.createElement("div", { className: "dn-ch-actions" },
            testBtn(channelKey),
            React.createElement("button", {
              type: "button",
              className: "dn-set-btn dn-set-btnSmall" + (armed ? " dn-set-btnDanger" : ""),
              onClick: function () {
                if (armed) {
                  chRemove(idx);
                  setDelArmedId(null);
                } else {
                  setDelArmedId(ch.id);
                  setTimeout(function () { setDelArmedId(null); }, 3000);
                }
              },
            }, armed ? t("chDeleteConfirm") : t("chDelete")),
          ),
        ),
      );
    }

    /**
     * 事件/动态 kind 行的路由区（#508 M1 chips 直点形态，设计样本 r4）：
     * 候选 chips（点亮态真实反映投递面：无条目=defaultRouteIds，有条目=显式快照）
     * + stale 残留 chip（虚线删除线，title 说明）+ 状态标签（跟随默认 / 自定义·N·恢复默认）。
     * 状态标签 custom 态可点击恢复跟随默认；全灭由 routeToggle 自动恢复默认并 toast 反馈
     * 由调用方无感（删除条目即恢复——状态标签随即回到默认态）。
     */
    function routeChipsRow(kind: string) {
      var routes = routeOf(kind);
      var options = routeOptions(settings);
      var litIds = routes === undefined ? defaultRouteIds(settings) : routes.slice();
      var litSet: Record<string, boolean> = {};
      litIds.forEach(function (id: string) { litSet[id] = true; });
      // stale：条目残留但候选中不存在的频道 id（已删除频道；投递时自动跳过，保存时清理）
      var staleIds = (routes || []).filter(function (id: string) {
        return !options.some(function (o) { return o.id === id; });
      });
      var chips = options.map(function (o) {
        var on = litSet[o.id] === true;
        return React.createElement("button", {
          type: "button",
          key: o.id,
          className: "dn-route-chip" + (on ? " is-on" : ""),
          "aria-pressed": on ? "true" : "false",
          onClick: function () { routeToggle(kind, o.id, !on); },
        }, o.label);
      });
      staleIds.forEach(function (id: string) {
        chips.push(React.createElement("span", {
          key: "stale-" + id,
          className: "dn-route-chip is-stale",
          title: t("routeStaleTitle"),
        }, id + " · " + t("routeStaleChip")));
      });
      var isCustom = routes !== undefined;
      chips.push(React.createElement("button", {
        type: "button",
        key: "state",
        className: "dn-route-state" + (isCustom ? " is-custom" : ""),
        title: isCustom ? t("routeCustomStateTitle") : t("routeDefaultStateTitle"),
        onClick: function () { if (isCustom) routeSetKind(kind, null); },
      }, isCustom ? t("routeCustomState", { n: litIds.length }) : t("routeDefaultState")));
      return React.createElement("div", { className: "dn-evt-routes", key: "routes-" + kind },
        React.createElement("span", { className: "dn-evt-routesCap" }, t("routeCap")),
        chips,
      );
    }

    // 事件区（#508 M1 r4 形态）：内置事件卡（sev 色点 + kind 码 + switch + 路由 chips）
    var eventChildren: any[] = [];
    EVENT_KEYS.forEach(function (kv) {
      var key = kv[0], labelKey = kv[1];
      var kindId = EVENT_KIND_MAP[key];
      var sev = KIND_SEV[kindId] || "info";
      eventChildren.push(React.createElement("div", { className: "dn-evt", key: "ev-" + key },
        React.createElement("div", { className: "dn-evt-head" },
          React.createElement("span", { className: "dn-sev" + (sev !== "info" ? " dn-sev-" + sev : ""), title: "severity: " + sev }),
          React.createElement("span", { className: "dn-evt-name" }, t(labelKey)),
          React.createElement("span", { className: "dn-evt-kind" }, kindId),
          switchControl(key, t("evtSwitch", { name: t(labelKey) })),
        ),
        routeChipsRow(kindId),
      ));
    });
    // 动态 kind（插件提议的通知类型）：待确认 = 允许/拒绝 + 路由提示；已允许 = 同款
    // 路由 chips（r4 拍板：动态 kind 也支持配置投递频道——kindRoutes 天然支持动态
    // kind id 作 key，与服务端 resolveRoutes 的 kind 无关路由解析一致）。
    var kindRows: any[] = kindsList.map(function (k: any) {
      var nameText = k.label && k.label !== k.id ? k.label : k.id;
      if (k.confirmed) {
        return React.createElement("div", { className: "dn-kinds dn-kinds-ok", key: k.id },
          React.createElement("div", { className: "dn-kinds-head" },
            React.createElement("span", { className: "dn-sev" }),
            React.createElement("span", { className: "dn-kinds-name" }, nameText),
            React.createElement("span", { className: "dn-evt-kind" }, k.id),
            React.createElement("span", { className: "dn-kinds-actions" },
              React.createElement("button", {
                type: "button", className: "dn-set-btn dn-set-btnSmall",
                onClick: function () { confirmOne(k.id, false); },
              }, t("kindRevoke")),
            ),
          ),
          routeChipsRow(k.id),
        );
      }
      return React.createElement("div", { className: "dn-kinds", key: k.id },
        React.createElement("div", { className: "dn-kinds-head" },
          React.createElement("span", { className: "dn-sev" }),
          React.createElement("span", { className: "dn-kinds-name" }, nameText),
          React.createElement("span", { className: "dn-evt-kind" }, k.id),
          React.createElement("span", { className: "dn-kinds-actions" },
            React.createElement("button", {
              type: "button", className: "dn-set-btn dn-set-btnSmall dn-set-btnPrimary",
              onClick: function () { confirmOne(k.id, true); },
            }, t("kindAllow")),
            React.createElement("button", {
              type: "button", className: "dn-set-btn dn-set-btnSmall dn-set-btnGhostDanger",
              onClick: function () { confirmOne(k.id, false); },
            }, t("kindDeny")),
          ),
        ),
        React.createElement("div", { className: "dn-kind-routeHint" }, t("kindRouteHint")),
      );
    });
    eventChildren.push(React.createElement("div", { key: "kinds" },
      React.createElement("div", { className: "dn-sec", style: { marginTop: "14px" } },
        React.createElement("span", { className: "dn-sec-title" }, t("kindsTitle")),
        React.createElement("span", { className: "dn-sec-hint" }, t("kindsHint")),
      ),
      kindsList.length === 0 ? React.createElement("div", { className: "dn-set-note" }, t("kindsEmpty")) : kindRows,
    ));

    // 频道区：内置两卡 + 实例卡（bark / webhook 按类型分派）+ 添加按钮
    var channelsChildren: any[] = [
      builtinCard("browserNotify", t("chBrowserNotify"), "browser"),
      builtinCard("systemNotify", t("chSystemNotify"), "system"),
    ].concat((settings.channels || []).map(function (c: any, i: number) {
      return String(c.type) === "webhook" ? webhookCard(c, i) : barkCard(c, i);
    }));
    channelsChildren.push(React.createElement("div", { className: "dn-ch-add", key: "ch-add" },
      React.createElement("button", { type: "button", className: "dn-set-btn", onClick: function () { chAdd("bark"); } }, t("chAddBark")),
      React.createElement("button", { type: "button", className: "dn-set-btn dn-set-btnPrimary", onClick: function () { chAdd("webhook"); } }, t("chAddWebhook")),
    ));

    // 合并去重折叠区（#508 M1：统一 dn-ch-adv 折叠形态 + dn-adv-row 行）
    var dedupFold = React.createElement("details", { className: "dn-ch-adv dn-sec-adv", key: "adv-params" },
      React.createElement("summary", null, t("secDedup")),
      React.createElement("div", { className: "dn-ch-adv-body" },
        advRow(t("errMergeWindow"), React.createElement("input", {
          type: "number", min: 0, step: 1000, className: "dn-set-input dn-set-numInput",
          "aria-label": t("errMergeWindow"),
          value: settings.errorMergeWindowMs,
          onChange: function (e: any) { patch({ errorMergeWindowMs: Number(e.target.value) }); },
        })),
        advRow(t("doneAggWindow"), React.createElement("input", {
          type: "number", min: 0, step: 1000, className: "dn-set-input dn-set-numInput",
          "aria-label": t("doneAggWindow"),
          value: settings.doneMergeWindowMs,
          onChange: function (e: any) { patch({ doneMergeWindowMs: Number(e.target.value) }); },
        })),
        advRow(t("approveRemind"), React.createElement("input", {
          type: "number", min: 0, step: 1, className: "dn-set-input dn-set-numInput",
          "aria-label": t("approveRemind"),
          value: settings.askRemindMin,
          onChange: function (e: any) { patch({ askRemindMin: Number(e.target.value) }); },
        })),
        advRow(t("historyRetention"), React.createElement("input", {
          type: "number", min: 0, step: 1, className: "dn-set-input dn-set-numInput",
          "aria-label": t("historyRetention"),
          value: settings.historyMaxAgeDays,
          onChange: function (e: any) { patch({ historyMaxAgeDays: Number(e.target.value) }); },
        })),
        advRow(t("maxConnections"), React.createElement("input", {
          type: "number", min: 1, max: 1024, step: 1, className: "dn-set-input dn-set-numInput",
          "aria-label": t("maxConnections"),
          value: settings.maxConnections,
          onChange: function (e: any) { patch({ maxConnections: Number(e.target.value) }); },
        })),
      ),
    );

    var qh = settings.quietHours || {};
    var allows = qh.allowKinds || [];
    function setAllowKinds(next: string[]) {
      patch({ quietHours: Object.assign({}, qh, { allowKinds: next }) });
    }
    /** 跟随已启用事件：一键把当前 notifyXxx=true 的对应 kind 全选为豁免（函数式更新——
     *  setSettings(prev=>...) 读最新快照计算，避免连点/同帧先改开关后旧闭包漏勾最新态）。 */
    function allowFollowEnabled() {
      setSettings(function (prev: any) {
        var nextQh = prev.quietHours || {};
        var next = EVENT_KEYS.filter(function (kv) { return prev[kv[0]] === true; }).map(function (kv) { return EVENT_KIND_MAP[kv[0]]; });
        return Object.assign({}, prev, { quietHours: Object.assign({}, nextQh, { allowKinds: next }) });
      });
      setSaved("");
    }
    /** 恢复默认豁免（ask/question/error——高频阻塞型，卡着的任务需要叫醒）。 */
    function allowResetDefault() {
      setAllowKinds(["ask", "question", "error"]);
    }
    // 免打扰豁免候选（issue #421：扩至全部 6 个内置事件 kind，label 复用事件文案
    // KIND_KEYS 字典；由 EVENT_KEYS + EVENT_KIND_MAP 派生，不新建平行表。
    // #508 M1：chips 直点形态——未启用事件弱化沿用 dn-set-allowDim 锚点，勾选态保留照常
    // 写入（服务端判定只看 quietHours.allowKinds.includes(kind)，不看开关）。
    var quietAllowChoices = EVENT_KEYS.map(function (kv) {
      var notifyKey = kv[0];
      var kind = EVENT_KIND_MAP[notifyKey];
      var enabled = settings[notifyKey] === true;
      return { kind: kind, notifyKey: notifyKey, enabled: enabled, labelKey: KIND_KEYS[kind] || "k" + kind };
    });
    var allowChips = quietAllowChoices.map(function (c) {
      var checked = allows.indexOf(c.kind) !== -1;
      return React.createElement("button", {
        type: "button",
        key: c.kind,
        className: "dn-route-chip" + (checked ? " is-on" : "") + (c.enabled ? "" : " dn-set-allowDim"),
        "aria-pressed": checked ? "true" : "false",
        onClick: function () {
          var next = allows.slice();
          if (!checked && next.indexOf(c.kind) === -1) next.push(c.kind);
          else if (checked && next.indexOf(c.kind) !== -1) next.splice(next.indexOf(c.kind), 1);
          setAllowKinds(next);
        },
      }, t(c.labelKey), c.enabled ? null : React.createElement("span", { className: "dn-set-allowHint" }, t("allowDisabledHint")));
    });
    // 免打扰卡（#508 M1 r4 形态：开关 + 时段 + 豁免 chips + 快捷按钮）
    var dndCard = React.createElement("div", { className: "dn-dnd", key: "dnd" },
      React.createElement("div", { className: "dn-dnd-head" },
        React.createElement("span", { className: "dn-sev dn-sev-warning" }),
        React.createElement("span", { className: "dn-evt-name" }, t("dndEnable")),
        switchToggle(qh.enabled === true, function (v: boolean) {
          patch({ quietHours: Object.assign({}, qh, { enabled: v }) });
        }, t("dndEnable")),
      ),
      qh.enabled === true ? React.createElement("div", null,
        React.createElement("div", { className: "dn-dnd-row" },
          React.createElement("span", { className: "dn-dnd-cap" }, t("dndStart")),
          React.createElement("input", {
            type: "time", className: "dn-set-input", "aria-label": t("dndStart"),
            value: qh.start || "22:00",
            onChange: function (e: any) { patch({ quietHours: Object.assign({}, qh, { start: e.target.value }) }); },
          }),
          React.createElement("span", { className: "dn-dnd-cap" }, t("dndEnd")),
          React.createElement("input", {
            type: "time", className: "dn-set-input", "aria-label": t("dndEnd"),
            value: qh.end || "08:00",
            onChange: function (e: any) { patch({ quietHours: Object.assign({}, qh, { end: e.target.value }) }); },
          }),
        ),
        React.createElement("div", { className: "dn-dnd-row", style: { display: "block" } },
          React.createElement("span", { className: "dn-dnd-cap" }, t("dndStillLabel") + "："),
          React.createElement("div", { className: "dn-set-allows" }, allowChips),
          React.createElement("div", { className: "dn-set-allowActions" },
            React.createElement("button", { type: "button", className: "dn-set-btn dn-set-btnSmall", onClick: allowFollowEnabled },
              t("allowFollowEnabled")),
            React.createElement("button", { type: "button", className: "dn-set-btn dn-set-btnSmall", onClick: allowResetDefault },
              t("allowResetDefault")),
          ),
        ),
      ) : null,
    );

    // 三端降级文案（A5/A8；#418：浏览器通知权限状态行已移入「浏览器通知」频道卡，
    // 这里只保留服务不可用 / 非安全上下文 / 平台不支持三条全局降级说明）
    var degradation: any[] = [];
    if (metaValue && metaValue.writable === false) {
      degradation.push(React.createElement("div", { className: "dn-set-note", key: "settings-unavailable" },
        t("settingsSvcDown")));
    }
    if ("Notification" in window) {
      if (!isSecureContext()) {
        degradation.push(React.createElement("div", { className: "dn-set-note", key: "insecure" },
          t("httpDegraded")));
      }
    } else {
      degradation.push(React.createElement("div", { className: "dn-set-note", key: "noapi" },
        t("iosUnsupported")));
    }

    // 通知记录 tab（#508 M1：历史独立成 tab；#418：清理/发送测试/刷新并排工具行；
    // 动作区 A6/A7；请求权限按钮随权限状态行一起归入「浏览器通知」频道卡）
    var historyPane = React.createElement("div", { key: "history" },
      React.createElement("div", { className: "dn-set-historyTools" },
        React.createElement("button", {
          type: "button", className: "dn-set-btn dn-set-btnSmall" + (clearArmedValue ? " dn-set-btnDanger" : ""), onClick: confirmClear,
        }, clearArmedValue ? t("clearConfirm") : t("clearLabel")),
        React.createElement("button", {
          type: "button", className: "dn-set-btn dn-set-btnSmall", onClick: function () { sendTest(); },
        }, t("sendTest")),
        React.createElement("button", {
          type: "button", className: "dn-set-btn dn-set-btnSmall",
          onClick: function () { loadHistory({ value: true }); },
        }, t("refresh")),
        React.createElement("span", { className: "dn-set-historyCount" }, t("historyTitle")),
      ),
      !history || history.length === 0
        ? React.createElement("div", { className: "dn-set-note" }, t("historyEmpty"))
        : React.createElement("ul", { className: "dn-set-history" },
            history.map(function (r: any, i: number) {
              var d = new Date(r.ts);
              var pad = function (n: number) { return n < 10 ? "0" + n : String(n); };
              var time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
              var sev = KIND_SEV[r.kind] || "info";
              return React.createElement("li", { className: "dn-set-historyItem", key: String(r.ts) + "-" + i },
                React.createElement("span", { className: "dn-sev" + (sev !== "info" ? " dn-sev-" + sev : ""), title: "severity: " + sev }),
                React.createElement("div", { className: "dn-set-historyMain" },
                  React.createElement("div", { className: "dn-set-historyHead" },
                    React.createElement("span", { className: "dn-set-historyKind" }, KIND_KEYS[r.kind] !== undefined ? t(KIND_KEYS[r.kind]) : r.kind),
                    React.createElement("span", { className: "dn-set-historyTime" }, time),
                    r.suppressed === "quiet"
                      ? React.createElement("span", { className: "dn-set-historySuppressed" }, t("historySuppressed"))
                      : null,
                  ),
                  React.createElement("div", { className: "dn-set-historyText" }, r.title + "：" + r.message),
                ),
              );
            }),
          ),
    );

    // ---- #508 M1：卡内三 tab（通知事件 / 通知频道 / 通知记录）----

    // 待确认动态 kind 计数（「通知事件」tab 徽标——确认流是安全设计，不可被 tab 埋没）
    var pendingKinds = kindsList.filter(function (k: any) { return !k.confirmed; }).length;

    // tab 栏：三个普通 button（不引入 role=tablist 管理成本——#402 决策延续）
    var tabbar = React.createElement("div", { className: "dn-set-tabs" },
      React.createElement("button", {
        type: "button",
        className: "dn-set-tab" + (activeTab === "events" ? " dn-set-tabActive" : ""),
        onClick: function () { setActiveTab("events"); },
      },
        t("secEvents"),
        pendingKinds > 0
          ? React.createElement("span", { className: "dn-set-tabBadge" }, String(pendingKinds))
          : null,
      ),
      React.createElement("button", {
        type: "button",
        className: "dn-set-tab" + (activeTab === "channels" ? " dn-set-tabActive" : ""),
        onClick: function () { setActiveTab("channels"); },
      }, t("secChannels")),
      React.createElement("button", {
        type: "button",
        className: "dn-set-tab" + (activeTab === "history" ? " dn-set-tabActive" : ""),
        onClick: function () { setActiveTab("history"); },
      }, t("secHistory")),
    );

    // 事件 tab 内容（#508：历史移出，事件页聚焦事件路由与确认流）
    var eventsPane = [
      eventChildren,
      dedupFold,
      dndCard,
    ];
    // 频道 tab 内容：频道卡组（内置 + Bark + Webhook）+ 添加按钮（#418：无就近保存——
    // 与 foot 保存同一份全量草稿，双保存按钮视觉重复；域级拆分属 #405 跟踪）
    var channelsPane = [
      channelsChildren,
    ];

    // #402 第 4 条：去掉设置卡 title/副标题；顶部直接是 tab 栏。
    // #508 M1：底部保存栏 = 脏状态指示（diffSettingsPayload 键数）+ 放弃更改 + 保存。
    var dirtyCount = Object.keys(diffPayload()).length;
    return React.createElement("li", { className: "dn-set-card" },
      tabbar,
      React.createElement("div", { className: "dn-set-body" },
        activeTab === "events" ? eventsPane : activeTab === "channels" ? channelsPane : historyPane,
        React.createElement("div", { className: "dn-set-notes" }, degradation),
        React.createElement("div", { className: "dn-set-foot" },
          saved
            ? React.createElement("span", { className: saved.err ? "dn-set-error" : "dn-set-saved" }, saved.msg)
            : dirtyCount > 0
              ? React.createElement("span", { className: "dn-dirty" }, t("dirtySome", { n: dirtyCount }))
              : null,
          React.createElement("span", { className: "dn-spacer" }),
          React.createElement("button", { type: "button", className: "dn-set-btn dn-set-btnSmall", onClick: discardChanges }, t("discardChanges")),
          React.createElement("button", { type: "button", className: "dn-set-save", onClick: save }, t("save")),
        ),
      ),
    );
  }

  // ------------------------------------------------------------ 装配

export function apply(ctx: any) {
    // 测试直测挂载面（#470 复核 P1-2）：diffSettingsPayload 是模块级纯函数，
    // 经 apply 暴露给 smoke 测试引用——保证「测试即产品实现」而非手写近似。
    (apply as any).diffSettingsPayload = diffSettingsPayload;
    try {
      ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });

      // i18n（issue #348）：注册本插件字典；t 绑定官方 locale 服务（未装配回落 key 本体）。
      var locale: any = ctx.get("locale");
      // #469：订阅取消函数供 disposer 卸载调用（守卫对齐 T4 provider-usage/
      // mcp-manager 的 undefined 形态——不预设 subscribe 返回 null，防其返回
      // null 时 null 初始化遮蔽导致守卫失效），防重复 apply 后旧订阅持续重绑
      // 已停用实例。
      var unsubLocale: (() => void) | undefined;
      if (locale && typeof locale.register === "function") {
        try {
          locale.register(NS, { zh: zh, en: en });
          t = locale.bind(NS);
          if (typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
            unsubLocale = locale.subscribe(function () {
              try { t = locale.bind(NS); } catch (e) { /* 忽略 */ }
            });
          }
        } catch (e) {
          console.warn("[dsh-notifier] locale 注册失败：", e);
        }
      }

      // 通知半区（SSE / 浏览器通知）：不依赖任何插件 DOM（C6），直接启动
      var disposeEvents: { close: () => void; reconnect: () => void } | null = startEvents();
      // 页面重新可见时：还原标题 + 强制重建 SSE（iOS 后台挂起后连接可能已失效，
      // 重建自动带 since 补拉，避免断线窗口漏通知）。
      // #469：具名 handler 在 apply 内注册、disposer 移除（对齐 mcp-manager
      // onVisible 范式）——匿名模块体注册无卸载路径，重复 apply/热更会累积
      // 旧监听、可能操作已置 null 的 SSE 句柄。
      function onVisibilityChange() {
        if (document.visibilityState === "visible") {
          restoreTitle();
          if (eventsHandle && eventsHandle.reconnect) eventsHandle.reconnect();
        }
      }
      document.addEventListener("visibilitychange", onVisibilityChange);
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
            // label 传 thunk（#402 第 5 条）：宿主 nav rows 每次读取经 resolveSlotLabel
            // 求值 + shell 订阅 locale 重渲染，切语言即跟随（注册期求值字符串快照是旧行为）。
            // t 为本模块 var 活绑定（apply 内 locale.subscribe 回调重绑），thunk 保持最小
            // t(key) 形态、不包任何可能抛错的逻辑（thunk 抛错会炸宿主 nav 渲染）。
            { name: "settings.section", id: "dsh-notifier", order: 70, label: () => t("tabLabel"), locale: NS },
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
          document.removeEventListener("visibilitychange", onVisibilityChange);
          // #469 P1-1：标题恢复（restoreTitle）原本只由 visibilitychange 回前台
          // 触发；disposer 摘除监听后该路径关闭，若残留 flashTitle 的 savedTitle
          // 缓存则标题永久卡死（评审复现：hidden 帧 → 卸载 → 标题不恢复）。
          // 故卸载时主动恢复一次标题并清缓存。
          restoreTitle();
          if (unsubLocale !== undefined) {
            unsubLocale();
            unsubLocale = undefined;
          }
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
export const inject: string[] = ["slots", "locale"];
