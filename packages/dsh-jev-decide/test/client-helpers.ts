/** dsh-jev-decide client 测试共享夹具（支撑模块：不入任何层、不计 --min）。 */
import { apply } from "../src/client/index.ts";
import { APP_ROUTES } from "../src/client/api/routes.ts";

/** 确定性轮询（不用固定 sleep 做断言；截止读真实 Date.now）。 */
export function pollUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tick = async (): Promise<void> => {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("pollUntil: " + label + " timeout");
    await new Promise((r) => setTimeout(r, 5));
    return tick();
  };
  return tick();
}

/** JSON Response 桩。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 裸 v1 掩码配置（无密钥绑定）。 */
export const BARE_CONFIG = {
  version: 1,
  connection: { hasPlaintextKey: false, timeoutMs: 8000, maxConcurrency: 4, truncBudget: 32000 },
  presets: [
    { id: "general", enabled: true, automationCap: 2 },
    { id: "secret-leak", enabled: false, automationCap: 0 },
    { id: "plan-review", enabled: true, automationCap: 1 },
    { id: "risk-check", enabled: true, automationCap: 1 },
    { id: "custom", enabled: true, automationCap: 2 },
  ],
  history: { perSession: 200, totalSessions: 50 },
};

/** 默认全路由桩（health/config/history/presets/testConnection 全 200）。 */
export function baseStub(url: string): Response {
  if (url.includes(APP_ROUTES.health))
    return jsonResponse({ ok: true, version: "0.1.0", templateVersion: 1 });
  if (url.includes(APP_ROUTES.config)) return jsonResponse(BARE_CONFIG);
  if (url.includes(APP_ROUTES.history)) return jsonResponse({ ok: true, entries: [] });
  if (url.includes(APP_ROUTES.presets)) return jsonResponse({ ok: true, presets: [] });
  if (url.includes(APP_ROUTES.testConnection)) return jsonResponse({ ok: true, latencyMs: 1 });
  return jsonResponse({}, 404);
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

/** 安装全局 fetch 桩并记录调用（含请求体）；返回还原函数与调用记录。 */
export function installStub(handler: (url: string, method: string) => Response): {
  readonly restore: () => void;
  readonly calls: FetchCall[];
} {
  const prev = (globalThis as unknown as { fetch?: unknown }).fetch;
  const calls: FetchCall[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: unknown,
    init?: { method?: string; body?: unknown },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
    return handler(url, method);
  };
  return {
    calls,
    restore: () => {
      if (prev === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
      else (globalThis as unknown as { fetch: unknown }).fetch = prev;
    },
  };
}

export interface Mount {
  readonly card: HTMLElement;
  readonly effects: Array<() => void>;
}

/** 经真实 apply 挂载设置卡（调用方先 installStub；返回释放器由调用方兜底）。 */
export function mountCard(): Mount {
  const effects: Array<() => void> = [];
  let render: (() => HTMLElement) | null = null;
  const slots = {
    inject: (_name: string, setup: () => unknown) => {
      setup();
      return () => {};
    },
    register: (_item: unknown, renderFn: () => HTMLElement) => {
      render = renderFn;
      return () => {};
    },
  };
  const ctx = {
    slots,
    effect: (fn: () => () => void) => {
      effects.push(fn());
    },
  };
  apply(ctx as never);
  if (render === null) throw new Error("card render 未注册");
  const card = (render as () => HTMLElement)();
  document.body.appendChild(card);
  return { card, effects };
}
