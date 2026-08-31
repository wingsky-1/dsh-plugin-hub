/**
 * dsh-notifier — Bark 推送频道（M2，issue #366）。
 *
 * 职责：BarkChannelConfig → NotifyChannel 适配。发送走 Bark API V2 标准形态
 * `POST {baseUrl}/push` + JSON body（device_key 走 body 不落 URL——反代 access
 * log 默认只记 URL 与 header，正文不落日志；已实测本地 bark-server 200）。
 *
 * 可靠性（设计终稿 §四 + 评审 P1 修订）：
 * - 10s 硬超时（AbortSignal.timeout）；
 * - 重试 ×2 仅针对网络错误/超时/5xx（幂等重试面）；4xx 是确定失败不重试；
 * - 实例级在途并发 ≤2（BarkGate 按 cfg.id 键控，跨配置变更延续）——内置
 *   频道（browser/system）不经此门，防止慢出站拖住实时推送（评审 P1）；
 * - 成功判定双查：HTTP 2xx + 响应体 code===200（部分反代会 200 包错误页）；
 * - 错误出口统一脱敏：device key 字面替换 → sanitizeErrorText 通用表——
 *   已实测 bark-server 4xx 响应体会回显 key 原文（评审 P0-4）。
 *
 * level 映射（评审 P0-2 契约）：severity → Bark level 单点映射（SEVERITY_LEVEL）；
 * 实例配置显式 level 覆盖映射；severity 缺省且无显式配置时不携带 level。
 */
import { SECRET_MASK } from "./config.ts";
import type { BarkChannelConfig } from "./config.ts";
import type { NotifyChannel, NotifySeverity } from "./service.ts";
import { sanitizeErrorText } from "./message.ts";

/** severity → Bark level 静态映射（契约测试锁定；critical 需苹果特批故不映射）。 */
export const SEVERITY_LEVEL: Readonly<Record<NotifySeverity, "active" | "timeSensitive" | "passive" | "critical">> = {
  failure: "timeSensitive",
  warning: "active",
  success: "active",
  info: "passive",
};

/** 单次推送硬超时（毫秒；设计终稿 §四）。 */
export const BARK_TIMEOUT_MS = 10_000;
/** 网络错误/5xx 重试次数（总尝试 = 1 + BARK_RETRIES）。 */
export const BARK_RETRIES = 2;
/** 实例级在途并发上限（评审 P1：per-channel 限流，内置频道豁免）。 */
export const BARK_MAX_INFLIGHT = 2;

/** Bark 实例级在途限流门（按 cfg.id 键控存于装配层，跨配置变更延续）。 */
export interface BarkGate {
  inflight: number;
  queue: Array<() => void>;
}

export function createBarkGate(): BarkGate {
  return { inflight: 0, queue: [] };
}

/** 4xx 类确定失败（不参与重试）。 */
class BarkHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`bark HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

/** createBarkChannel 已知的顶层配置键（透传键 = 此集合之外的 string/number 键）。 */
const BARK_KNOWN_TOP_KEYS: readonly string[] = ["id", "name", "type", "baseUrl", "deviceKey", "enabled", "sound", "level", "group", "icon", "url", "badge"];

/**
 * Bark 频道实例工厂。
 * @param cfg 实例配置（normalizeConfig 已归一化）。
 * @param gate 实例级限流门（同 id 复用同一实例；装配层持有）。
 * @returns NotifyChannel——send() 返回在途 promise（resolve=终态成功 /
 *   reject=终态失败，错误已脱敏），调用方据此记录 status；send 本身不抛同步错。
 */
export function createBarkChannel(cfg: BarkChannelConfig, gate: BarkGate): NotifyChannel {
  // 错误出口脱敏：先按 device key 字面替换（key 多为 22 位 base62，通用规则表
  // 覆盖不到），再过 sanitizeErrorText 有序表 + 截断（评审 P0-4 收口）。
  const scrub = (text: string): string => sanitizeErrorText(String(text).split(cfg.deviceKey).join(SECRET_MASK), 300);

  /** 单次 POST（不含重试）。非 2xx 抛 BarkHttpError；2xx 但 body code!==200 视为失败。 */
  async function postOnce(payload: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/push`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: payload,
        signal: AbortSignal.timeout(BARK_TIMEOUT_MS),
      });
    } catch (error) {
      // fetch 层失败（网络/超时/DNS）：统一为可重试错误
      throw new Error(`bark 请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200); // 4xx 响应体可能回显 key → scrub
      } catch {
        // 响应体读不到：仅状态码
      }
      throw new BarkHttpError(res.status, scrub(detail));
    }
    // 成功判定双查（评审 P1）：HTTP 2xx + body code===200；无 body/非 JSON 保守放行
    try {
      const body = (await res.json()) as { code?: unknown; message?: unknown };
      if (body && typeof body === "object" && "code" in body && body.code !== 200) {
        throw new Error(`bark code ${String(body.code)}: ${scrub(String(body.message ?? ""))}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) return; // 非 JSON 响应：HTTP 2xx 已足够
      throw error;
    }
  }

  /** 带重试的单条投递：网络/超时/5xx 重试 ×2；4xx 立即失败。 */
  async function sendWithRetry(payload: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= BARK_RETRIES; attempt += 1) {
      try {
        await postOnce(payload);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof BarkHttpError && error.status >= 400 && error.status < 500) throw error;
        // 网络错误/超时/5xx：退避后重试（1s/2s 线性退避，简单够用）
        if (attempt < BARK_RETRIES) await new Promise<void>((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  /** 经限流门的投递（在途 ≥2 时排队）。 */
  async function sendWithGate(payload: string): Promise<void> {
    if (gate.inflight >= BARK_MAX_INFLIGHT) {
      await new Promise<void>((resolve) => gate.queue.push(resolve));
    }
    gate.inflight += 1;
    try {
      return await sendWithRetry(payload);
    } finally {
      gate.inflight -= 1;
      const next = gate.queue.shift();
      if (next) next();
    }
  }

  return {
    name: `bark:${cfg.id}`,
    // capabilities：Bark 无硬性服务端限制，取合理客户端体验值（标题一行约 64
    // 码点；正文 4096 码点兜底截断）。框架层 truncateCodePoints 统一执行。
    capabilities: { titleMaxLen: 64, maxBodyLen: 4096 },
    send(payload) {
      // 组装 body：必填三键 + severity→level（显式配置覆盖映射）+ 可选参数 + 透传键
      const body: Record<string, unknown> = {
        device_key: cfg.deviceKey,
        title: payload.title,
        body: payload.body,
      };
      const level = cfg.level ?? (payload.severity ? SEVERITY_LEVEL[payload.severity] : undefined);
      if (level) body.level = level;
      if (cfg.sound !== undefined) body.sound = cfg.sound;
      if (cfg.group !== undefined) body.group = cfg.group;
      if (cfg.icon !== undefined) body.icon = cfg.icon;
      if (cfg.url !== undefined) body.url = cfg.url;
      if (cfg.badge !== undefined) body.badge = cfg.badge;
      // 未知参数透传（normalizeConfig 已做类型过滤与保留键剔除；此处仅摘出）
      for (const [key, value] of Object.entries(cfg)) {
        if ((BARK_KNOWN_TOP_KEYS as readonly string[]).includes(key)) continue;
        body[key] = value;
      }
      // fire-and-forget 语义由调用方（service dispatch）决定是否等待——本方法
      // 返回在途 promise 且不抛同步错（排队与重试都在 promise 内）。
      return sendWithGate(JSON.stringify(body));
    },
  };
}
