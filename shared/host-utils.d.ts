import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoopbackOptions } from "./loopback.d.ts";

/** 写 JSON 响应（统一带 referrer-policy 头，防 referrer 泄露）。 */
export declare function writeJson(res: ServerResponse, status: number, payload: unknown): void;

/**
 * 序列化一帧 SSE data 行（输出形如 `data: <json>\n\n`）。
 * undefined / 含换行 payload 行为对齐三包历史实现、非承诺契约（#472）。
 */
export declare function sseData(payload: unknown): string;

/** 请求体读不出来的具体成因：供端点在失败文案里说清是哪一种。 */
export type JsonBodyInvalidReason = "too-large" | "unreadable" | "malformed" | "not-object";

/** `readJsonBodyOutcome` 的成因可辨结果：缺席（可选 body 未给）/ 合法对象 / 非法（带具体成因）。 */
export type JsonBodyOutcome =
  | { kind: "absent" }
  | { kind: "json"; value: object }
  | { kind: "invalid"; reason: JsonBodyInvalidReason };

/**
 * 读请求 body（JSON）并保留失败成因：需要 fail-closed 的端点用它（畸形 body 不能被当成「没有 body」，
 * 否则有副作用的端点会拿垃圾输入触发真实动作）。
 * @param limit 字节上限（默认 2MB）。
 */
export declare function readJsonBodyOutcome(
  req: IncomingMessage,
  limit?: number,
): Promise<JsonBodyOutcome>;

/**
 * 宽松读请求 body（JSON）：解析失败或超限返回 undefined（不抛错），由调用方决定响应。
 * 成因不可辨——要区分「缺席」与「非法」用 `readJsonBodyOutcome`。
 * @param limit 字节上限（默认 2MB）。
 */
export declare function readJsonBody(
  req: IncomingMessage,
  limit?: number,
): Promise<object | undefined>;

/** 把任意抛出的值转成可读错误消息。 */
export declare function errorMessage(error: unknown): string;

/**
 * 读请求 body（JSON，限长防滥用）。
 * 兼容 Node 事件流（data/end）与 async-iterator 桩两种形态。
 * @param limit 字节上限（默认 256KB）。
 */
export declare function readBody(req: IncomingMessage, limit?: number): Promise<object>;

/**
 * Loopback + 方法白名单低阶路由守卫：非 loopback → 403，方法不在白名单 → 405，
 * 否则放行（403 先于 405 为本守卫执行顺序，仅对套守卫端点成立）。
 * @param methods 允许的 HTTP 方法白名单。
 * @param loopbackOptions 透传给 isLoopbackRequest 的可选判定参数（#549：仅
 *   serve 资源路由放行 cross-site no-cors 子资源时使用；其余路由不得传）。
 * @returns 是否放行（true 时调用方继续处理请求）。
 */
export declare function guardLoopbackMethod(
  req: IncomingMessage,
  res: ServerResponse,
  methods: string[],
  loopbackOptions?: LoopbackOptions,
): boolean;
