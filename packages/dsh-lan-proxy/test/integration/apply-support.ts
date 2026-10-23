// apply 装配族共享替身：只服务 test/integration/apply-*.test.ts 两个文件，
// 不进任何测试层、不计 --min。假件只提供原始事实与调用记录，不替被测代码做决定
// （testing skill §3）。不外扩为跨域通用 harness。
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { SETTINGS_NS } from "../../src/server/config/interface.ts";

/** HTTP 响应替身：真实 getter 的 headersSent（否则「还能不能写头」判据恒真）。 */
export class FakeRes extends EventEmitter {
  headersSent = false;
  _headers = new Map<string, string>();
  _chunks: Buffer[] = [];
  ended = false;
  destroyed = false;
  statusCode = 0;
  getHeader(name: string) {
    return this._headers.get(String(name).toLowerCase());
  }
  setHeader(name: string, value: string) {
    this._headers.set(String(name).toLowerCase(), value);
  }
  removeHeader(name: string) {
    this._headers.delete(String(name).toLowerCase());
  }
  writeHead(code: number, msg?: string | Record<string, string>, headers?: Record<string, string>) {
    if (typeof msg === "object" && msg !== null) {
      headers = msg;
      msg = undefined;
    }
    this.statusCode = code;
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers))
        this._headers.set(key.toLowerCase(), value);
    }
    this.headersSent = true;
  }
  write(chunk: unknown, encoding?: BufferEncoding, callback?: () => void) {
    if (typeof encoding === "function") {
      callback = encoding as unknown as () => void;
      encoding = undefined;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), encoding);
    this._chunks.push(buf);
    if (typeof callback === "function") callback();
    return true;
  }
  end(chunk?: unknown, encoding?: BufferEncoding, callback?: () => void) {
    if (typeof chunk === "function") {
      callback = chunk as unknown as () => void;
      chunk = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.ended = true;
    if (typeof callback === "function") callback();
  }
  destroy() {
    this.destroyed = true;
  }
}

/** fake 请求（默认回环 GET；callers 按需覆盖 socket/headers/method）。 */
export function makeReq(over: Record<string, unknown> = {}) {
  return {
    method: "GET",
    headers: { host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    ...over,
  };
}

/** config 路由调用器：经真实 handler，带 body 时补一个可读的 async 流。
 *
 * 只服务 config 路由族的观测采集（apply-wiring），不外扩为跨域通用 harness。
 */
export function makeConfigCaller(route: Pick<WebRoute, "handler">) {
  return async (
    method: string,
    overrides: Record<string, unknown> = {},
    body?: unknown,
  ): Promise<{ status: number; body: string }> => {
    const req = Object.assign(
      { method, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } },
      overrides,
    ) as unknown as IncomingMessage;
    const chunks: string[] = [];
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(c?: unknown) {
        if (c !== undefined) chunks.push(String(c));
      },
      getHeader() {
        return undefined;
      },
      setHeader() {},
    } as unknown as ServerResponse;
    if (body !== undefined) {
      const stream = Object.assign(new EventEmitter(), req) as unknown as IncomingMessage;
      process.nextTick(() => {
        stream.emit("data", Buffer.from(JSON.stringify(body)));
        stream.emit("end");
      });
      await route.handler(stream, res);
    } else {
      await route.handler(req, res);
    }
    return { status: status || 200, body: chunks.join("") };
  };
}

/** fake settings 存储的 document-updated 监听器（ns/revision，与官方事件同形）。 */
export type FakeSettingsWatcher = (ns?: unknown, revision?: unknown) => void;

/** fake settings 存储的内存态（官方 settings 存储文档的内存形态）。 */
export interface FakeSettingsState {
  user: Record<string, unknown>;
  base: Record<string, unknown>;
  revision: number;
  describeCalls: number;
  updates: Array<{ patch: Record<string, unknown>; expectedRevision?: number }>;
  replaces: Array<{ section: Record<string, unknown>; expectedRevision?: number }>;
  listeners: FakeSettingsWatcher[];
  unsubscribed: number;
}

/** 构造 fake settings service（官方 SettingsForms 服务的内存形态）。
 *
 * base 即组合层 entry 的投影：真实宿主的 describe 返回 resolved value
 *（defaults → base → user），fake 以 base+user 合并模拟该语义。
 */
export function makeSettings(
  initialUser: Record<string, unknown> = {},
  initialBase: Record<string, unknown> = {},
) {
  const state: FakeSettingsState = {
    user: { ...initialUser },
    base: { ...initialBase },
    revision: 1,
    describeCalls: 0,
    updates: [],
    replaces: [],
    listeners: [],
    unsubscribed: 0,
  };
  const emit = (ns: unknown) => {
    for (const cb of [...state.listeners]) cb(ns, state.revision);
  };
  const service = {
    describe(_opts?: unknown) {
      state.describeCalls += 1;
      return [
        {
          ns: SETTINGS_NS,
          value: { ...state.base, ...state.user },
          user: JSON.parse(JSON.stringify(state.user)),
          revision: state.revision,
        },
      ];
    },
    update: async (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => {
      if (ns !== SETTINGS_NS) throw new Error(`unexpected ns ${ns}`);
      state.updates.push({ patch, expectedRevision });
      Object.assign(state.user, patch);
      state.revision += 1;
      emit(ns);
    },
    replace: async (ns: string, section: Record<string, unknown>, expectedRevision?: number) => {
      if (ns !== SETTINGS_NS) throw new Error(`unexpected ns ${ns}`);
      state.replaces.push({ section, expectedRevision });
      state.user = { ...section };
      state.revision += 1;
      emit(ns);
    },
    // 接缝经 sctx.on 订阅 document-updated（fake 经 listeners 收集）。
    on: (event: string, cb: FakeSettingsWatcher) => {
      if (event === "settings/document-updated") state.listeners.push(cb);
      return () => {
        state.unsubscribed += 1;
      };
    },
  };
  return { state, service };
}

/** fake webServer：prefixes/exact Map + register/registerFallback + port（转发器目标端口）。 */
export interface SmokeTestRoute {
  kind: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
}
export type SmokeTestHandler = (...args: unknown[]) => unknown;
export function makeWebServer() {
  const prefixes = new Map<string, SmokeTestRoute>();
  const exact = new Map<string, SmokeTestRoute>();
  const ws: {
    prefixes: Map<string, SmokeTestRoute>;
    exact: Map<string, SmokeTestRoute>;
    fallback: SmokeTestHandler | undefined;
    port: number;
    register(route: SmokeTestRoute): () => void;
    registerFallback(handler: SmokeTestHandler): () => void;
    tapIndex(): () => void;
  } = {
    prefixes,
    exact,
    fallback: undefined,
    port: 30800,
    register(route: SmokeTestRoute) {
      const table = route.kind === "exact" ? exact : prefixes;
      if (table.has(route.path)) throw new Error("duplicate");
      table.set(route.path, route);
      return () => {
        table.delete(route.path);
      };
    },
    registerFallback(handler: SmokeTestHandler) {
      ws.fallback = handler;
      return () => {
        ws.fallback = undefined;
      };
    },
    // apply 内 randomUUID polyfill 经 tapIndex 注入；smoke 无需断言 HTML。
    tapIndex() {
      return () => {};
    },
  };
  return ws;
}
