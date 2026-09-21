/**
 * dsh-provider-usage — server/shared 时间解析叶子（#768 A波1）。
 *
 * parseHHMM 的 canonical 落点（由 server/config/normalize.ts:33 纯下沉，表达式逐字一致，
 * 零行为变更）。共享层准入：无单一所有者（config 归一化 + schedule 到期判定双消费）、
 * 零依赖纯函数（零 import）、≥2 正当消费者。目录外经 server/shared/interface.ts 消费，
 * 旧址 server/config/normalize.ts 保留 re-export 门面（生产与测试同源，均经 shared 门面）。
 */

/** HH:MM 解析（非法返回 null；notifier quiet-hours 同款严格性）。 */
export function parseHHMM(v: unknown): { h: number; m: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (m === null) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mm) || h < 0 || h > 23 || mm < 0 || mm > 59)
    return null;
  return { h, m: mm };
}
