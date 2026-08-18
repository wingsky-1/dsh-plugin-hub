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
// 2. 挂点改为多分支、无时序依赖：直接替换已注册 prefix 的 route.handler
//    （含 /api、/plugins），并接管 fallback 席位（覆盖 /assets 静态资源与
//    index.html）；patch register / registerFallback 仅作兜底。原版只 patch
//    register，而 rc.6 的 dsh-client-connection 在 apply 期间即注册 /api，
//    晚装配的 patch 落空（dump-config 条目顺序 + connection 源码 562 行
//    ctx.effect 立即执行，实测确认）。
//
// 安全边界：
// - 每请求实例级遮蔽 writeHead/write/end，不动任何 prototype；
// - 仅压缩 Accept-Encoding 协商 gzip（q=0 拒绝）且响应未自带
//   content-encoding 的可压缩类型；SSE（text/event-stream）、zip 导出、
//   已编码响应、HEAD 请求、带 Range 的请求原样透传；
// - 无全局副作用：卸载恢复被替换的 handler 与 register / registerFallback。

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

/** 各接管面的实际状态（health 诊断）。 */
export type GzipMount = "replace" | "register-patch" | "passthrough";

/** 三个接管面：api（RPC）、plugins（插件客户端 bundle）、fallback（静态资源 + index）。 */
export interface GzipHandlers {
  api: GzipMount;
  plugins: GzipMount;
  fallback: GzipMount;
}

/** apply 配置（enabled=false 时不注册任何东西）。 */
export interface GzipConfig {
  enabled?: boolean;
  /** gzip 压缩级别 1..9，默认 1（静态文本场景性价比最高；非数字自动归一）。 */
  level?: number;
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
 * 归一化 gzip level：非有限数回退 1；clamp 到 1..9。
 * @param value 配置里的 level（可能为 string / NaN / 越界）。
 * @returns 有效压缩级别。
 */
export function normalizeLevel(value: unknown): number {
  const level = Number(value);
  if (!Number.isFinite(level)) return 1;
  return Math.min(9, Math.max(1, Math.trunc(level)));
}

/**
 * 按请求包装 ServerResponse 为其输出流套 gzip。
 * 不协商 gzip / HEAD / 带 Range / 类型不可压缩 / 已带 content-encoding 时原样返回 res。
 * 遮蔽仅在实例上（不动 prototype），请求结束后自然随 res 一起丢弃。
 * @param res node:http ServerResponse。
 * @param req 对应 IncomingMessage（读 Accept-Encoding / method / Range）。
 * @param stats 可选计数。
 * @param level gzip 压缩级别 1..9（默认 1）。
 * @returns 包装后（或原样）的 res。
 */
export function wrapResponse(res: ServerResponse, req: IncomingMessage, stats?: GzipStats, level = 1): ServerResponse {
  // HEAD 无 body、Range 需范围语义：均透传不压缩。
  if (!acceptsGzip(req.headers["accept-encoding"]) || req.method === "HEAD" || req.headers.range !== undefined) {
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
        gzip = createGzip({ level });
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
 * 安装 gzip 压缩包装（多分支，无时序依赖），返回恢复函数数组与各接管面状态。
 * 接管范围：已注册的 prefix 命名路由（/api、/plugins 及未来第三方 prefix）
 * 与 fallback 席位（/assets 静态资源 + index.html）；register / registerFallback
 * patch 作兜底（先装配或后续注册的情形）。
 * @param webServer ctx.webServer 服务实例。
 * @param stats 计数。
 * @param level gzip 级别。
 * @returns 恢复函数、向后兼容 mounted（/api 接管方式）与各接管面状态。
 */
export function installWrappers(webServer: DshWebServer, stats: GzipStats, level = 1): {
  disposers: Array<() => void>;
  mounted: string;
  handlers: GzipHandlers;
} {
  const disposers: Array<() => void> = [];
  const wrap = (handler: DshRoute["handler"]) =>
    (req: IncomingMessage, res: ServerResponse) => handler(req, wrapResponse(res, req, stats, level));

  const handlers: GzipHandlers = { api: "register-patch", plugins: "register-patch", fallback: "register-patch" };

  // 挂点 1：已注册 prefix 全量替换（依赖 prefixes 为实例公开字段，
  // 非官方 API；上游改结构则退化到 register patch 兜底）。
  const prefixes = webServer.prefixes;
  if (prefixes && typeof (prefixes as Map<string, { handler: DshRoute["handler"] }>).forEach === "function") {
    for (const [path, route] of prefixes) {
      const original = route.handler;
      route.handler = wrap(original);
      if (path === "/api") handlers.api = "replace";
      else if (path === "/plugins") handlers.plugins = "replace";
      disposers.push(() => {
        route.handler = original;
      });
    }
  }

  // 挂点 2：register patch 兜底（后续注册的 prefix）。register 为官方必选
  // 方法，直接 patch；fallback/registerFallback 为非官方方法才判存在性。
  {
    const originalRegister = webServer.register;
    webServer.register = function register(route: DshRoute) {
      const dispose = originalRegister.call(webServer, route);
      if (route.kind === "prefix" && webServer.prefixes) {
        const stored = webServer.prefixes.get(route.path);
        const target = stored ?? route;
        const original = target.handler;
        target.handler = wrap(original);
        if (route.path === "/api") handlers.api = "register-patch";
        else if (route.path === "/plugins") handlers.plugins = "register-patch";
      }
      return dispose;
    };
    disposers.push(() => {
      webServer.register = originalRegister;
    });
  }

  // 挂点 3：fallback 席位接管（覆盖 /assets 静态资源与 index.html）。
  // fallback / registerFallback 为非官方实例字段，运行时普通属性，可读可替。
  const owner = webServer as unknown as {
    fallback?: DshRoute["handler"];
    registerFallback?: (handler: DshRoute["handler"]) => () => void;
  };
  if (typeof owner.fallback === "function") {
    const original = owner.fallback;
    owner.fallback = wrap(original);
    handlers.fallback = "replace";
    disposers.push(() => {
      owner.fallback = original;
    });
  }
  if (typeof owner.registerFallback === "function") {
    const originalRegisterFallback = owner.registerFallback;
    owner.registerFallback = function registerFallback(handler: DshRoute["handler"]) {
      const dispose = originalRegisterFallback.call(webServer, wrap(handler));
      handlers.fallback = "register-patch";
      return dispose;
    };
    disposers.push(() => {
      owner.registerFallback = originalRegisterFallback;
    });
  }

  // 向后兼容：mounted 反映 /api 的实际接管方式（与历史 "replace" / "register-patch" 一致）。
  const mounted = handlers.api === "replace" ? "replace" : "register-patch";
  return { disposers, mounted, handlers };
}

// ---------------------------------------------------------------- apply

export function apply(ctx: PluginContext, config: GzipConfig = {}): void {
  if (config.enabled === false) return;

  const level = normalizeLevel(config.level);
  const stats: GzipStats = { compressed: 0, passthrough: 0 };
  const disposers: Array<() => void> = [];

  ctx.effect(() => {
    const { disposers: wrapperDisposers, handlers } = installWrappers(ctx.webServer, stats, level);
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
          // mounted 与 handlers.api 实时一致（向后兼容的 /api 接管方式）。
          mounted: handlers.api,
          handlers,
          compressed: stats.compressed,
          passthrough: stats.passthrough,
        });
      },
    });
    disposers.push(healthDisposer);

    ctx.logger.info(
      `dsh-gzip: gzip enabled (level ${level}, api=${handlers.api}, plugins=${handlers.plugins}, fallback=${handlers.fallback})`
    );

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
