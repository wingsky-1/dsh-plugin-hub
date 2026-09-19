/**
 * dsh-notifier — 浏览器端（自包含）。
 *
 * 行为：
 * - 在「设置」面板注册独立 tab「通知中心」（settings.section 插槽：参照
 *   provider-usage「用量统计」tab；不做 plugin.item 双插槽重复展示——入口只有这一个）；
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
import { closeNotificationsOf, trackNotification } from "./notify/registry.ts";
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
// 能力自检面的投影（宿主面归一化 + 浏览器面判定）收在同一处：判定与文案必须同源，
// 两处各写一遍就等于把「未知不该被渲染成可用」这条口径分叉。
import { clientDiagnosticsOf } from "./capabilities.ts";
import type { ClientFacts } from "./capabilities.ts";
// 页面内即时反馈（横幅 / 短提示）：非安全上下文下唯一的降级提醒通道。
import { showBanner, toast } from "./notify/display.ts";
// 设置草稿的纯逻辑与保存串行 guard：零 React 零 DOM，可被 node 直接 import——它们决定
// 「保存什么」，因此必须是可判据的面（原先挂在公开 apply 上，实测零消费者）。
import {
  assignChannelFields,
  diffSettingsPayload,
  domainPayload,
  rebaseSettings,
} from "./settings/diff.ts";
import { createSaveGuard } from "./settings/save-guard.ts";
// 一次失败请求的结构化结论（是否围栏拒答 / 引导文案 / 展示正文）与结构化字段挂载：
// 判定顺序是两端契约（结构化优先、状态码与文案兜底），故收在纯函数模块里由单测直接打红。
import { apiFailureOf, markHttpFailure } from "./api-error.ts";
import type { HttpFailure } from "./api-error.ts";
// 设置卡的渲染原子层：普通函数返回 JSX，依赖（t / statusMap / patch / sendTest / 平台 / 诊断
// 视图）一律显式传参——原子层不读卡片状态，搬家不会让闭包静默捕获到旧 state。
import { channelsPane } from "./settings/panes/channels.tsx";
import { eventsPane } from "./settings/panes/events.tsx";
import { historyPane } from "./settings/panes/history.tsx";
import type { ChannelStatusMap } from "./settings/parts/status.tsx";
import type {
  ClearHistoryResult,
  ConflictLatest,
  ConfigSnapshot,
  HistoryRecordView,
  MetaView,
  PostKindResult,
  PutResult,
  RegisteredKindView,
  SendTestResult,
  SettingsChannelView,
  SettingsPatch,
  SettingsView,
} from "./settings/types.ts";
// 两端共享面 src/shared/interface.ts：音色白名单、通知类型表、频道 id 归一化、webhook 预设
// （模板 / 认证白名单）与理由 code 的事实源都在这里，客户端只消费，不再各写一份副本——跨端
// 漂移的症状是「设置页选得到、宿主拒收」与「勾了频道却收不到」。该目录的模块必须零 import
// （或同目录相对），判据见 scripts/test/shared-leaf-imports.test.ts。
import {
  KIND_SEVERITY,
  channelIdOf,
  createDisposerStack,
  isBuiltinKind,
} from "../shared/interface.ts";
import type { NotifySeverity } from "../shared/interface.ts";
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

/**
 * kind → 展示强度（severity）css 修饰符（事件行/历史行色点）。事实源在 src/shared/kinds.ts
 * （两端共享面），与宿主端定稿读同一张表。
 *
 * 未知 kind（外部注册）回落 info：收口前是 `KIND_SEV[kind] || "info"`，而那张表的键集
 * 恰好等于内置 kind 全集，故「是内置 kind 就查表、否则 info」与它是同一条判据。
 */
function severityOf(kind: string): NotifySeverity {
  return isBuiltinKind(kind) ? KIND_SEVERITY[kind] : "info";
}

/**
 * 请求浏览器通知权限（必须在用户手势内调用，Chrome 才接受）。
 * 完成后回调（无论结果），用于刷新卡片权限状态。
 */
function requestPermission(onDone?: () => void) {
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
 * @param owner 页面级单例（已弹通知 / 标题闪烁 / <style>）的归属令牌：热更或重复 apply 时，
 *   后装实例的清理不许动先前实例登记的资源。
 */
function showNotification(
  kind: string,
  title: string,
  message: string,
  opts: { sound?: unknown; playOnly?: boolean },
  owner: object,
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
        // 本行的判据是已登记的缺口而不是遗漏：happy-dom 的 BrowserWindow.focus() 是 TODO
        // 空实现（不派发事件、无任何可观测副作用），而本仓测试纪律禁用 vi.spyOn，故「点击
        // 通知会把窗口拉到前台」在当前夹具下写不出可打红的判据。变可测的条件是把这里抽成
        // 接收 window 端口的纯函数，由假件记录调用。
        window.focus();
        notification.close();
      };
      trackNotification(notification, owner);
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
  else if (fallback === "title") titleFlasher.flash(title, owner);
  if (policy.selfPlay && audioEngine.gate()) audioEngine.playTone(policy.tone);
}

