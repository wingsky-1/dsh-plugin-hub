// dsh-gzip —— /api 响应 gzip 压缩插件（修复版，仓库自建维护）。
//
// 背景：dsh Web GUI 加载会话历史时，一页历史可含全部流式 chunk 事件，
// 响应 4~13MB 且服务端不压缩；浏览器侧 RPC 有 30s 硬超时，低带宽链路
// （easytier / ZeroTier / Tailscale、移动网络）直接「历史加载失败」。
// gzip 后同页 ~1.2MB，实测（隔离环境）由 ~36s 降到 ~3s。
//
// 与上游 040822/dsh-gzip v0.1.1 的差异（两处实测修复）：
// 1. 补 dsh.bundle.patch 清单——原版无此声明，`dsh plugin add dsh-gzip`
//    只装成 plain dependency（warning），永不装配，静默无效。
// 2. 挂点改为双分支：优先直接替换 webServer.prefixes 中已注册的 /api
//    route.handler（无时序依赖）；patch register 仅作兜底。原版只 patch
//    register，而 rc.6 的 dsh-client-connection 在 apply 期间即注册 /api，
//    晚装配的 patch 落空（dump-config 条目顺序 + connection 源码 562 行
//    ctx.effect 立即执行，实测确认）。
//
// 安全边界：
// - 每请求实例级遮蔽 writeHead/write/end，不动任何 prototype；
// - 仅压缩 Accept-Encoding 协商 gzip（q=0 拒绝）且响应未自带
//   content-encoding 的可压缩类型；SSE（text/event-stream）、zip 导出、
//   已编码响应原样透传；
// - 无全局副作用：卸载恢复被替换的 handler 与 register。

import { createGzip } from "node:zlib";
import type { Gzip } from "node:zlib";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
import type { PluginContext, DshWebServer, DshRoute } from "../../../types/dsh.js";

export const name = "dsh-gzip";
export const inject = ["webServer"];

/** 压缩/透传计数（health 摘要用）。 */
export interface GzipStats {
  compressed: number;
  passthrough: number;
}

/** apply 配置（enabled=false 时不注册任何东西）。 */
export interface GzipConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

/** 路由常量单一来源（客户端契约/smoke 共用）。 */
export const ROUTES = {
  health: "/api/dsh-gzip/health",
};

export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson } from "../../../shared/host-utils.js";

// ---------------------------------------------------------------- 纯函数

/**
 * 判断 Accept-Encoding 头是否接受 gzip（q=0 视为拒绝）。
 * @param value 原始 Accept-Encoding 值。
 * @returns 是否接受 gzip。
 */
export function acceptsGzip(value: unknown): boolean {
  if (typeof value !== "string") return false;
  for (const part of value.split(",")) {
    const [coding, ...params] = part.trim().split(";").map((item) => item.trim());
    const q = params.find((param) => param.startsWith("q="));
    if (coding.toLowerCase() !== "gzip") continue;
    if (q === void 0) return true;
    const parsed = Number(q.slice(2));
    if (Number.isFinite(parsed) && parsed > 0) return true;
  }
  return false;
}

/**
 * 判断 content-type 是否可压缩：JSON/JSON 系/文本（SSE 除外）。
 * @param contentType 响应 content-type。
 * @returns 是否可压缩。
 */
export function isCompressible(contentType: unknown): boolean {
  const type = String(contentType).split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("application/json")
    || type.endsWith("+json")
    || (type.startsWith("text/") && type !== "text/event-stream");
}

/** 合并 Vary 头：已存在时追加 accept-encoding，避免覆盖上游语义。 */
export function joinVary(existing: unknown): string {
  const value = existing === void 0 ? "" : String(existing);
  return value === "" ? "accept-encoding" : `${value}, accept-encoding`;
}

/**
 * 按请求包装 ServerResponse 为其输出流套 gzip。
 * 不协商 gzip / 类型不可压缩 / 已带 content-encoding 时原样返回 res。
 * 遮蔽仅在实例上（不动 prototype），请求结束后自然随 res 一起丢弃。
 * @param res node:http ServerResponse。
 * @param req 对应 IncomingMessage（读 Accept-Encoding）。
 * @param stats 可选计数。
 * @returns 包装后（或原样）的 res。
 */
