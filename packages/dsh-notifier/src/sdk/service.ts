/**
 * dsh-notifier — SDK 契约域：通知中心核心服务实现（'wingsky.notifier'）。
 *
 * 本模块是**包 ABI 适配器**：只持有 2 张注册表（kindRegistry/channelRegistry）与
 * 5 方法薄适配；编排（渲染 → 裁决 → 统一脱敏 → 落史 + fail-soft 投递）全部在
 * pipeline 域（createSendKind/createHandleDecision/resolveChannelPool/
 * createDeliverer）。内置频道经 index.ts 注入（builtinChannels + play，
 * sdk→channels 值边消除）；send() 动态 kind 与 sendKind 统一过裁决全链
 * （enabled→确认→免打扰→路由）。
 * 域间只剩 pipeline 值边 + config/pipeline/stores/text 的 type 边（编排迁出后
 * 本域不再取值 config/text 的符号；BUILTIN_CHANNELS 归 config 并由编排层消费）。
 *
 * 兼容红线：SSE 帧契约、历史 jsonl、免打扰/suppressed/多标签租约
 * 全部保持——本模块只做管线收敛，不改出口语义。
 */
import { createAppendHistory, createAdjudicator, createDeliverer, createHandleDecision, createSendKind, isBuiltinKind, isKindConfirmed, resolveChannelPool } from "../pipeline/interface.ts";
import type { AdjudicateResult, ChannelPoolEntry } from "../pipeline/interface.ts";
import type { NotifyConfig } from "../config/interface.ts";
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
 * 管线（编排在 pipeline 域，本模块只装配注入面）：
 *   enabled 判定 → kind 动态未确认 → suppressed 落史 → 免打扰检查（被拦截
 *   也落 suppressed 历史）→ 逐频道 fail-soft 投递 → 历史落盘 → 返回受理结果。
 *
 * 内置频道经 index.ts 装配：实例入投递池（builtinChannels），播放决议随裁决
 * 快照解析并经 play 值传递（browser→SSE 帧 / system→notify）。
 */
export function createNotifierService(deps: NotifierServiceDeps): NotifierServiceInternal {
  const { current, enabled, history, logger, outboundChannels, builtinChannels, recordStatus, emitSent, setConfirm, play } = deps;

  /** 动态 kind 注册表（id → label；确认态持久化在配置 allowKinds——重启后不丢失）。 */
  const kindRegistry = new Map<string, { label: string }>();
  /** 插件贡献频道注册表（name → channel；默认未启用，MVP 仅存表）。 */
  const channelRegistry = new Map<string, NotifyChannel>();

  /** 历史追加（fire-and-forget：落史失败只 warn，不打断编排）。 */
  const appendHistory = createAppendHistory({ append: (entry) => history.append(entry), logger });

  const deliver = createDeliverer({ recordStatus, emitSent, appendHistory, play });

  /** 统一脱敏时点与 suppressed 分叉（编排实现在 pipeline 域）。 */
  const handleDecision = createHandleDecision({ deliver, appendHistory, logger });

  /** 投递池解析（裁决时随快照调用——单刻语义：派生闭包不得自行读 current）。 */
  const allChannels = (snapshot: NotifyConfig): ChannelPoolEntry[] =>
    resolveChannelPool(snapshot, { builtinChannels, outboundChannels, logger });

  const adjudicate = createAdjudicator({
    current,
    enabled,
    isKindConfirmed: (kind, snapshot) => isKindConfirmed(kind, kindRegistry, snapshot),
    allChannels,
  });

  /** 统一通知管线（kind 形态，编排实现在 pipeline 域；本工厂不读 current()）。 */
  const sendKind = createSendKind({ adjudicate, handleDecision });

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
      // 确认态持久化到配置 allowKinds（重启后不丢失）；fire-and-forget
      setConfirm(kind, confirmed);
    },

    listKinds() {
      const allowed = current().allowKinds;
      const allowedSet = Array.isArray(allowed) ? new Set(allowed) : new Set<string>();
      return [...kindRegistry.entries()].map(([id, v]) => ({ id, label: v.label, confirmed: allowedSet.has(id) }));
    },

    registerChannel(ch: NotifyChannel) {
      // 配置层注册面（D11）：登记即止，注册表不参与裁决与投递解析——投递池由
      // outboundChannels/builtinChannels 两个注入面给出，与本注册表无关。
      if (typeof ch?.name !== "string" || typeof ch?.send !== "function") return;
      channelRegistry.set(ch.name, ch);
    },

    async send(req: NotifyRequest) {
      // 形状守卫：不匹配转结构化结果，不抛异常
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
      // 动态 kind：与 sendKind 统一过裁决全链（enabled/免打扰不再绕过；
      // title/body 直通不经 NOTIFY_KINDS 文案模板，severity 直通）；中心
      // 兜底：动态 kind body 从「调用方负责脱敏」变「send 统一脱敏」（开关由
      // 裁决结果携带，本分支不自行读 current()）。
      const ts = Date.now();
      const title = req.title ?? "DSH 通知";
      const body = String(req.body ?? "");
      const decision: AdjudicateResult = adjudicate({ kind, title, body, severity: req.severity, ts });
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