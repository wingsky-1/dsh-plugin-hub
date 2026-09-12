/**
 * dsh-notifier api 域 —— 路由块：注册端点，并给每条请求套上围栏。
 *
 * 壳里做三件事，顺序即优先级：
 *
 * 1. **回环围栏**：非回环请求一律 403。共享层的判定带了 DNS 重绑定与跨站防御，普通
 *    `/api` 路由必须用默认参数——放行 `no-cors` 的那个开关只给资源伺服路由。
 * 2. **方法围栏**：路径对而方法不在表里给 405 而不是 404。两者对排查的意义不同：
 *    404 说「没有这个端点」，405 说「有，但你不能这样调」。
 * 3. **异常收口**：端点内抛出的任何东西变成 500 并记日志。宿主把整个响应生命周期
 *    交给 handler，漏出去的异常留下的不是错误页，是一个挂住的连接。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoggerPort, RegisterRoute } from "../../deps.ts";
import { isLoopbackRequest } from "../../deps.ts";
import type { Endpoint, HttpMethod } from "./type.ts";

/**
 * 写一个 JSON 响应。
 *
 * 泛型而不是固定形状：响应体有设置视图、历史数组、状态表各不相同的形状，让它们各自
 * 搬进本域或退化成宽类型都不划算——序列化不关心形状，只关心它能被 JSON 表达。
 */
export function sendJson<T>(res: ServerResponse, status: number, body: T): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** 写一个错误响应。客户端按 `error` 字段取提示文本。 */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
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
            sendError(res, 403, "forbidden");
            return;
          }
          const handle = endpoint.methods[(req.method ?? "") as HttpMethod];
          if (handle === undefined) {
            res.writeHead(405, { allow: Object.keys(endpoint.methods).join(", ") });
            res.end();
            return;
          }
          try {
            const done = handle(req, res);
            // 异步端点的失败落在 promise 上，同步端点的落在 catch 里——收口只有一处，
            // 但两条路都要接上，否则异步端点的异常会变成未捕获拒绝。
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
 * 异常收口：记日志并回 500。
 *
 * 响应头可能已经发出（SSE 端点尤其如此），所以只在不曾写过时才补 500——重复写会抛
 * `ERR_HTTP_HEADERS_SENT`，把一次端点失败升级成宿主侧的未捕获异常。
 */
function reportFailure(res: ServerResponse, logger: LoggerPort, reason: string): void {
  logger.warn(`dsh-notifier: 浏览器端点处理失败 — ${reason}`);
  if (!res.headersSent) sendError(res, 500, reason);
}
