/**
 * dsh-notifier — 通知中心核心 service（M1：'wingsky.notifier'）。
 *
 * 定位：把 dsh-notifier 升级为 hub 内通知中心——**仅单向通知**，标准接口供
 * 其他插件调用。本模块是提供方实现（createNotifierService + ctx.provide），
 * 类型面供消费方经包导出 import（cordis Context 声明合并见 service.d.ts）。
 *
 * 设计（终稿 §三~§六，MVP 裁剪）：
 * - 消息模型 NotifyRequest：source / kind / severity / body / title? / data?
 *   —— kind 为必填第一轴（免打扰/历史/路由全靠它）；severity 仅展示强度。
 * - Channel SPI：频道实现最小契约（capabilities 声明式降级，框架统一处理
 *   截断/重试），MVP 内置 browser / system 两频道（包一层 sse / system）。
 * - 动态 kind 注册 + 用户确认：插件经 registerKind 提议，未确认一律走
 *   suppressed 落史（复用免打扰路径，零新增状态机）；confirmKind 确认后放行。
 * - 内置事件源与外部调用方收敛到同一条 sendInternal 管线（评审 #1）：
 *   severity 映射静态表 + 免打扰 + fail-soft 逐频道分发 + 历史落盘。
 * - 缺省广播：未声明 kindRoutes 的 kind 发往全部启用频道（MVP 无稀疏覆盖，
 *   路由例外编辑 UI 砍进 v-next；kindRoutes 字段进配置白名单见 config.ts）。
 *
 * 兼容红线（§8）：SSE 帧契约、历史 jsonl、免打扰/suppressed/多标签租约
 * 全部保持——本模块只做管线收敛，不改出口语义。
 */
import type { SseHub, SystemNotifier } from "./server.ts";
import type { HistoryStore } from "./history.ts";
import type { NotifyConfig } from "./config.ts";
import { isInQuietHours } from "./quiet-hours.ts";
import { NOTIFY_KINDS } from "./message.ts";
import { sanitizeErrorText } from "./message.ts";
import type { NotifyDetail } from "./message.ts";

// ---------------------------------------------------------------- 消息模型

/** 展示强度（severity 仅展示；过滤语义归 kind）。 */
export type NotifySeverity = "info" | "success" | "warning" | "failure";

/** 通知请求（外部调用方通用入口）。 */
export interface NotifyRequest {
  /** 调用方标识，如 '@wingsky-1/dsh-idle-archive'。 */
  source: string;
  /** kind：内置七 kind 或经 registerKind 注册的动态 kind（'<source-short>:<id>'）。 */
  kind: string;
  severity: NotifySeverity;
  /** 正文（调用方负责脱敏，中心兜底截断）。 */
  body: string;
  title?: string;
  /** 频道专有透传（MVP 仅 string 值、白名单字段见 config）。 */
  data?: Record<string, string>;
}

/** 单个频道的受理结果。 */
export interface NotifyResult {
  channelId: string;
  status: "ok" | "skipped" | "failed";
  error?: string;
}

/** 动态 kind 注册（仅 host 侧插件进程可调；模型工具不得注册）。 */
export interface KindRegistration {
  /** '<source-short>:<id>'，实现侧校验前缀与 source 归属，防冒认。 */
  id: string;
  /** 设置页展示名（展示层文本，非推送内容）。 */
  label: string;
  /** 建议路由（MVP 保留字段，未启用稀疏覆盖）。 */
  channels?: string[];
}

// ---------------------------------------------------------------- Channel SPI

/** 频道能力声明（框架据此做降级：标题并入 / 超长截断）。 */
export interface ChannelCapabilities {
  /** 标题最大码点数；<=0 表示不支持标题（并入正文）。 */
  titleMaxLen: number;
  /** 正文最大码点数（超长按此截断）。 */
  maxBodyLen: number;
}

/** 频道最小实现契约。 */
export interface NotifyChannel {
  /** 即 channelId，唯一。 */
  name: string;
  capabilities: ChannelCapabilities;
  /**
   * 投递一条已解析消息；同步抛错即该频道受理 failed；返回 promise 时其决议
   * 为投递终态（resolve=成功 / reject=失败，错误须已脱敏），调用方据此记录
   * status 与 sent 事件（受理结果不受终态影响——铁律 1）。
   */
  send(payload: { title: string; body: string; kind: string; ts: number; severity?: NotifySeverity }): void | Promise<void>;
}