function handleNotifyFrame(payload: Record<string, unknown>, owner: object) {
  // 帧字段按展示契约收窄：SSE 载荷恒为服务端序列化的通知帧；缺失回落空串（标签拼装恒有
  // 定义，不把 "undefined" 拼进 tag）。判定字段（whenVisible/playOnly/sound）保持 unknown
  // 原样交判定侧（frameAccepted/soundPolicyOf 本就按 unknown 解释）。
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  const title = typeof payload.title === "string" ? payload.title : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  // 测试通知无条件提醒；其余帧在页面可见时不打扰，除非帧自带 whenVisible——判定见 notify/policy.ts
  if (
    !frameAccepted({
      kind: kind,
      whenVisible: payload.whenVisible,
      playOnly: payload.playOnly,
      visibility: document.visibilityState,
    })
  ) {
    return;
  }
  showNotification(
    kind,
    title,
    message,
    {
      sound: payload.sound,
      playOnly: payload.playOnly === true,
    },
    owner,
  );
}

// ------------------------------------------------------------ SSE 半区

/**
 * 当前会话句柄。用一个 const 容器而不是模块级 let：容器本身不变，变的是它指向的会话——
 * 也让「谁该把它清空」这件事有身份可比（disposer 只在仍指向自己的会话时才清）。
 */
const eventsHandle: { current: NotifySession | null } = { current: null };

// ------------------------------------------------------------ 设置卡片

/**
 * 非 2xx 一律抛错，并把结构化字段挂到 Error 上（判定侧读它，见 api-error.ts）。
 *
 * 读路径此前完全不看 `r.ok`：403 的围栏体（`{error, code, status}`）被当数据用——历史读成空数组、
 * 诊断面把拒答体当自检载荷。`body` 传的是已解析的响应体，围栏体的 code/status 才挂得上。
 * 抛错不是给用户看的（各调用点的 catch 决定降级），是为了让「非 2xx」不再伪装成一份空数据。
 */
function assertOk(r: Response, body: unknown): void {
  if (!r.ok) throw markHttpFailure(new Error("HTTP " + r.status), r.status, body);
}

/** 加载 GET /config 包装体 → 结构化 {user, revision, effective, writable}。 */
function fetchConfig(): Promise<ConfigSnapshot> {
  return fetch(ROUTES.config, { headers: { accept: "application/json" } }).then(function (
    r: Response,
  ) {
    return r.json().then(function (body: ConfigSnapshot) {
      if (!r.ok) {
        const nested = body.error;
        const detail =
          typeof nested === "object" && nested !== null
            ? nested.details || nested.error
            : undefined;
        throw markHttpFailure(new Error(detail || "HTTP " + r.status), r.status, body);
      }
      return body;
    });
  });
}

/** 拉取最近历史记录（最近 10 条，倒序）。 */
function fetchHistory(): Promise<HistoryRecordView[]> {
  return fetch(ROUTES.history, { headers: { accept: "application/json" } }).then(function (
    r: Response,
  ) {
    return r.json().then(function (body: { records?: unknown }) {
      assertOk(r, body);
      const records: unknown = body.records;
      return (Array.isArray(records) ? records : []).slice(-10).reverse() as HistoryRecordView[];
    });
  });
}

/** 拉取频道投递状态（per-channel 最近投递终态）。
 *  失败向上抛（调用方决定保留旧态而非清空状态行）。 */
function fetchStatus(): Promise<ChannelStatusMap> {
  return fetch(ROUTES.status, { headers: { accept: "application/json" } }).then(function (
    r: Response,
  ) {
    return r.json().then(function (body: { channels?: unknown }) {
      assertOk(r, body);
      const channels: unknown = body.channels;
      return (
        typeof channels === "object" && channels !== null ? channels : {}
      ) as ChannelStatusMap;
    });
  });
}

/**
 * 拉取动态 kind 清单（注册表 + 确认态）。
 *
 * 失败一律回落空清单（调用点的既有降级：清单区显示「暂无」），故这里自己吞掉 `assertOk` 抛出的
 * 错误——判据仍在（非 2xx 的 body 不再被当清单读），只是不给用户报错。
 */
