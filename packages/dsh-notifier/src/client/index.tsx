/**
 * dsh-notifier — 浏览器端（自包含）。
 *
 * 行为：
 * - 在「设置」面板注册独立 tab「通知中心」（settings.section 插槽：参照
 *   provider-usage「用量统计」tab；不做 plugin.item 双插槽重复展示）
 *   ——侧边栏「通知」入口/浮层/角标/拖拽全部移除；
 * - 通知半区保留并与 DOM 解耦：SSE /events 订阅 + 60s 看门狗 +
 *   visibilitychange 重建 + 多标签租约 + 音频手势解锁，不依赖任何插件 DOM；
 * - 历史记录最近 10 条收进卡片；卡片动作区含清理记录（两段式确认）/
 *   请求权限/发送测试通知；三端降级文案迁入卡片；
 * - 配置读取走 GET /config 包装体 {ok,user,revision,effective,writable}，保存走
 *   PUT {patch, expectedRevision}（基线 diff 只提变更键，防组合层默认值回写覆盖）。
 */
// 浏览器半区干净模块：只导出 apply/inject；React 由构建期 external 注入（经 factory
// 注入的 require("react") 解析，dsh web 不暴露全局 React）。契约外壳（IIFE/load/
// Symbol.toStringTag 装配）由 scripts/build/build-client.ts 统一生成——源码不写任何 loader。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";
// 样式注入收敛 shared/client/ensure-style.js：本包只补
// { id, cssText, version } 实参；STYLE_ID/CSS_VERSION 常量保留为调用实参来源，
// disposer（getElementById(STYLE_ID)）沿用常量。
import { ensureStyle } from "../../../../shared/client/ensure-style.js";
// 通知帧的展示策略（纯判定）、多标签租约、音频出口：外部事实（时钟 / storage /
// AudioContext）都从端口进来，于是「未解锁 / 被挂起 / 被拒绝」与租约三分支都能在 node 里
// 跑出判据。音色单点仍在 src/shared/interface.ts，改由 notify/audio.ts 消费。
import { bindTranslate, t, type Translate } from "./locale.ts";
import { createAudioEngine, type AudioContextLike } from "./notify/audio.ts";
import { closeAllNotifications, trackNotification } from "./notify/registry.ts";
import { titleFlasher } from "./notify/title.ts";
import { claimMaster as claimMasterLease, MASTER_KEY } from "./notify/lease.ts";
import { startNotifySession, type EventSourceLike, type NotifySession } from "./notify/session.ts";
import {
  displayChannelOf,
  fallbackChannelOf,
  frameAccepted,
  soundPolicyOf,
} from "./notify/policy.ts";
import * as React from "react";
// i18n：复用官方 dsh-client-locale——zh/en 双语字典，LocaleNamespaceMap
// 声明合并进官方 ui-slots 类型面；仅 import type（编译期擦除，无运行时依赖）。
import { zh, en, type NotifierLocaleKey } from "./locales.ts";
// 投递理由的渲染收在同一处：状态行与通知记录都要用，文案来源与「认不出的 code 怎么回退」
// 必须是同一条口径，两处各写一遍就等于把降级行为分叉。
import { deliveryViewOf, reasonText } from "./reason-text.ts";
import type { DeliveryView } from "./reason-text.ts";
// 能力自检面的投影（宿主面归一化 + 浏览器面判定）收在同一处：判定与文案必须同源，
// 两处各写一遍就等于把「未知不该被渲染成可用」这条口径分叉。
import { clientDiagnosticsOf } from "./capabilities.ts";
import type { ClientFacts } from "./capabilities.ts";
// 页面内即时反馈（横幅 / 短提示）：非安全上下文下唯一的降级提醒通道。
import { showBanner, toast } from "./notify/display.ts";
// 凭据掩码字段的编辑语义：服务端掩码不得作为可编辑字面量进输入框（见模块头）。
import { credentialFieldKey, credentialFieldView } from "./settings/mask.ts";
// 设置草稿的纯逻辑与保存串行 guard：零 React 零 DOM，可被 node 直接 import——它们决定
// 「保存什么」，因此必须是可判据的面（原先挂在公开 apply 上，实测零消费者）。
import {
  assignChannelFields,
  clampMaxConnections,
  diffSettingsPayload,
  domainPayload,
  rebaseSettings,
} from "./settings/diff.ts";
import { createSaveGuard } from "./settings/save-guard.ts";
// 显式类型导入，先把 @deepseek-ai/dsh-client-ui-slots 拉进模块解析图：上游发布物
// lib/types/*.d.ts 相对导入保留 .ts 后缀，declare module 增强的模块名解析会判
// TS2664（microsoft/TypeScript#63960 同类；上游修复发布物后此行可删）。
import type { LocaleNamespaceMap as _LocaleNamespaceMap } from "@deepseek-ai/dsh-client-ui-slots";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** dsh-notifier 设置卡/历史列表/权限降级说明文案。 */
    notifier: NotifierLocaleKey;
  }
}

/** 本插件字典命名空间（宿主 locale 服务注册用）。 */
const NS = "notifier";

const ROUTES = {
  config: "/api/dsh-notifier/config",
  events: "/api/dsh-notifier/events",
  health: "/api/dsh-notifier/health",
  diagnostics: "/api/dsh-notifier/diagnostics",
  test: "/api/dsh-notifier/test",
  history: "/api/dsh-notifier/history",
  status: "/api/dsh-notifier/status",
  kinds: "/api/dsh-notifier/kinds",
};
/** 内置音色 id（与服务端 config.ts SOUND_IDS 同源复制——客户端不 import 宿主
 *  模块，两处由各自测试锁定；定稿口径 ding/bell/chime/pop）。 */
const SOUND_IDS: readonly string[] = ["ding", "bell", "chime", "pop"];
/** 声音设置是否处于「开」：true 与内置音色 id 都算开，false 与脏值算关。
 *  三态摘要、卡体提示、声音行开关三处共用这一条口径——各判一遍就会出现「卡片说有声、开关说没有」。 */
function soundIsOn(value: any): boolean {
  return value === true || (typeof value === "string" && SOUND_IDS.indexOf(value) !== -1);
}
const STYLE_ID = "dsh-notifier-style";
// 每次样式契约变更后 bump（版本号单调递增，保证 ensureStyle 判定为新版本并重注入）
// 声音行/三态/试听样式加入时再次 bump。
// 能力自检行（dn-ch-diag）加入时再次 bump。
const CSS_VERSION = "784-1";
// 浏览器通知图标（内联 SVG data URL，零外部资源；铃铛造型）。
const NOTIFY_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0f9d6e"/><path fill="#fff" d="M12 4a1 1 0 0 1 1 1v.55A5.5 5.5 0 0 1 17.5 11v2.3l1.45 1.45a1 1 0 0 1-.7 1.7H5.75a1 1 0 0 1-.7-1.7L6.5 13.3V11A5.5 5.5 0 0 1 11 5.55V5a1 1 0 0 1 1-1zm-2.5 13a2.5 2.5 0 0 0 5 0h-5z"/></svg>',
  );

