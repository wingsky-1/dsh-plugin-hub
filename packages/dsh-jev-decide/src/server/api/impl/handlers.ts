/**
 * api 域实现：端点处理器（只做 HTTP 形状与参数搬运，判定全在注入端口里）。
 *
 * - PUT /config：体上限 64KB；校验失败 400（仅类别+码）；成功回裸 v1 掩码体；
 * - GET /presets 只读（PUT 进方法表即 405，不在此分流）；
 * - GET /history：root 兼容完整路径/rootHash；单测锁定 limit 钳制语义由 history 域承载；
 * - DELETE /history：root 与 sessionId 双必填（缺一 400，仅单会话）；
 * - POST /test-connection：空体 {} 合法（密钥取自服务端配置，不取自请求体）。
 */
import type { IncomingMessage } from "node:http";
import { ROUTES, TEMPLATE_VERSION } from "../../../shared/interface.ts";
import type { ApiDeps } from "../deps.ts";
import type { Endpoint } from "./route.ts";
import { sendFailure, sendJson } from "./route.ts";

/** 请求体上限（64KB；超限 413 不读完）。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 读 JSON 体（空体即 {}；超限/非法抛错由调用方收口 400/413）。 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new Error("body not JSON"));
      }
    });
    req.on("error", (cause: unknown) =>
      reject(cause instanceof Error ? cause : new Error(String(cause))),
    );
  });
}

/** 查询参数（相对 URL 用占位基拼）。 */
function queryOf(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? "/";
  return new URL(raw, "http://127.0.0.1").searchParams;
}

/** 数值参数（非法即 undefined，由域层回落默认）。 */
function numParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw === "") return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

/** 组装端点表（处理器全部经 ports 注入能力）。 */
export function buildEndpoints(ports: ApiDeps): Endpoint[] {
  return [
    {
      path: ROUTES.health,
      methods: {
        GET: (_req, res) => {
          sendJson(res, 200, {
            ok: true,
            version: ports.version(),
            templateVersion: TEMPLATE_VERSION,
          });
        },
      },
    },
    {
      path: ROUTES.config,
      methods: {
        GET: (_req, res) => {
          sendJson(res, 200, ports.readConfig());
        },
        PUT: (req, res) => {
          readJsonBody(req)
            .then(
              (body) => {
                try {
                  sendJson(res, 200, ports.writeConfig(body));
                } catch (cause: unknown) {
                  const failure = asFailure(cause);
                  sendFailure(
                    res,
                    failure.status,
                    failure.errorCode,
                    failure.category,
                    failure.message,
                  );
                }
              },
              () =>
                sendFailure(res, 400, "INVALID_BODY", "bad-request", "body must be JSON <=64KB"),
            )
            .catch(() => sendFailure(res, 500, "INTERNAL", "internal", "unreachable"));
        },
      },
    },
    {
      path: ROUTES.presets,
      methods: {
        GET: (_req, res) => {
          sendJson(res, 200, { ok: true, presets: ports.readPresets() });
        },
      },
    },
    {
      path: ROUTES.history,
      methods: {
        GET: (req, res) => {
          try {
            const params = queryOf(req);
            const entries = ports.readHistory({
              root: params.get("root") ?? undefined,
              sessionId: params.get("sessionId") ?? undefined,
              limit: numParam(params, "limit"),
            });
            sendJson(res, 200, { ok: true, entries });
          } catch (cause: unknown) {
            const failure = asFailure(cause);
            sendFailure(res, failure.status, failure.errorCode, failure.category, failure.message);
          }
        },
        DELETE: (req, res) => {
          try {
            const params = queryOf(req);
            const removed = ports.removeHistory({
              root: params.get("root") ?? undefined,
              sessionId: params.get("sessionId") ?? undefined,
            });
            sendJson(res, 200, { ok: true, deleted: removed.deleted });
          } catch (cause: unknown) {
            const failure = asFailure(cause);
            sendFailure(res, failure.status, failure.errorCode, failure.category, failure.message);
          }
        },
      },
    },
    {
      path: ROUTES.testConnection,
      methods: {
        POST: (req, res) => {
          readJsonBody(req)
            .then(
              (body) => {
                ports
                  .probeConnection(body)
                  .then(
                    (probe) => {
                      if (probe.ok) sendJson(res, 200, { ok: true, latencyMs: probe.latencyMs });
                      else
                        sendFailure(
                          res,
                          probeStatus(probe.errorCode),
                          probe.errorCode,
                          probe.category,
                          probe.message,
                        );
                    },
                    (cause: unknown) => {
                      const failure = asFailure(cause);
                      sendFailure(
                        res,
                        failure.status,
                        failure.errorCode,
                        failure.category,
                        failure.message,
                      );
                    },
                  )
                  .catch(() => sendFailure(res, 500, "INTERNAL", "internal", "unreachable"));
              },
              () =>
                sendFailure(res, 400, "INVALID_BODY", "bad-request", "body must be JSON <=64KB"),
            )
            .catch(() => sendFailure(res, 500, "INTERNAL", "internal", "unreachable"));
        },
      },
    },
  ];
}

/** 结构化抛错信封（组合根 writeConfig 按此 JSON 抛错，免跨域值引用）。 */
export interface ThrownFailure {
  readonly status: number;
  readonly errorCode: string;
  readonly category: string;
  readonly message: string;
}

/** 域抛错映射（JSON 信封优先；history[400] 前缀回落 400；余者 500）。 */
function asFailure(cause: unknown): {
  readonly status: number;
  readonly errorCode: string;
  readonly category: string;
  readonly message: string;
} {
  const message = cause instanceof Error ? cause.message : String(cause);
  try {
    const parsed = JSON.parse(message) as Partial<ThrownFailure>;
    if (
      typeof parsed.status === "number" &&
      typeof parsed.errorCode === "string" &&
      typeof parsed.category === "string" &&
      typeof parsed.message === "string"
    ) {
      return {
        status: parsed.status,
        errorCode: parsed.errorCode,
        category: parsed.category,
        message: parsed.message,
      };
    }
  } catch {
    // 非信封按前缀规则回落。
  }
  const match = /\[(\d+)\]/.exec(message);
  if (match !== null) {
    const status = Number(match[1]);
    return {
      status,
      errorCode: "BAD_REQUEST",
      category: "bad-request",
      message: message.replace(match[0], "").trim(),
    };
  }
  return { status: 500, errorCode: "INTERNAL", category: "internal", message };
}

/** 探针错误码映射状态（凭据/缺 key 401 形，余者 502）。 */
function probeStatus(errorCode: string): number {
  if (errorCode === "NO_KEY" || errorCode === "UNAUTHORIZED") return 401;
  if (errorCode === "TIMEOUT") return 504;
  return 502;
}