// ---------------------------------------------------------------- Service 契约

/** 'wingsky.notifier' 服务面（消费方经 ctx['wingsky.notifier'] 调用）。 */
export interface NotifierService {
  readonly apiVersion: 1;
  /** 注册动态 kind（待确认；确认前 send 走 suppressed）。 */
  registerKind(reg: KindRegistration): void;
  /** 确认/撤销一个动态 kind（设置页调用；内置 kind 无需确认）。 */
  confirmKind(kind: string, confirmed: boolean): void;
  /** 查询动态 kind 注册与确认态（设置页渲染）。 */
  listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
  /** 注册一个插件贡献频道（MVP：进注册表待用户开启，未启用不投递）。 */
  registerChannel(ch: NotifyChannel): void;
  /** 通用发送入口：快速返回受理结果，投递终态经落盘/事件可见。 */
  send(req: NotifyRequest): Promise<NotifyResult[]>;
}

/** 内部服务面（装配层专用：内置事件源经 sendKind 走完整文案管线）。 */
export interface NotifierServiceInternal extends NotifierService {
  /**
   * 内置事件源入口（等价搬移前的 notify(kind, detail) 完整语义：kind 文案
   * 模板渲染 + 动态 kind 确认检查 + 免打扰 + fail-soft 分发 + 历史落盘）。
   * @returns 受理结果（调用方以 results.some(r => r.status === 'ok') 判定
   *   是否真正发出——与旧 notify() 的 boolean 语义逐点对齐）。
   */
  sendKind(kind: string, detail?: NotifyDetail, opts?: { bypassQuiet?: boolean; onlyChannel?: string }): NotifyResult[];
}

// ---------------------------------------------------------------- severity 映射（评审 #1）

/** 内置 kind → 展示强度 静态映射（契约测试锁定）。 */
export const KIND_SEVERITY: Readonly<Record<string, NotifySeverity>> = {
  ask: "warning",
  question: "info",
  done: "success",
  "subagent-done": "info",
  error: "failure",
  "turn-end": "info",
  test: "info",
};

// ---------------------------------------------------------------- 实现

/** createNotifierService 的注入面（全部由 index.ts 装配层提供）。 */
export interface NotifierServiceDeps {
  /** 当前生效配置（settings 解析值；dispatch 时实时读取）。 */
  current(): NotifyConfig;
  /** 总开关（组合层 enabled；false 时 send 一律 skipped）。 */
  enabled(): boolean;
  /** SSE 推送枢纽（browser 频道）。 */
  sse: SseHub;
  /** 系统通知通道。 */
  system: SystemNotifier;
  /** 历史存储（落盘 fire-and-forget）。 */
  history: HistoryStore;
  /** 日志出口。 */
  logger: { warn: (m: string) => void; info: (m: string) => void };
  /** 配置驱动的出站频道（M2：bark 实例；enabled 过滤后返回，每次 dispatch 现取）。 */
  outboundChannels(): Array<{ id: string; channel: NotifyChannel }>;
  /** 频道投递终态落盘（status 文件；错误文本已由调用方脱敏）。 */
  recordStatus(channelId: string, status: "ok" | "failed", error?: string): void;
  /** 投递终态事件（'wingsky-notify/sent'；装配层 try/catch 包裹，缺服务静默跳过）。 */
  emitSent(payload: NotifySentEvent): void;
  /** 动态 kind 确认写入（持久化到配置 allowKinds；fire-and-forget）。 */
  setConfirm(kind: string, confirmed: boolean): void;
}

/** 投递终态事件负载（'wingsky-notify/sent'；旁观插件订阅面，铁律 1 的事件半边）。 */
export interface NotifySentEvent {
  kind: string;
  /** 消息标题（模板渲染后）。 */
  title: string;
  /** 消息正文（模板渲染后）。 */
  message: string;
  /** 投递频道 id。 */
  channelId: string;
  /** 投递终态。 */
  status: "ok" | "failed";
  /** 失败摘要（已脱敏；ok 时缺省）。 */
  error?: string;
  ts: number;
}

/** 内置频道 id。 */
export const BUILTIN_CHANNELS = {
  browser: "browser",
  system: "system",
} as const;

