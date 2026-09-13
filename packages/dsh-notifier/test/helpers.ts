/**
 * dsh-notifier — 测试共享夹具（支撑模块）。
 *
 * 为什么放在 `test/` 根而不是 `test/unit/` 下：它不是测试条目——不进任何测试层、也不计
 * `--min`（门禁口径是 `test/` 下的全部 `*.test.ts`；同名先例见 dsh-mcp-manager /
 * dsh-provider-usage 的 `test/helpers.ts`）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { DeliverResult } from "../src/server/channels/impl/deliver/type.ts";
import type { AgentRegistryPort } from "../src/server/events/deps.ts";
import type { DeliverReason, LoggerPort } from "../src/server/shared/interface.ts";

/**
 * 临时改写环境变量，返回还原函数。
 *
 * 还原语义按「原本是否存在」分两类：原本不存在则删除而不是写成空串——空串与未设置在
 * `dshHome()` 里同义（空白视同未设置），但在别的读取方那里可能不同义，夹具不该替它们决定。
 */
export function withEnv(overrides: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * 隔离 DSH home：本次测试的全部落盘进独占的临时目录，跑完连目录一起删。
 *
 * `dispose` 必须进 `afterEach`/`afterAll`：漏掉会让后续用例继承上一个用例的 `DSH_HOME`，
 * 症状是「单跑绿、连跑红」，而且写出来的文件在仓库外，自查 `git status` 看不见。
 */
export function tempDshHome(): { readonly dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-test-"));
  const restore = withEnv({ DSH_HOME: dir });
  return {
    dir,
    dispose: () => {
      restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 轮询直到谓词成立，超时抛错。
 *
 * 为什么不用固定 sleep：等 50ms 与「异步确实完成了」不是一回事，慢 runner 上就是 flake。
 * 为什么超时**抛错**而不是返回 false：静默返回 false 会让调用方把「没等到」读成「条件不成立」，
 * 于是用例继续往下断言一个从未发生的事实，红在离原因很远的地方。
 */
export async function pollUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`pollUntil: ${label} 在 ${timeoutMs}ms 内未成立`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 宿主日志出口的假实现：记下 warn 文案供断言，而不是让失败面消失在控制台里。 */
export function makeLogger(): LoggerPort & { readonly warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    warn: (message: string) => {
      warns.push(message);
    },
  };
}

/** 请求桩参数：`method` 与 `url` 是每个域自己的事实，其余按需覆盖。 */
interface JsonReqOptions {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly remoteAddress?: string;
  readonly host?: string;
}

/**
 * 请求桩：只造被测代码会读的那几个字段。
 *
 * 不给 `rawBody` 时按 `body` 序列化，给了就原样进流——解析失败面要的正是「原样进流的脏文本」，
 * 走 `JSON.stringify` 反而测不到它。
 */
export function jsonReq(options: JsonReqOptions): IncomingMessage {
  const text = options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  return {
    method: options.method,
    url: options.url,
    headers: { host: options.host ?? "127.0.0.1:3080" },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (text !== "") yield Buffer.from(text, "utf8");
    },
  } as unknown as IncomingMessage;
}

/**
 * 响应桩：`headersSent` 是真实 getter（端点靠它判「还能不能写头」，写成普通字段会让那条判据恒真），
 * `json()` 直接解析累积正文，省掉每个文件各写一遍 `JSON.parse(rec.text)`。
 */
export function makeRes(): {
  readonly res: ServerResponse;
  readonly rec: {
    status: number;
    headers: Record<string, string>;
    text: string;
    headersSent: boolean;
  };
  readonly json: () => Record<string, unknown>;
} {
  const rec = { status: 0, headers: {} as Record<string, string>, text: "", headersSent: false };
  const res = {
    get headersSent() {
      return rec.headersSent;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      rec.status = status;
      rec.headers = { ...(headers ?? {}) };
      rec.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.text += chunk;
      rec.headersSent = true;
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    rec,
    json: (): Record<string, unknown> => JSON.parse(rec.text),
  };
}

/** 路由注册桩：记下收到的路由与它们的摘除动作——「卸载后旧 handler 还挂着」只有靠它才看得见。 */
export function makeRegister(): {
  readonly routes: WebRoute[];
  readonly disposed: string[];
  readonly register: (route: WebRoute) => () => void;
} {
  const routes: WebRoute[] = [];
  const disposed: string[] = [];
  return {
    routes,
    disposed,
    register: (route: WebRoute): (() => void) => {
      routes.push(route);
      return () => {
        disposed.push(route.path);
      };
    },
  };
}

/** 取失败明细的 reason。成功结果说明用例前提不成立：当场炸掉，别让断言落在一个不存在的事实上。 */
/** 取失败结果的结构化理由；非失败同上处理。断言打在 code / params / detail 上，不打在散文上。 */
export function reasonOf(result: DeliverResult): DeliverReason {
  if (result.status !== "failed") throw new Error(`期望失败，实际 ${result.status}`);
  return result.reason;
}

/** 取失败结果的可重试标记；非失败同上处理。 */
export function retryableOf(result: DeliverResult): boolean {
  if (result.status !== "failed") throw new Error(`期望失败，实际 ${result.status}`);
  return result.retryable;
}

/**
 * 假 Agent 注册表：`live` 是 id → Agent，`owned` 是「子 id + 父 Agent」对。
 *
 * 与 sdk 的 `makeRegister`（种类登记）只差一个字，故这里叫 `makeAgentRegistry`。
 */
export function makeAgentRegistry(
  options: { live?: Agent[]; owned?: ReadonlyArray<readonly [string, string]> } = {},
): AgentRegistryPort {
  const live = new Map((options.live ?? []).map((agent) => [String(agent.id), agent]));
  return {
    lookup: (id) => {
      const agent = live.get(String(id));
      return agent === undefined ? { found: false } : { found: true, agent };
    },
    isOwnedBy: (id, owner) =>
      (options.owned ?? []).some(
        ([child, parent]) => child === String(id) && parent === String(owner.id),
      ),
  };
}

/** 跨边界喂值：编译期联合不代表运行时的值也在枚举里，守的正是编译期管不到的那一侧。 */
export function wire<T>(value: unknown): T {
  return value as T;
}

/**
 * 排一次宏任务，把在飞的微任务链走完。
 *
 * 钉住时钟时不能用 `pollUntil`（它的截止时间读 `Date.now()`，谓词不成立就永不超时），
 * 而这类等待又不需要真的等时间——要的只是「队列排空」。
 */
export function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 一次 fetch 调用的记录：URL、header、body 分开放，「凭据不许落 URL」这类判据才写得出来。 */
export interface FetchCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal | null | undefined;
}

/** 全局 fetch 桩：出口用例全程无网络；用完必须 `afterEach(() => vi.unstubAllGlobals())`。 */
export function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal,
    };
    calls.push(call);
    return Promise.resolve().then(() => respond(call));
  });
  return calls;
}
