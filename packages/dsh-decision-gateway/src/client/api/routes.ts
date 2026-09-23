/**
 * dsh-decision-gateway — 客户端传输层（api/ 域内模块，经 interface.ts 门面引用）。
 *
 * 路由回退取共享 ROUTES（宿主单一事实源经构建期 __DSH_ROUTES__ 注入时优先注入值）。
 * 零 bare import。
 */
import { ROUTES } from "../../shared/interface.ts";

/** 构建期注入的宿主路由表（bundle-host extraDefine；缺席即 undefined）。 */
declare const __DSH_ROUTES__: Record<string, string> | undefined;

/** 取注入值（非字符串/缺席即回落共享 ROUTES）。 */
function injected(key: string, fallback: string): string {
  if (typeof __DSH_ROUTES__ !== "undefined") {
    const value: unknown = (__DSH_ROUTES__ as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

/** 卡片实际使用的路由表（注入优先，共享兜底）。 */
export const APP_ROUTES: {
  readonly health: string;
  readonly config: string;
  readonly presets: string;
  readonly history: string;
  readonly testConnection: string;
} = {
  health: injected("health", ROUTES.health),
  config: injected("config", ROUTES.config),
  presets: injected("presets", ROUTES.presets),
  history: injected("history", ROUTES.history),
  testConnection: injected("testConnection", ROUTES.testConnection),
};

/** 客户端 fetch 默认超时（浏览器→dsh web 一跳；与 provider-usage 10s 先例对齐）。 */
export const CLIENT_FETCH_TIMEOUT_MS = 10_000;

export function fetchTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = CLIENT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  if (init?.signal !== undefined) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
