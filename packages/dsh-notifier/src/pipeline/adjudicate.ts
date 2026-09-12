/**
 * dsh-notifier — 推送管线域：裁决（工厂化 + current() 单刻快照）。
 *
 * createAdjudicator 每次裁决取局部单刻快照（deps.current() 恰好一次），快照
 * 贯穿 enabled → 确认 → 免打扰 → 路由 → 播放决议解析——裁决与投递之间改配置
 * 不影响本次投递（有意行为变更，测试锁定）。播放决议随投递池条目携带
 * （deps.allChannels 在快照上解析内置频道启用条件与 spec，调用方经注入面提供）。
 * isBuiltinKind 保留导出供 sdk registerKind 防冒认。
 */
import { BUILTIN_CHANNELS, isInQuietHours } from "../config/interface.ts";
import type { NotifyConfig } from "../config/interface.ts";
import { NOTIFY_KINDS, normalizeSeverity } from "../text/interface.ts";
import type { AdjudicateDeps, AdjudicateOptions, AdjudicateResult, AdjudicatedNotice, ChannelPoolEntry } from "./interface.ts";

/** 内置 kind 恒可用（无需确认）。 */
export function isBuiltinKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTIFY_KINDS, kind);
}

/**
 * 动态 kind 是否获用户确认（确认态持久化在配置 allowKinds；未注册/未确认 → 抑制）。
 * @param kindRegistry 动态 kind 注册表（id → label；createNotifierService 持有）。
 * @param snapshot 裁决单刻快照（确认态读面——不再实时读取 current）。
 */
export function isKindConfirmed(kind: string, kindRegistry: Map<string, { label: string }>, snapshot: NotifyConfig): boolean {
  if (isBuiltinKind(kind)) return true;
  if (!kindRegistry.has(kind)) return false;
  const allowed = snapshot.allowKinds;
  return Array.isArray(allowed) && allowed.includes(kind);
}

/**
 * 路由解析：实际投递集合 = 启用频道池 ∩ (kindRoutes[kind] ?? '*')。
 * 缺省（无条目）= 广播全部启用频道；稀疏条目命中才投递；条目里指向已删除
 * 频道（配置 channels 中不存在）的 id 记入 stale（skipped + warn，不影响其他）。
 * onlyChannel（per-channel 测试）直接命中单频道并绕过路由。
 * @param pool 已按裁决快照解析的投递池（含内置频道播放决议）。
 * @param snapshot 裁决单刻快照（kindRoutes 读面）。
 */
export function resolveRoutes(args: {
  kind: string;
  onlyChannel?: string;
  pool: ChannelPoolEntry[];
  snapshot: NotifyConfig;
}): { targets: ChannelPoolEntry[]; stale: string[] } {
  const { kind, onlyChannel, pool, snapshot } = args;
  if (onlyChannel) {
    return { targets: pool.filter((t) => t.id === onlyChannel), stale: [] };
  }
  const routes = snapshot.kindRoutes?.[kind];
  if (!Array.isArray(routes) || routes.length === 0) {
    return { targets: pool, stale: [] };
  }
  const set = new Set(routes);
  const targets = pool.filter((t) => set.has(t.id));
  const known = new Set<string>([BUILTIN_CHANNELS.browser, BUILTIN_CHANNELS.system]);
  // 频道路由 id = `type:id`（与客户端 channelIdFor / 宿主 outboundChannels 同语义；
  // bark/webhook 通用，未来频道类型天然兼容）
  for (const c of snapshot.channels ?? []) known.add(`${c.type}:${c.id}`);
  const stale = routes.filter((id) => !known.has(id));
  return { targets, stale };
}

/**
 * 创建裁决器（工厂闭包：deps 在实例生命周期固定；current() 每次裁决恰好 1 次）。
 * @returns adjudicate(opts) → AdjudicateResult。
 */
export function createAdjudicator(deps: AdjudicateDeps): (opts: AdjudicateOptions) => AdjudicateResult {
  return function adjudicate(opts: AdjudicateOptions): AdjudicateResult {
    // 单刻快照——本次裁决全部读面（确认态/免打扰/路由/播放决议）共用此
    // 对象；后续任何配置变更不影响本次判定结果（派生闭包只经快照取值）。
    const snapshot = deps.current();
    const { kind, title, body, ts, bypassQuiet, onlyChannel } = opts;
    // severity 入口校验（#733 M2-3.4）：类型联合只在编译期存在，跨宿主边界传来的值
    //（未类型化调用方 / 配置 / JSON）不受它约束。裁决是通知进入投递管线的唯一入口，
    // 故校验与归一只在此处做一次——非法值回落「未提供」，由下游既有缺省路径接管，
    // 不新造第二套默认值语义（见 text/message.ts normalizeSeverity）。
    const severity = normalizeSeverity(opts.severity);
    // 脱敏开关随快照解析并随结果携带（快照缺键 → undefined 容错为 true），
    // 编排层据其统一脱敏——不开第二次 current()（单刻契约）。
    const sanitizeContent = snapshot.sanitizeContent !== false;

    if (deps.enabled() === false) {
      return { decision: "suppressed", reason: "disabled", kind, title, body, ts, sanitizeContent };
    }
    if (!deps.isKindConfirmed(kind, snapshot)) {
      return { decision: "suppressed", reason: "kind-pending", kind, title, body, ts, sanitizeContent };
    }
    if (!bypassQuiet && isInQuietHours(new Date(), snapshot.quietHours)) {
      const allowed = snapshot.quietHours.allowKinds ?? [];
      if (!allowed.includes(kind)) {
        return { decision: "suppressed", reason: "quiet", kind, title, body, ts, sanitizeContent };
      }
    }
    const { targets, stale } = resolveRoutes({ kind, onlyChannel, pool: deps.allChannels(snapshot), snapshot });
    const notice: AdjudicatedNotice = { kind, title, body, severity, ts, targets, stale, sanitizeContent };
    return { decision: "deliver", notice };
  };
}