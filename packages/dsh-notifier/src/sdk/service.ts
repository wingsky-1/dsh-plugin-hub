/**
 * dsh-notifier — SDK 契约域：通知中心核心服务实现（'wingsky.notifier'）。
 *
 * PR2（T2-1）：判定/投递上移至 pipeline 工厂——createAdjudicator 单刻快照
 * （B-2：每次通知 current() 恰好 1 次，裁决/播放决议同快照）、createDeliverer
 * fail-soft 投递（DeliverDeps 注入，终态/落史/play 全经 deps）；内置频道经
 * index.ts 注入（builtinChannels + play，sdk→channels 值边消除——D23）；
 * send() 动态 kind 与 sendKind 统一过裁决全链（enabled→确认→免打扰→路由，
 * B-9/D24）。
 *
 * 兼容红线（§8）：SSE 帧契约、历史 jsonl、免打扰/suppressed/多标签租约
 * 全部保持——本模块只做管线收敛，不改出口语义。
 */
import { resolveSoundSetting } from "../config/interface.ts";
import type { NotifyConfig, SoundId } from "../config/interface.ts";
import { createAdjudicator, createDeliverer, isBuiltinKind, isKindConfirmed } from "../pipeline/interface.ts";
import type { AdjudicateResult, ChannelPoolEntry } from "../pipeline/interface.ts";
import { KIND_SEVERITY, NOTIFY_KINDS, sanitizeNoticeContent } from "../text/interface.ts";
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

/** browser 帧级 sound 编码（BrowserDispatchSpec.sound；与 SSE 帧契约同源：
 *  false → silent；pop=true：true → system、SoundId → selfplay+tone；pop=false
 *  （只响不弹）：无 OS 通知实体可发声，true 也编码 selfplay（客户端默认旋律，
 *  P1-1 复核——编码需随 pop 决议，否则 system 模式会让客户端既不弹也不播）。 */
function encodeBrowserSound(sound: NotifyConfig["browserSound"], pop: boolean): { mode: "silent" | "system" | "selfplay"; tone?: SoundId } {
  if (sound === false) return { mode: "silent", tone: undefined };
  if (sound === true) return pop ? { mode: "system", tone: undefined } : { mode: "selfplay", tone: undefined };
  return { mode: "selfplay", tone: sound };
}

/**
 * 创建通知中心服务实现。
 *
 * 管线（与搬移前的 notify 行为一致，判定/投递经工厂收敛）：
 *   enabled 判定 → kind 动态未确认 → suppressed 落史 → 免打扰检查（被拦截
 *   也落 suppressed 历史）→ 逐频道 fail-soft 投递 → 历史落盘 → 返回受理结果。
 *
 * 内置频道经 index.ts 装配：实例入投递池（builtinChannels），播放决议随裁决
 * 快照解析并经 play 值传递（browser→SSE 帧 / system→notify，D23）。
 */
