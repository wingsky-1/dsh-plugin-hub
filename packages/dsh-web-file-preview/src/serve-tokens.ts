/**
 * dsh-web-file-preview — serve token 映射管理（issue #73，纯逻辑、无 node:http 依赖）。
 *
 * 进程级懒起单例 token 映射：token → 只读 root 目录，serve 路由据此伺服
 * HTML 预览工程。内存态映射——不落盘、不拷贝，进程崩溃即消失（无陈旧目录可扫）。
 *
 * 生命周期（spec B 组）：
 *  - alloc   ：分配随机 token（128-bit，防枚举），root = HTML 文件所在目录（realpath 后）；
 *  - serve 命中：刷新闲置计时（idle 语义，B3a）；
 *  - TTL     ：闲置超过 ttlMs 的 token 在下次访问时被回收（懒回收，无定时器泄漏）；
 *  - LRU     ：达到 maxTokens 上限时淘汰「最久未用且非活跃」的 token——活跃 =
 *    近 activeWindowMs 内有 serve 命中（客户端已建 iframe 的预览正在取资源），
 *    不淘汰活跃预览（B4a）；全部活跃时拒绝新分配（防泄漏优先于可用性）；
 *  - release ：显式释放（客户端 closeModal 上报，B5），幂等。
 *
 * 数值为「实现层可调项」（spec B3b/B4b），默认值记录于 README：
 *  - ttlMs        = 30min（预览长期不交互失效兜底）
 *  - activeWindowMs = 5min（iframe 打开期间子资源请求持续刷新，关闭后自然降级）
 *  - maxTokens    = 64（并发预览上限）
 */
import { randomBytes } from "node:crypto";
export interface ServeTokenEntry {
  /** 只读 root（token 分配时 fs.realpath 后的目录绝对路径）。 */
  root: string;
  /** 最近一次 serve 命中的时间戳（ms，now() 注入源）。 */
  lastHit: number;
}

export interface TokenStoreOptions {
  /** 时钟注入（测试拨表用）；默认 Date.now。 */
  now?: () => number;
  /** 闲置 TTL（ms）；默认 30min。 */
  ttlMs?: number;
  /** 并发 token 上限；默认 64。 */
  maxTokens?: number;
  /** 活跃判定窗口（ms）：最近 activeWindowMs 内有 serve 命中视为活跃；默认 5min。 */
  activeWindowMs?: number;
}

export interface TokenStore {
  /** 分配 token；达到上限且无 LRU 可淘汰项时返回 null（调用方 400/429）。 */
  alloc(root: string): string | null;
  /** 按 token 取条目并刷新闲置计时；未知 / 已过期 → undefined（serve 命中路径）。 */
  get(token: string): ServeTokenEntry | undefined;
  /** 显式释放（幂等）；不存在返回 false。 */
  release(token: string): boolean;
  /** 当前存活 token 数（测试/诊断）。 */
  size(): number;
  /** 只读快照（测试断言）。 */
  snapshot(): Map<string, ServeTokenEntry>;
}

/** 默认值（README 记录的声明值；spec B3b/B4b 实现层可调项）。 */
export const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_TOKEN_MAX = 64;
export const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export function createTokenStore(options?: TokenStoreOptions): TokenStore {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  const maxTokens = options?.maxTokens ?? DEFAULT_TOKEN_MAX;
  const activeWindowMs = options?.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;

  /** token → 条目（模块级单例由调用方持有）。 */
  const entries = new Map<string, ServeTokenEntry>();

  /** 上次 sweep 见过的最大时钟值（评审 P2-2：时钟回拨兜底——回拨时以 max 计算
   * cutoff，防止 lastHit 恒大于 cutoff 导致 TTL 永不回收；NTP 校正/休眠唤醒场景）。 */
  let maxClockSeen = now();

  /** 懒回收：删除所有闲置超时的 token（alloc/get 时调用，O(n)，n ≤ maxTokens）。 */
  function sweepExpired(): void {
    const current = now();
    if (current > maxClockSeen) maxClockSeen = current;
    const cutoff = maxClockSeen - ttlMs;
    for (const [token, entry] of entries) {
      if (entry.lastHit < cutoff) entries.delete(token);
    }
  }

  /** 该 token 是否处于活跃窗口内（LRU 淘汰候选排除活跃预览）。 */
  function isActive(entry: ServeTokenEntry): boolean {
    const current = now();
    if (current > maxClockSeen) maxClockSeen = current;
    return maxClockSeen - entry.lastHit <= activeWindowMs;
  }

  /** LRU 淘汰：移除最久未用且非活跃的 token；返回是否腾出空位。 */
  function evictOne(): boolean {
    let victim: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [token, entry] of entries) {
      if (isActive(entry)) continue; // 不淘汰活跃预览（B4a）
      if (entry.lastHit < oldest) {
        oldest = entry.lastHit;
        victim = token;
      }
    }
    if (victim === undefined) return false;
    entries.delete(victim);
    return true;
  }

  return {
    alloc(root: string): string | null {
      sweepExpired();
      if (entries.size >= maxTokens && !evictOne()) return null; // 全部活跃 → 拒绝新分配
      let token: string;
      do {
        // 128-bit 随机串：不可枚举（A3 未知 token 404 的信息面收敛到猜中概率≈0）。
        token = randomToken();
      } while (entries.has(token));
      entries.set(token, { root, lastHit: now() });
      return token;
    },
    get(token: string): ServeTokenEntry | undefined {
      sweepExpired();
      const entry = entries.get(token);
      if (entry === undefined) return undefined;
      entry.lastHit = now(); // idle 语义：每次 serve 命中刷新闲置计时（B3a）
      return entry;
    },
    release(token: string): boolean {
      return entries.delete(token);
    },
    size(): number {
      return entries.size;
    },
    snapshot(): Map<string, ServeTokenEntry> {
      return new Map(entries);
    },
  };
}

/** 128-bit 随机 hex（node:crypto randomBytes；进程级安全随机源）。 */
function randomToken(): string {
  return randomBytes(16).toString("hex");
}
