/**
 * dsh-notifier — SDK 契约域：通知中心核心服务实现（'wingsky.notifier'）。
 *
 * 定位：把 dsh-notifier 升级为 hub 内通知中心——**仅单向通知**，标准接口供
 * 其他插件调用。本模块是提供方实现（createNotifierService + ctx.provide），
 * 类型面供消费方经包导出 import（cordis Context 声明合并见 service.d.ts）。
 * 判定/投递纯函数自旧单文件机械提炼至 pipeline 域（行为等价，PR1 零行为变更；
 * PR2 在此上移 current() 单刻快照与重试/并发门）。
 *
 * 兼容红线（§8）：SSE 帧契约、历史 jsonl、免打扰/suppressed/多标签租约
 * 全部保持——本模块只做管线收敛，不改出口语义。
 */
import { createBrowserChannel, createSystemChannel } from "../channels/interface.ts";
import { isInQuietHours, resolveSoundSetting } from "../config/interface.ts";
import type { NotifyConfig } from "../config/interface.ts";
import { deliverToChannel, isBuiltinKind, isKindConfirmed, resolveRoutes } from "../pipeline/interface.ts";
import { KIND_SEVERITY, NOTIFY_KINDS } from "../text/interface.ts";
import type { NotifyDetail } from "../text/interface.ts";
import { BUILTIN_CHANNELS } from "./interface.ts";
import type {
  KindRegistration,
  NotifierService,
  NotifierServiceDeps,
  NotifierServiceInternal,
  NotifyChannel,
  NotifyRequest,
  NotifyResult,
} from "./interface.ts";

// ---------------------------------------------------------------- 实现

/**
 * 创建通知中心服务实现。
 *
 * 管线（与搬移前的 notify 行为完全一致）：
 *   enabled 判定 → kind 动态未确认 → suppressed 落史 → 免打扰检查（被拦截
 *   也落 suppressed 历史）→ 逐频道 fail-soft 投递 → 历史落盘 → 返回受理结果。
 *
 * 内置频道走 SPI：browser 包 sse.broadcast（SSE 帧契约不变），system 包
 * system.notify（自带 1s 节流与 30s 超时杀进程，语义不变）——工厂见 channels 域。
 */
export function createNotifierService(deps: NotifierServiceDeps): NotifierServiceInternal {
  const { current, enabled, sse, system, history, logger, outboundChannels, recordStatus, emitSent, setConfirm } = deps;

  /** 动态 kind 注册表（id → label；确认态持久化在配置 allowKinds——M2 修复 M1 内存态重启丢失）。 */
  const kindRegistry = new Map<string, { label: string }>();
  /** 插件贡献频道注册表（name → channel；默认未启用，MVP 仅存表）。 */
  const channelRegistry = new Map<string, NotifyChannel>();

  /** 历史追加（与搬移前一致：fire-and-forget）。 */
  function appendHistory(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }) {
    try {
      history.append(entry);
    } catch (error) {
      logger.warn(`dsh-notifier: 历史落盘失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 内置频道实例（注入面 sse/system 经 channels 域工厂包装为 NotifyChannel；
   *  #640/#641：声音/弹窗策略在投递时刻实时读取——dispatch 侧 current()）。 */
  const browserChannel = createBrowserChannel({ sse, current });
  const systemChannel = createSystemChannel({ system, current });

  /** 全部可投递频道：内置（按「弹窗开关 || 声音非静音」进入）+ 配置驱动实例
   *  （enabled 过滤由装配层保证）。#640/#641：弹窗关 + 声音开 → 只响不弹投递
   *  （B6：投递集合条件 = 弹窗 || 声音非静音）。 */
  function allChannels(): Array<{ id: string; channel: NotifyChannel }> {
    const cfg = current();
    const out: Array<{ id: string; channel: NotifyChannel }> = [];
    const browserSound = resolveSoundSetting(cfg, "browser");
    if (cfg.browserNotify || browserSound !== false) out.push({ id: BUILTIN_CHANNELS.browser, channel: browserChannel });
    const systemSound = resolveSoundSetting(cfg, "system");
    if (cfg.systemNotify || systemSound !== false) out.push({ id: BUILTIN_CHANNELS.system, channel: systemChannel });
    try {
      out.push(...outboundChannels());
    } catch (error) {
      logger.warn(`dsh-notifier: 出站频道读取失败（fail-soft 跳过）: ${error instanceof Error ? error.message : String(error)}`);
    }
    return out;
  }

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
    if (!isKindConfirmed(kind, kindRegistry, current)) {
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
    const { targets, stale } = resolveRoutes({ kind, onlyChannel: opts?.onlyChannel, allChannels, current });
    for (const id of stale) {
      logger.warn(`dsh-notifier: kindRoutes[${kind}] 指向已删除频道 ${id}，记 skipped`);
      results.push({ channelId: id, status: "skipped", error: "stale-route" });
    }
    const severity = KIND_SEVERITY[kind];
    for (const target of targets) {
      results.push(deliverToChannel({ kind, title, message, ts, severity, target, recordStatus, emitSent }));
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
      if (!isKindConfirmed(kind, kindRegistry, current)) {
        appendHistory({ ts, kind, title, message: body, suppressed: "kind-pending" });
        return [{ channelId: "*", status: "skipped", error: "kind-pending" }];
      }
      // 动态 kind：不经过 NOTIFY_KINDS 文案模板，title/body 直通；severity 直通
      const { targets, stale } = resolveRoutes({ kind, allChannels, current });
      const results: NotifyResult[] = [];
      for (const id of stale) {
        logger.warn(`dsh-notifier: kindRoutes[${kind}] 指向已删除频道 ${id}，记 skipped`);
        results.push({ channelId: id, status: "skipped", error: "stale-route" });
      }
      for (const target of targets) {
        results.push(deliverToChannel({ kind, title, message: body, ts, severity: req.severity, target, recordStatus, emitSent }));
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