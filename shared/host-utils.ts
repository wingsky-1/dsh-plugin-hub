// dsh 插件家族共享层 — 宿主端辅助函数（单一事实源）。
//
// 历史：writeJson 5 份、errorMessage 4 份、readBody 4 份 3 档 limit 在各插件
// 逐字复制并已漂移。统一由本模块提供；readBody 的 limit 由调用方显式传入，
// 消除隐式差异。

import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Loopback 围栏判定参数。
 * - allowCrossSiteNoCors（#549）：仅 serve 类资源伺服路由使用——放行「显式
 *   sec-fetch-mode: no-cors」的跨站子资源请求（sandbox iframe opaque origin
 *   的相对路径 css/js/img 加载）；cors fetch/XHR 与 navigate 仍拒绝。
 *   普通 /api 路由必须保持默认（不传 options）拒绝一切 cross-site。
 */
export interface LoopbackOptions {
  allowCrossSiteNoCors?: boolean;
}

/**
 * Loopback 围栏：请求必须来自回环地址 + 回环 Host，且满足跨站/来源约束，
 * 否则拒绝。默认拒绝一切 `sec-fetch-site: cross-site` 请求（DNS 重绑定 +
 * 跨站防御）；仅当 `options.allowCrossSiteNoCors` 为 true 时，**显式带
 * `sec-fetch-mode: no-cors` 的跨站子资源请求**放行（见 issue #549：
 * sandbox iframe 的 opaque origin 会使其相对路径子资源请求（css/js/img）
 * 一律呈 cross-site，serve 虚拟伺服需放行 no-cors 标签型加载，但 cors
 * fetch/XHR 与 navigate 仍拒绝）。
 *
 * 跨站放行是安全语义变更点，**只允许 serve 类资源伺服路由使用**；
 * 普通 /api 路由必须保持默认拒绝。
 *
 * @param request - Node http 请求对象。
 * @param options - 可选判定参数。
 * @returns 是否允许。
 */
/**
 * 对端地址是否回环（IPv4 / IPv6 / IPv4-mapped 三种写法）。fail-closed：拿不到地址即拒绝。
 *
 * 单立一函数是因为它与 Host 头是**两个不同的事实**：前者在传输层（谁连过来的），
 * 后者在应用层（他说自己是谁）。合成一条 if 时，「改 Host 白名单」会连带改到对端判定。
 */