function fetchKinds(): Promise<RegisteredKindView[]> {
  return fetch(ROUTES.kinds, { headers: { accept: "application/json" } })
    .then(function (r: Response) {
      return r.json().then(function (body: { kinds?: unknown }) {
        assertOk(r, body);
        const kinds: unknown = body.kinds;
        return (Array.isArray(kinds) ? kinds : []) as RegisteredKindView[];
      });
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
    .then(function (r: Response) {
      return r.json().then(function (body: { platform?: unknown }) {
        assertOk(r, body);
        return typeof body.platform === "string" ? body.platform : null;
      });
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
      return r.json().then(function (body: unknown) {
        assertOk(r, body);
        return body;
      });
    })
    .finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
}

/** 动态 kind 确认（POST /kinds {kind, confirmed}）。 */
function postKind(kind: string, confirmed: boolean): Promise<PostKindResult> {
  return fetch(ROUTES.kinds, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: kind, confirmed: confirmed }),
  }).then(function (r: Response) {
    return r.json().then(function (body: PostKindResult) {
      if (!r.ok) {
        const nested = body.error;
        const detail =
          typeof nested === "object" && nested !== null
            ? nested.details || nested.error
            : undefined;
        throw markHttpFailure(new Error(detail || "HTTP " + r.status), r.status, body);
      }
      return body;
    });
  });
}

