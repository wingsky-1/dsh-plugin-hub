/**
 * api 域路由块：注册端点并给每条请求套围栏。
 *
 * 围栏用仓库共享层那一份（`guardLoopbackMethod`），不在这里重写判定：
 * 安全边界的修复必须传播到所有插件，复制一份就是让它不再传播（shared/loopback.js 的模块注释即此意）。
 * 顺序由共享层保证：非回环 403 先于方法错 405。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { guardLoopbackMethod, writeJson } from "../../../../../../../shared/host-utils.js";
import type { LoggerPort } from "../../../shared/interface.ts";
import type { RegisterRoute } from "../../deps.ts";

/** 一个端点的处理器。 */
type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** 一条路由：路径 + 方法白名单（方法名 → 处理器）。 */
export interface Endpoint {
  readonly path: string;
  readonly methods: Readonly<Record<string, RequestHandler>>;
}

/**
 * 注册端点组，返回摘除器清单。**要么全上、要么全不上**。
 *
 * 中途失败时把已挂的那些摘回去再抛：宿主侧留着一条没有摘除器的路由，比一条都没挂更糟——
 * 它在册、会响应、而下一次装配只会再挂一遍，且没人能摘掉它。
 */
export function registerEndpoints(
  register: RegisterRoute,
  endpoints: readonly Endpoint[],
  logger: LoggerPort,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  for (const endpoint of endpoints) {
    try {
      disposers.push(
        register({
          kind: "exact",
          path: endpoint.path,
          handler: (req, res) => {
            if (!guardLoopbackMethod(req, res, Object.keys(endpoint.methods))) return;
            const handle = endpoint.methods[req.method ?? ""];
            try {
              const done = handle(req, res);
              // 异步端点失败落在 promise、同步端点落在 catch：收口只有一处，两条路都要接上，
              // 否则异步端点的异常会变成未捕获拒绝。
              if (done instanceof Promise) {
                done.catch((cause) => reportFailure(res, logger, cause));
              }
            } catch (cause) {
              reportFailure(res, logger, cause);
            }
          },
        }),
      );
    } catch (cause) {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {
          // 回滚阶段不做失败上报：一个端点的摘除失败不该掩盖首个异常。
        }
      }
      throw cause;
    }
  }
  return disposers;
}

/**
 * 异常收口：记日志并回 500。响应头可能已经发出，所以只在不曾写过时才补 500
 * ——重复写会抛 `ERR_HTTP_HEADERS_SENT`，把一次端点失败升级成宿主侧的未捕获异常。
 */
function reportFailure(res: ServerResponse, logger: LoggerPort, cause: unknown): void {
  const reason = cause instanceof Error ? cause.message : String(cause);
  logger.warn("dsh-worktree-sidebar: 浏览器端点处理失败 — " + reason);
  if (!res.headersSent) writeJson(res, 500, { ok: false, error: { message: reason } });
}