export function createNotifierService(deps: NotifierServiceDeps): NotifierServiceInternal {
  const { current, enabled, history, logger, outboundChannels, builtinChannels, recordStatus, emitSent, setConfirm, play } = deps;

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

  /**
   * 投递池解析（裁决时随快照调用——B-2 单刻语义：启用条件与播放决议全部基于
   * 传入快照，派生闭包不得自行读 current）。内置频道按「弹窗开关 || 声音非静音」
   * 进入（#640/#641：弹窗关 + 声音开 → 只响不弹投递）；出站频道 enabled 过滤
   * 由装配层保证。
   */
  function allChannels(snapshot: NotifyConfig): ChannelPoolEntry[] {
    const out: ChannelPoolEntry[] = [];
    const browser = builtinChannels.find((c) => c.id === BUILTIN_CHANNELS.browser);
    const browserSound = resolveSoundSetting(snapshot, "browser");
    if (browser && (snapshot.browserNotify || browserSound !== false)) {
      const pop = snapshot.browserNotify === true;
      out.push({ ...browser, dispatch: { pop, sound: encodeBrowserSound(browserSound, pop) } });
    }
    const system = builtinChannels.find((c) => c.id === BUILTIN_CHANNELS.system);
    const systemSound = resolveSoundSetting(snapshot, "system");
    if (system && (snapshot.systemNotify || systemSound !== false)) {
      out.push({ ...system, dispatch: { pop: snapshot.systemNotify === true, sound: systemSound } });
    }
    try {
      out.push(...outboundChannels());
    } catch (error) {
      logger.warn(`dsh-notifier: 出站频道读取失败（fail-soft 跳过）: ${error instanceof Error ? error.message : String(error)}`);
    }
    return out;
  }

  const adjudicate = createAdjudicator({
    current,
    enabled,
    isKindConfirmed: (kind, snapshot) => isKindConfirmed(kind, kindRegistry, snapshot),
    allChannels,
  });

  const deliver = createDeliverer({
    recordStatus,
    emitSent,
    appendHistory,
    play,
  });

  /**
   * 裁决结果 → 受理结果（suppressed：disabled 不落史（D15）/kind-pending、quiet
   * 落史 + skipped；deliver：stale warn + 全链投递 + 落史）。
   * B-1/B-4：统一脱敏时点 = 渲染完成后、任何落史/投递前——裁决结果已携带快照
   * 解析的 sanitizeContent 开关（B-2 单刻契约：此处不得二次调用 current()），
   * 本函数按开关对结果文本统一脱敏一次后落入历史/投递。
   */
  function handleDecision(decision: AdjudicateResult): NotifyResult[] {
    if (decision.decision === "suppressed") {
      const { kind, title, body, ts, reason, sanitizeContent } = decision;
      if (reason === "disabled") {
        return [{ channelId: "*", status: "skipped", error: "enabled=false" }];
      }
      const safe = sanitizeNoticeContent({ title, body }, sanitizeContent);
      if (reason === "quiet") {
        logger.info(`dsh-notifier: ${kind} 被免打扰拦截（未发出）：${safe.body.replace(/\n/g, " / ")}`);
      }
      appendHistory({ ts, kind, title: safe.title, message: safe.body, suppressed: reason });
      return [{ channelId: "*", status: "skipped", error: reason }];
    }
    const notice = decision.notice;
    for (const id of notice.stale) {
      logger.warn(`dsh-notifier: kindRoutes[${notice.kind}] 指向已删除频道 ${id}，记 skipped`);
    }
    const safe = sanitizeNoticeContent({ title: notice.title, body: notice.body }, notice.sanitizeContent);
    const results = deliver({ ...notice, title: safe.title, body: safe.body });
    logger.info(`dsh-notifier: ${notice.kind} ${safe.body.replace(/\n/g, " / ")}`);
    return results;
  }

  /**
   * 统一通知管线（kind 形态，等价搬移前的 notify）。外部 send() 与内置事件源
   * 都经它收敛（评审 #1）——send() 动态 kind 自 B-9 起同样过裁决全链。
   * B-1：渲染文本原样进裁决（其结果携带脱敏开关），统一脱敏在其后
   * handleDecision 内按开关执行——本函数不再自行读 current()（B-2 单刻契约）。
   * @returns 受理结果数组（投递终态经历史落盘与 wingsky-notify/sent 事件可见）。
   */
  function sendKind(kind: string, detail: NotifyDetail = {}, opts?: { bypassQuiet?: boolean; onlyChannel?: string }): NotifyResult[] {
    const spec = NOTIFY_KINDS[kind];
    const ts = Date.now();
    const title = spec?.title ?? "DSH 通知";
    const message = spec?.message({ ...detail, ts }) ?? detail.message ?? "";
    const decision = adjudicate({
      kind,
      title,
      body: message,
      severity: KIND_SEVERITY[kind],
      ts,
      bypassQuiet: opts?.bypassQuiet,
      onlyChannel: opts?.onlyChannel,
    });
    return handleDecision(decision);
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
      // 动态 kind：与 sendKind 统一过裁决全链（B-9/D24——enabled/免打扰不再绕过；
      // title/body 直通不经 NOTIFY_KINDS 文案模板，severity 直通）；B-4 中心
      // 兜底：动态 kind body 从「调用方负责脱敏」变「send 统一脱敏」（B-4，
      // 开关由裁决结果携带，本分支不自行读 current()）。
      const ts = Date.now();
      const title = req.title ?? "DSH 通知";
      const body = String(req.body ?? "");
      const decision = adjudicate({ kind, title, body, severity: req.severity, ts });
      return handleDecision(decision);
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