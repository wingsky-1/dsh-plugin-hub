/**
 * api 域实现：路由围栏（回环 403 先于方法 405，异常收口 500）。
 *
 * - 非回环一律 403（默认参数，不放行 cross-site：普通 /api 路由）；
 * - 方法不在表里给 405（Allow 头带合法方法），不给 404；
 * - 处理器抛错收口 500（已发头则不再写头）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackRequest } from "../../../../../../shared/loopback.js";
import type { LoggerPort } from "../deps.ts";

/** 端点方法表（键为大写方法名）。 */
export type MethodTable = Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
>;

/** 端点（path 精确匹配）。 */
export interface Endpoint {
  readonly path: string;
  readonly methods: MethodTable;
}

/** 注册口（组合根转交的 ctx.webServer.register 窄面）。 */
export type RegisterRoute = (route: {
  readonly kind: "exact";
  readonly path: string;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
}) => () => void;

/** JSON 成功体。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** 失败包络（必含 errorCode + category，供客户端 failureCategory 识别）。 */
export function sendFailure(
  res: ServerResponse,
  status: number,
  errorCode: string,
  category: string,
  message: string,
): void {
  sendJson(res, status, { ok: false, error: { errorCode, category, message } });
}

/** 注册端点组（返回摘除器；与装配顺序逆序释放由调用方组织）。 */
export function registerEndpoints(
  register: RegisterRoute,
  endpoints: Endpoint[],
  logger: LoggerPort,
): (() => void)[] {
  const disposers: (() => void)[] = [];
  for (const endpoint of endpoints) {
    disposers.push(
      register({
        kind: "exact",
        path: endpoint.path,
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) {
            // R3：围栏体与失败体统一为 errorCode+category（客户端 failureCategory 读四键容忍，旧三键不再产出）。
            sendFailure(
              res,
              403,
              "FORBIDDEN_LOOPBACK",
              "loopback-only",
              "forbidden: loopback-only",
            );
            return;
          }
          const handle = endpoint.methods[req.method ?? ""];
          if (handle === undefined) {
            res.writeHead(405, {
              "content-type": "application/json; charset=utf-8",
              allow: Object.keys(endpoint.methods).join(", "),
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: {
                  errorCode: "METHOD_NOT_ALLOWED",
                  category: "method-not-allowed",
                  message: "method not allowed",
                },
              }),
            );
            return;
          }
          try {
            const done = handle(req, res);
            if (done instanceof Promise) {
              done.catch((cause: unknown) => reportFailure(res, logger, cause));
            }
          } catch (cause: unknown) {
            reportFailure(res, logger, cause);
          }
        },
      }),
    );
  }
  return disposers;
}

/** 异常收口（记日志 + 500；已发头不再写）。 */
function reportFailure(res: ServerResponse, logger: LoggerPort, cause: unknown): void {
  const reason = cause instanceof Error ? cause.message : String(cause);
  logger.warn("dsh-jev-decide: 端点处理失败 —— " + reason);
  if (!res.headersSent) sendFailure(res, 500, "INTERNAL", "internal", reason);
}
