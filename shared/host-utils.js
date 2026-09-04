// dsh 插件家族共享层 — 宿主端辅助函数（单一事实源）。
//
// 历史：writeJson 5 份、errorMessage 4 份、readBody 4 份 3 档 limit 在各插件
// 逐字复制并已漂移。统一由本模块提供；readBody 的 limit 由调用方显式传入，
// 消除隐式差异。

import { Buffer } from "node:buffer";

import { isLoopbackRequest } from "./loopback.js";

/**
 * Loopback + 方法白名单低阶路由守卫。
 *
 * **对本守卫的执行顺序**：非 loopback → 403；方法不在白名单 → 405；否则放行
 * （403 先于 405）。该顺序仅对**套本守卫的端点**成立——个别端点（如
 * mcp-manager /config）是端点级方法分流先于 loopback 的刻意例外，不适用。
 *
 * @param {import("node:http").IncomingMessage} req - Node http 请求对象。
 * @param {import("node:http").ServerResponse} res - 响应对象。
 * @param {string[]} methods - 允许的 HTTP 方法白名单。
 * @returns {boolean} 是否放行（true 时调用方继续处理请求）。
 */
export function guardLoopbackMethod(req, res, methods) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: "forbidden: loopback-only" });
    return false;
  }
  if (!methods.includes(req.method)) {
    writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    return false;
  }
  return true;
}

/**
 * 写 JSON 响应（统一带 referrer-policy 头，防 referrer 泄露）。
 * @param {import("node:http").ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 序列化为 JSON 的负载。
 */
export function writeJson(res, status, payload) {
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
 * @param {unknown} payload - 序列化为 JSON 的 SSE 帧负载。
 * @returns {string} SSE data 帧文本。
 */
export function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 宽松读请求 body（JSON）：解析失败或超限返回 undefined（不抛错），
 * 由调用方决定响应。与 readBody 共用限长语义。
 * @param {import("node:http").IncomingMessage} req - Node http 请求对象（或 async-iterator 桩）。
 * @param {number} [limit] - 字节上限（默认 2MB）。
 * @returns {Promise<object|undefined>} 解析后的 JSON 对象；空/非法/超限返回 undefined。
 */
export async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return undefined;
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把任意抛出的值转成可读错误消息。
 * @param {unknown} error - 任意抛出的值。
 * @returns {string} 可读错误消息。
 */
export function errorMessage(error) {
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
 * @param {import("node:http").IncomingMessage} req - Node http 请求对象（或 async-iterator 桩）。
 * @param {number} [limit] - 字节上限（显式传入，默认 256KB）。
 * @returns {Promise<object>} 解析后的 JSON 对象（空 body 返回 {}）。
 */
export function readBody(req, limit = 256 * 1024) {
  // async-iterator 形态（部分测试桩）：逐块读取，限长检查。
  if (typeof req[Symbol.asyncIterator] === "function" && typeof req.on !== "function") {
    return (async () => {
      const chunks = [];
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
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
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
        resolvePromise(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        const e = /** @type {Error} */ (error);
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}
