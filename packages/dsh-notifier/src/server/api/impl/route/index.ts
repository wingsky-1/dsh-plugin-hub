/**
 * api 域路由块：注册端点并给每条请求套上围栏——回环围栏（非回环一律 403，必须用共享层默认参数：放行 `no-cors` 的开关
 * 只给资源伺服路由）、方法围栏（方法不在表里给 405 而不是 404）、异常收口（漏出去的异常留下的不是错误页，是一个挂住的连接）。
 */
import type { ServerResponse } from "node:http";
import { isLoopbackRequest } from "../../../../../../../shared/loopback.js";
import type { LoggerPort, RegisterRoute } from "../../deps.ts";
import type { Endpoint, HttpMethod } from "./type.ts";

/**
 * 写一个 JSON 响应。泛型而不是固定形状：响应体有设置视图、历史数组、状态表各不相同的形状，
 * 而序列化只关心它能被 JSON 表达。
 */
export function sendJson<T>(
  res: ServerResponse,
  status: number,
  body: T,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/**
 * 失败负载。三个字段分开不是冗余：客户端把 `error` 当提示文本、把 `code` 当分流依据（版本冲突靠
 * `SETTINGS_CONFLICT` 判，不靠中文文案），`details` 给结构化细节——合成一个字符串就等于让客户端
 * 去匹配文案，而文案是本地化的。
 */
interface FailureBody {
  /** 面向用户的失败原因。 */
  error?: string;
  /** 结构化细节（请求体非法等）。 */
  details?: string;
  /** 补充说明（如合法取值范围）；客户端不读它，用它的是直接看响应的排查者。 */
  hint?: string;
  /** 机器可判的失败类别。 */
  code?: string;
}

/** 写一个失败响应：`{ ok: false, error: {...} }`，与端点的成功体同族。 */
export function sendFailure(
  res: ServerResponse,
  status: number,
  failure: FailureBody,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { ok: false, error: failure }, headers);
}

/** 围栏拒绝体：`error` 是**裸字符串**，与端点失败体的对象形状不同，这是刻意的——客户端读失败提示的顺序是
 * 「`details` → `error` → `HTTP <status>`」，而它识别局域网直连只认最后那条兜底里的状态码。把 403 包成对象，
 * 提示文案就会变成「非回环请求」、状态码消失，「请改用 https 访问」的引导随之失效。 */
function sendRefused(
  res: ServerResponse,
  status: number,
  reason: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error: reason }, headers);
}

/** 注册端点组，返回摘除器清单（与装配顺序相反地释放）。 */
export function registerEndpoints(
  register: RegisterRoute,
  endpoints: Endpoint[],
  logger: LoggerPort,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  for (const endpoint of endpoints) {
    disposers.push(
      register({
        kind: "exact",
        path: endpoint.path,
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) {
            sendRefused(res, 403, "forbidden: loopback-only");
            return;
          }
          const handle = endpoint.methods[(req.method ?? "") as HttpMethod];
          if (handle === undefined) {
            // `allow` 是 405 该带的头，调用方不必回翻文档；状态码与文案仍与旧协议一致。
            sendRefused(res, 405, `method not allowed: ${req.method}`, {
              allow: Object.keys(endpoint.methods).join(", "),
            });
            return;
          }
          try {
            const done = handle(req, res);
            // 异步端点失败落在 promise、同步端点落在 catch：收口只有一处，但两条路都要接上，
            // 否则异步端点的异常会变成未捕获拒绝。
            if (done instanceof Promise) {
              done.catch((cause) => {
                reportFailure(res, logger, cause instanceof Error ? cause.message : String(cause));
              });
            }
          } catch (cause) {
            reportFailure(res, logger, cause instanceof Error ? cause.message : String(cause));
          }
        },
      }),
    );
  }
  return disposers;
}

/**
 * 异常收口：记日志并回 500。响应头可能已经发出（SSE 端点尤其如此），所以只在不曾写过时才补 500
 * ——重复写会抛 `ERR_HTTP_HEADERS_SENT`，把一次端点失败升级成宿主侧的未捕获异常。
 */
function reportFailure(res: ServerResponse, logger: LoggerPort, reason: string): void {
  logger.warn(`dsh-notifier: 浏览器端点处理失败 — ${reason}`);
  if (!res.headersSent) sendFailure(res, 500, { error: reason });
}
