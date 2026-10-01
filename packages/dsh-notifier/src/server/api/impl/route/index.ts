/**
 * api 域路由块：注册端点并给每条请求套上围栏——回环围栏（非回环一律 403，必须用共享层默认参数：放行 `no-cors` 的开关
 * 只给资源伺服路由）、方法围栏（方法不在表里给 405 而不是 404）、异常收口（漏出去的异常留下的不是错误页，是一个挂住的连接）。
 */
import type { ServerResponse } from "node:http";
import { isLoopbackRequest } from "../../../../../../../shared/loopback.js";
import { REFUSAL_CODES } from "../../../../shared/interface.ts";
import type { RefusalCode } from "../../../../shared/interface.ts";
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

/** 围栏拒绝体：`error` 是**裸字符串**，与端点失败体的对象形状不同，这是刻意的——旧客户端读失败提示的顺序是
 * 「`details` → `error` → `HTTP <status>`」，而它识别局域网直连只认最后那条兜底里的状态码。把 403 包成对象，
 * 提示文案就会变成「非回环请求」、状态码消失，「请改用 https 访问」的引导随之失效。
 *
 * `code` / `status` 是与 `error` 并列的**新增 sibling 字段**（#769）：新客户端按结构化字段分流，
 * 不再依赖「服务端必须永远保持 `error` 为裸字符串」这条隐式契约；旧客户端读不到它们，行为不变。
 * 因此三者共存，而不是把 `error` 升级成对象——后者会让新旧客户端都退到兜底路径上去。
 * `allow` 不进 body：它已是 405 的标准头（同一份事实两处声明，就有两处先腐烂）。 */
function sendRefused(
  res: ServerResponse,
  status: number,
  code: RefusalCode,
  reason: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error: reason, code, status }, headers);
}

/**
 * 注册端点组，返回摘除器清单（与装配顺序相反地释放）。
 *
 * **中途抛错整单回滚**：本函数逐条注册，第 N 条抛错时前 N-1 条已经挂在宿主上，而它们的摘除器
 * 只存在于下面这个局部表里——调用方（按返回值登记）拿不到它们，不就地摘就是永久泄漏
 * （实测后续卸载摘掉 0 条路由）。
 *
 * 回滚与成功路径共用同一把「逐项隔离」的尺子：一条摘除器抛错不阻断其余。实测组合故障（注册第 4 条
 * kinds 抛错，且第 3 条 status 的摘除器也抛错）下去掉隔离，则 3 条里只摘 1 条、泄漏 2 条，抛给调用方的
 * 错误还会从「注册失败」变成「摘除失败」——那同时违反本文件「清理路径不盖首因」那条承诺。
 *
 * **「逆序」这一半在这里不钉**：8 条路由彼此独立、谁先撤没有语义差别，把整条序钉死只会让加一条
 * 端点就红一次。真正有语义的那处逆序在 api 域装配面（「帧订阅排在第一条路由之前」，先断帧的来路
 * 再拆它的出口），那一处有判据。
 */
export function registerEndpoints(
  register: RegisterRoute,
  endpoints: Endpoint[],
  logger: LoggerPort,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  try {
    registerAll(register, endpoints, logger, disposers);
  } catch (error) {
    // 整单回滚：已挂的逐个摘除、不留「已注册」的假记忆。清理路径不盖首因，也不上报。
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // 一个资源的清理失败不拖垮其余：跳过其余等于把它们都留在宿主上。
      }
    }
    throw error;
  }
  return disposers;
}

/** 逐条注册并把每条的摘除器记进 `disposers`（单独一层是为了让回滚罩住整个注册过程）。 */
function registerAll(
  register: RegisterRoute,
  endpoints: Endpoint[],
  logger: LoggerPort,
  disposers: Array<() => void>,
): void {
  for (const endpoint of endpoints) {
    disposers.push(
      register({
        kind: "exact",
        path: endpoint.path,
        handler: (req, res) => {
          if (!isLoopbackRequest(req)) {
            sendRefused(res, 403, REFUSAL_CODES.FORBIDDEN_LOOPBACK, "forbidden: loopback-only");
            return;
          }
          const handle = endpoint.methods[(req.method ?? "") as HttpMethod];
          if (handle === undefined) {
            // `allow` 是 405 该带的头，调用方不必回翻文档；状态码与文案仍与旧协议一致，
            // 新增的只是与之并列的机读 code/status。
            sendRefused(
              res,
              405,
              REFUSAL_CODES.METHOD_NOT_ALLOWED,
              `method not allowed: ${req.method}`,
              {
                allow: Object.keys(endpoint.methods).join(", "),
              },
            );
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
}

/**
 * 异常收口：记日志并回 500。响应头可能已经发出（SSE 端点尤其如此），所以只在不曾写过时才补 500
 * ——重复写会抛 `ERR_HTTP_HEADERS_SENT`，把一次端点失败升级成宿主侧的未捕获异常。
 */
function reportFailure(res: ServerResponse, logger: LoggerPort, reason: string): void {
  logger.warn(`dsh-notifier: 浏览器端点处理失败 — ${reason}`);
  if (!res.headersSent) sendFailure(res, 500, { error: reason });
}
