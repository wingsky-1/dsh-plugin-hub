/**
 * dsh-notifier 客户端 —— 多标签主从租约。
 *
 * 同一个 URL 在同一个浏览器里开多个标签时，只有持租约的那个标签提醒，其余静默；租约过期即被
 * 抢占。storage 与时钟都从参数进来，判定因此可以在 node 里被穷举——这是原先拿不到的
 * （它直接读写 localStorage 与 Date.now）。
 *
 * 两条行为是刻意的，别在重写时「修正」：
 * 1. 任何异常（storage 不可用、JSON 损坏）一律放行（返回 true）——宁可在多标签下重复提醒，
 *    也不要在隐私模式/受限环境里彻底不提醒；
 * 2. 租约身份是**跨实例共享**的量（同一页面重新挂载仍是同一个标签），所以 tabId 由调用方
 *    持有并复用，而不是每次装配新生成一个。
 */

/** storage 键与租约时长。 */
export const MASTER_KEY = "dsh-notifier:master";
export const MASTER_LEASE_MS = 15000;

/** 租约判定要用到的两类外部事实。 */
export interface LeasePorts {
  now(): number;
  read(): string | null;
  write(value: string): void;
}

function parseLease(raw: string | null): Record<string, unknown> | null {
  // 假值（含空串）一律当「没有租约」：这不是防御性写法而是既有语义——storage 里出现空串时
  // 旧实现直接抢占并写入，若改成 JSON.parse("") 会走异常分支返回 true 但**不写**租约，
  // 于是后续每个标签都各自放行（多标签重复提醒）。
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const lease = value as Record<string, unknown>;
  if (typeof lease.id !== "string" || typeof lease.ts !== "number") return null;
  return lease;
}

/**
 * 取租约：持租约且未过期 → 续租并返回 true；属于别的标签且未过期 → false；无主/已过期 → 抢占。
 */
export function claimMaster(tabId: string, ports: LeasePorts): boolean {
  try {
    const lease = parseLease(ports.read());
    const now = ports.now();
    const ts = lease === null ? undefined : lease.ts;
    if (lease !== null && typeof ts === "number" && now - ts < MASTER_LEASE_MS) {
      if (lease.id === tabId) {
        // 保留解析出的其它键：租约节点将来加字段时，续租不该把它们抹掉
        ports.write(JSON.stringify(Object.assign({}, lease, { ts: now })));
        return true;
      }
      return false;
    }
    ports.write(JSON.stringify({ id: tabId, ts: now }));
    return true;
  } catch {
    return true;
  }
}
