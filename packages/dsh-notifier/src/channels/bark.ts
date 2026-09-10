/**
 * dsh-notifier — Bark 推送频道（M2，issue #366）。
 *
 * 职责：BarkChannelConfig → NotifyChannel 适配。发送走 Bark API V2 标准形态
 * `POST {baseUrl}/push` + JSON body（device_key 走 body 不落 URL——反代 access
 * log 默认只记 URL 与 header，正文不落日志；已实测本地 bark-server 200）。
 *
 * 可靠性（B-3 上移后）：
 * - 10s 硬超时（AbortSignal.timeout）——超时归属 channel 侧，不动；
 * - 重试/并发门已上移框架 pipeline/deliver（capabilities.retry/maxInflight
 *   声明 + RetryableError 错误标注）；channel 只保留单次投递；
 * - 成功判定双查：HTTP 2xx + 响应体 code===200（部分反代会 200 包错误页）；
 * - 错误出口统一脱敏：device key 字面替换 → sanitizeErrorText 通用表——
 *   已实测 bark-server 4xx 响应体会回显 key 原文（评审 P0-4）。
 *
 * level 映射（评审 P0-2 契约）：severity → Bark level 单点映射（SEVERITY_LEVEL）；
 * 实例配置显式 level 覆盖映射；severity 缺省且无显式配置时不携带 level。
 */
import { SECRET_MASK } from "../config/interface.ts";
import type { BarkChannelConfig, BarkLevel } from "../config/interface.ts";
import type { NotifyChannel, NotifySeverity, RetryableError } from "../sdk/interface.ts";
import { sanitizeErrorText } from "../text/interface.ts";

/** severity → Bark level 静态映射（契约测试锁定；critical 需苹果特批故不映射）。 */
export const SEVERITY_LEVEL: Readonly<Record<NotifySeverity, BarkLevel>> = {
  failure: "timeSensitive",
  warning: "active",
  success: "active",
  info: "passive",
};

/** 单次推送硬超时（毫秒；超时归属 channel 侧，B-3 不动）。 */
export const BARK_TIMEOUT_MS = 10_000;

/**
 * 4xx 确定失败（retryable:false）；5xx 可重试（retryable:true）——
 * 错误协议标注供框架 deliver 决策（B-3）。
 */
class BarkHttpError extends Error implements RetryableError {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, detail: string) {
    super(`bark HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.retryable = status >= 500;
  }
}

/** createBarkChannel 已知的顶层配置键（透传键 = 此集合之外的 string/number 键）。 */
const BARK_KNOWN_TOP_KEYS: readonly string[] = ["id", "name", "type", "baseUrl", "deviceKey", "enabled", "sound", "level", "levels", "group", "icon", "url", "badge"];

/**
 * Bark 频道实例工厂。
 * @param cfg 实例配置（normalizeConfig 已归一化）。
 * @returns NotifyChannel——send() 返回在途 promise（resolve=终态成功 /
 *   reject=终态失败，错误已脱敏且按 RetryableError 协议标注），调用方据此记录
 *   status；send 本身不抛同步错。重试/并发门由框架 deliver 依 capabilities 承载
 *   （B-3），本实例只做单次投递。
 */
export function createBarkChannel(cfg: BarkChannelConfig): NotifyChannel {
  // 错误出口脱敏：先按 device key 字面替换（key 多为 22 位 base62，通用规则表
  // 覆盖不到），再过 sanitizeErrorText 有序表 + 截断（评审 P0-4 收口）。
  const scrub = (text: string): string => sanitizeErrorText(String(text).split(cfg.deviceKey).join(SECRET_MASK), 300);

  /** 单次 POST（重试归框架）。非 2xx 抛 BarkHttpError；2xx 但 body code!==200 视为失败。 */
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
      // fetch 层失败（网络/超时/DNS）：可重试（协议标注 true，框架据此重试）
      const err = new Error(`bark 请求失败: ${error instanceof Error ? error.message : String(error)}`) as RetryableError;
      err.retryable = true;
      throw err;
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
        // body code 非 200：服务端业务拒绝，对等现状可重试面（幂等 POST）
        const err = new Error(`bark code ${String(body.code)}: ${scrub(String(body.message ?? ""))}`) as RetryableError;
        err.retryable = true;
        throw err;
      }
    } catch (error) {
      if (error instanceof SyntaxError) return; // 非 JSON 响应：HTTP 2xx 已足够
      throw error;
    }
  }

  return {
    name: `bark:${cfg.id}`,
    // capabilities：Bark 无硬性服务端限制，取合理客户端体验值（标题一行约 64
    // 码点；正文 4096 码点兜底截断）。retry/maxInflight 供框架 deliver 上移
    // 使用（B-3，对等现状 sendWithRetry ×2/在途 ≤2 排队）。
    capabilities: {
      titleMaxLen: 64,
      maxBodyLen: 4096,
      retry: { maxRetries: 2, backoffMs: 1000 },
      maxInflight: 2,
    },
    send(payload) {
      // 组装 body：必填三键 + 紧急度（levels[kind] > level > severity 映射）+ 可选参数 + 透传键
      const body: Record<string, unknown> = {
        device_key: cfg.deviceKey,
        title: payload.title,
        body: payload.body,
      };
      const level = cfg.levels?.[payload.kind] ?? cfg.level ?? (payload.severity ? SEVERITY_LEVEL[payload.severity] : undefined);
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
      // fire-and-forget 语义由调用方（service dispatch）决定是否等待——返回
      // 在途 promise 且不抛同步错（重试与排队已在框架 deliver 的 promise 内）。
      return postOnce(JSON.stringify(body));
    },
  };
}