/** 统一码点截断（中文场景按码点，不按 UTF-16 code unit）。 */
function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/**
 * 创建通知中心服务实现。
 *
 * 管线（与搬移前的 notify 行为完全一致）：
 *   enabled 判定 → kind 动态未确认 → suppressed 落史 → 免打扰检查（被拦截
 *   也落 suppressed 历史）→ 逐频道 fail-soft 投递 → 历史落盘 → 返回受理结果。
 *
 * 内置频道走 SPI：browser 包 sse.broadcast（SSE 帧契约不变），system 包
 * system.notify（自带 1s 节流与 30s 超时杀进程，语义不变）。
 */
export function createNotifierService(deps: NotifierServiceDeps): NotifierServiceInternal {
  const { current, enabled, sse, system, history, logger, outboundChannels, recordStatus, emitSent, setConfirm } = deps;

  /** 动态 kind 注册表（id → label；确认态持久化在配置 allowKinds——M2 修复 M1 内存态重启丢失）。 */
  const kindRegistry = new Map<string, { label: string }>();
  /** 插件贡献频道注册表（name → channel；默认未启用，MVP 仅存表）。 */
  const channelRegistry = new Map<string, NotifyChannel>();

  /** 内置七 kind 恒可用（无需确认）。 */
  function isBuiltinKind(kind: string): boolean {
    return Object.prototype.hasOwnProperty.call(NOTIFY_KINDS, kind);
  }

  /** 动态 kind 是否获用户确认（确认态持久化在配置 allowKinds；未注册/未确认 → 抑制）。 */
  function isKindConfirmed(kind: string): boolean {
    if (isBuiltinKind(kind)) return true;
    if (!kindRegistry.has(kind)) return false;
    const allowed = current().allowKinds;
    return Array.isArray(allowed) && allowed.includes(kind);
  }

  /** 历史追加（与搬移前一致：fire-and-forget）。 */
  function appendHistory(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }) {
    try {
      history.append(entry);
    } catch (error) {
      logger.warn(`dsh-notifier: 历史落盘失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 全部可投递频道：内置（按开关）+ 配置驱动实例（enabled 过滤由装配层保证）。 */
  function allChannels(): Array<{ id: string; channel: NotifyChannel }> {
    const cfg = current();
    const out: Array<{ id: string; channel: NotifyChannel }> = [];
    if (cfg.browserNotify) out.push({ id: BUILTIN_CHANNELS.browser, channel: browserChannel });
    if (cfg.systemNotify) out.push({ id: BUILTIN_CHANNELS.system, channel: systemChannel });
    try {
      out.push(...outboundChannels());
    } catch (error) {
      logger.warn(`dsh-notifier: 出站频道读取失败（fail-soft 跳过）: ${error instanceof Error ? error.message : String(error)}`);
    }
    return out;
  }

  /**
   * 路由解析（终稿 §4.6）：实际投递集合 = 启用频道 ∩ (kindRoutes[kind] ?? '*')。
   * 缺省（无条目）= 广播全部启用频道；稀疏条目命中才投递；条目里指向已删除
   * 频道（配置 channels 中不存在）的 id 记入 stale（skipped + warn，不影响其他）。
   * onlyChannel（per-channel 测试）直接命中单频道并绕过路由。
   */
  function resolveRoutes(kind: string, onlyChannel?: string): { targets: Array<{ id: string; channel: NotifyChannel }>; stale: string[] } {
    let pool = allChannels();
    if (onlyChannel) {
      return { targets: pool.filter((t) => t.id === onlyChannel), stale: [] };
    }
    const routes = current().kindRoutes?.[kind];
    if (!Array.isArray(routes) || routes.length === 0) {
      return { targets: pool, stale: [] };
    }
    const set = new Set(routes);
    const targets = pool.filter((t) => set.has(t.id));
    const known = new Set<string>([BUILTIN_CHANNELS.browser, BUILTIN_CHANNELS.system]);
    for (const c of current().channels ?? []) known.add(`bark:${c.id}`);
    const stale = routes.filter((id) => !known.has(id));
    return { targets, stale };
  }

  /**
   * 单频道投递：受理同步返回（铁律 1）；投递终态经 status 落盘 + sent 事件
   * 异步可见（bark 的 promise 决议；内置频道同步完成即终态）。错误出口统一
   * sanitizeErrorText（评审 P0-4：NotifyResult.error / status / 事件三路都过）。
   */
  function deliver(kind: string, title: string, message: string, ts: number, severity: NotifySeverity | undefined, target: { id: string; channel: NotifyChannel }): NotifyResult {
    const { id, channel } = target;
    const finalizeError = (err: unknown): string => sanitizeErrorText(err instanceof Error ? err.message : String(err), 300);
    try {
      const safeTitle = truncateCodePoints(String(title), channel.capabilities.titleMaxLen > 0 ? channel.capabilities.titleMaxLen : channel.capabilities.maxBodyLen);
      const safeBody = truncateCodePoints(String(message), channel.capabilities.maxBodyLen);
      const outcome = channel.send({ title: safeTitle, body: safeBody, kind, ts, severity });
      const emitOk = () => {
        try {
          recordStatus(id, "ok");
          emitSent({ kind, title: safeTitle, message: safeBody, channelId: id, status: "ok", ts });
        } catch {
          // 终态上报失败不影响受理语义
        }
      };
      const emitFail = (err: unknown) => {
        const e = finalizeError(err);
        try {
          recordStatus(id, "failed", e);
          emitSent({ kind, title: safeTitle, message: safeBody, channelId: id, status: "failed", error: e, ts });
        } catch {
          // 同上
        }
      };
      if (outcome && typeof (outcome as Promise<void>).then === "function") {
        (outcome as Promise<void>).then(emitOk, emitFail);
      } else {
        emitOk();
      }
      return { channelId: id, status: "ok" };
    } catch (error) {
      const e = finalizeError(error);
      try {
        recordStatus(id, "failed", e);
        emitSent({ kind, title, message, channelId: id, status: "failed", error: e, ts });
      } catch {
        // 同上
      }
      return { channelId: id, status: "failed", error: e };
    }
  }

  /** 内置 browser 频道：包一层 SSE hub（帧契约 {type,kind,title,message,ts,seq} 不变）。 */
  const browserChannel: NotifyChannel = {
    name: BUILTIN_CHANNELS.browser,
    capabilities: { titleMaxLen: 64, maxBodyLen: 2048 },
    send(payload) {
      sse.broadcast({ type: "notify", kind: payload.kind, title: payload.title, message: payload.body, ts: payload.ts });
    },
  };

  /** 内置 system 频道：包一层系统通知（节流/超时/降级语义不变）。 */
  const systemChannel: NotifyChannel = {
    name: BUILTIN_CHANNELS.system,
    capabilities: { titleMaxLen: 64, maxBodyLen: 256 },
    send(payload) {
      system.notify(payload.title, payload.body);
    },
  };

  /**
   * 统一通知管线（kind 形态，等价搬移前的 notify）。外部 send() 与内置事件源
   * 都经它收敛（评审 #1）。对内置 kind 用 NOTIFY_KINDS 文案模板；动态 kind 由
   * send() 在调用前完成确认检查后直接投递 body（不经模板）。
   * @returns 受理结果数组（投递终态经历史落盘与 wingsky-notify/sent 事件可见）。
   */
  function sendKind(kind: string, detail: NotifyDetail = {}, opts?: { bypassQuiet?: boolean; onlyChannel?: string }): NotifyResult[] {
    if (enabled() === false) {
      return [{ channelId: "*", status: "skipped", error: "enabled=false" }];
    }
    const spec = NOTIFY_KINDS[kind];
    const ts = Date.now();
    const title = spec?.title ?? "DSH 通知";
    const message = spec?.message({ ...detail, ts }) ?? detail.message ?? "";
    const results: NotifyResult[] = [];

    // 动态 kind 未确认 → suppressed 落史，不触达任何频道（复用免打扰路径语义）
    if (!isKindConfirmed(kind)) {
      appendHistory({ ts, kind, title, message, suppressed: "kind-pending" });
      results.push({ channelId: "*", status: "skipped", error: "kind-pending" });
      return results;
    }

    // 免打扰拦截（被拦截也记录「未发出」历史）
    const suppressedByQuiet = (() => {
      if (opts?.bypassQuiet) return false;
      if (!isInQuietHours(new Date(), current().quietHours)) return false;
      const allows = current().quietHours.allowKinds ?? [];
      return !allows.includes(kind);
    })();
    if (suppressedByQuiet) {
      logger.info(`dsh-notifier: ${kind} 被免打扰拦截（未发出）：${message.replace(/\n/g, " / ")}`);
      appendHistory({ ts, kind, title, message, suppressed: "quiet" });
      return [{ channelId: "*", status: "skipped", error: "quiet" }];
    }

    // 路由解析 + 逐频道投递（受理同步返回；终态经 deliver 异步落盘/事件）
    const { targets, stale } = resolveRoutes(kind, opts?.onlyChannel);
    for (const id of stale) {
      logger.warn(`dsh-notifier: kindRoutes[${kind}] 指向已删除频道 ${id}，记 skipped`);
      results.push({ channelId: id, status: "skipped", error: "stale-route" });
    }
    const severity = KIND_SEVERITY[kind];
    for (const target of targets) {
      results.push(deliver(kind, title, message, ts, severity, target));
    }
    logger.info(`dsh-notifier: ${kind} ${message.replace(/\n/g, " / ")}`);
    appendHistory({ ts, kind, title, message });
    return results;
  }

  const service: NotifierServiceInternal = {
    apiVersion: 1,

    /** 内置事件源入口（装配层经此发送；等价旧 notify 完整语义）。 */
    sendKind,

    registerKind(reg: KindRegistration) {
      const id = reg?.id;
      if (typeof id !== "string" || id.length === 0) return;
      // 防冒认：动态 id 必须带 ':' 且前缀非内置 kind 名
      const sep = id.indexOf(":");
      if (sep <= 0 || isBuiltinKind(id.slice(0, sep))) return;
      kindRegistry.set(id, { label: typeof reg.label === "string" ? reg.label : id });
    },

    confirmKind(kind: string, confirmed: boolean) {
      if (!kindRegistry.has(kind)) return;
      // 确认态持久化到配置 allowKinds（M2：修复 M1 内存态重启丢失）；fire-and-forget
      setConfirm(kind, confirmed);
    },

    listKinds() {
      const allowed = current().allowKinds;
      const allowedSet = Array.isArray(allowed) ? new Set(allowed) : new Set<string>();
      return [...kindRegistry.entries()].map(([id, v]) => ({ id, label: v.label, confirmed: allowedSet.has(id) }));
    },

    registerChannel(ch: NotifyChannel) {
      if (typeof ch?.name !== "string" || typeof ch?.send !== "function") return;
      channelRegistry.set(ch.name, ch);
    },

    async send(req: NotifyRequest) {
      // 形状守卫（评审 #4 纪律）：不匹配转结构化结果，不抛异常
      if (typeof req !== "object" || req === null) {
        return [{ channelId: "*", status: "failed", error: "invalid request shape" }];
      }
      const kind = req.kind;
      if (typeof kind !== "string" || kind.length === 0) {
        return [{ channelId: "*", status: "failed", error: "missing kind" }];
      }
      // 外部调用方发内置 kind：仍走完整文案管线（模板 + 确认 + 免打扰 + 分发）
      if (isBuiltinKind(kind)) {
        return sendKind(kind, { message: req.body });
      }
      const ts = Date.now();
      const title = req.title ?? "DSH 通知";
      const body = String(req.body ?? "");
      if (!isKindConfirmed(kind)) {
        appendHistory({ ts, kind, title, message: body, suppressed: "kind-pending" });
        return [{ channelId: "*", status: "skipped", error: "kind-pending" }];
      }
      // 动态 kind：不经过 NOTIFY_KINDS 文案模板，title/body 直通；severity 直通
      const { targets, stale } = resolveRoutes(kind);
      const results: NotifyResult[] = [];
      for (const id of stale) {
        logger.warn(`dsh-notifier: kindRoutes[${kind}] 指向已删除频道 ${id}，记 skipped`);
        results.push({ channelId: id, status: "skipped", error: "stale-route" });
      }
      for (const target of targets) {
        results.push(deliver(kind, title, body, ts, req.severity, target));
      }
      appendHistory({ ts, kind, title, message: body });
      return results;
    },
  };

  return service;
}

// ---------------------------------------------------------------- 便捷访问

/** 从 ctx 安全读取通知中心服务（未注入返回 undefined，消费方据此降级）。 */
export function getNotifierService(ctx: unknown): NotifierService | undefined {
  try {
    const svc = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get?.("wingsky.notifier", false);
    return svc as NotifierService | undefined;
  } catch {
    return undefined;
  }
}