/** 测试通知（channelId 可选——per-channel 测试，收敛到 service 管线）。 */
function sendTestReq(channelId?: string): Promise<SendTestResult> {
  return fetch(ROUTES.test, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(channelId ? { channelId: channelId } : {}),
  }).then(function (r: Response) {
    return r.json().then(function (body: SendTestResult) {
      if (!r.ok) {
        const nested = body.error;
        const detail =
          typeof nested === "object" && nested !== null
            ? nested.details || nested.error
            : undefined;
        // 围栏拒绝体的 error 是裸字符串；403 的 https 引导改由结构化 code/status 判定，
        // 文案里的状态码只作旧宿主的兜底（见 api-error.ts），故两者都挂上。
        throw markHttpFailure(new Error(detail || "HTTP " + r.status), r.status, body);
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
  // 设置草稿：形状是服务端 settings 对象，客户端只读其中几个键（真正的形状声明在宿主侧）。
  // 声明成 Record 而不是让 useState(null) 推成 null：否则每次读键都要靠调用方把值当 any 传进来。
  const draft = useState(null as SettingsView | null);
  const settings = draft[0];
  const setSettings = draft[1];
  // 声明形状而不是让 useState(null) 推成 null：读侧只取 writable，但写成 never 的话
  // 任何一次读取都要靠调用方把值当 any 传进来才编得过（就是本行原先的形态）。
  const meta = useState(null as MetaView | null);
  const metaValue = meta[0];
  const setMeta = meta[1];
  // 保存反馈（i18n 重构：msg + err 结构化状态，不能用文案内容判断错误态）
  const savedDraft = useState(null as { msg: string; err: boolean } | null);
  const saved = savedDraft[0];
  const setSaved = function (msg: string, err?: boolean) {
    savedDraft[1](msg ? { msg: msg, err: err === true } : null);
  };
  const historyDraft = useState(null as HistoryRecordView[] | null);
  const history = historyDraft[0];
  const setHistory = historyDraft[1];
  const clearArmed = useState(false);
  const clearArmedValue = clearArmed[0];
  const setClearArmed = clearArmed[1];
  // 频道投递状态（/status channels map，键=bark:<id>）/ 动态 kind 清单（/kinds）
  const statusDraft = useState({} as ChannelStatusMap);
  const statusMap = statusDraft[0];
  const setStatusMap = statusDraft[1];
  const kindsDraft = useState([] as RegisteredKindView[]);
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
  const baselineRef = ReactHooks.useRef(null as SettingsView | null);
  // settings / meta（revision）ref 收口——异步回调（保存成功 / trailing 补发）
  // 一律读 ref 而非渲染闭包值，杜绝「连点第二个 PUT 带旧 revision」「补发漏提交在途
  // 新编辑」两类陈旧闭包问题。settingsRef 由 patch（唯一写入口）在 updater 内同步。
  const settingsRef = ReactHooks.useRef(null as SettingsView | null);
  const metaRef = ReactHooks.useRef(null as MetaView | null);
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
  const conflictDraft = useState(null as null | { entry: string; latest: ConflictLatest });
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
      .then(function (map) {
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
      .then(function (list) {
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
      .then(function (v) {
        if (!alive.value) return;
        // 服务端快照收成客户端视图（HTTP 边界断言，字段形态见 settings/types.ts）。
        const effective = ((v && v.effective) || {}) as SettingsView;
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
      .catch(function (e: unknown) {
        if (!alive.value) return;
        const failure = apiFailureOf(e, t);
        setSaved(t("loadFail", { msg: failure.message, hint: failure.hint }), true);
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
  function patch(p: SettingsPatch) {
    setSettings(function (prev) {
      const cur: SettingsView = prev === null ? {} : prev;
      const next = typeof p === "function" ? p(cur) : Object.assign({}, cur, p);
      settingsRef.current = next;
      return next;
    });
    setSaved("");
  }

  /** 整体替换 settings：已知完整 next 时同步写 settingsRef 再
   *  setState——调用方（loadCard / 冲突恢复 rebase / 静默刷新）随后可能立即
   *  读 ref（如覆盖重提 saveFor），不能等 updater 异步执行。事件级增量编辑
   *  仍走 patch（updater 内写 ref，天然与 state 计算同步）。 */
  function commitSettings(next: SettingsView) {
    settingsRef.current = next;
    setSettings(next);
    setSaved("");
  }

  /** 基线 diff：只提交与加载基线不同的键（防组合层 base 被默认值回写覆盖）。
   *  逻辑收敛在模块级纯函数 diffSettingsPayload（供测试直测）。
   *  读 settingsRef（非渲染闭包 settings）——trailing 补发在 .then 回调里
   *  触发，必须取最新草稿；渲染期调用时 ref 与 state 同值，无行为差异。 */
  function diffPayload(): Record<string, unknown> {
    // 两个来源都可能是 null（配置还没读回来）：空草稿与 null 在 diffSettingsPayload 里同样是
    // 「没有可提交的键」（它只遍历自有键），故显式给 {} 让类型与运行期取值一致。
    return diffSettingsPayload(settingsRef.current || settings || {}, baselineRef.current);
  }

  /** 409 冲突恢复：拉最新 → 无脏静默刷新 / 有脏弹双动作横幅。 */
  function handleConflict(entry: string) {
    fetchConfig()
      .then(function (v) {
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
  function applyLatestQuiet(latest: ConflictLatest) {
    const fresh = Object.assign({}, latest.effective) as SettingsView;
    commitSettings(fresh);
    baselineRef.current = Object.assign({}, fresh);
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
  function putAndCommit(payload: Record<string, unknown>, entry: string) {
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
      .then(function (r: Response) {
        return r.json().then(function (body: PutResult) {
          if (!r.ok) {
            const nested = body.error;
            const detail =
              typeof nested === "object" && nested !== null
                ? nested.details || nested.error
                : undefined;
            // 挂 code 供 catch 按契约分流：409 判定优先
            // err.code === "SETTINGS_CONFLICT"，不再依赖错误文案中文匹配
            // （文案是本地化/可改的，code 是契约字段）。文案保留进 message。
            // markHttpFailure 两种形状都取：SETTINGS_CONFLICT 在 `body.error.code`，
            // 围栏拒答的 code 与 error 平铺（它同时补上 status，供失败判定用）。
            const code = typeof nested === "object" && nested !== null ? nested.code : undefined;
            throw markHttpFailure(new Error(detail || code || "HTTP " + r.status), r.status, body);
          }
          return body;
        });
      })
      .then(function (body: PutResult) {
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
      .catch(function (e: unknown) {
        const failure = apiFailureOf(e, t);
        const errCode = e instanceof Error ? (e as HttpFailure).code : undefined;
        // 409 判定：code 契约优先，中文文案仅作旧服务端回退
        if (errCode === "SETTINGS_CONFLICT" || failure.message.indexOf("版本冲突") >= 0) {
          // 版本冲突：进入双动作恢复（不再仅提示手动关闭重开）
          handleConflict(entry);
          return;
        }
        // AbortError（15s 超时兜底）：服务端可能已写入也可能未写入——提示重试，
        // 用户重试时 revision 若已推进会自然走 409 恢复流程，语义自洽。
        if (e instanceof Error && e.name === "AbortError") {
          setSaved(t("saveTimeout"), true);
          return;
        }
        setSaved(t("saveFail", { msg: failure.message }), true);
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
  function diffPayloadFor(entry: string): Record<string, unknown> {
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
    let payload: Record<string, unknown>;
    try {
      payload = diffPayloadFor(entry);
    } catch (error) {
      // 防御：tryBegin 后同步异常（diff 计算等理论不可达路径）必须释放 guard
      saveGuard.end();
      const detail = error instanceof Error ? error.message : undefined;
      setSaved(t("saveFail", { msg: String(detail || error) }), true);
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
    const merged = rebaseSettings(localChanges, latest.effective || {}) as SettingsView;
    commitSettings(merged); // 同步写 ref：随后 saveFor 立即以 merged 计算 diff
    baselineRef.current = Object.assign({}, latest.effective || {}) as SettingsView;
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
      .then(function (data) {
        toast(
          t(
            channelId ? "testChannelOk" : "testSent",
            channelId ? undefined : { n: data && data.sseConnections },
          ),
        );
        loadStatus({ value: true });
      })
      .catch(function (error: unknown) {
        const failure = apiFailureOf(error, t);
        toast(t("testFail", { msg: failure.message, hint: failure.hint }));
      });
  }

  /** 权限行的授权动作：手势内请求权限，完成后刷新状态行。
   *  为什么留在卡片这层：requestPermission 的手势内调用与 setSaved/setPermTick 都是本组件的
   *  闭包，诊断原子只收这一个回调，不反向读本组件状态。 */
  function requestNotificationPermission() {
    requestPermission(function () {
      setSaved(t("permRequested"));
      setPermTick(permTick + 1); // 触发重渲染刷新权限状态行
    });
  }

  // ---- 频道编辑（settings.channels 不可变操作；deviceKey 掩码语义见服务端）----

  /** 更新第 idx 个频道实例（字段经 assignChannelFields 合并——空串/undefined
   *  删键；函数式基于最新 channels，防后写覆盖）。 */
  function chPatch(idx: number, part: Record<string, unknown>) {
    patch(function (prev) {
      const list = (prev.channels || []).slice();
      // 合并结果恒为频道字段集（assignChannelFields 只做删键/浅覆盖，见 settings/diff.ts）。
      list[idx] = assignChannelFields(list[idx] || {}, part) as SettingsChannelView;
      return Object.assign({}, prev, { channels: list });
    });
  }

  /** 写/删某实例的 levels 映射（kind→level；level 为空删除该 kind；函数式基于最新 channels）。 */
  function chLevelsSet(idx: number, kind: string, level: string) {
    if (!kind || kind === "__proto__" || kind === "constructor" || kind === "prototype") return;
    patch(function (prev) {
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
    patch(function (prev) {
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
    patch(function (prev) {
      const list = prev.channels || [];
      let seq = 1;
      const taken = new Set(
        list.map(function (c) {
          return String(c.id);
        }),
      );
      while (taken.has(kind + "-" + seq)) seq += 1;
      const id = kind + "-" + seq;
      const base: SettingsChannelView =
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
    const routes: Record<string, string[]> = settings?.kindRoutes || {};
    return routes[kind];
  }

  /** 写/清 kind 路由条目（ids=null 删除条目恢复默认；函数式基于最新 kindRoutes）。 */
  function routeSetKind(kind: string, ids: string[] | null) {
    patch(function (prev) {
      const routes = Object.assign({}, prev.kindRoutes || {});
      if (ids === null || ids.length === 0) delete routes[kind];
      else routes[kind] = ids;
      return Object.assign({}, prev, { kindRoutes: routes });
    });
  }

  /** 频道显示名：内置用固定文案（它们的 name 不参与配置），实例用 name 回退 id。 */
  function channelLabel(c: SettingsChannelView): string {
    if (c.type === "browser") return t("chBrowserNotify");
    if (c.type === "system") return t("chSystemNotify");
    return c.name || String(c.id);
  }

  /** 当前「跟随默认」投递面（路由 id 列表）：内置与实例同一判据——`enabled`（发不发）。
   *  chips 点亮态（无条目时）与首次切换物化的快照都以本函数为准——所见即所得。 */
  function defaultRouteIds(prev: SettingsView): string[] {
    const ids: string[] = [];
    (prev.channels || []).forEach(function (c) {
      if (c.enabled === true) ids.push(channelIdOf(c));
    });
    return ids;
  }

  /** 路由候选（含停用频道——保留显示以呈现「已配置但未启用」；未启用者置灰
   *  禁点——投递面 = 启用频道 ∩ 路由，未启用频道即使点亮也不投递，假点亮误导。
   *  enabled 标志供 chips 置灰/title 提示；已勾选未启用频道不自动清除，
   *  用户启用后即恢复有效）。候选顺序即 `channels` 顺序：内置恒在最前。 */
  function routeOptions(
    prev: SettingsView,
  ): Array<{ id: string; label: string; enabled: boolean }> {
    return (prev.channels || []).map(function (c) {
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
    patch(function (prev) {
      const routes: Record<string, string[]> = Object.assign({}, prev.kindRoutes || {});
      const prior = routes[kind];
      const cur = prior === undefined ? defaultRouteIds(prev).slice() : prior.slice();
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
      .then(function (body) {
        const freshRevision = body && typeof body.revision === "number" ? body.revision : undefined;
        if (freshRevision !== undefined && metaRef.current) {
          const nextMeta = Object.assign({}, metaRef.current, { revision: freshRevision });
          metaRef.current = nextMeta;
          setMeta(nextMeta);
        }
        toast(t("kindConfirmOk"));
        return loadKinds({ value: true });
      })
      .catch(function (e: unknown) {
        const detail = e instanceof Error ? e.message : undefined;
        toast(t("kindConfirmFail", { msg: detail || e }));
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
      .then(function (r: Response) {
        // 只挂响应码、不读响应体：DELETE 的失败体未必是 JSON，解析它会把一条失败请求
        // 变成两条（读体再抛）。状态码足以让判定侧不再依赖「文案里含 403」这条兜底。
        if (!r.ok) throw markHttpFailure(new Error("HTTP " + r.status), r.status);
        return r.json();
      })
      .then(function (data: ClearHistoryResult) {
        toast(t("cleared", { n: data.removed || 0 }));
        loadHistory({ value: true });
      })
      .catch(function (error: unknown) {
        const failure = apiFailureOf(error, t);
        toast(t("clearFail", { msg: failure.message, hint: failure.hint }));
      });
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
    // 本函数只在 settings 已加载的渲染路径被调用（651 行守卫之后）；`?? {}` 只是让
    // 嵌套函数体内丢失的 narrowing 仍有定义（该分支不可达，原先是直接读 null 抛错）。
    const options = routeOptions(settings ?? {});
    const litIds = routes === undefined ? defaultRouteIds(settings ?? {}) : routes.slice();
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

  // 能力自检的渲染模型：宿主面（读服务端载荷）+ 浏览器面（读本页事实）合成一次，
  // 下面所有卡片只投影它——JSX 里不再出现任何「这个状态算不算好」的判断。
  const diag = clientDiagnosticsOf(diagnostics, clientFacts(), t);

  // 三端降级文案（浏览器通知权限状态行已移入「浏览器通知」频道卡，
  // 这里只保留服务不可用 / 非安全上下文 / 平台不支持三条全局降级说明）
  const degradation: React.ReactNode[] = [];
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

  // ---- 卡内三 tab（通知事件 / 通知频道 / 通知记录）----

  // 待确认动态 kind 计数（「通知事件」tab 徽标——确认流是安全设计，不可被 tab 埋没）
  const pendingKinds = kindsList.filter(function (k) {
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

  // 去掉设置卡 title/副标题；顶部直接是 tab 栏。
  // 底部保存栏 = 脏状态指示（diffSettingsPayload 键数）+ 放弃更改 + 保存。
  // foot 显示全量脏计数（含频道域）；「保存频道」按钮的域脏态不做单独
  // 计数——无频道域脏时点击走空 diff 的「未修改」提示（与 foot 保存同交互语义）。
  const dirtyCount = Object.keys(diffPayload()).length;

  // 三个 pane 的**条件调用**（普通函数返回 JSX，非 active tab 根本不调用——保持既有条件渲染
  // 语义；改成组件会引入挂载/卸载）。依赖一律显式传参，pane 模块内不读本组件闭包。
  // 频道 tab 的依赖面（三张卡的并集）以单一对象传入：位置参数会退化成 25 项长表。
  const channelsPaneDeps = {
    settings,
    statusMap,
    hostPlatform,
    diag,
    channelLabel,
    chPatch,
    chRemove,
    chLevelsSet,
    chAdd,
    sendTest,
    isSecureContext,
    requestNotificationPermission,
    audioEngine,
    kindsList,
    delArmedId,
    setDelArmedId,
    levelsNew,
    setLevelsNew,
    revealMap,
    setRevealMap,
    secretEdited,
    markSecretEdited,
    saving,
    saveFor,
    t,
  };
  return (
    <li className="dn-set-card">
      {tabbar}
      <div className="dn-set-body">
        {/* 历史独立成 tab：清理/发送测试/刷新并排工具行；请求权限按钮随权限状态行归入
            「浏览器通知」频道卡 */}
        {activeTab === "events"
          ? eventsPane(settings, kindsList, patch, confirmOne, routeChipsRow, severityOf, t)
          : activeTab === "channels"
            ? channelsPane(channelsPaneDeps)
            : historyPane(
                history,
                clearArmedValue,
                confirmClear,
                sendTest,
                loadHistory,
                severityOf,
                t,
              )}
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

/**
 * 页面级单例的归属令牌容器：每次 apply 换一枚新令牌，清理时先比对。热更或重复 apply 时旧实例
 * 的 disposer 仍会执行，无条件清理会把新实例正在用的 <style> / 标题闪烁 / 弹窗一并摘掉。
 */
const pageOwner: { current: object | null } = { current: null };

/** 宿主 locale 服务读形态（本包只用 register/bind/subscribe/getSnapshot；缺失即回落 key 本体）。 */
interface LocaleServiceView {
  register: (ns: string, dict: { zh: unknown; en: unknown }) => void;
  bind: (ns: string) => unknown;
  subscribe?: (listener: () => void) => () => void;
  getSnapshot?: () => unknown;
}

/** 宿主插槽读形态（本包只用 settings.section 的 inject/register；缺失即 tab 不挂载）。 */
interface SlotsView {
  inject: (name: string, setup: () => unknown) => void;
  register: (item: Record<string, unknown>, render: () => unknown) => unknown;
}

/**
 * 浏览器端上下文的窄面（本包实际使用的面：get + effect），与 inject 声明的
 * ["slots", "locale"] 对齐；slots/locale 各自的读形态见上。effect 面与 DisposerHost
 * 同形（finally 里 stack.attach 直接消费）。
 */
interface ClientContext {
  get: (name: string) => unknown;
  effect: (callback: () => () => void, id: string) => void;
}

export function apply(ctx: ClientContext): void {
  // 清理栈：边装配边采集 teardown，登记点（attach）放在 finally——中途同步抛错时，
  // 已建立的那些资源也仍有 disposer 可摘（见 shared/disposers.ts 文件头对登记点在后的说明）。
  const stack = createDisposerStack();
  try {
    // 页面级单例（<style> / 标题闪烁 / 已弹通知）的归属令牌：热更或重复 apply 时旧实例的
    // disposer 仍会执行，只有仍属当前实例的清理才许动这些共享资源，否则新实例会变成无样式
    // 页面、丢掉闪烁提示、连带关掉自己正在显示的弹窗。
    const owner: object = {};

    // 两处**页面级单例**没有「建立时刻」（<style> 由 ensureStyle 复用同 id 元素，通知登记是
    // 模块级表），故顶格登记；释放是逆序的，排最前 = 最后释放，共享外壳比实例资源活得久。
    // <style> 只在仍是当前归属者时才摘，否则旧实例的 disposer 会把新实例的样式表摘掉
    // （页面变成无样式）；摘除即让位，归属随之清空。
    stack.own(function () {
      if (pageOwner.current !== owner) return;
      pageOwner.current = null;
      document.getElementById(STYLE_ID)?.remove();
    });
    stack.own(function () {
      closeNotificationsOf(owner);
    });

    // 样式注入后立刻认领页面级归属（就在这一行，不是装配成功之后）：认领的时刻就是「本实例开始
    // 为这个共享节点负责」的时刻。放到末尾会让半途失败的实例永远不认领，而它刚注入的样式表此后
    // 再也摘不掉——R5 的漏清理换了个形态复活（登记点有了，释放却被归属判定挡掉）。
    ensureStyle({ id: STYLE_ID, cssText: STYLE, version: CSS_VERSION });
    pageOwner.current = owner;

    // 页面重新可见时：还原标题 + 强制重建 SSE（iOS 后台挂起后连接可能已失效，
    // 重建自动带 since 补拉，避免断线窗口漏通知）。
    // 具名 handler 在 apply 内注册、disposer 移除（对齐 mcp-manager
    // onVisible 范式）——匿名模块体注册无卸载路径，重复 apply/热更会累积旧监听。
    // 释放是同步的：不存在「监听还在、标题已还原」的窗口（没有谁能在同一个同步循环里派发
    // 事件），故这里不需要为次序做取舍——逆序释放让实例资源先走、页面级单例最后走。
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        titleFlasher.restore(owner);
        eventsHandle.current?.reconnect();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    stack.own(function () {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
    // 标题恢复原本只由 visibilitychange 回前台触发；disposer 摘除监听后该路径关闭，
    // 若残留恢复缓存则标题永久卡在「🔔 …」（复现路径：hidden 帧 → 卸载）。
    // 带归属：旧实例的 disposer 不许摘掉新实例的闪烁（见 notify/title.ts）。
    stack.own(function () {
      titleFlasher.restore(owner);
    });

    // i18n：注册本插件字典；t 绑定官方 locale 服务（未装配回落 key 本体）。
    const locale = ctx.get("locale") as LocaleServiceView | null | undefined;
    // 订阅取消函数供 disposer 卸载调用（守卫对齐 provider-usage/
    // mcp-manager 的 undefined 形态——不预设 subscribe 返回 null，防其返回
    // null 时 null 初始化遮蔽导致守卫失效），防重复 apply 后旧订阅持续重绑
    // 已停用实例。
    let unsubLocale: (() => void) | undefined;
    if (locale && typeof locale.register === "function") {
      // 收窄后的别名：嵌套回调内 narrowing 会重置，别名本身即非空类型，回调内照常可用。
      const localeService = locale;
      // bind/subscribe 必须带接收者调用：宿主实现依赖 this，detached 摘出即抛，失败被各层 catch 静默吞掉后整面板回落 key 本体。
      try {
        localeService.register(NS, { zh: zh, en: en });
        // 宿主 bind 出的签名以本包字典键为参数，比端口声明的 string 更窄——收口在适配这一处
        bindTranslate(localeService.bind(NS) as Translate);
        if (
          typeof localeService.subscribe === "function" &&
          typeof localeService.getSnapshot === "function"
        ) {
          unsubLocale = localeService.subscribe(function () {
            try {
              bindTranslate(localeService.bind(NS) as Translate);
            } catch {
              /* 忽略 */
            }
          });
        }
      } catch (e) {
        console.warn("[dsh-notifier] locale 注册失败：", e);
      }
    }
    if (unsubLocale !== undefined) {
      const unsubscribe = unsubLocale;
      stack.own(function () {
        unsubscribe();
      });
    }

    // 通知半区（SSE / 浏览器通知）：不依赖任何插件 DOM，直接启动。
    // 会话是「建立 + 配对释放」的资源，走 acquire：make 抛错就不留释放登记（会话没建成，
    // 也没有要关的东西）。
    eventsHandle.current = stack.acquire(
      function () {
        return startNotifySession(
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
          function (payload) {
            handleNotifyFrame(payload, owner);
          },
        );
      },
      function (session) {
        session.close();
        // 只在仍指向自己的会话时才清空：重复 apply 时后装的实例才是当前句柄，
        // 无条件置 null 会让存活实例的回前台重连静默失效（跨实例串味）。
        if (eventsHandle.current === session) eventsHandle.current = null;
      },
    );
    // 首次任意点击解锁音频（浏览器自动播放策略要求手势）。具名 + disposer 摘除：
    // 从未点击就被卸载时，匿名监听会永久留在 document 上，且下次点击会在插件已卸载后
    // 构造一个 AudioContext。
    function onFirstClick() {
      audioEngine.unlock();
      document.removeEventListener("click", onFirstClick, { capture: true });
    }
    document.addEventListener("click", onFirstClick, { capture: true });
    stack.own(function () {
      document.removeEventListener("click", onFirstClick, { capture: true });
    });

    // 设置面板独立 tab「通知中心」（settings.section）。
    // 参照 dsh-provider-usage「用量统计」tab 的接线（slots.inject + register，
    // 独立顶层页）；label 为导航显示文本。旧运行时若不声明该插槽，inject
    // 回调不执行 → tab 不挂载、通知半区照常工作（与 provider-usage 同语义，
    // 不做 plugin.item 双插槽重复展示）。
    const slots = ctx.get("slots") as SlotsView | null | undefined;
    if (slots && typeof slots.inject === "function") {
      const slotHost = slots;
      // 就地兜住插槽接线：这里失败只意味着设置 tab 没挂上，通知半区照常工作；冒到外层会被
      // 报成整段「挂载失败」，把一次可降级的缺页说成插件不可用。
      try {
        slotHost.inject("settings.section", function () {
          return slotHost.register(
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
      } catch (error) {
        console.warn("[dsh-notifier] 设置 tab 未挂载：", error);
      }
    } else {
      console.warn("[dsh-notifier] 缺少 slots 服务，设置 tab 未挂载（通知半区照常工作）");
    }
  } catch (error) {
    console.warn("[dsh-notifier] 挂载失败：", error);
  } finally {
    stack.attach(ctx, "dsh-notifier", function (error) {
      console.warn("[dsh-notifier] 卸载清理失败：", error);
    });
  }
}

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块，React externals）----
// 设置卡片是 React 组件（settings.section 独立 tab 插槽由宿主 React 渲染）；通知半区
// 不依赖任何 DOM，slot 缺失时照常工作。
export const inject: string[] = ["slots", "locale"];
