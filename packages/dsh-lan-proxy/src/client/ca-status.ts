/**
 * dsh-lan-proxy — 一键 CA 客户端提醒判定（issue #930 F8 展示层）。
 *
 * 纯函数：health.certInfo 快照 → 到期 / IP 变化提醒。到期阈值 30 天（复用
 * certStillValid 口径风格：剩余有效期与阈值比较）。解析不出即不提醒
 * （展示层 fail-open；下发端仍按三态如实 404，不依赖本判定）。
 */

/** 叶子到期提醒阈值（毫秒）：剩余有效期低于 30 天即提醒轮换。 */
export const LEAF_EXPIRY_WARN_MS = 30 * 86400 * 1000;

/** certInfo 读子集（health 快照经 HTTP 后的形态；缺键容错）。 */
export interface CertInfoView {
  leafValidTo?: unknown;
  leafSans?: unknown;
  currentIps?: unknown;
}

/** 提醒结果（调用方按 httpsEnabled 与 caState 决定是否渲染）。 */
export interface CaWarnings {
  expiring: boolean;
  ipChanged: boolean;
}

/**
 * X509 subjectAltName 原串中的 IP 条目（"IP Address:1.2.3.4" 前缀；DNS 条目
 * 与非字符串一律忽略——丢弃未知形态，不抛错）。
 */
export function sanIps(sans: unknown): string[] {
  if (!Array.isArray(sans)) return [];
  const prefix = "IP Address:";
  const out: string[] = [];
  for (const entry of sans) {
    if (typeof entry === "string" && entry.startsWith(prefix)) {
      out.push(entry.slice(prefix.length));
    }
  }
  return out;
}

/**
 * 提醒判定：到期（validTo 可解析且剩余 < 30 天）与 IP 变化（当期非回环 IP
 * 存在未被 SAN 覆盖者；当期为空即无法判断，不提醒）。
 */
export function evaluateCaWarnings(info: CertInfoView, nowMs: number): CaWarnings {
  let expiring = false;
  if (typeof info.leafValidTo === "string") {
    const validTo = Date.parse(info.leafValidTo);
    if (!Number.isNaN(validTo)) expiring = validTo - nowMs < LEAF_EXPIRY_WARN_MS;
  }
  const current = Array.isArray(info.currentIps)
    ? info.currentIps.filter((ip): ip is string => typeof ip === "string")
    : [];
  const covered = new Set(sanIps(info.leafSans));
  return { expiring, ipChanged: current.length > 0 && current.some((ip) => !covered.has(ip)) };
}