export function wrapResponse(res: ServerResponse, req: IncomingMessage, stats?: GzipStats): ServerResponse {
  if (!acceptsGzip(req.headers["accept-encoding"])) {
    if (stats) stats.passthrough += 1;
    return res;
  }

  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let gzip: Gzip | null = null;
  let counted = false;

  // 重赋值实例方法：类型断言到 ServerResponse 的方法签名（保留原逻辑，
  // 兼容 node:http 重载签名）。
  res.writeHead = (function writeHead(
    this: ServerResponse,
    statusCode: number,
    statusMessage?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders
  ) {
    if (typeof statusMessage === "object" && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = void 0;
    }
    if (gzip === null && !this.headersSent) {
      const contentType = headers?.["content-type"] ?? this.getHeader("content-type");
      const existingEncoding = headers?.["content-encoding"] ?? this.getHeader("content-encoding");
      if (existingEncoding === void 0 && isCompressible(contentType)) {
        gzip = createGzip();
        if (stats && !counted) {
          counted = true;
          stats.compressed += 1;
        }
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          delete headers["content-length"];
          headers["content-encoding"] = "gzip";
          headers["vary"] = joinVary(headers["vary"]);
        } else {
          this.removeHeader("content-length");
          this.setHeader("content-encoding", "gzip");
          this.setHeader("vary", joinVary(this.getHeader("vary")));
        }
        // gzip 输出喂给底层 socket；背压时暂停，res 排空后恢复。
        gzip.on("data", (chunk) => {
          if (!originalWrite(chunk)) {
            gzip!.pause();
            res.once("drain", () => gzip!.resume());
          }
        });
        gzip.on("end", () => originalEnd());
        gzip.on("error", () => {
          // 压缩失败：断开响应，客户端视作截断并中止请求。
          res.destroy();
        });
      }
    }
    return originalWriteHead(statusCode, statusMessage, headers);
  }) as ServerResponse["writeHead"];

  res.write = (function write(
    this: ServerResponse,
    chunk: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void
  ) {
    if (gzip === null) return originalWrite(chunk, encoding as BufferEncoding, callback);
    if (gzip.write(chunk, encoding as BufferEncoding)) {
      if (typeof callback === "function") callback();
      return true;
    }
    // gzip 内部缓冲已满：把它的 drain 桥接为 res 的 drain，
    // 让只监听 res 背压的上游（RPC bridge）能正确恢复。
    const onDrain = () => {
      gzip!.off("drain", onDrain);
      this.emit("drain");
    };
    gzip.on("drain", onDrain);
    if (typeof callback === "function") gzip.once("drain", callback);
    return false;
  }) as ServerResponse["write"];

  res.end = (function end(
    this: ServerResponse,
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void
  ) {
    if (typeof chunk === "function") {
      callback = chunk as () => void;
      chunk = void 0;
    }
    if (gzip === null) return originalEnd(chunk, encoding as BufferEncoding, callback);
    if (chunk !== void 0 && chunk !== null) gzip.write(chunk, encoding as BufferEncoding);
    gzip.end();
    // 原始 end 由 gzip "end" 处理器触发（数据排空后才落终结帧）。
    if (typeof callback === "function") gzip.once("end", callback);
  }) as ServerResponse["end"];

  return res;
}

/**
 * 安装 /api 压缩包装（双分支，无时序依赖），返回恢复函数数组。
 * @param webServer ctx.webServer 服务实例。
 * @param stats 计数。
 * @returns 恢复函数与挂点说明。
 */
export function installWrappers(webServer: DshWebServer, stats: GzipStats): { disposers: Array<() => void>; mounted: string } {
  const disposers: Array<() => void> = [];
  // register patch 兜底总是安装；mounted 描述当前 /api 的实际接管方式。
  let mounted = "register-patch";

  // 挂点 1：/api 已注册（本插件晚装配）——直接替换 route.handler。
  // host-webserver 派发时每次读取 route.handler（dispatch 处
  // `await route.handler(req, res)`），运行时替换立即生效。
  // 依赖 prefixes 为实例公开字段（非官方 API，上游改结构则退化到挂点 2）。
  const api = webServer.prefixes?.get("/api");
  if (api) {
    const original = api.handler;
    api.handler = (req, res) => original(req, wrapResponse(res, req, stats));
    mounted = "replace";
    disposers.push(() => {
      api.handler = original;
    });
  }

  // 挂点 2：/api 尚未注册（本插件先装配）——patch register 兜底，
  // 连接插件注册 /api 的瞬间接管 handler。保存原始引用（不 bind），
  // 卸载后身份级恢复，避免留下 bound 包装差异。
  const originalRegister = webServer.register;
  webServer.register = function register(route: DshRoute) {
    const dispose = originalRegister.call(webServer, route);
    if (route.kind === "prefix" && route.path === "/api") {
      const original = route.handler;
      route.handler = (req, res) => original(req, wrapResponse(res, req, stats));
    }
    return dispose;
  };
  disposers.push(() => {
    webServer.register = originalRegister;
  });

  return { disposers, mounted };
}

// ---------------------------------------------------------------- apply

export function apply(ctx: PluginContext, config: GzipConfig = {}): void {
  if (config.enabled === false) return;

  const stats: GzipStats = { compressed: 0, passthrough: 0 };
  const disposers: Array<() => void> = [];

  ctx.effect(() => {
    const { disposers: wrapperDisposers, mounted } = installWrappers(ctx.webServer, stats);
    disposers.push(...wrapperDisposers);

    // 健康检查（exact 路由先于 /api prefix 命中，自带 loopback 围栏）。
    const healthDisposer = ctx.webServer.register({
      kind: "exact",
      path: ROUTES.health,
      handler: (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end("method not allowed");
          return;
        }
        if (!isLoopbackRequest(req)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        writeJson(res, 200, {
          ok: true,
          plugin: "dsh-gzip",
          mounted,
          compressed: stats.compressed,
          passthrough: stats.passthrough,
        });
      },
    });
    disposers.push(healthDisposer);

    ctx.logger.info(`dsh-gzip: /api gzip enabled (mount: ${mounted})`);

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 卸载失败不掩盖其他清理。
        }
      }
    };
  }, "dsh-gzip");
}
