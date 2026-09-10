/**
 * dsh-notifier — 推送管线域：裁决（PR1 机械提炼自 sdk/service 旧 createNotifierService）。
 *
 * 本文件承载现状「判定」语义：内置 kind 判定（NOTIFY_KINDS 表）、动态 kind
 * 确认态判定（注册表 + 配置 allowKinds 持久化确认）、路由解析（启用频道 ∩
 * kindRoutes 稀疏覆盖；指向已删频道的 id 记 stale）。PR2 行为重构在此上移
 * current() 单刻快照与 AdjudicateDeps 注入面（B-2）——PR1 仅搬家，函数体与
 * 调用时序与提炼前完全一致（current() 仍实时读取）。
 */
import { NOTIFY_KINDS } from "../text/interface.ts";
import type { NotifyConfig } from "../config/interface.ts";
import { BUILTIN_CHANNELS } from "../sdk/interface.ts";
import type { NotifyChannel } from "../sdk/interface.ts";

/** 内置 kind 恒可用（无需确认）。 */
export function isBuiltinKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTIFY_KINDS, kind);
}

/**
 * 动态 kind 是否获用户确认（确认态持久化在配置 allowKinds；未注册/未确认 → 抑制）。
 * @param kindRegistry 动态 kind 注册表（id → label；createNotifierService 持有）。
 * @param current 当前生效配置实时读取器（确认态读面）。
 */
export function isKindConfirmed(kind: string, kindRegistry: Map<string, { label: string }>, current: () => NotifyConfig): boolean {
  if (isBuiltinKind(kind)) return true;
  if (!kindRegistry.has(kind)) return false;
  const allowed = current().allowKinds;
  return Array.isArray(allowed) && allowed.includes(kind);
}

/**
 * 路由解析（终稿 §4.6）：实际投递集合 = 启用频道 ∩ (kindRoutes[kind] ?? '*')。
 * 缺省（无条目）= 广播全部启用频道；稀疏条目命中才投递；条目里指向已删除
 * 频道（配置 channels 中不存在）的 id 记入 stale（skipped + warn，不影响其他）。
 * onlyChannel（per-channel 测试）直接命中单频道并绕过路由。
 * @param allChannels 投递集合实时解析（sdk 域提供；含内置 + 配置驱动频道）。
 */
export function resolveRoutes(args: {
  kind: string;
  onlyChannel?: string;
  allChannels: () => Array<{ id: string; channel: NotifyChannel }>;
  current: () => NotifyConfig;
}): { targets: Array<{ id: string; channel: NotifyChannel }>; stale: string[] } {
  const { kind, onlyChannel, allChannels, current } = args;
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
  // #508 M2（复核 4②）：频道路由 id = `type:id`（与客户端 channelIdFor / 宿主
  // outboundChannels 同语义；bark/webhook 通用，未来频道类型天然兼容）
  for (const c of current().channels ?? []) known.add(`${c.type}:${c.id}`);
  const stale = routes.filter((id) => !known.has(id));
  return { targets, stale };
}