function isLoopbackPeerAddress(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Host 头解析与判定：必须是 127.0.0.1 / localhost / [::1]，否则拒绝。
 * 返回解析好的 URL（同源比较要用它的 host），解析失败或不在白名单即 undefined。
 */
function loopbackHostUrlOf(request: IncomingMessage): URL | undefined {
  const host = request.headers.host;
  if (typeof host !== "string") return undefined;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  if (
    hostUrl.hostname !== "127.0.0.1" &&
    hostUrl.hostname !== "localhost" &&
    hostUrl.hostname !== "[::1]"
  ) {
    return undefined;
  }
  return hostUrl;
}

/**
 * 跨站判定（#549）：默认拒绝一切 cross-site；仅 serve 资源路由经 allowCrossSiteNoCors
 * 放行「显式 no-cors」的跨站子资源（标签型加载）。
 * fail-closed：cross-site 请求缺少 no-cors 标记（含头缺失的防御语义）一律拒绝，不猜测放行。
 * 同源（无 sec-fetch-site 或非 cross-site）恒放行——同源与否由 Origin 头那一段再判一次。
 */
function crossSiteRequestAllowed(request: IncomingMessage, options: LoopbackOptions): boolean {
  if (request.headers["sec-fetch-site"] !== "cross-site") return true;
  return options.allowCrossSiteNoCors === true && request.headers["sec-fetch-mode"] === "no-cors";
}

export function isLoopbackRequest(
  request: IncomingMessage,
  options: LoopbackOptions = {},
): boolean {
  if (!isLoopbackPeerAddress(request)) return false;
  const hostUrl = loopbackHostUrlOf(request);
  if (hostUrl === undefined) return false;
  if (!crossSiteRequestAllowed(request, options)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Loopback + 方法白名单低阶路由守卫。
 *
 * **对本守卫的执行顺序**：非 loopback → 403；方法不在白名单 → 405；否则放行
 * （403 先于 405）。该顺序仅对**套本守卫的端点**成立——个别端点（如
 * mcp-manager /config）是端点级方法分流先于 loopback 的刻意例外，不适用。
 *
 * @param req - Node http 请求对象。
 * @param res - 响应对象。
 * @param methods - 允许的 HTTP 方法白名单。
 * @param loopbackOptions - 透传给
 *   isLoopbackRequest 的可选判定参数（#549：仅 serve 资源路由放行
 *   cross-site no-cors 子资源时使用；其余路由不得传）。
 * @returns 是否放行（true 时调用方继续处理请求）。
 */
export function guardLoopbackMethod(
  req: IncomingMessage,
  res: ServerResponse,
  methods: string[],
  loopbackOptions?: LoopbackOptions,
): boolean {
  if (!isLoopbackRequest(req, loopbackOptions)) {
    writeJson(res, 403, { error: "forbidden: loopback-only" });
    return false;
  }
  // `req.method` 在 @types/node 上是 `string | undefined`。断言不改变运行时取值：
  // 缺 method 时 includes 仍为 false，照原样落 405，不存在被误放行的分支。
  if (!methods.includes(req.method as string)) {
    writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    return false;
  }
  return true;
}

/**
 * 写 JSON 响应（统一带 referrer-policy 头，防 referrer 泄露）。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param payload - 序列化为 JSON 的负载。
 */
export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(payload));
}

/**
 * 序列化一帧 SSE data 行（输出形如 `data: <json>\n\n`）。
 * 与 mcp-manager / notifier / provider-usage 三处历史实现逐字同构（#472 收敛）。
 * JSON.stringify(undefined) 返回 undefined，拼接为 `data: undefined\n\n`；含真实
 * 换行的 payload 由 JSON 转义为字面 `\n`，不拆多行 data 帧。现状三处均无调用点
 * 传 undefined（payload 恒为对象字面量），该行为仅为对齐历史、不额外兜底，
 * 非承诺契约——若未来收紧（抛错/省略）不视为破坏兼容（需单开决策）。
 * @param payload - 序列化为 JSON 的 SSE 帧负载。
 * @returns SSE data 帧文本。
 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 请求体读不出来的具体成因：供端点在失败文案里说清是哪一种。 */
export type JsonBodyInvalidReason = "too-large" | "unreadable" | "malformed" | "not-object";

/** `readJsonBodyOutcome` 的成因可辨结果：缺席（可选 body 未给）/ 合法对象 / 非法（带具体成因）。 */
export type JsonBodyOutcome =
  | { kind: "absent" }
  | { kind: "json"; value: object }
  | { kind: "invalid"; reason: JsonBodyInvalidReason };

/**
 * 读请求 body（JSON）并**保留失败成因**。
 *
 * 为什么需要它：`readJsonBody` 把「没给 body」「JSON 畸形」「超出上限」「JSON 合法但不是对象」
 * 收敛成同一个 undefined，调用方想区分「可选 body 缺席」与「给了但读不出来」只能靠猜。对**有副作用**
 * 的端点，这个歧义是有代价的：畸形请求会走到「按缺省处理」那条路，等于拿垃圾输入触发真实动作。
 * 需要 fail-closed 的端点用本函数；宽松端点继续用 `readJsonBody`（它是本函数的薄包装）。
 * @param req - Node http 请求对象（或 async-iterator 桩）。
 * @param limit - 字节上限（默认 2MB）。
 * @returns 成因可辨的结果。
 */
export async function readJsonBodyOutcome(
  req: IncomingMessage,
  limit = 2 * 1024 * 1024,
): Promise<JsonBodyOutcome> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return { kind: "invalid", reason: "too-large" };
      chunks.push(chunk);
    }
  } catch {
    return { kind: "invalid", reason: "unreadable" };
  }
  let text: string;
  try {
    text = Buffer.concat(chunks).toString("utf8");
  } catch {
    // 块不是 Buffer（流被 setEncoding 成字符串之类）：与「读不出来」同义。这里必须在 try 内——
    // 本函数对外的承诺是**不抛错**（宽版面 `readJsonBody` 是它的薄包装），抛出去会打到调用方。
    return { kind: "invalid", reason: "unreadable" };
  }
  // 空 body（含纯空白）与「没写 body」是同一件事：可选参数缺席，不是错误。
  if (text.trim() === "") return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { kind: "invalid", reason: "not-object" };
  return { kind: "json", value: parsed };
}

/**
 * 宽松读请求 body（JSON）：解析失败或超限返回 undefined（不抛错），由调用方决定响应。
 * 成因不可辨——要区分「缺席」与「非法」用 `readJsonBodyOutcome`。与 readBody 共用限长语义。
 * @param req - Node http 请求对象（或 async-iterator 桩）。
 * @param limit - 字节上限（默认 2MB）。
 * @returns 解析后的 JSON 对象；空/非法/超限返回 undefined。
 */
export async function readJsonBody(
  req: IncomingMessage,
  limit = 2 * 1024 * 1024,
): Promise<object | undefined> {
  const outcome = await readJsonBodyOutcome(req, limit);
  return outcome.kind === "json" ? outcome.value : undefined;
}

/**
 * 把任意抛出的值转成可读错误消息。
 * @param error - 任意抛出的值。
 * @returns 可读错误消息。
 */
export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    return String(error);
  } catch {
    return "[unrenderable thrown value]";
  }
}

/**
 * 读请求 body（JSON，限长防滥用）。
 * 兼容两种请求形态：Node 事件流（data/end）与 async-iterator 桩（测试用）。
 * @param req - Node http 请求对象（或 async-iterator 桩）。
 * @param limit - 字节上限（显式传入，默认 256KB）。
 * @returns 解析后的 JSON 对象（空 body 返回 {}）。
 */
export function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<object> {
  // async-iterator 形态（部分测试桩）：逐块读取，限长检查。
  if (typeof req[Symbol.asyncIterator] === "function" && typeof req.on !== "function") {
    return (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error("body too large");
        chunks.push(chunk);
      }
      return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    })();
  }
  // Node 事件流形态。
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolvePromise(
          chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
      } catch (error) {
        const e = error as Error;
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}