// i18n：label 列存字典 key（渲染期 t 求值，模块加载时 t 尚未装配）。
const EVENT_KEYS = [
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
const EVENT_KIND_MAP: Record<string, string> = {
  notifyAsk: "ask",
  notifyQuestion: "question",
  notifyTaskDone: "done",
  notifySubagentDone: "subagent-done",
  notifyTaskError: "error",
  notifyTurnEnd: "turn-end",
};
/** kind → 字典 key（未知 kind 回落 kind 本体显示，数据不翻译）。 */
const KIND_KEYS: Record<string, string> = {
  ask: "kAsk",
  question: "kQuestion",
  done: "kDone",
  "subagent-done": "kSubagentDone",
  error: "kError",
  "turn-end": "kTurnEnd",
  test: "kTest",
};

/**
 * kind → 展示强度（severity）css 修饰符（事件行/历史行色点）。
 * 与服务端 service.ts KIND_SEVERITY 同源复制（客户端不 import 宿主端模块——
 * 干净模块边界），两处由各自测试锁定；新增 kind 时同步维护。
 */
const KIND_SEV: Record<string, string> = {
  ask: "warning",
  question: "info",
  done: "success",
  "subagent-done": "info",
  error: "failure",
  "turn-end": "info",
  test: "info",
};

/**
 * 频道实例 → 路由 id（channelId 前缀单点化）。
 * 旧实现 "bark:"+id 三处硬编码（service resolveRoutes / 宿主 outboundChannels /
 * 客户端 routeToggle），webhook 频道引入后统一为 `type:id`——本 helper 为客户端
 * 单一事实源，宿主端同名单独维护（跨端无共享模块，注释互指）。
 */
function channelIdFor(cfg: Record<string, any>): string {
  return String(cfg.type || "") + ":" + String(cfg.id || "");
}

/**
 * 频道对外 id：内置取 `type`，实例取 `type:id`——宿主侧有一条同名规则，两端必须逐字一致。
 * 各自维护一份而不是共享：客户端与宿主没有共享模块；一致性由路由往返判据（chips ↔ kindRoutes）锁住。
 */
function channelIdOf(cfg: Record<string, any>): string {
  const type = String(cfg.type || "");
  return type === "browser" || type === "system" ? type : channelIdFor(cfg);
}

/**
 * webhook 频道预设：选择预设填充认证方式与消息模板；URL 不自动
 * 覆盖（避免丢用户已填内容——「仅空值填充」的变体：URL 只在为空时
 * 由用户填写，模板/认证随预设走且可再改）。模板渲染契约见 channel-webhook.ts：
 * 文本占位符 JSON-aware 转义、{{ts}} 数字直出、{{priority}} 频道感知映射。
 */
const WEBHOOK_PRESETS: Record<string, { auth: string; template: string }> = {
  ntfy: {
    auth: "bearer",
    template:
      '{\n  "topic": "<topic>",\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "tags": ["{{kind}}"],\n  "priority": "{{priority}}"\n}',
  },
  gotify: {
    auth: "bearer",
    template:
      '{\n  "title": "{{title}}",\n  "message": "{{message}}",\n  "priority": "{{priority}}"\n}',
  },
  custom: {
    auth: "header",
    template:
      '{\n  "event": "{{kind}}",\n  "title": "{{title}}",\n  "body": "{{message}}",\n  "severity": "{{severity}}",\n  "ts": {{ts}}\n}',
  },
};

/**
 * 频道类型图标（设计上刻意保留；内联 SVG 零外部资源）。
 * browser=地球 / system=显示器 / webhook=闪电 / 其余（bark）=铃铛。
 */
function iconEl(channelType: string) {
  let paths: any[];
  if (channelType === "browser") {
    paths = [
      <circle cx={12} cy={12} r={9} key="c" />,
      <path
        d="M3 12h18M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z"
        key="p"
      />,
    ];
  } else if (channelType === "system") {
    paths = [
      <rect x={3} y={4} width={18} height={12} rx={2} key="r" />,
      <path d="M8 20h8M12 16v4" key="p" />,
    ];
  } else if (channelType === "webhook") {
    paths = [<path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" key="p" strokeLinejoin="round" />];
  } else {
    paths = [
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" key="a" />,
      <path d="M13.7 21a2 2 0 0 1-3.4 0" key="b" />,
    ];
  }
  return (
    <span className="dn-ch-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        {paths}
      </svg>
    </span>
  );
}

/**
 * 403（loopback 围栏拒绝）时的可操作引导文案，供各处 catch 复用。
 * 非 403 错误返回空串，避免给普通失败粘贴无关提示。
 */
function accessHint(error: any) {
  const text = String((error && error.message) || "");
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
    Notification.requestPermission()
      .then(function () {
        if (onDone) onDone();
      })
      .catch(function () {
        if (onDone) onDone();
      });
  } catch {
    if (onDone) onDone();
  }
}

// ------------------------------------------------------------ 通知显示（半区）

/** 本页已弹出的系统通知（保留最近 5 条，超出即关最旧的）。 */
/** 本标签页的租约身份：跨 apply 复用——重新挂载仍是同一个标签，不该被当成「另一个标签」
 *  而在 15 秒内静默（见 notify/lease.ts 的模块头）。 */
const TAB_ID = Math.random().toString(36).slice(2);

/**
 * 跨实例共享的音频出口：AudioContext 与播放节流窗口必须全页一份，否则重复挂载会让同一帧
 * 响两次或该响的不响。用 const 单例承载闭包状态，而不是模块级 let。
 */
const audioEngine = createAudioEngine({ ctor: audioContextCtorOf, now: () => Date.now() });

/** 本页的主标签租约（storage 与时钟走端口，判定在 notify/lease.ts）。 */
function claimMaster(): boolean {
  return claimMasterLease(TAB_ID, {
    now: () => Date.now(),
    read: () => localStorage.getItem(MASTER_KEY),
    write: (value) => {
      localStorage.setItem(MASTER_KEY, value);
    },
  });
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

/** 平台 AudioContext 构造器：前缀化的老 Safari 名字不在标准 DOM 类型里，取用点收在这里，
 *  能力自检与解锁共用同一判据。 */
function audioContextCtorOf(): (new () => AudioContextLike) | undefined {
  const legacy = (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  return (window.AudioContext ?? legacy) as (new () => AudioContextLike) | undefined;
}

/**
 * 本页的能力事实。判定与文案都在 capabilities.ts（纯函数、不碰 DOM）：
 * 这里只负责把浏览器里的现状读出来，读法本身没有可断言的分支。
 */
function clientFacts(): ClientFacts {
  const hasApi = "Notification" in window;
  return {
    notificationApi: hasApi,
    secureContext: isSecureContext(),
    // 权限值只作数据带过去（值域外的取值由判定侧按「无法判定」处理）
    permission: hasApi ? String(Notification.permission) : "unknown",
    audio: audioEngine.facts(),
  };
}

/**
 * 通知展示总入口。
 *
 * 判定（走哪条通道、什么声音策略）在 notify/policy.ts 的纯函数里；这里只做三件事：过主标签
 * 租约、执行判定给出的通道、按策略自播。顺序是刻意的——租约在构造 Notification 之前，副标签
 * 连横幅都不弹；Notification 构造抛错则降级到页面内提醒（同一条降级判定重算一次）。
 *
 * @param opts.sound 服务端帧级声音策略；缺省（0.2.3 的帧没有这个字段）按「跟随系统默认」。
 * @param opts.playOnly 只响不弹：不弹实体、仅按需自播。
 */
function showNotification(
  kind: string,
  title: string,
  message: string,
  opts: { sound?: unknown; playOnly?: boolean },
) {
  const playOnly = opts.playOnly === true;
  const policy = soundPolicyOf(opts.sound, playOnly);
  // 多标签去重：弹实体与只响不弹自播一律先过主标签租约，副标签静默
  if (!claimMaster()) return;
  const notificationUsable = systemNotificationUsable();
  if (
    displayChannelOf({
      playOnly,
      notificationUsable,
      visibility: document.visibilityState,
    }) === "notification"
  ) {
    try {
      const notification = new Notification(title, {
        body: message,
        tag:
          "dsh-notifier-" + kind + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        icon: NOTIFY_ICON,
        silent: policy.silent,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      trackNotification(notification);
      // selfplay 模式：Notification 已 silent 防双响，页内补播
      if (policy.selfPlay && audioEngine.gate()) audioEngine.playTone(policy.tone);
      return;
    } catch (error) {
      console.warn("[dsh-notifier] 浏览器通知失败，降级为页面内提醒：", error);
    }
  }
  // 降级通道 / 只响不弹：横幅或标题闪烁；声音按帧策略
  const fallback = fallbackChannelOf(playOnly, document.visibilityState);
  if (fallback === "banner") showBanner(kind, title, message);
  else if (fallback === "title") titleFlasher.flash(title);
  if (policy.selfPlay && audioEngine.gate()) audioEngine.playTone(policy.tone);
}

function handleNotifyFrame(payload: any) {
  // 测试通知无条件提醒；其余帧在页面可见时不打扰，除非帧自带 whenVisible——判定见 notify/policy.ts
  if (
    !frameAccepted({
      kind: payload.kind,
      whenVisible: payload.whenVisible,
      playOnly: payload.playOnly,
      visibility: document.visibilityState,
    })
  ) {
    return;
  }
  showNotification(payload.kind, payload.title, payload.message, {
    sound: payload.sound,
    playOnly: payload.playOnly === true,
  });
}

// ------------------------------------------------------------ SSE 半区

/**
 * 当前会话句柄。用一个 const 容器而不是模块级 let：容器本身不变，变的是它指向的会话——
 * 也让「谁该把它清空」这件事有身份可比（disposer 只在仍指向自己的会话时才清）。
 */
const eventsHandle: { current: NotifySession | null } = { current: null };

// ------------------------------------------------------------ 设置卡片

/** 加载 GET /config 包装体 → 结构化 {user, revision, effective, writable}。 */
function fetchConfig(): Promise<any> {
  return fetch(ROUTES.config, { headers: { accept: "application/json" } }).then(function (r: any) {
    return r.json().then(function (body: any) {
      if (!r.ok) {
        const err = (body && body.error) || {};
        throw new Error(err.details || err.error || "HTTP " + r.status);
      }
      return body;
    });
  });
}

/** 拉取最近历史记录（最近 10 条，倒序）。 */
function fetchHistory(): Promise<any[]> {
  return fetch(ROUTES.history, { headers: { accept: "application/json" } })
    .then(function (r: any) {
      return r.json();
    })
    .then(function (data: any) {
      const records = (data && data.records) || [];
      return records.slice(-10).reverse();
    });
}

/** 拉取频道投递状态（per-channel 最近投递终态）。
 *  失败向上抛（调用方决定保留旧态而非清空状态行）。 */
function fetchStatus(): Promise<any> {
  return fetch(ROUTES.status, { headers: { accept: "application/json" } })
    .then(function (r: any) {
      return r.json();
    })
    .then(function (data: any) {
      return (data && data.channels) || {};
    });
}

/** 拉取动态 kind 清单（注册表 + 确认态）。 */
function fetchKinds(): Promise<any[]> {
  return fetch(ROUTES.kinds, { headers: { accept: "application/json" } })
    .then(function (r: any) {
      return r.json();
    })
    .then(function (data: any) {
      return (data && data.kinds) || [];
    })
    .catch(function () {
      return [];
    });
}

/**
 * 拉取宿主能力自检（GET /diagnostics）。15s 超时兜底：服务端首次探测要起子进程，可能慢；
 * 超时与失败一律静默降级成「读不到」，由调用方把那块整体不渲染——诊断面缺席不该让设置页报错。
 */
/** 宿主平台（/health platform）：服务端运行机器的 OS——系统通道弹在宿主机器上，浏览器 OS
 *  与宿主 OS 可异机，所以不能拿 navigator.platform 猜。失败/未知一律 null，由渲染侧回落通用文案。 */
function fetchHealth(): Promise<string | null> {
  return fetch(ROUTES.health, { headers: { accept: "application/json" } })
    .then(function (r: any) {
      return r.json();
    })
    .then(function (body: any) {
      return typeof body.platform === "string" ? (body.platform as string) : null;
    })
    .catch(function () {
      return null;
    });
}

function fetchDiagnostics(): Promise<unknown> {
  const ctrl: AbortController | null =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer: ReturnType<typeof setTimeout> | null = ctrl
    ? setTimeout(function () {
        ctrl!.abort();
      }, 15000)
    : null;
  const init: RequestInit = { headers: { accept: "application/json" } };
  if (ctrl) init.signal = ctrl.signal;
  return fetch(ROUTES.diagnostics, init)
    .then(function (r) {
      return r.json() as Promise<unknown>;
    })
    .finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
}

/** 动态 kind 确认（POST /kinds {kind, confirmed}）。 */
function postKind(kind: string, confirmed: boolean): Promise<any> {
  return fetch(ROUTES.kinds, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: kind, confirmed: confirmed }),
  }).then(function (r: any) {
    return r.json().then(function (body: any) {
      if (!r.ok)
        throw new Error(
          (body && body.error && (body.error.details || body.error.error)) || "HTTP " + r.status,
        );
      return body;
    });
  });
}

/** 测试通知（channelId 可选——per-channel 测试，收敛到 service 管线）。 */
function sendTestReq(channelId?: string): Promise<any> {
  return fetch(ROUTES.test, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(channelId ? { channelId: channelId } : {}),
  }).then(function (r: any) {
    return r.json().then(function (body: any) {
      if (!r.ok) {
        const err = (body && body.error) || {};
        // 围栏拒绝体的 error 是裸字符串；403 的 https 引导靠文案里的状态码识别，兜底不能去掉。
        throw new Error(err.details || err.error || "HTTP " + r.status);
      }
      return body;
    });
  });
}

/**
 * 设置面板独立 tab「通知中心」（settings.section 插槽渲染的 React 卡片）。
 * 重设计：频道卡分区（browser/system/bark×n，状态灯 + per-channel
 * 测试）+ 事件路由复选组（kindRoutes 单源双向编辑）+ 动态 kind 确认清单 +
 * 高级参数折叠；字段全量 + 基线 diff 只提变更键 + 历史最近 10 条 + 动作区 +
 * 三端降级文案。保存走 PUT {patch, expectedRevision}（乐观并发，冲突提示刷新）。
 */
function SettingsCard() {
  const ReactHooks = React;
  const useState = ReactHooks.useState;
  const useEffect = ReactHooks.useEffect;
  const draft = useState(null);
  const settings = draft[0];
  const setSettings = draft[1];
  const meta = useState(null); // { user, revision, effective, writable }
  const metaValue = meta[0];
  const setMeta = meta[1];
  // 保存反馈（i18n 重构：msg + err 结构化状态，不能用文案内容判断错误态）
  const savedDraft = useState(null);
  const saved = savedDraft[0];
  const setSaved = function (msg: string, err?: boolean) {
    savedDraft[1](msg ? { msg: msg, err: err === true } : null);
  };
  const historyDraft = useState(null);
  const history = historyDraft[0];
  const setHistory = historyDraft[1];
  const clearArmed = useState(false);
  const clearArmedValue = clearArmed[0];
  const setClearArmed = clearArmed[1];
  // 频道投递状态（/status channels map，键=bark:<id>）/ 动态 kind 清单（/kinds）
  const statusDraft = useState({} as Record<string, any>);
  const statusMap = statusDraft[0];
  const setStatusMap = statusDraft[1];
  const kindsDraft = useState([] as any[]);
  const kindsList = kindsDraft[0];
  const setKindsList = kindsDraft[1];
  // 宿主能力自检载荷（/diagnostics 原样收下；归一化与文案在 capabilities.ts）。
  // null = 还没拉到或拉取失败 → 诊断块整体不渲染（旧服务端没有这条路由也走这条路径）。
  const diagnosticsDraft = useState(null as unknown);
  const diagnostics = diagnosticsDraft[0];
  const setDiagnostics = diagnosticsDraft[1];
  // 宿主平台进 state 而不是模块变量：它是要渲染的数据。原先写成模块变量让抓取回调无法触发
  // 重渲染——/health 晚于最后一次 setState 返回时，系统卡会一直显示通用文案直到用户再交互。
  const hostPlatformDraft = useState(null as string | null);
  const hostPlatform = hostPlatformDraft[0];
  const setHostPlatform = hostPlatformDraft[1];
  // 频道删除两段确认（实例 id）。路由编辑展开行（openRoute）随 chips
  // 直点形态移除——chips 无展开层，routeToggle 直接落草稿。
  const delArmedDraft = useState(null as string | null);
  const delArmedId = delArmedDraft[0];
  const setDelArmedId = delArmedDraft[1];
  // levels：每个频道「待添加映射」草稿（kind + level；按频道 id 键控）
  const levelsNewDraft = useState({} as Record<string, { kind: string; level: string }>);
  const levelsNew = levelsNewDraft[0];
  const setLevelsNew = levelsNewDraft[1];
  // 卡内三 tab（通知事件 / 通知频道 / 通知记录——历史独立成 tab）。
  // 切 tab 仅条件拼接 children——全部表单/瞬态 state 都在本组件顶层，切换零丢失。
  const activeTabDraft = useState("events" as "events" | "channels" | "history");
  const activeTab = activeTabDraft[0];
  const setActiveTab = activeTabDraft[1];
  // 浏览器通知权限状态行在频道卡内——Notification.permission 非 React state，
  // 请求权限完成后 bump 一次触发重渲染刷新状态行文案/隐藏按钮。
  const permTickDraft = useState(0);
  const permTick = permTickDraft[0];
  const setPermTick = permTickDraft[1];
  // webhook 凭据字段显隐态（键 = <channelId>:<field>；纯瞬态，不入配置、
  // 不影响基线 diff——掩码值本身不回显，显隐只影响「正在输入的新值」可见性）。
  const revealDraft = useState({} as Record<string, boolean>);
  const revealMap = revealDraft[0];
  const setRevealMap = revealDraft[1];
  // 凭据字段「已被用户编辑」的键集（键 = <channelId>:<field>）。未编辑的字段保持服务端掩码
  // 原样提交、由服务端按严格相等还原；只有用户真的输入过才把新值写进草稿——把掩码渲染成
  // 可编辑 value 会让「在圆点后追加一个字符」变成一次真凭据覆盖（见 settings/mask.ts）。
  const secretEditedDraft = useState({} as Record<string, boolean>);
  const secretEdited = secretEditedDraft[0];
  const setSecretEdited = secretEditedDraft[1];

  /** 标记某凭据字段已被用户编辑（幂等）。 */
  function markSecretEdited(key: string) {
    if (secretEdited[key] === true) return;
    const nextEdited: Record<string, boolean> = Object.assign({}, secretEdited);
    nextEdited[key] = true;
    setSecretEdited(nextEdited);
  }
  // 加载基线：保存时只提交与基线不同的键（增量 diff），未改动的键不提交。
  // 用 useRef 持久化：组件每次渲染局部变量会重置为 null，导致 save() 闭包里读不到
  // 基线而永远判定「无变化」。
  const baselineRef = ReactHooks.useRef(null as Record<string, any> | null);
  // settings / meta（revision）ref 收口——异步回调（保存成功 / trailing 补发）
  // 一律读 ref 而非渲染闭包值，杜绝「连点第二个 PUT 带旧 revision」「补发漏提交在途
  // 新编辑」两类陈旧闭包问题。settingsRef 由 patch（唯一写入口）在 updater 内同步。
  const settingsRef = ReactHooks.useRef(null as Record<string, any> | null);
  const metaRef = ReactHooks.useRef(null as any);
  // 保存串行 guard（模块级纯工厂）——同一时刻仅一个在途 PUT。
  const saveGuardRef = ReactHooks.useRef(null as ReturnType<typeof createSaveGuard> | null);
  if (saveGuardRef.current === null) saveGuardRef.current = createSaveGuard();
  const saveGuard = saveGuardRef.current;
  // 保存中 UI 态（按钮禁用 + 「保存中…」文案）
  const savingDraft = useState(false);
  const saving = savingDraft[0];
  const setSaving = savingDraft[1];
  // 409 冲突横幅态。null=无冲突；非 null={ entry, latest }——
  // latest 为冲突时拉取的服务端最新 {effective, revision}（「加载最新/覆盖」动作
  // 的数据源）。横幅期间用户可继续编辑（非模态），动作触发时实时重算本地变更。
  const conflictDraft = useState(null as null | { entry: string; latest: any });
  const conflict = conflictDraft[0];
  const setConflict = conflictDraft[1];

  function loadHistory(alive: { value: boolean }) {
    fetchHistory()
      .then(function (records) {
        if (alive.value) setHistory(records);
      })
      .catch(function () {
        if (alive.value) setHistory([]);
      });
  }

  function loadStatus(alive: { value: boolean }) {
    fetchStatus()
      .then(function (map: any) {
        if (alive.value) setStatusMap(map);
      })
      .catch(function () {
        // 拉取失败保留已加载状态行（不清空——旧实现 catch → {} 会把
        // 已展示的最近投递终态抹掉，瞬时网络抖动即丢信息）
      });
  }

  function loadKinds(alive: { value: boolean }) {
    // 与上面的 loadStatus 同款：失败保留已加载列表，不清空（瞬时抖动不该丢已展示内容）
    fetchKinds()
      .then(function (list: any[]) {
        if (alive.value) setKindsList(list);
      })
      .catch(function () {});
  }

  function loadHealth(alive: { value: boolean }) {
    // 失败与未知都不提示：平台提示回落通用文案即可（用户无法处置「读不到宿主 OS」）
    fetchHealth()
      .then(function (platform) {
        if (alive.value) setHostPlatform(platform);
      })
      .catch(function () {});
  }

  function loadDiagnostics(alive: { value: boolean }) {
    // 失败与超时都不提示：自检面缺席时界面少一块，而不是多一条用户无法处置的错误
    fetchDiagnostics()
      .then(function (body) {
        if (alive.value) setDiagnostics(body);
      })
      .catch(function () {});
  }

  function loadCard(alive: { value: boolean }) {
    fetchConfig()
      .then(function (v: any) {
        if (!alive.value) return;
        const effective = (v && v.effective) || {};
        commitSettings(Object.assign({}, effective));
        baselineRef.current = Object.assign({}, effective);
        const nextMeta = {
          user: v.user || {},
          revision: v.revision,
          effective: effective,
          writable: v.writable !== false,
        };
        metaRef.current = nextMeta;
        setMeta(nextMeta);
        if (v.writable === false) setSaved(t("settingsUnavailable"), true);
      })
      .catch(function (e: any) {
        if (!alive.value) return;
        setSaved(t("loadFail", { msg: (e && e.message) || e, hint: accessHint(e) }), true);
      });
  }

  useEffect(function () {
    const alive = { value: true };
    loadCard(alive);
    loadHistory(alive);
    loadStatus(alive);
    loadKinds(alive);
    loadDiagnostics(alive);
    loadHealth(alive);
    return function () {
      alive.value = false;
    };
  }, []);

  if (!settings) {
    return <li className="dn-set-card">{t("settingsLoading")}</li>;
  }

  /** settings 唯一写入口（ref 收口）：updater 内同步 settingsRef——
   *  为什么在 updater 内写（而非 useEffect latest 模式）：useEffect 是 passive
   *  effect（paint 后异步），可能与网络宏任务回调（保存成功 / trailing 补发）
   *  乱序；updater 内写在 state 计算的同一闭包同一时刻完成，时序零窗口。React
   *  并发 abort 重放会重跑整个 updater 队列，最终写值恒等于最终提交的 state
   *  （最终一致）；StrictMode 双调写同值幂等。all 调用点（loadCard /
   *  switchControl / discardChanges / 各 patch 调用方）统一走本函数，保证
   *  异步回调读 settingsRef.current 恒为最新草稿。
   *  p 为对象时浅合并；为函数时以最新 prev 计算（prev => next）。 */
  function patch(p: any) {
    setSettings(function (prev: any) {
      const next = typeof p === "function" ? p(prev) : Object.assign({}, prev, p);
      settingsRef.current = next;
      return next;
    });
    setSaved("");
  }

  /** 整体替换 settings：已知完整 next 时同步写 settingsRef 再
   *  setState——调用方（loadCard / 冲突恢复 rebase / 静默刷新）随后可能立即
   *  读 ref（如覆盖重提 saveFor），不能等 updater 异步执行。事件级增量编辑
   *  仍走 patch（updater 内写 ref，天然与 state 计算同步）。 */
  function commitSettings(next: Record<string, any>) {
    settingsRef.current = next;
    setSettings(next);
    setSaved("");
  }

  /** 基线 diff：只提交与加载基线不同的键（防组合层 base 被默认值回写覆盖）。
   *  逻辑收敛在模块级纯函数 diffSettingsPayload（供测试直测）。
   *  读 settingsRef（非渲染闭包 settings）——trailing 补发在 .then 回调里
   *  触发，必须取最新草稿；渲染期调用时 ref 与 state 同值，无行为差异。 */
  function diffPayload(): Record<string, any> {
    return diffSettingsPayload(settingsRef.current || settings, baselineRef.current);
  }

  /** 409 冲突恢复：拉最新 → 无脏静默刷新 / 有脏弹双动作横幅。 */
  function handleConflict(entry: string) {
    fetchConfig()
      .then(function (v: any) {
        if (!v) return;
        const latest = {
          effective: (v && v.effective) || {},
          revision: v && v.revision,
          user: (v && v.user) || {},
        };
        // 本地已无该入口脏（用户在 409 往返间撤销/放弃）→ 静默切到最新（兑现
        // 「自动重拉重新渲染」的安全路径，不打扰）。
        if (Object.keys(diffPayloadFor(entry)).length === 0) {
          applyLatestQuiet(latest);
          return;
        }
        setConflict({ entry: entry, latest: latest });
        setSaved(""); // 冲突横幅自带标题（conflictTitle/conflictChannels），foot 提示区清空防重复
      })
      .catch(function () {
        // 拉最新失败：不弹横幅（缺最新 revision 时弹会误导），只提示可重试
        setSaved(t("conflictReloadFail"), true);
      });
  }

  /** 无脏静默刷新：settings/baseline/meta 全部切到服务端最新（不丢任何草稿——
   *  调用前已确认本地无脏）。 */
  function applyLatestQuiet(latest: any) {
    commitSettings(Object.assign({}, latest.effective));
    baselineRef.current = Object.assign({}, latest.effective);
    const nextMeta = {
      user: latest.user || {},
      revision: latest.revision,
      effective: Object.assign({}, latest.effective),
      writable: true,
    };
    metaRef.current = nextMeta;
    setMeta(nextMeta);
    setSaved("");
  }

  /** 提交 PUT 并处理响应（save 的内核；guard 占用与释放由 saveFor 负责）。
   *  409 不再只提示文案——转 handleConflict 进入双动作恢复流程。
   *  实测补强（浏览器验证发现）：fetch 在极端环境（连接池耗尽/服务端静默
   *  挂起）可能永不 settle → finally 永不执行 → 按钮永久「保存中」。加 15s
   *  AbortController 超时兜底：超时中断请求（服务端写入与否未知，UI 必须恢复），
   *  释放 guard 并提示重试。 */
  function putAndCommit(payload: Record<string, any>, entry: string) {
    const expectedRevision =
      metaRef.current && typeof metaRef.current.revision === "number"
        ? metaRef.current.revision
        : undefined;
    const ctrl: AbortController | null =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer: ReturnType<typeof setTimeout> | null = ctrl
      ? setTimeout(function () {
          ctrl!.abort();
        }, 15000)
      : null;
    let chain = fetch(ROUTES.config, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: payload, expectedRevision: expectedRevision }),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r: any) {
        return r.json().then(function (body: any) {
          if (!r.ok) {
            const err = (body && body.error) || {};
            // 挂 code 供 catch 按契约分流：409 判定优先
            // err.code === "SETTINGS_CONFLICT"，不再依赖错误文案中文匹配
            // （文案是本地化/可改的，code 是契约字段）。文案保留进 message。
            const throwErr = new Error(
              err.error || err.details || err.code || "HTTP " + r.status,
            ) as Error & { code?: string };
            if (err.code !== undefined) throwErr.code = String(err.code);
            throw throwErr;
          }
          return body;
        });
      })
      .then(function (body: any) {
        // 事务性基线推进：只并入本次 PUT 实际提交的 payload
        // 键——若并入点击后的 settings 全量，在途期间的编辑会被固化为基线而丢失；
        // 键级并入后，在途新编辑（非 payload 键）仍在 diff 中，由 trailing 补发提交。
        baselineRef.current = Object.assign({}, baselineRef.current || {}, payload);
        const nextMeta = {
          user: (body && body.user) || {},
          revision: (body && body.revision) || undefined,
          effective: Object.assign({}, baselineRef.current),
          writable: true,
        };
        metaRef.current = nextMeta; // 同步写 ref：补发立即读新 revision，不再 409
        setMeta(nextMeta);
        setConflict(null); // 覆盖保存成功：横幅关闭（若曾因再 409 重现）
        setSaved(t("savedOk"));
        setTimeout(function () {
          setSaved("");
        }, 2200);
      })
      .catch(function (e: any) {
        const msg = (e && e.message) || e;
        // 409 判定：code 契约优先，中文文案仅作旧服务端回退
        if ((e && e.code === "SETTINGS_CONFLICT") || String(msg).indexOf("版本冲突") >= 0) {
          // 版本冲突：进入双动作恢复（不再仅提示手动关闭重开）
          handleConflict(entry);
          return;
        }
        // AbortError（15s 超时兜底）：服务端可能已写入也可能未写入——提示重试，
        // 用户重试时 revision 若已推进会自然走 409 恢复流程，语义自洽。
        if (e && e.name === "AbortError") {
          setSaved(t("saveTimeout"), true);
          return;
        }
        setSaved(t("saveFail", { msg: msg }), true);
      });
    if (timer !== null) {
      chain = chain.finally(function () {
        clearTimeout(timer!);
      });
    }
    return chain;
  }

  /** 从全量 diff 中按入口过滤出本次要提交的键（域保存；
   *  纯逻辑收敛在模块级 domainPayload，供测试直测）。 */
  function diffPayloadFor(entry: string): Record<string, any> {
    return domainPayload(diffPayload(), entry);
  }

  /** 保存（串行 guard 接入，入口参数化）：同一时刻仅一个在途 PUT——
   *  - entry："all"（foot 全量）/ "channels"（频道 tab 域保存，只提 channels 键）；
   *  - 在途期间再次点击（任意入口）：guard 记 pending=该入口并立即返回；
   *    本次在途结束（finally 释放 guard）后按被拒入口原样补发（trailing）——
   *    补发读 settingsRef 最新草稿 + metaRef 最新 revision，无丢失、无误 409，
   *    域保存被拒不会升级成全量提交（事件 tab 半成品不被误提交）；
   *  - 空 diff：初次点击提示「未修改」；补发路径（quietIfEmpty=true）静默返回，
   *    不覆盖刚显示的「已保存」；
   *  - guard.end() 放 finally：成功/失败/异常任何路径都释放，防按钮永久卡死。 */
  function saveFor(entry: string, quietIfEmpty?: boolean) {
    if (!saveGuard.tryBegin(entry)) return; // 在途：记 pending=entry，由在途 finally 补发
    let payload: Record<string, any>;
    try {
      payload = diffPayloadFor(entry);
    } catch (error) {
      // 防御：tryBegin 后同步异常（diff 计算等理论不可达路径）必须释放 guard
      saveGuard.end();
      setSaved(t("saveFail", { msg: String((error && (error as any).message) || error) }), true);
      return;
    }
    if (Object.keys(payload).length === 0) {
      saveGuard.end();
      if (!quietIfEmpty) setSaved(t("unchanged"));
      return;
    }
    setSaving(true);
    // 显式标注不等待：putAndCommit 内部已按契约分流处理失败（409 → handleConflict、
    // 超时 / 其它 → setSaved 提示），它的返回链不会以拒绝收场；此处只补收尾的 UI 复位。
    void putAndCommit(payload, entry).finally(function () {
      setSaving(false);
      const nextEntry = saveGuard.end();
      if (nextEntry !== null) saveFor(nextEntry, true); // trailing 补发（同入口，天然不循环）
    });
  }

  /** 冲突横幅「加载最新」：丢弃本地草稿，切到服务端最新（等价旧「关闭重开」
   *  的手动重拉，无需用户手动操作）。 */
  function resolveConflictLoadLatest() {
    if (!conflict) return;
    applyLatestQuiet(conflict.latest);
    setConflict(null);
    toast(t("conflictLoadedLatest"));
  }

  /** 冲突横幅「保留我的修改并覆盖」：rebase-then-retry——
   *  以最新 effective 为新基线，把本地变更键（动作触发时实时重算，非 409 快照，
   *  横幅期间新编辑不丢）覆盖上去，用新 revision 重提；再 409 会回到横幅
   *  （每次覆盖消费一次用户动作，天然收敛、无自动风暴）。 */
  function resolveConflictOverwrite() {
    if (!conflict) return;
    const entry = conflict.entry;
    const latest = conflict.latest;
    const localChanges = diffPayloadFor(entry); // 实时重算（相对旧基线的当前脏）
    const merged = rebaseSettings(localChanges, latest.effective || {});
    commitSettings(merged); // 同步写 ref：随后 saveFor 立即以 merged 计算 diff
    baselineRef.current = Object.assign({}, latest.effective || {});
    const nextMeta = {
      user: latest.user || {},
      revision: latest.revision,
      effective: Object.assign({}, latest.effective || {}),
      writable: true,
    };
    metaRef.current = nextMeta;
    setMeta(nextMeta);
    setConflict(null);
    setSaved("");
    // 用最新 revision 重提（quiet 补发语义：diff 由合并后的 settings 计算）
    saveFor(entry, true);
  }

  /** 放弃更改——草稿回写加载基线（编辑态/运行时镜像同步还原）。
   *  经 patch 统一写入口（settingsRef 同步）；按钮在 saving 期间禁用
   *  （foot 渲染处），消除「在途成功回调覆盖放弃后基线」的竞态。
   *  放弃即退出冲突语境：409 横幅一并关闭（否则横幅会指向已被丢弃的草稿）。 */
  function discardChanges() {
    if (baselineRef.current) {
      commitSettings(Object.assign({}, baselineRef.current));
    }
    setConflict(null);
    setSaved("");
    toast(t("discardOk"));
  }

  /** 发送测试通知（channelId 可选——per-channel 测试；完成后刷新状态行）。 */
  function sendTest(channelId?: string) {
    sendTestReq(channelId)
      .then(function (data: any) {
        toast(
          t(
            channelId ? "testChannelOk" : "testSent",
            channelId ? undefined : { n: data && data.sseConnections },
          ),
        );
        loadStatus({ value: true });
      })
      .catch(function (error: any) {
        toast(t("testFail", { msg: error.message, hint: accessHint(error) }));
      });
  }

  // ---- 频道编辑（settings.channels 不可变操作；deviceKey 掩码语义见服务端）----

  /** 更新第 idx 个频道实例（字段经 assignChannelFields 合并——空串/undefined
   *  删键；函数式基于最新 channels，防后写覆盖）。 */
  function chPatch(idx: number, part: Record<string, any>) {
    patch(function (prev: any) {
      const list = (prev.channels || []).slice();
      list[idx] = assignChannelFields(list[idx] || {}, part);
      return Object.assign({}, prev, { channels: list });
    });
  }

  /** 写/删某实例的 levels 映射（kind→level；level 为空删除该 kind；函数式基于最新 channels）。 */
  function chLevelsSet(idx: number, kind: string, level: string) {
    if (!kind || kind === "__proto__" || kind === "constructor" || kind === "prototype") return;
    patch(function (prev: any) {
      const list = (prev.channels || []).slice();
      const ch = Object.assign({}, list[idx]);
      const levels = Object.assign({}, ch.levels || {});
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
      const list = (prev.channels || []).slice();
      list.splice(idx, 1);
      return Object.assign({}, prev, { channels: list });
    });
  }

  /** 新增频道实例（kind = "bark" | "webhook"）——自动分配未占用的 id
   *  （bark-1… / webhook-1…），默认禁用（出站授权显式授予）。可选认证/
   *  凭据/模板字段一律**不预置键**——空串形态会被服务端写面校验整组 400（token/
   *  username/password/headerValue 要求非空、headerName 过头名正则），未填写 =
   *  键不存在；输入清空经 assignChannelFields 同步删键。url/baseUrl 为必填占位，
   *  未填保存由服务端 400 拦（url 非法即整组拒绝，语义正确）。超时缺省 10s 由
   *  服务端 normalize 兜底。 */
  function chAdd(kind: string) {
    patch(function (prev: any) {
      const list = prev.channels || [];
      let seq = 1;
      const taken = new Set(
        list.map(function (c: any) {
          return String(c.id);
        }),
      );
      while (taken.has(kind + "-" + seq)) seq += 1;
      const id = kind + "-" + seq;
      const base: Record<string, any> =
        kind === "webhook"
          ? {
              id: id,
              name: t("chNewWebhookName") + " " + seq,
              type: "webhook",
              url: "",
              auth: "none",
              timeoutSec: 10,
              enabled: false,
            }
          : {
              id: id,
              name: t("chNewBarkName") + " " + seq,
              type: "bark",
              baseUrl: "",
              enabled: false,
            };
      return Object.assign({}, prev, { channels: list.concat([base]) });
    });
    setDelArmedId(null);
  }

  // ---- 路由（kindRoutes 单源；事件行与频道卡双向编辑同一份配置）----

  /** 当前 kind 的路由数组（undefined = 跟随默认广播）。 */
  function routeOf(kind: string): string[] | undefined {
    const routes = settings.kindRoutes || {};
    return routes[kind];
  }

  /** 写/清 kind 路由条目（ids=null 删除条目恢复默认；函数式基于最新 kindRoutes）。 */
  function routeSetKind(kind: string, ids: string[] | null) {
    patch(function (prev: any) {
      const routes = Object.assign({}, prev.kindRoutes || {});
      if (ids === null || ids.length === 0) delete routes[kind];
      else routes[kind] = ids;
      return Object.assign({}, prev, { kindRoutes: routes });
    });
  }

  /** 频道显示名：内置用固定文案（它们的 name 不参与配置），实例用 name 回退 id。 */
  function channelLabel(c: any): string {
    if (c.type === "browser") return t("chBrowserNotify");
    if (c.type === "system") return t("chSystemNotify");
    return c.name || String(c.id);
  }

  /** 当前「跟随默认」投递面（路由 id 列表）：内置与实例同一判据——`enabled`（发不发）。
   *  chips 点亮态（无条目时）与首次切换物化的快照都以本函数为准——所见即所得。 */
  function defaultRouteIds(prev: any): string[] {
    const ids: string[] = [];
    (prev.channels || []).forEach(function (c: any) {
      if (c.enabled === true) ids.push(channelIdOf(c));
    });
    return ids;
  }

  /** 路由候选（含停用频道——保留显示以呈现「已配置但未启用」；未启用者置灰
   *  禁点——投递面 = 启用频道 ∩ 路由，未启用频道即使点亮也不投递，假点亮误导。
   *  enabled 标志供 chips 置灰/title 提示；已勾选未启用频道不自动清除，
   *  用户启用后即恢复有效）。候选顺序即 `channels` 顺序：内置恒在最前。 */
  function routeOptions(prev: any): Array<{ id: string; label: string; enabled: boolean }> {
    return (prev.channels || []).map(function (c: any) {
      return { id: channelIdOf(c), label: channelLabel(c), enabled: c.enabled === true };
    });
  }

  /**
   * 路由 chips 单点切换（chips 直点形态；函数式基于最新
   * kindRoutes/channels 计算，防同帧勾选后写覆盖）。
   *
   * 语义（替代旧「undefined=全选快照」歧义）：
   * - kindRoutes 无条目 = 跟随默认（投递到全部当前启用频道，随启停动态变化）；
   * - 任一 chip 切换即把当前默认投递面物化为显式快照（冻结），此后启停变化需显式维护；
   * - 清空（全灭）= 删除条目恢复跟随默认（与旧实现「空数组即 delete」一致）。
   */
  function routeToggle(kind: string, oid: string, checked: boolean) {
    patch(function (prev: any) {
      const routes = Object.assign({}, prev.kindRoutes || {});
      const cur = routes[kind] === undefined ? defaultRouteIds(prev).slice() : routes[kind].slice();
      const at = cur.indexOf(oid);
      if (checked && at === -1) cur.push(oid);
      else if (!checked && at !== -1) cur.splice(at, 1);
      if (cur.length === 0) delete routes[kind];
      else routes[kind] = cur;
      return Object.assign({}, prev, { kindRoutes: routes });
    });
  }

  /** 动态 kind 确认（POST /kinds；完成后刷新清单并提示）。
   *  响应体带新 revision → 同步 metaRef/setMeta——服务端
   *  确认写入已推进 revision，若不同步，同一窗口随后保存会带过期 revision 必 409
   *  （无并发的纯版本链断点，比连点更高频）。 */
  function confirmOne(kind: string, confirmed: boolean) {
    postKind(kind, confirmed)
      .then(function (body: any) {
        const freshRevision = body && typeof body.revision === "number" ? body.revision : undefined;
        if (freshRevision !== undefined && metaRef.current) {
          const nextMeta = Object.assign({}, metaRef.current, { revision: freshRevision });
          metaRef.current = nextMeta;
          setMeta(nextMeta);
        }
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
      setTimeout(function () {
        setClearArmed(false);
      }, 3000);
      return;
    }
    setClearArmed(false);
    fetch(ROUTES.history, { method: "DELETE" })
      .then(function (r: any) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data: any) {
        toast(t("cleared", { n: data.removed || 0 }));
        loadHistory({ value: true });
      })
      .catch(function (error) {
        toast(t("clearFail", { msg: error.message, hint: accessHint(error) }));
      });
  }

  /** 频道卡体行（cap + 控件 + 可选 hint；CSS dn-ch-row/dn-ch-cap/dn-ch-ctl）。 */
  function chRow(cap: string, control: any, hint?: string) {
    return (
      <div className="dn-ch-row">
        <span className="dn-ch-cap">{cap}</span>
        <span className="dn-ch-ctl">{control}</span>
        {hint ? <span className="dn-ch-hint">{hint}</span> : null}
      </div>
    );
  }

  /** 折叠区行（cap + 控件；CSS dn-adv-row）。 */
  function advRow(cap: string, control: any) {
    return (
      <div className="dn-adv-row">
        <span className="dn-adv-cap">{cap}</span>
        {control}
      </div>
    );
  }

  /** switch 开关底层（track 40×22 + 透明 input 覆盖 44×32 触控区；
   *  aria-label 提供可访问名——switch 无内联文本，WCAG 4.1.2）。 */
  function switchToggle(checked: boolean, onChange: (v: boolean) => void, ariaLabel: string) {
    return (
      <label className="dn-switch">
        <input
          type="checkbox"
          aria-label={ariaLabel}
          checked={checked === true}
          onChange={function (e: any) {
            onChange(e.target.checked === true);
          }}
        />
        <span className="dn-switch-track" />
      </label>
    );
  }

  /** 顶层布尔设置键的 switch（switchToggle 的设置键薄封装）。
   *  统一走 patch 写入口（settingsRef 同步），不再裸 setSettings。 */
  function switchControl(key: string, ariaLabel: string) {
    return switchToggle(
      settings[key] === true,
      function (v: boolean) {
        patch(function (prev: any) {
          const next = Object.assign({}, prev);
          next[key] = v;
          return next;
        });
      },
      ariaLabel,
    );
  }

  function textInput(
    value: any,
    onChange: (v: string) => void,
    opts?: { type?: string; placeholder?: string; ariaLabel?: string },
  ) {
    return (
      <input
        type={(opts && opts.type) || "text"}
        className="dn-set-input dn-set-inputText"
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={opts && opts.placeholder}
        aria-label={(opts && opts.ariaLabel) || (opts && opts.placeholder) || undefined}
        onChange={function (e: any) {
          onChange(e.target.value);
        }}
      />
    );
  }

  function numInput(
    value: any,
    onChange: (v: number | undefined) => void,
    opts?: { ariaLabel?: string; min?: number; max?: number },
  ) {
    return (
      <input
        type="number"
        step={1}
        className="dn-set-input dn-set-numInput"
        min={opts && opts.min}
        max={opts && opts.max}
        aria-label={opts && opts.ariaLabel}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={function (e: any) {
          onChange(e.target.value === "" ? undefined : Number(e.target.value));
        }}
      />
    );
  }

  function padTime(ts: number) {
    const d = new Date(ts);
    const pad = function (n: number) {
      return n < 10 ? "0" + n : String(n);
    };
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  /** 频道状态摘要（上提卡头 statusDot + statusTxt；完整错误经 title 提示）。 */
  function statusText(channelKey: string): string {
    const st = statusMap[channelKey];
    if (!st || !st.lastTs) return t("chNeverSent");
    if (st.lastStatus === "ok") return t("chLastOk") + " · " + padTime(st.lastTs);
    const why = reasonText(st.lastError, t);
    return t("chLastFail") + " · " + padTime(st.lastTs) + (why ? "：" + why : "");
  }
  function statusDotClass(channelKey: string): string {
    const st = statusMap[channelKey];
    if (!st || !st.lastTs) return "";
    return st.lastStatus === "ok" ? "ok" : "fail";
  }

  function testBtn(channelId?: string) {
    return (
      <button
        type="button"
        className="dn-set-btn dn-set-btnSmall"
        onClick={function () {
          sendTest(channelId);
        }}
      >
        {t("chTest")}
      </button>
    );
  }

  /** 投递失败徽标：最近投递失败时上提至卡头 summary 行，收起态仍可见。 */
  function failBadge(channelKey: string) {
    const st = statusMap[channelKey];
    if (!st || !st.lastTs || st.lastStatus !== "failed") return null;
    return <span className="dn-ch-failBadge">{t("chLastFail") + " · " + padTime(st.lastTs)}</span>;
  }

  /**
   * 浏览器通知权限状态行（从全局降级区移入「浏览器通知」频道卡）。
   * 三态文案 + 未授权时的「请求通知权限」按钮（手势内请求，完成后刷新状态）；
   * 非安全上下文/无 Notification API 时返回 null（对应降级文案仍在全局 notes）。
   */
  function browserPermLine() {
    if (!("Notification" in window) || !isSecureContext()) return null;
    let text = "";
    let pending = false;
    if (Notification.permission === "granted") text = t("permGranted");
    else if (Notification.permission === "denied") text = t("permDenied");
    else {
      text = t("permDefault");
      pending = true;
    }
    return (
      <div className="dn-ch-perm">
        <span className="dn-ch-permText">{text}</span>
        {pending ? (
          <button
            type="button"
            className="dn-set-btn dn-set-btnSmall"
            onClick={function () {
              requestPermission(function () {
                setSaved(t("permRequested"));
                setPermTick(permTick + 1); // 触发重渲染刷新权限状态行
              });
            }}
          >
            {t("requestPerm")}
          </button>
        ) : null}
      </div>
    );
  }

  /**
   * 内置频道卡（browser/system）：开关 + 行为参数 + 状态行 + per-channel 测试。
   * 整卡 details 可折叠——非受控 + key remount 形态（key 含 enabled，
   * open 仅 mount 生效），未启用默认收起、启用默认展开；手动开合完全交 DOM，
   * 无受控时序坑；启停切换重挂载重置折叠态（预期行为）。summary 内 enable
   * checkbox 依赖 HTML 规范豁免（点击 interactive content 不触发 summary 激活）。
   */
  /**
   * 内置频道卡（三开关：启用 / 弹窗 / 声音）：
   * 卡头 = 类型图标 + 名称 + 类型徽标 + 状态点/摘要 + **启用** switch；卡体 = 弹窗行 + 声音行
   * （开关 + 音色下拉 + ▶试听）+（浏览器）权限状态行 + 测试按钮。
   *
   * 谁决定什么：**启用**决定「发不发」（关掉 = 完全不投递，声音也不发）；**弹窗 + 声音**决定
   * 「怎么发」（弹窗关而声音开 = 只响不弹；两者都关 = 本频道不会有任何提醒，卡体给出提示）。
   * 三态摘要：启用开 + 弹窗开 = 启用；启用开 + 弹窗关 + 声音开 = 仅声音；启用关 = 已停用。
   */
  /**
   * 内置频道卡：与实例卡同源——它们都是 `settings.channels` 里的一项，只是不渲染删除入口、也没有凭据。
   * 卡头 = 图标 + 名称 + 内置徽标 + 状态摘要 + 状态点 + 失败徽标 + 启用 switch；卡体 = 弹窗行 +
   * （浏览器另有「页面可见时也弹」）+ 声音行 + 权限/平台提示 + 测试按钮。
   */
  function builtinCard(index: number, ch: any, label: string) {
    const channelId = channelIdOf(ch);
    const enabled = ch.enabled === true;
    const popup = ch.popup === true;
    const soundOn = soundIsOn(ch.sound);
    const stateCls = !enabled ? " dn-ch-off" : !popup && soundOn ? " dn-ch-sound" : " dn-ch-onEdge";
    const summaryState = !enabled
      ? t("chStateOff")
      : !popup && soundOn
        ? t("chStateSound")
        : t("chStateOn");
    const extras: any[] = [];
    extras.push(
      chRow(
        t("chPopup"),
        switchToggle(
          popup,
          function (v: boolean) {
            chPatch(index, { popup: v });
          },
          t("chPopup") + " " + label,
        ),
      ),
    );
    if (ch.type === "browser") {
      extras.push(
        chRow(
          t("chWhenVisible"),
          switchToggle(
            ch.whenVisible === true,
            function (v: boolean) {
              chPatch(index, { whenVisible: v });
            },
            t("chWhenVisible") + " " + label,
          ),
        ),
      );
    }
    extras.push(soundRow(index, ch, label));
    return (
      <details
        className={"dn-ch-card" + stateCls}
        key={"ch-" + channelId + ":" + enabled + ":" + popup + ":" + soundOn}
        open={enabled}
      >
        <summary>
          {iconEl(String(ch.type))}
          <span className="dn-ch-name">{label}</span>
          <span className="dn-ch-type">{t("chTypeBuiltin")}</span>
          <span className="dn-ch-stateTxt">{summaryState}</span>
          <span className={"dn-ch-statusDot " + statusDotClass(channelId)} />
          <span className="dn-ch-statusTxt" title={statusText(channelId)}>
            {statusText(channelId)}
          </span>
          {failBadge(channelId)}
          <span className="dn-ch-summaryRight">
            {switchToggle(
              enabled,
              function (v: boolean) {
                chPatch(index, { enabled: v });
              },
              (enabled ? t("chToggleOff") : t("chToggleOn")) + label,
            )}
          </span>
        </summary>
        <div className="dn-ch-body">
          {extras}
          {enabled && !popup && soundOn ? (
            <div className="dn-set-note-inline dn-soundOnly">{t("chSoundOnlyNote")}</div>
          ) : null}
          {enabled && !popup && !soundOn ? (
            <div className="dn-set-note-inline dn-soundOnly">{t("chPopupSoundOffNote")}</div>
          ) : null}
          {/* 浏览器通知权限状态行归入浏览器频道卡（权限授权入口同卡就近可达） */}
          {ch.type === "browser" ? browserPermLine() : null}
          {/* 浏览器面自检行：宿主侧接口看不到本页的权限与音频解锁状态 */}
          {ch.type === "browser" ? browserDiagnosticsLine() : null}
          {/* 系统卡平台提示（/health platform 消费；宿主 OS 与浏览器 OS 可异机） */}
          {ch.type === "system" ? systemPlatformHint() : null}
          {/* 宿主能力自检（/diagnostics）：结论 + 处置建议 + 明细折叠 */}
          {ch.type === "system" ? hostDiagnosticsBlock() : null}
          <div className="dn-ch-actions">{testBtn(channelId)}</div>
        </div>
      </details>
    );
  }

  /** 平台提示行：宿主平台差异说明——Windows SoundPlayer 语义、macOS
   *  NSSound、Linux 自播；/health 拉取失败/未知平台回落通用说明。 */
  function systemPlatformHint() {
    let text: string;
    if (hostPlatform === "win32") text = t("sysPlatformWin");
    else if (hostPlatform === "darwin") text = t("sysPlatformMac");
    else if (hostPlatform === "linux") text = t("sysPlatformLinux");
    else text = t("sysPlatformOther");
    return <div className="dn-set-note-inline">{text}</div>;
  }

  /**
   * 宿主能力自检块（系统频道卡体）。为什么落在卡体而不是卡头 `.dn-ch-statusTxt`：窄屏下
   * 卡头那行被 display:none 收起，而手机恰是最需要知道「为什么没响」的地方。
   * 这里只做机械投影——结论、处置建议、明细的文案都来自 capabilities.ts。
   */
  function hostDiagnosticsBlock() {
    const view = diag.host;
    if (!view) return null;
    return (
      <div className={"dn-ch-diag dn-ch-diag-" + view.tone}>
        <span className="dn-ch-diagText">{view.line}</span>
        {view.unknownLine ? <span className="dn-ch-diagText">{view.unknownLine}</span> : null}
        {view.remediationLines.length === 0 ? null : (
          <div>
            <span className="dn-ch-diagCap">{view.remediationTitle}</span>
            <ul className="dn-ch-diagItems">
              {view.remediationLines.map(function (text, i) {
                return <li key={"rem-" + i}>{text}</li>;
              })}
            </ul>
          </div>
        )}
        {/* 明细折叠（沿用通知记录里 dn-ch-reasonRaw 的折叠范式）；来源标注在展开区首行 */}
        <details className="dn-ch-reasonRaw">
          <summary>{view.detailsLabel}</summary>
          <div className="dn-ch-reasonRawText">
            <div className="dn-ch-diagSrc">{view.sourceLabel}</div>
            {view.details.map(function (row, i) {
              return (
                <div className="dn-ch-diagDetail" key={"det-" + i}>
                  <span className="dn-ch-diagDetailCap">{row.label}</span>
                  <span>{row.value}</span>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    );
  }

  /** 浏览器面自检行（浏览器频道卡体）：宿主算不出来的那几个事实（权限、音频解锁）在这里成一句话。 */
  function browserDiagnosticsLine() {
    const view = diag.browser;
    return (
      <div className={"dn-ch-diag dn-ch-diag-" + view.tone}>
        <span className="dn-ch-diagText">{view.line}</span>
        <span className="dn-ch-diagSrc">{view.sourceLabel}</span>
      </div>
    );
  }

  /** 内置音色选项（4 音色；label 字典键）。 */
  // 常量表：每次渲染重建一份是原实现的形态，这里只把声明关键字收正（改成 const 不会改变
  // 取值时机——引用它的 soundRow 只在更深处的 JSX 构造期被调用）
  const SOUND_OPTION_KEYS: Record<string, string> = {
    ding: "toneDing",
    bell: "toneBell",
    chime: "toneChime",
    pop: "tonePop",
  };

  /** 单通道声音行：开关（false/true 切换）+ 展开音色下拉 + ▶试听。
   *  开关语义：off=false（静音）；on=true（跟随系统默认）；on 后选择音色 =
   *  SoundId（显式音色）。交互全部显式 audioEngine.unlock() 兜底（autoplay 策略下
   *  纯后台页面自播需此前任意手势解锁；试听点击本身即手势）。 */
  function soundRow(index: number, ch: any, channelLabel: string) {
    const soundVal = ch.sound;
    const soundOn = soundIsOn(soundVal);
    const toneValue =
      typeof soundVal === "string" && SOUND_IDS.indexOf(soundVal) !== -1 ? soundVal : "";
    const toneOpts: any[] = [
      <option value="" key="sys">
        {t("chSoundFollow")}
      </option>,
    ].concat(
      SOUND_IDS.map(function (id) {
        return (
          <option value={id} key={id}>
            {t(SOUND_OPTION_KEYS[id])}
          </option>
        );
      }),
    );
    return (
      <div className="dn-ch-row" key={"sound-" + channelIdOf(ch)}>
        <span className="dn-ch-cap">{t("chSound")}</span>
        <span className="dn-ch-ctl">
          {switchToggle(
            soundOn,
            function (v: boolean) {
              // 用户手势：解锁音频（开启声音后隐藏页面自播才可能发声）
              audioEngine.unlock();
              chPatch(index, { sound: v }); // false / true
            },
            t("chSound") + " " + channelLabel,
          )}
          {soundOn ? (
            <select
              className="dn-set-input dn-set-select"
              value={toneValue}
              aria-label={t("chSoundTone")}
              onChange={function (e: any) {
                audioEngine.unlock();
                chPatch(index, { sound: e.target.value === "" ? true : e.target.value });
              }}
            >
              {toneOpts}
            </select>
          ) : null}
          {soundOn ? (
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall dn-tonePreview"
              aria-label={t("chSoundPreview")}
              onClick={function () {
                audioEngine.playPreview(toneValue || undefined);
              }}
            >
              ▶ {t("chSoundPreview")}
            </button>
          ) : null}
          {toneValue === "" && soundOn ? (
            <span className="dn-ch-hint">{t("chSoundFollowHint")}</span>
          ) : null}
        </span>
      </div>
    );
  }

  /**
   * Bark 实例卡：卡头 = 图标 + 名称 + 类型徽标 + 状态点/摘要 +
   * 失败徽标 + 启用 switch；卡体 = 基本行 + 高级参数折叠（含 levels 矩阵）+ 测试/删除。
   * 整卡 details 可折叠（非受控 + key remount），未启用默认收起。
   */
  function barkCard(ch: any, idx: number) {
    const channelKey = channelIdFor(ch);
    const armed = delArmedId === ch.id;
    const deviceKeyKey = credentialFieldKey(String(ch.id), "deviceKey");
    const levelOpts: any[] = [
      <option value="" key="auto">
        {t("chLevelAuto")}
      </option>,
    ];
    ["active", "timeSensitive", "passive", "critical"].forEach(function (lv: string) {
      levelOpts.push(
        <option value={lv} key={lv}>
          {lv}
        </option>,
      );
    });
    // levels（kind→level）编辑：kind 建议 = 内置 7 kind + 动态已注册 kind；datalist id 按实例唯一
    const suggestKinds: string[] = Object.keys(KIND_KEYS);
    (kindsList || []).forEach(function (k: any) {
      if (suggestKinds.indexOf(String(k.id)) === -1) suggestKinds.push(String(k.id));
    });
    const dlId = "dn-levels-suggest-" + String(ch.id);
    const levels = ch.levels || {};
    const levelKeys = Object.keys(levels);
    const levelsRows: any[] = levelKeys.map(function (kind) {
      return (
        <div className="dn-levels-row" key={"lv-" + kind}>
          <span className="dn-levels-kind">
            {KIND_KEYS[kind] !== undefined ? t(KIND_KEYS[kind]) + " (" + kind + ")" : kind}
          </span>
          <select
            className="dn-set-input dn-set-select"
            value={levels[kind] || ""}
            onChange={function (e: any) {
              chLevelsSet(idx, kind, e.target.value);
            }}
          >
            {levelOpts}
          </select>
          <button
            type="button"
            className="dn-set-btn dn-set-btnSmall"
            onClick={function () {
              chLevelsSet(idx, kind, "");
            }}
          >
            {t("chLevelsRemove")}
          </button>
        </div>
      );
    });
    const newRow = levelsNew[String(ch.id)] || { kind: "", level: "active" };
    const newKindKnown = suggestKinds.indexOf(newRow.kind) !== -1;
    const addRow = (
      <div className="dn-levels-add" key="lv-add">
        <input
          type="text"
          className="dn-set-input dn-set-inputText"
          list={dlId}
          placeholder={t("chLevelsKindPlaceholder")}
          value={newRow.kind}
          onChange={function (e: any) {
            setLevelsNew(
              Object.assign({}, levelsNew, {
                [String(ch.id)]: { kind: e.target.value, level: newRow.level },
              }),
            );
          }}
        />
        <select
          className="dn-set-input dn-set-select"
          value={newRow.level}
          onChange={function (e: any) {
            setLevelsNew(
              Object.assign({}, levelsNew, {
                [String(ch.id)]: { kind: newRow.kind, level: e.target.value },
              }),
            );
          }}
        >
          {levelOpts}
        </select>
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            if (newRow.kind) {
              chLevelsSet(idx, newRow.kind, newRow.level);
              setLevelsNew(
                Object.assign({}, levelsNew, { [String(ch.id)]: { kind: "", level: "active" } }),
              );
            }
          }}
        >
          {t("chLevelsAdd")}
        </button>
        {newRow.kind && !newKindKnown ? (
          <span className="dn-set-note-inline">{t("chLevelsUnknown")}</span>
        ) : null}
      </div>
    );
    return (
      <details
        className={"dn-ch-card" + (ch.enabled ? " dn-ch-onEdge" : " dn-ch-off")}
        key={channelKey + ":" + (ch.enabled === true)}
        open={ch.enabled === true}
      >
        <summary>
          {iconEl("bark")}
          <span className="dn-ch-name">{ch.name || ch.id}</span>
          <span className="dn-ch-type">bark</span>
          <span className={"dn-ch-statusDot " + statusDotClass(channelKey)} />
          <span className="dn-ch-statusTxt" title={statusText(channelKey)}>
            {statusText(channelKey)}
          </span>
          {failBadge(channelKey)}
          <span className="dn-ch-summaryRight">
            {switchToggle(
              ch.enabled === true,
              function (v: boolean) {
                chPatch(idx, { enabled: v });
              },
              (ch.enabled ? t("chToggleOff") : t("chToggleOn")) + (ch.name || ch.id),
            )}
          </span>
        </summary>
        <div className="dn-ch-body">
          {chRow(
            t("chBarkName"),
            textInput(
              ch.name,
              function (v: string) {
                chPatch(idx, { name: v });
              },
              { placeholder: t("chBarkNamePlaceholder"), ariaLabel: t("chBarkName") },
            ),
          )}
          {chRow(
            t("chBarkBaseUrl"),
            textInput(
              ch.baseUrl,
              function (v: string) {
                chPatch(idx, { baseUrl: v });
              },
              { placeholder: "https://api.day.app", ariaLabel: t("chBarkBaseUrl") },
            ),
            t("chBarkBaseUrlHint"),
          )}
          {chRow(
            t("chBarkDeviceKey"),
            <span className="dn-secret" key="deviceKey">
              <input
                type="password"
                className="dn-set-input dn-set-inputText"
                value={
                  credentialFieldView(
                    ch.deviceKey,
                    secretEdited[deviceKeyKey] === true,
                    t("chBarkDeviceKeyPlaceholder"),
                  ).value
                }
                placeholder={
                  credentialFieldView(
                    ch.deviceKey,
                    secretEdited[deviceKeyKey] === true,
                    t("chBarkDeviceKeyPlaceholder"),
                  ).placeholder
                }
                aria-label={t("chBarkDeviceKey")}
                onChange={function (e: any) {
                  markSecretEdited(deviceKeyKey);
                  chPatch(idx, { deviceKey: e.target.value });
                }}
              />
            </span>,
            t("chBarkDeviceKeyHint"),
          )}
          <details className="dn-ch-adv" key={"adv-" + ch.id}>
            <summary>{t("chAdvanced")}</summary>
            <div className="dn-ch-adv-body">
              {advRow(
                t("chBarkSound"),
                textInput(
                  ch.sound,
                  function (v: string) {
                    chPatch(idx, { sound: v });
                  },
                  { ariaLabel: t("chBarkSound") },
                ),
              )}
              {advRow(
                t("chBarkGroup"),
                textInput(
                  ch.group,
                  function (v: string) {
                    chPatch(idx, { group: v });
                  },
                  { ariaLabel: t("chBarkGroup") },
                ),
              )}
              <div className="dn-set-note-inline">{t("chBarkGroupHint")}</div>
              {advRow(
                t("chBarkIcon"),
                textInput(
                  ch.icon,
                  function (v: string) {
                    chPatch(idx, { icon: v });
                  },
                  { ariaLabel: t("chBarkIcon") },
                ),
              )}
              <div className="dn-set-note-inline">{t("chBarkIconHint")}</div>
              {advRow(
                t("chBarkUrl"),
                textInput(
                  ch.url,
                  function (v: string) {
                    chPatch(idx, { url: v });
                  },
                  { ariaLabel: t("chBarkUrl") },
                ),
              )}
              {advRow(
                t("chBarkBadge"),
                numInput(
                  ch.badge,
                  function (v: number | undefined) {
                    chPatch(idx, { badge: v });
                  },
                  { ariaLabel: t("chBarkBadge") },
                ),
              )}
              {advRow(
                t("chBarkLevel"),
                <select
                  className="dn-set-input dn-set-select"
                  value={ch.level || ""}
                  aria-label={t("chBarkLevel")}
                  onChange={function (e: any) {
                    chPatch(idx, { level: e.target.value || undefined });
                  }}
                >
                  {levelOpts}
                </select>,
              )}
              <div className="dn-set-note-inline">{t("chBarkLevelHint")}</div>
              <div className="dn-set-note-inline">{t("chLevelsHint")}</div>
              {levelKeys.length === 0 ? (
                <div className="dn-set-note-inline">{t("chLevelsEmpty")}</div>
              ) : (
                levelsRows
              )}
              {addRow}
              <datalist id={dlId}>
                {suggestKinds.map(function (k) {
                  return (
                    <option value={k} key={k}>
                      {k}
                    </option>
                  );
                })}
              </datalist>
            </div>
          </details>
          <div className="dn-ch-actions">
            {testBtn(channelKey)}
            <button
              type="button"
              className={"dn-set-btn dn-set-btnSmall" + (armed ? " dn-set-btnDanger" : "")}
              onClick={function () {
                if (armed) {
                  chRemove(idx);
                  setDelArmedId(null);
                } else {
                  setDelArmedId(ch.id);
                  setTimeout(function () {
                    setDelArmedId(null);
                  }, 3000);
                }
              }}
            >
              {armed ? t("chDeleteConfirm") : t("chDelete")}
            </button>
          </div>
        </div>
      </details>
    );
  }

  /**
   * Webhook 实例卡（新增频道位，安卓经 ntfy / Gotify / 自建网关推送；默认停用）。
   * 卡头同 Bark 实例卡形态；卡体：预设（填充认证/模板，URL 不覆盖）/ 名称 / 目标 URL /
   * 认证（none|bearer|basic|header，动态字段凭据掩码）/ 投递超时（1-60s clamp）/
   * JSON 模板编辑器（占位符 chips 光标处插入）。渲染契约见 channel-webhook.ts。
   */
  function webhookCard(ch: any, idx: number) {
    const channelKey = channelIdFor(ch);
    const armed = delArmedId === ch.id;
    const authValue =
      ["none", "bearer", "basic", "header"].indexOf(String(ch.auth || "none")) !== -1
        ? String(ch.auth || "none")
        : "none";
    const chId = String(ch.id);

    /** webhook 字段 patch（函数式基于最新 channels，防同帧后写覆盖）。 */
    function whPatch(part: Record<string, any>) {
      chPatch(idx, part);
    }

    /** 凭据输入 + 显隐按钮。value 走 maskedFieldValue：未编辑时为空（占位符给「已配置」提示），
     *  服务端掩码不进 value——它一旦被改写就不再等于掩码，服务端会把它当新凭据落盘。 */
    function secretField(field: string, placeholderKey: string) {
      const key = credentialFieldKey(chId, field);
      const shown = revealMap[key] === true;
      const fieldView = credentialFieldView(
        ch[field],
        secretEdited[key] === true,
        t(placeholderKey),
      );
      const part: Record<string, any> = {};
      return (
        <span className="dn-secret" key={field}>
          <input
            type={shown ? "text" : "password"}
            className="dn-set-input dn-set-inputText"
            value={fieldView.value}
            placeholder={fieldView.placeholder}
            aria-label={t(placeholderKey)}
            onChange={function (e: any) {
              markSecretEdited(key);
              part[field] = e.target.value;
              whPatch(part);
            }}
          />
          <button
            type="button"
            className="dn-secret-reveal"
            onClick={function () {
              const next: Record<string, boolean> = Object.assign({}, revealMap);
              next[key] = !shown;
              setRevealMap(next);
            }}
          >
            {shown ? t("secretHide") : t("secretShow")}
          </button>
        </span>
      );
    }

    /** 占位符插入模板（光标处；受控值经 whPatch 回写）。 */
    function insertTpl(token: string) {
      const ta = document.getElementById("dn-tpl-" + chId) as HTMLTextAreaElement | null;
      if (!ta) {
        whPatch({ template: (ch.template || "") + token });
        return;
      }
      const at =
        ta.selectionStart === null || ta.selectionStart === undefined
          ? ta.value.length
          : ta.selectionStart;
      whPatch({ template: ta.value.slice(0, at) + token + ta.value.slice(at) });
    }

    const authCtl: any[] = [
      <select
        key="auth-select"
        className="dn-set-input dn-set-select"
        value={authValue}
        aria-label={t("whAuth")}
        onChange={function (e: any) {
          whPatch({ auth: e.target.value });
        }}
      >
        <option value="none">{t("whAuthNone")}</option>
        <option value="bearer">{t("whAuthBearer")}</option>
        <option value="basic">{t("whAuthBasic")}</option>
        <option value="header">{t("whAuthHeader")}</option>
      </select>,
    ];
    if (authValue === "bearer") authCtl.push(secretField("token", "whAuthToken"));
    else if (authValue === "basic") {
      authCtl.push(
        <input
          key="username"
          type="text"
          className="dn-set-input dn-set-inputText"
          value={ch.username || ""}
          placeholder={t("whAuthUsername")}
          aria-label={t("whAuthUsername")}
          onChange={function (e: any) {
            whPatch({ username: e.target.value });
          }}
        />,
      );
      authCtl.push(secretField("password", "whAuthPassword"));
    } else if (authValue === "header") {
      authCtl.push(
        <input
          key="headerName"
          type="text"
          className="dn-set-input dn-set-inputText"
          value={ch.headerName || ""}
          placeholder={t("whAuthHeaderName")}
          aria-label={t("whAuthHeaderName")}
          onChange={function (e: any) {
            whPatch({ headerName: e.target.value });
          }}
        />,
      );
      authCtl.push(secretField("headerValue", "whAuthHeaderValue"));
    }

    const textTokens = [
      "{{title}}",
      "{{message}}",
      "{{kind}}",
      "{{severity}}",
      "{{priority}}",
      "{{source}}",
    ];
    const tplChips: any[] = textTokens.map(function (tok: string) {
      return (
        <button
          type="button"
          key={tok}
          className="dn-tpl-chip"
          title={t("whTemplateHint")}
          onClick={function () {
            insertTpl(tok);
          }}
        >
          {tok}
        </button>
      );
    });
    tplChips.push(
      <button
        type="button"
        key="{{ts}}"
        className="dn-tpl-chip is-raw"
        title={"{{ts}} → " + String(Date.now()) + "（数字直出，不加引号）"}
        onClick={function () {
          insertTpl("{{ts}}");
        }}
      >
        {"{{ts}}"}
      </button>,
    );

    return (
      <details
        className={"dn-ch-card" + (ch.enabled ? " dn-ch-onEdge" : " dn-ch-off")}
        key={channelKey + ":" + (ch.enabled === true)}
        open={ch.enabled === true}
      >
        <summary>
          {iconEl("webhook")}
          <span className="dn-ch-name">{ch.name || ch.id}</span>
          <span className="dn-ch-type">webhook</span>
          <span className={"dn-ch-statusDot " + statusDotClass(channelKey)} />
          <span className="dn-ch-statusTxt" title={statusText(channelKey)}>
            {statusText(channelKey)}
          </span>
          {failBadge(channelKey)}
          <span className="dn-ch-summaryRight">
            {switchToggle(
              ch.enabled === true,
              function (v: boolean) {
                whPatch({ enabled: v });
              },
              (ch.enabled ? t("chToggleOff") : t("chToggleOn")) + (ch.name || ch.id),
            )}
          </span>
        </summary>
        <div className="dn-ch-body">
          {chRow(
            t("whPreset"),
            <select
              className="dn-set-input dn-set-select"
              value=""
              aria-label={t("whPreset")}
              onChange={function (e: any) {
                const p = WEBHOOK_PRESETS[e.target.value];
                if (!p) return;
                // preset 落配置（{{priority}} 频道感知映射的依据）；认证与模板随预设填充，URL 不覆盖（防丢已填内容）
                whPatch({ preset: e.target.value, auth: p.auth, template: p.template });
              }}
            >
              <option value="">{t("whPreset")}</option>
              <option value="ntfy">{t("whPresetNtfy")}</option>
              <option value="gotify">{t("whPresetGotify")}</option>
              <option value="custom">{t("whPresetCustom")}</option>
            </select>,
            t("whPresetHint"),
          )}
          {chRow(
            t("chBarkName"),
            textInput(
              ch.name,
              function (v: string) {
                whPatch({ name: v });
              },
              { placeholder: t("chBarkNamePlaceholder"), ariaLabel: t("chBarkName") },
            ),
          )}
          {chRow(
            t("whUrl"),
            textInput(
              ch.url,
              function (v: string) {
                whPatch({ url: v });
              },
              { placeholder: t("whUrlPlaceholder"), ariaLabel: t("whUrl") },
            ),
            t("whUrlHint"),
          )}
          {chRow(t("whAuth"), <span className="dn-authFields">{authCtl}</span>, t("whAuthHint"))}
          {chRow(
            t("whTimeout"),
            numInput(
              ch.timeoutSec,
              function (v: number | undefined) {
                // UI 层先 clamp（1-60）；服务端 normalize 仍权威 clamp（防绕过 UI 的 PUT）
                whPatch({
                  timeoutSec:
                    v === undefined ? undefined : Math.min(60, Math.max(1, Math.round(v))),
                });
              },
              { ariaLabel: t("whTimeout"), min: 1, max: 60 },
            ),
            t("whTimeoutHint"),
          )}
          <div className="dn-ch-row" style={{ display: "block" }}>
            <div className="dn-ch-cap" style={{ marginBottom: "6px" }}>
              {t("whTemplate")}
            </div>
            <textarea
              id={"dn-tpl-" + chId}
              className="dn-tpl"
              spellCheck={false}
              aria-label={t("whTemplate")}
              value={ch.template || ""}
              onChange={function (e: any) {
                whPatch({ template: e.target.value });
              }}
            />
            <div className="dn-tplChips">
              <span className="dn-tplCap">{t("routeCap") + ":"}</span>
              {tplChips}
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={function () {
                  // 恢复为当前预设（ch.preset 由预设下拉落配置；缺省 ntfy 与服务端默认一致）的默认模板
                  const p = WEBHOOK_PRESETS[String(ch.preset || "ntfy")];
                  if (p) whPatch({ template: p.template });
                }}
              >
                {t("whTplRestore")}
              </button>
            </div>
            <span className="dn-ch-hint">{t("whTemplateHint")}</span>
            <span className="dn-ch-hint">{t("whTemplateFailHint")}</span>
          </div>
          <div className="dn-ch-actions">
            {testBtn(channelKey)}
            <button
              type="button"
              className={"dn-set-btn dn-set-btnSmall" + (armed ? " dn-set-btnDanger" : "")}
              onClick={function () {
                if (armed) {
                  chRemove(idx);
                  setDelArmedId(null);
                } else {
                  setDelArmedId(ch.id);
                  setTimeout(function () {
                    setDelArmedId(null);
                  }, 3000);
                }
              }}
            >
              {armed ? t("chDeleteConfirm") : t("chDelete")}
            </button>
          </div>
        </div>
      </details>
    );
  }

  /**
   * 事件/动态 kind 行的路由区（chips 直点形态）：
   * 候选 chips（点亮态真实反映投递面：无条目=defaultRouteIds，有条目=显式快照）
   * + stale 残留 chip（虚线删除线，title 说明）+ 状态标签（跟随默认 / 自定义·N·恢复默认）。
   * 状态标签 custom 态可点击恢复跟随默认；全灭由 routeToggle 自动恢复默认并 toast 反馈
   * 由调用方无感（删除条目即恢复——状态标签随即回到默认态）。
   */
  function routeChipsRow(kind: string) {
    const routes = routeOf(kind);
    const options = routeOptions(settings);
    const litIds = routes === undefined ? defaultRouteIds(settings) : routes.slice();
    const litSet: Record<string, boolean> = {};
    litIds.forEach(function (id: string) {
      litSet[id] = true;
    });
    // stale：条目残留但候选中不存在的频道 id（已删除频道；投递时自动跳过，保存时清理）
    const staleIds = (routes || []).filter(function (id: string) {
      return !options.some(function (o) {
        return o.id === id;
      });
    });
    const chips = options.map(function (o) {
      const on = litSet[o.id] === true;
      // 未启用频道：置灰禁点——投递面 = 启用频道 ∩ 路由，停用频道点亮
      // 也不投递（假点亮）；title 说明「启用后可用」。已勾选未启用项保留勾选
      // 显示（不自动改用户配置），用户启用频道后该 chip 恢复可点/生效。
      return (
        <button
          type="button"
          key={o.id}
          className={"dn-route-chip" + (on ? " is-on" : "") + (o.enabled ? "" : " is-off")}
          aria-pressed={on ? "true" : "false"}
          disabled={!o.enabled}
          title={o.enabled ? undefined : t("routeDisabledHint")}
          onClick={function () {
            routeToggle(kind, o.id, !on);
          }}
        >
          {o.label}
        </button>
      );
    });
    staleIds.forEach(function (id: string) {
      chips.push(
        <span key={"stale-" + id} className="dn-route-chip is-stale" title={t("routeStaleTitle")}>
          {id + " · " + t("routeStaleChip")}
        </span>,
      );
    });
    const isCustom = routes !== undefined;
    chips.push(
      <button
        type="button"
        key="state"
        className={"dn-route-state" + (isCustom ? " is-custom" : "")}
        title={isCustom ? t("routeCustomStateTitle") : t("routeDefaultStateTitle")}
        onClick={function () {
          if (isCustom) routeSetKind(kind, null);
        }}
      >
        {isCustom ? t("routeCustomState", { n: litIds.length }) : t("routeDefaultState")}
      </button>,
    );
    return (
      <div className="dn-evt-routes" key={"routes-" + kind}>
        <span className="dn-evt-routesCap">{t("routeCap")}</span>
        {chips}
      </div>
    );
  }

  // 事件区：内置事件卡（sev 色点 + kind 码 + switch + 路由 chips）
  const eventChildren: any[] = [];
  EVENT_KEYS.forEach(function (kv) {
    const key = kv[0],
      labelKey = kv[1];
    const kindId = EVENT_KIND_MAP[key];
    const sev = KIND_SEV[kindId] || "info";
    eventChildren.push(
      <div className="dn-evt" key={"ev-" + key}>
        <div className="dn-evt-head">
          <span
            className={"dn-sev" + (sev !== "info" ? " dn-sev-" + sev : "")}
            title={"severity: " + sev}
          />
          <span className="dn-evt-name">{t(labelKey)}</span>
          <span className="dn-evt-kind">{kindId}</span>
          {switchControl(key, t("evtSwitch", { name: t(labelKey) }))}
        </div>
        {routeChipsRow(kindId)}
      </div>,
    );
  });
  // 动态 kind（插件提议的通知类型）：待确认 = 允许/拒绝 + 路由提示；已允许 = 同款
  // 路由 chips（动态 kind 也支持配置投递频道——kindRoutes 天然支持动态
  // kind id 作 key，与服务端 resolveRoutes 的 kind 无关路由解析一致）。
  const kindRows: any[] = kindsList.map(function (k: any) {
    const nameText = k.label && k.label !== k.id ? k.label : k.id;
    if (k.confirmed) {
      return (
        <div className="dn-kinds dn-kinds-ok" key={k.id}>
          <div className="dn-kinds-head">
            <span className="dn-sev" />
            <span className="dn-kinds-name">{nameText}</span>
            <span className="dn-evt-kind">{k.id}</span>
            <span className="dn-kinds-actions">
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={function () {
                  confirmOne(k.id, false);
                }}
              >
                {t("kindRevoke")}
              </button>
            </span>
          </div>
          {routeChipsRow(k.id)}
        </div>
      );
    }
    return (
      <div className="dn-kinds" key={k.id}>
        <div className="dn-kinds-head">
          <span className="dn-sev" />
          <span className="dn-kinds-name">{nameText}</span>
          <span className="dn-evt-kind">{k.id}</span>
          <span className="dn-kinds-actions">
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall dn-set-btnPrimary"
              onClick={function () {
                confirmOne(k.id, true);
              }}
            >
              {t("kindAllow")}
            </button>
            <button
              type="button"
              className="dn-set-btn dn-set-btnSmall dn-set-btnGhostDanger"
              onClick={function () {
                confirmOne(k.id, false);
              }}
            >
              {t("kindDeny")}
            </button>
          </span>
        </div>
        <div className="dn-kind-routeHint">{t("kindRouteHint")}</div>
      </div>
    );
  });
  eventChildren.push(
    <div key="kinds">
      <div className="dn-sec" style={{ marginTop: "14px" }}>
        <span className="dn-sec-title">{t("kindsTitle")}</span>
        <span className="dn-sec-hint">{t("kindsHint")}</span>
      </div>
      {kindsList.length === 0 ? <div className="dn-set-note">{t("kindsEmpty")}</div> : kindRows}
    </div>,
  );

  // 能力自检的渲染模型：宿主面（读服务端载荷）+ 浏览器面（读本页事实）合成一次，
  // 下面所有卡片只投影它——JSX 里不再出现任何「这个状态算不算好」的判断。
  const diag = clientDiagnosticsOf(diagnostics, clientFacts(), t);

  // 频道区：`channels` 逐项按类型分派（内置两卡 + bark/webhook 实例卡）+ 添加按钮。
  // 先按**真实下标**遍历再分派：chPatch / chRemove 都按下标操作，先 filter 会让编辑打到隔壁条目。
  const channelsChildren: any[] = [];
  (settings.channels || []).forEach(function (c: any, i: number) {
    if (c.type === "browser" || c.type === "system") {
      channelsChildren.push(builtinCard(i, c, channelLabel(c)));
      return;
    }
    channelsChildren.push(String(c.type) === "webhook" ? webhookCard(c, i) : barkCard(c, i));
  });
  channelsChildren.push(
    <div className="dn-ch-add" key="ch-add">
      <button
        type="button"
        className="dn-set-btn"
        onClick={function () {
          chAdd("bark");
        }}
      >
        {t("chAddBark")}
      </button>
      <button
        type="button"
        className="dn-set-btn dn-set-btnPrimary"
        onClick={function () {
          chAdd("webhook");
        }}
      >
        {t("chAddWebhook")}
      </button>
    </div>,
  );

  // 资源上限折叠区（统一 dn-ch-adv 折叠形态 + dn-adv-row 行）
  const dedupFold = (
    <details className="dn-ch-adv dn-sec-adv" key="adv-params">
      <summary>{t("secDedup")}</summary>
      <div className="dn-ch-adv-body">
        {advRow(
          t("historyRetention"),
          <input
            type="number"
            min={0}
            step={1}
            className="dn-set-input dn-set-numInput"
            aria-label={t("historyRetention")}
            value={settings.historyMaxAgeDays}
            onChange={function (e: any) {
              patch({ historyMaxAgeDays: Number(e.target.value) });
            }}
          />,
        )}
        {advRow(
          t("maxConnections"),
          <input
            type="number"
            min={1}
            max={1024}
            step={1}
            className="dn-set-input dn-set-numInput"
            aria-label={t("maxConnections")}
            value={settings.maxConnections}
            onChange={function (e: any) {
              // 空串→undefined→diff 键被序列化丢弃→不提交保持原值；
              // 非空软 clamp（1-1024）防 0→400 保存死锁（服务端 normalize 仍权威）
              patch({
                maxConnections: clampMaxConnections(
                  e.target.value === "" ? undefined : Number(e.target.value),
                ),
              });
            }}
          />,
        )}
      </div>
    </details>
  );

  const qh = settings.quietHours || {};
  const allows = qh.allowKinds || [];
  function setAllowKinds(next: string[]) {
    patch({ quietHours: Object.assign({}, qh, { allowKinds: next }) });
  }
  /** 跟随已启用事件：一键把当前 notifyXxx=true 的对应 kind 全选为豁免（函数式更新读最新
   *  快照，避免连点/同帧先改开关后旧闭包漏勾最新态）。
   *  必须走 patch 而不是裸 setSettings：patch 在 updater 内同步 settingsRef.current，而
   *  diffPayload() 读的正是那个 ref——绕过它这次改动就进不了 diff，用户在未做其它编辑时
   *  点保存会看到「未修改」，改动被静默丢弃。 */
  function allowFollowEnabled() {
    patch(function (prev: any) {
      const nextQh = prev.quietHours || {};
      const next = EVENT_KEYS.filter(function (kv) {
        return prev[kv[0]] === true;
      }).map(function (kv) {
        return EVENT_KIND_MAP[kv[0]];
      });
      return Object.assign({}, prev, {
        quietHours: Object.assign({}, nextQh, { allowKinds: next }),
      });
    });
  }
  /** 恢复默认豁免（ask/question/error——高频阻塞型，卡着的任务需要叫醒）。 */
  function allowResetDefault() {
    setAllowKinds(["ask", "question", "error"]);
  }
  // 免打扰豁免候选（覆盖全部 6 个内置事件 kind，label 复用事件文案
  // KIND_KEYS 字典；由 EVENT_KEYS + EVENT_KIND_MAP 派生，不新建平行表。
  // chips 直点形态——未启用事件弱化沿用 dn-set-allowDim 锚点，勾选态保留照常
  // 写入（服务端判定只看 quietHours.allowKinds.includes(kind)，不看开关）。
  const quietAllowChoices = EVENT_KEYS.map(function (kv) {
    const notifyKey = kv[0];
    const kind = EVENT_KIND_MAP[notifyKey];
    const enabled = settings[notifyKey] === true;
    return {
      kind: kind,
      notifyKey: notifyKey,
      enabled: enabled,
      labelKey: KIND_KEYS[kind] || "k" + kind,
    };
  });
  const allowChips = quietAllowChoices.map(function (c) {
    const checked = allows.indexOf(c.kind) !== -1;
    // 未启用事件：置灰禁点——事件开关关闭则不产生通知，豁免勾选无意义；
    // 保留已勾选显示（不自动改配置），启用事件后恢复可点。禁点用原生 disabled。
    return (
      <button
        type="button"
        key={c.kind}
        className={
          "dn-route-chip" + (checked ? " is-on" : "") + (c.enabled ? "" : " dn-set-allowDim")
        }
        aria-pressed={checked ? "true" : "false"}
        disabled={!c.enabled}
        title={c.enabled ? undefined : t("allowDisabledHint")}
        onClick={function () {
          const next = allows.slice();
          if (!checked && next.indexOf(c.kind) === -1) next.push(c.kind);
          else if (checked && next.indexOf(c.kind) !== -1) next.splice(next.indexOf(c.kind), 1);
          setAllowKinds(next);
        }}
      >
        {t(c.labelKey)}
        {c.enabled ? null : <span className="dn-set-allowHint">{t("allowDisabledHint")}</span>}
      </button>
    );
  });
  // 免打扰卡（开关 + 时段 + 豁免 chips + 快捷按钮）
  const dndCard = (
    <div className="dn-dnd" key="dnd">
      <div className="dn-dnd-head">
        <span className="dn-sev dn-sev-warning" />
        <span className="dn-evt-name">{t("dndEnable")}</span>
        {switchToggle(
          qh.enabled === true,
          function (v: boolean) {
            patch({ quietHours: Object.assign({}, qh, { enabled: v }) });
          },
          t("dndEnable"),
        )}
      </div>
      {qh.enabled === true ? (
        <div>
          <div className="dn-dnd-row">
            <span className="dn-dnd-cap">{t("dndStart")}</span>
            <input
              type="time"
              className="dn-set-input"
              aria-label={t("dndStart")}
              value={qh.start || "22:00"}
              onChange={function (e: any) {
                patch({ quietHours: Object.assign({}, qh, { start: e.target.value }) });
              }}
            />
            <span className="dn-dnd-cap">{t("dndEnd")}</span>
            <input
              type="time"
              className="dn-set-input"
              aria-label={t("dndEnd")}
              value={qh.end || "08:00"}
              onChange={function (e: any) {
                patch({ quietHours: Object.assign({}, qh, { end: e.target.value }) });
              }}
            />
          </div>
          <div className="dn-dnd-row" style={{ display: "block" }}>
            <span className="dn-dnd-cap">{t("dndStillLabel") + "："}</span>
            <div className="dn-set-allows">{allowChips}</div>
            <div className="dn-set-allowActions">
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={allowFollowEnabled}
              >
                {t("allowFollowEnabled")}
              </button>
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={allowResetDefault}
              >
                {t("allowResetDefault")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  // 三端降级文案（浏览器通知权限状态行已移入「浏览器通知」频道卡，
  // 这里只保留服务不可用 / 非安全上下文 / 平台不支持三条全局降级说明）
  const degradation: any[] = [];
  if (metaValue && metaValue.writable === false) {
    degradation.push(
      <div className="dn-set-note" key="settings-unavailable">
        {t("settingsSvcDown")}
      </div>,
    );
  }
  if ("Notification" in window) {
    if (!isSecureContext()) {
      degradation.push(
        <div className="dn-set-note" key="insecure">
          {t("httpDegraded")}
        </div>,
      );
    }
  } else {
    degradation.push(
      <div className="dn-set-note" key="noapi">
        {t("iosUnsupported")}
      </div>,
    );
  }

  /**
   * 逐出口投递明细：状态标签 + 主理由 + 宿主原文（原文折叠，并标注它的来源）。
   * 数据本来就随 `/history` 到了客户端（`archive(..., { channels })`），此前只是没人渲染——
   * 「投递成功却没声音」这类结论因此完全不可见，状态行在 `skipped` 后还不会变。
   */
  function deliveryLines(r: { channels?: unknown }) {
    const list: unknown[] = Array.isArray(r.channels) ? r.channels : [];
    const views: DeliveryView[] = [];
    list.forEach(function (delivery: unknown) {
      const view = deliveryViewOf(delivery, t);
      if (view) views.push(view);
    });
    if (views.length === 0) return null;
    return (
      <div className="dn-set-historyChannels">
        {views.map(function (view, j: number) {
          return (
            <div
              className={"dn-ch-delivery dn-ch-delivery-" + view.status}
              key={view.channelId + "-" + j}
            >
              <span className="dn-ch-deliveryName">{view.channelId}</span>
              <span className="dn-ch-deliveryStatus">{view.statusText}</span>
              {view.reason ? <span className="dn-ch-deliveryReason">{view.reason}</span> : null}
              {view.detail ? (
                <details className="dn-ch-reasonRaw">
                  <summary>{t("reasonDetailLabel")}</summary>
                  <div className="dn-ch-reasonRawText">{view.detail}</div>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  // 通知记录 tab（历史独立成 tab；清理/发送测试/刷新并排工具行；
  // 请求权限按钮随权限状态行一起归入「浏览器通知」频道卡）
  const historyPane = (
    <div key="history">
      <div className="dn-set-historyTools">
        <button
          type="button"
          className={"dn-set-btn dn-set-btnSmall" + (clearArmedValue ? " dn-set-btnDanger" : "")}
          onClick={confirmClear}
        >
          {clearArmedValue ? t("clearConfirm") : t("clearLabel")}
        </button>
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            sendTest();
          }}
        >
          {t("sendTest")}
        </button>
        <button
          type="button"
          className="dn-set-btn dn-set-btnSmall"
          onClick={function () {
            loadHistory({ value: true });
          }}
        >
          {t("refresh")}
        </button>
        <span className="dn-set-historyCount">{t("historyTitle")}</span>
      </div>
      {!history || history.length === 0 ? (
        <div className="dn-set-note">{t("historyEmpty")}</div>
      ) : (
        <ul className="dn-set-history">
          {history.map(function (r: any, i: number) {
            const d = new Date(r.ts);
            const pad = function (n: number) {
              return n < 10 ? "0" + n : String(n);
            };
            const time = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
            const sev = KIND_SEV[r.kind] || "info";
            return (
              <li className="dn-set-historyItem" key={String(r.ts) + "-" + i}>
                <span
                  className={"dn-sev" + (sev !== "info" ? " dn-sev-" + sev : "")}
                  title={"severity: " + sev}
                />
                <div className="dn-set-historyMain">
                  <div className="dn-set-historyHead">
                    <span className="dn-set-historyKind">
                      {KIND_KEYS[r.kind] !== undefined ? t(KIND_KEYS[r.kind]) : r.kind}
                    </span>
                    <span className="dn-set-historyTime">{time}</span>
                    {r.suppressed === "quiet" ? (
                      <span className="dn-set-historySuppressed">{t("historySuppressed")}</span>
                    ) : null}
                  </div>
                  <div className="dn-set-historyText">{r.title + "：" + r.message}</div>
                  {deliveryLines(r)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  // ---- 卡内三 tab（通知事件 / 通知频道 / 通知记录）----

  // 待确认动态 kind 计数（「通知事件」tab 徽标——确认流是安全设计，不可被 tab 埋没）
  const pendingKinds = kindsList.filter(function (k: any) {
    return !k.confirmed;
  }).length;

  // tab 栏：三个普通 button（不引入 role=tablist 管理成本）
  const tabbar = (
    <div className="dn-set-tabs">
      <button
        type="button"
        className={"dn-set-tab" + (activeTab === "events" ? " dn-set-tabActive" : "")}
        onClick={function () {
          setActiveTab("events");
        }}
      >
        {t("secEvents")}
        {pendingKinds > 0 ? <span className="dn-set-tabBadge">{String(pendingKinds)}</span> : null}
      </button>
      <button
        type="button"
        className={"dn-set-tab" + (activeTab === "channels" ? " dn-set-tabActive" : "")}
        onClick={function () {
          setActiveTab("channels");
        }}
      >
        {t("secChannels")}
      </button>
      <button
        type="button"
        className={"dn-set-tab" + (activeTab === "history" ? " dn-set-tabActive" : "")}
        onClick={function () {
          setActiveTab("history");
        }}
      >
        {t("secHistory")}
      </button>
    </div>
  );

  // 事件 tab 内容（历史移出，事件页聚焦事件路由与确认流）
  const eventsPane = [eventChildren, dedupFold, dndCard];
  // 频道 tab 内容：频道卡组（内置 + Bark + Webhook）+ 添加按钮 + 域保存行。
  // 域保存：频道 tab 底部「保存频道」只提交 channels
  // 键——与 foot 全量保存语义不同（域 vs 全量），不构成此前移除的「双份全量
  // 保存」视觉重复；当初预留的「域级拆分后按域重排按钮位置」由本行兑现。
  const channelsDomainSave = (
    <div className="dn-ch-domainSave" key="ch-domain-save">
      <span className="dn-ch-domainSaveHint">{t("channelsDomainHint")}</span>
      <button
        type="button"
        className="dn-set-btn dn-set-btnPrimary dn-set-save"
        disabled={saving}
        onClick={function () {
          saveFor("channels");
        }}
      >
        {saving ? t("saving") : t("saveChannels")}
      </button>
    </div>
  );
  const channelsPane = [channelsChildren, channelsDomainSave];

  // 去掉设置卡 title/副标题；顶部直接是 tab 栏。
  // 底部保存栏 = 脏状态指示（diffSettingsPayload 键数）+ 放弃更改 + 保存。
  // foot 显示全量脏计数（含频道域）；「保存频道」按钮的域脏态不做单独
  // 计数——无频道域脏时点击走空 diff 的「未修改」提示（与 foot 保存同交互语义）。
  const dirtyCount = Object.keys(diffPayload()).length;
  return (
    <li className="dn-set-card">
      {tabbar}
      <div className="dn-set-body">
        {activeTab === "events"
          ? eventsPane
          : activeTab === "channels"
            ? channelsPane
            : historyPane}
        <div className="dn-set-notes">{degradation}</div>
        {/* 409 冲突双动作横幅（非模态：横幅期间可继续编辑；动作触发时
              实时重算本地变更）。「忽略」= 关闭横幅、草稿保留原样。 */}
        {conflict ? (
          <div className="dn-conflict" role="alert">
            <span className="dn-conflictText">
              {t(conflict.entry === "channels" ? "conflictChannels" : "conflictTitle")}
            </span>
            <span className="dn-conflictActions">
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={resolveConflictLoadLatest}
              >
                {t("conflictLoadLatest")}
              </button>
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall dn-set-save"
                disabled={saving}
                onClick={resolveConflictOverwrite}
              >
                {t("conflictOverwrite")}
              </button>
              <button
                type="button"
                className="dn-set-btn dn-set-btnSmall"
                onClick={function () {
                  setConflict(null);
                }}
              >
                {t("conflictIgnore")}
              </button>
            </span>
          </div>
        ) : null}
        <div className="dn-set-foot">
          {saved ? (
            <span className={saved.err ? "dn-set-error" : "dn-set-saved"}>{saved.msg}</span>
          ) : dirtyCount > 0 ? (
            <span className="dn-dirty">{t("dirtySome", { n: dirtyCount })}</span>
          ) : null}
          <span className="dn-spacer" />
          {/* 保存中（guard 在途）禁用「放弃更改」与「保存」——防提交窗口内矛盾操作
                （放弃被在途成功回调覆盖基线）与连点重复 PUT；按钮文案切换「保存中…」。 */}
          <button
            type="button"
            className="dn-set-btn dn-set-btnSmall"
            disabled={saving}
            onClick={discardChanges}
          >
            {t("discardChanges")}
          </button>
          <button
            type="button"
            className="dn-set-save"
            disabled={saving}
            onClick={function () {
              saveFor("all");
            }}
          >
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </li>
  );
}

// ------------------------------------------------------------ 装配

export function apply(ctx: any) {
  try {
    ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });

    // i18n：注册本插件字典；t 绑定官方 locale 服务（未装配回落 key 本体）。
    const locale: any = ctx.get("locale");
    // 订阅取消函数供 disposer 卸载调用（守卫对齐 provider-usage/
    // mcp-manager 的 undefined 形态——不预设 subscribe 返回 null，防其返回
    // null 时 null 初始化遮蔽导致守卫失效），防重复 apply 后旧订阅持续重绑
    // 已停用实例。
    let unsubLocale: (() => void) | undefined;
    if (locale && typeof locale.register === "function") {
      try {
        locale.register(NS, { zh: zh, en: en });
        // 宿主 bind 出的签名以本包字典键为参数，比端口声明的 string 更窄——收口在适配这一处
        bindTranslate(locale.bind(NS) as Translate);
        if (typeof locale.subscribe === "function" && typeof locale.getSnapshot === "function") {
          unsubLocale = locale.subscribe(function () {
            try {
              bindTranslate(locale.bind(NS) as Translate);
            } catch {
              /* 忽略 */
            }
          });
        }
      } catch (e) {
        console.warn("[dsh-notifier] locale 注册失败：", e);
      }
    }

    // 通知半区（SSE / 浏览器通知）：不依赖任何插件 DOM，直接启动
    const session = startNotifySession(
      {
        url: ROUTES.events,
        createSource: (url) => new EventSource(url) as unknown as EventSourceLike,
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (handle) => {
          window.clearTimeout(handle);
        },
        warn: (message, cause) => {
          console.warn("[dsh-notifier] " + message + "：", cause);
        },
      },
      handleNotifyFrame,
    );
    eventsHandle.current = session;
    // 页面重新可见时：还原标题 + 强制重建 SSE（iOS 后台挂起后连接可能已失效，
    // 重建自动带 since 补拉，避免断线窗口漏通知）。
    // 具名 handler 在 apply 内注册、disposer 移除（对齐 mcp-manager
    // onVisible 范式）——匿名模块体注册无卸载路径，重复 apply/热更会累积旧监听。
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        titleFlasher.restore();
        eventsHandle.current?.reconnect();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    // 首次任意点击解锁音频（浏览器自动播放策略要求手势）。具名 + disposer 摘除：
    // 从未点击就被卸载时，匿名监听会永久留在 document 上，且下次点击会在插件已卸载后
    // 构造一个 AudioContext。
    function onFirstClick() {
      audioEngine.unlock();
      document.removeEventListener("click", onFirstClick, { capture: true });
    }
    document.addEventListener("click", onFirstClick, { capture: true });

    // 设置面板独立 tab「通知中心」（settings.section）。
    // 参照 dsh-provider-usage「用量统计」tab 的接线（slots.inject + register，
    // 独立顶层页）；label 为导航显示文本。旧运行时若不声明该插槽，inject
    // 回调不执行 → tab 不挂载、通知半区照常工作（与 provider-usage 同语义，
    // 不做 plugin.item 双插槽重复展示）。
    const slots = ctx.get("slots");
    if (slots && typeof slots.inject === "function") {
      slots.inject("settings.section", function () {
        return slots.register(
          // label 传 thunk：宿主 nav rows 每次读取经 resolveSlotLabel
          // 求值 + shell 订阅 locale 重渲染，切语言即跟随（注册期求值字符串快照是旧行为）。
          // t 走 client/locale.ts 的当前绑定（locale.subscribe 回调重绑），thunk 保持最小
          // t(key) 形态、不包任何可能抛错的逻辑（thunk 抛错会炸宿主 nav 渲染）。
          {
            name: "settings.section",
            id: "dsh-notifier",
            order: 70,
            label: () => t("tabLabel"),
            locale: NS,
          },
          function () {
            return <SettingsCard />;
          },
        );
      });
    } else {
      console.warn("[dsh-notifier] 缺少 slots 服务，设置 tab 未挂载（通知半区照常工作）");
    }

    // ⚠️ 清理必须写在 ctx.effect 返回的 disposer 里。
    ctx.effect(function () {
      return function () {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        // 标题恢复原本只由 visibilitychange 回前台触发；disposer 摘除监听后该路径关闭，
        // 若残留恢复缓存则标题永久卡在「🔔 …」（复现路径：hidden 帧 → 卸载）。
        titleFlasher.restore();
        if (unsubLocale !== undefined) {
          unsubLocale();
          unsubLocale = undefined;
        }
        session.close();
        // 只在仍指向自己的会话时才清空：重复 apply 时后装的实例才是当前句柄，
        // 无条件置 null 会让存活实例的回前台重连静默失效（跨实例串味）。
        if (eventsHandle.current === session) eventsHandle.current = null;
        document.removeEventListener("click", onFirstClick, { capture: true });
        closeAllNotifications();
        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();
      };
    }, "dsh-notifier");
  } catch (error) {
    console.warn("[dsh-notifier] 挂载失败：", error);
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals）----
// 设置卡片是 React 组件（settings.section 独立 tab 插槽由宿主 React 渲染）；通知半区
// 不依赖任何 DOM，slot 缺失时照常工作。
export const inject: string[] = ["slots", "locale"];
