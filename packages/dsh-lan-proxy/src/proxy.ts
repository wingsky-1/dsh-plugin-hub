// dsh-lan-proxy — 传输核心（不依赖 cordis，可独立单测）。
//
// 在 0.0.0.0:<port> 上监听，把所有 HTTP 请求与 WebSocket 升级转发到
// 127.0.0.1:<targetPort>（dsh web 服务器）。提供 `tls` + `httpsPort` 时，
// 额外在 0.0.0.0:<httpsPort> 上监听 HTTPS（与 HTTP 并存，同一转发核心），
// WebSocket 升级同步支持 wss。
//
// 转发引擎为成熟开源库 http-proxy（issue #10；新增第三方依赖红线已经决策
// issue #47 批准）：HTTP 报文转发与 WS upgrade 的 socket 管道、背压、升级
// 边界由库承担，构建期经 esbuild 内联进 lib/index.js，运行时零 npm 依赖。
// 安全围栏不交出去——hostnameAllowed / rewriteHeaders / isLoopbackTarget
// 纯函数保留为转发前置校验，http-proxy 仅在其后接管。两个设计点使它适配
// dsh 的安全模型：
//
// 1. /api 浏览器信任围栏。dsh-client-connection 会拒绝所有 Host 头不是回环
//    主机名或已配置受信 authority 的 /api 请求（DNS 重绑定 + 跨站防御）。
//    LAN 转发器无法向该围栏追加受信项（它只从配置解析一次），因此我们把
//    `Host` — 以及存在时的 `Origin` — 重写为回环目标 authority。这样
//    `Origin` 恰好等于重写后的 Host，正是围栏的校验条件。HTTPS 入站的
//    Origin 是 `https://…`，同样被重写为回环 HTTP authority（上游是明文）。
//
// 2. DNS 重绑定防护。若只把 Host 重写为回环地址，重绑定页面（攻击者域名
//    解析到你的局域网 IP）就能穿过围栏。因此我们拒绝所有主机名不是
//    IP 字面量（IPv4/IPv6）或 `localhost` 的入站 Host — 与 dsh 自身受信
//    主机推导的理据一致（"IP 字面量 Host 在任何端口都安全"，因为重绑定
//    需要攻击者可控的名字）。TLS 握手发生在 Host 检查之前，但证书只保证
//    加密不保证身份（自签），重绑定防护逻辑对 HTTPS 入站同样生效。
//
// `sec-fetch-site` 原样透传：从转发器自身源加载的浏览器页面发送
// `same-origin`，跨站页面仍发送 `cross-site` 并被围栏拒绝 — 防御链路完整。
import { createServer, Agent } from "node:http";
import type { Server, IncomingMessage, IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpsServer } from "node:https";
import { isIP } from "node:net";
import type { Socket, AddressInfo } from "node:net";
import { constants as zlibConstants } from "node:zlib";
// ws 库同时以两个名字绑定同一 WebSocket 类：WsClient 用于发起上游客户端连接，
// WebSocket 用于两端共同类型面（含静态 readyState 常量 OPEN）。
import { WebSocket as WsClient, WebSocketServer, WebSocket } from "ws";
// 成熟开源压缩中间件（Express 生态事实标准）：协商 / Vary / Content-Length 删除 /
// 背压 / 204·304·Range 豁免全部由库承担，构建期经 esbuild 内联（零运行时依赖）。
import compression from "compression";
// 成熟开源 HTTP/WS 转发库（node-http-proxy）：接管 HTTP 转发与 WS upgrade，
// 构建期经 esbuild 内联（零运行时依赖）。默认导入对齐其 CJS 导出面
// （module.exports = ProxyServer 类，静态方法 createProxyServer）。
import httpProxy from "http-proxy";

/** HTTP 响应压缩中间件请求对象最小面（compression 的 req 参数仅读 method/httpVersion 等）。 */
type CompressReq = IncomingMessage;
type CompressRes = ServerResponse;

/** createLanProxy 的日志器最小面（console 或 ctx.logger 均兼容）。 */
export interface LanLogger {
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/** TLS 证书材料（PEM 字符串或 Buffer）。 */
export interface TlsMaterials {
  key: string | Buffer;
  cert: string | Buffer;
}

/** createLanProxy 选项。 */
export interface LanProxyOptions {
  host?: string;
  port?: number;
  /** HTTPS 监听端口；与 {@link tls} 同时提供时启用 HTTPS（与 HTTP 并存）。 */
  httpsPort?: number;
  /** TLS 证书材料；提供时启用 HTTPS 监听（wss 同步支持）。 */
  tls?: TlsMaterials;
  targetHost?: string;
  /** dsh web 服务器实际绑定端口（必填）。 */
  targetPort: number;
  /**
   * WebSocket 压缩桥接：对命中 `paths` 的 WS 升级做「终结 + permessage-deflate」，
   * 浏览器段压缩、DSH 段明文；其余 WebSocket 继续由 http-proxy 做 TCP 字节透传。
   * 默认作用于大流量的 `/api/remote.mux`（dsh 0.1.2 起 api-gateway 拥有的
   * Remote 流 mux 通道，取代旧 events.mux/events.host）。DSH 服务端即使
   * 未来自身开启 permessage-deflate，这里 DSH 段固定不协商、浏览器段独立协商，
   * 天然避免双重压缩。桥接上游连接的入站头透传见 {@link bridgeUpstreamHeaders}。
   */
  wsCompress?: {
    enabled: boolean;
    paths: readonly string[];
    /**
     * 桥接半开探活间隔 ms（issue #268 P0-1）；缺省 DEFAULT_WS_PROBE_INTERVAL_MS，
     * 0 = 关闭。内部/测试注入口，非用户配置键。
     */
    probeIntervalMs?: number;
  };
  /**
   * WS 压缩协商策略（issue #308）：浏览器段是否协商 permessage-deflate /
   * 按 UA 片段拒绝。iOS Safari 启用压缩即失败（uWebSockets.js #76 实证），
   * 默认拦截 iPhone/iPad/iPod；缺省取 {@link DEFAULT_DEFLATE_POLICY}。
   */
  wsDeflatePolicy?: DeflatePolicy;
  /**
   * HTTP 响应压缩（合并自 dsh-gzip，经 compression 中间件在转发层实现）：
   * 对可压缩响应（JSON / 文本；SSE 豁免）按 Accept-Encoding 协商——含 br 时优先
   * 输出 Brotli（compression@1.8+ 支持），否则回退 gzip；options.level 仅作用
   * 于 gzip 回退路径。
   * 启用后 dsh-gzip 独立包（宿主端压缩）与本层经 content-encoding 检查天然互斥，
   * 任意组合只压一次。回环直连 web（不经本转发器）不经过此层。
   */
  httpCompress?: {
    enabled: boolean;
    /** 压缩档位预设：0 默认 / 1 低 / 2 中 / 3 高（对 gzip 与 Brotli 双生效）。 */
    level?: number;
  };
  /**
   * 自动注入启动令牌（issue #380）：提供时，LAN 设备首次访问 `GET /`（无会话
   * cookie）由转发层自动补当前 launch token——上游铸造持久会话 cookie，固定
   * 设备免手工拿 token；带失效 cookie 的同类请求在上游 401 后重放一次自愈。
   * getToken 动态读取（不缓存）：dsh web 重启后 token 变化自动跟随；返回
   * undefined（connection 服务未就绪/读取失败）时逐请求降级为不注入。
   */
  injectToken?: TokenProvider;
  logger?: LanLogger;
}

/**
 * 当前 dsh web 进程 launch token 的动态提供者最小面（issue #380）。
 * apply 侧封装自官方 connection 服务的公开方法 `authenticatedUrl(baseUrl)`
 * （@deepseek-ai/dsh-client-connection 公开 d.ts API，不依赖私有字段）。
 */
export interface TokenProvider {
  /** 返回当前 launch token；不可用时返回 undefined（逐请求降级为不注入）。 */
  getToken(): string | undefined;
}

/** 监听结果：httpPort 必有；httpsPort 仅在 HTTPS 成功启用时给出。 */
export interface LanListenResult {
  httpPort: number;
  httpsPort?: number;
}

/** 转发器实例。 */
export interface LanProxy {
  server: Server;
  /** HTTPS 监听器（仅启用 TLS 时存在）。 */
  httpsServer?: HttpsServer;
  listen(): Promise<LanListenResult>;
  close(): Promise<void>;
  targetAuthority: string;
  /** HTTP 响应压缩协商计数（未启用压缩时恒为 0）。 */
  httpCompressStats(): { compressed: number; passthrough: number };
  /**
   * 断连原因计数快照（issue #308 / 承载清单①轻量版）：转发层是全部连接的
   * 唯一观测点，统计各类异常断开供诊断「手机端切后台 / 中继超时 / 业务错误」
   * 的占比（health 与 GET /config 展示）。数值为进程启动/转发器重建后的累计。
   */
  connStats(): ConnStats;
}

/** 断连原因计数（转发层观测；见 {@link LanProxy.connStats}）。 */
export interface ConnStats {
  /** 桥接路径：任一端 close（正常或异常收口）。 */
  wsBridgeClosed: number;
  /** 桥接路径：半开探活判死强拆（iOS 后台冻结 / 中继静默掐断的特征信号）。 */
  wsBridgeHalfOpen: number;
  /** 桥接路径：upstream 错误（连接被掐 / 协议错误）。 */
  wsBridgeErrors: number;
  /** 透传路径：socket 异常销毁（未走正常关闭握手）。 */
  wsPassthroughDestroyed: number;
  /** 透传路径：socket error（ECONNRESET 等）。 */
  wsPassthroughErrors: number;
  /** HTTP 转发：客户端提前断开 → 上游响应 aborted。 */
  httpClientAborted: number;
  /** HTTP 转发：代理错误（上游不可达 / 转发中断）。 */
  httpProxyErrors: number;
}

/**
 * 判断 content-type 是否可压缩：JSON/JSON 系/文本（SSE 除外）。
 * 自 dsh-gzip 迁移的纯函数，作为 compression 中间件的自定义 filter——
 * 库默认 filter 会放行 text/event-stream，这里保持 dsh-gzip 的 SSE 豁免语义。
 * @param contentType 响应 content-type。
 * @returns 是否可压缩。
 */
export function isCompressible(contentType: unknown): boolean {
  const type = String(contentType).split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("application/json")
    || type.endsWith("+json")
    || (type.startsWith("text/") && type !== "text/event-stream");
}

/** 压缩预设档位 → compression 中间件选项（gzip 与 Brotli 双生效）。 */
export interface CompressionOptions {
  level?: number;
  brotli?: { params: Record<string, number> };
}

/** WS 压缩协商策略：浏览器段开关 + UA 拒绝片段。 */
export interface DeflatePolicy {
  /** 浏览器段是否允许协商 permessage-deflate（false = 全局关闭压缩）。 */
  browser?: boolean;
  /** UA 字符串包含任一片段 → 该端强制不协商压缩。 */
  uaDeny?: readonly string[];
}

/** 默认 WS 压缩策略（单一事实源）：浏览器段可协商，但 iOS 三件套强制不协商。 */
export const DEFAULT_DEFLATE_POLICY: Readonly<DeflatePolicy> = Object.freeze({
  browser: true,
  uaDeny: Object.freeze(["iPhone", "iPad", "iPod"]),
});

/**
 * 按策略判定某 UA 是否允许协商 WS 压缩（纯函数，可单测）。
 * 任一环节未配置均取宽松语义：无策略 = 放行；browser=false = 拒绝；
 * uaDeny 为空/UA 缺失 = 放行；UA 命中任一 deny 片段 = 拒绝。
 * @param policy 协商策略（缺省按放行处理）。
 * @param userAgent 入站 `user-agent` 请求头（可缺失）。
 */
export function deflateAllowedByPolicy(policy: DeflatePolicy | undefined, userAgent: string | undefined): boolean {
  if (policy?.browser === false) return false;
  const deny = policy?.uaDeny;
  if (deny === undefined || deny.length === 0) return true;
  if (typeof userAgent !== "string" || userAgent.length === 0) return true;
  return !deny.some((frag) => userAgent.includes(frag));
}

/**
 * 压缩档位映射（对 br 与 gzip 同时生效）：
 *   0 默认 → 不传参（库默认：gzip Z_DEFAULT_COMPRESSION=6 / br 质量 4）
 *   1 低   → gzip 1 / br 2（最快，静态文本性价比最高）
 *   2 中   → gzip 5 / br 5（均衡）
 *   3 高   → gzip 9 / br 9（最高压缩比，CPU 最贵）
 * 非法输入（非有限数/越界）按「默认」处理。
 */
export function resolveCompressionOptions(preset: unknown): CompressionOptions {
  switch (preset) {
    case 1:
      return { level: 1, brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 2 } } };
    case 2:
      return { level: 5, brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } } };
    case 3:
      return { level: 9, brotli: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } } };
    default:
      return {};
  }
}

/**
 * 格式化 `host:port` 用于请求头，IPv6 字面量加方括号。
 * @param host 主机名/IP。
 * @param port 端口。
 * @returns 格式化 authority。
 */
export function formatAuthority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/**
 * 判断入站 Host authority 是否允许转发。仅接受 IP 字面量与 `localhost`；
 * 任何 DNS 域名一律拒绝（HTTP 返回 403 / 升级连接直接断开）。
 * @param authority 原始 `Host` 请求头值。
 * @returns 是否允许。
 */
export function hostnameAllowed(authority: string | undefined): boolean {
  if (typeof authority !== "string" || authority.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${authority}`).hostname;
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}

/** 出站转发目标仅允许回环（防开放转发/SSRF）。targetHost 本应只指向回环 web 服务器。 */
export function isLoopbackTarget(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return host === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "::ffff:127.0.0.1";
}

/**
 * 为上游一跳重建请求头（Host/Origin 重写）。导出供纯函数单测锁定行为；
 *  实际转发路径上作为 http-proxy 的每请求 headers 覆盖传入（前置校验不外移）。 */
export function rewriteHeaders(headers: IncomingHttpHeaders, targetAuthority: string): IncomingHttpHeaders {
  const out = { ...headers };
  out.host = targetAuthority;
  if (out.origin !== undefined) out.origin = `http://${targetAuthority}`;
  return out;
}

// ---- injectToken（issue #380）：launch token 自动注入的判定与改写 ----
// 上游（dsh-client-connection.authorizeIndex）的铸造入口只有 `GET /` 且查询串
// 恰带一个 token 参数；带 token 的请求一律以 303 结束（匹配→铸 cookie，或
// 有效 cookie→清参重定向）。因此：
//   * 对「无会话 cookie」的 GET / 注入 token → 一次跳转即登录；
//   * 对「已带会话 cookie」的请求**绝不注入**——否则有效 cookie 用户会被
//     无限 303（浏览器每次都带 cookie、代理每次都注入）。该排除是正确性
//     必需而非优化，重构时不得移除（smoke 用例锁死意图）。
//   * 失效 cookie（签名 secret 重置等）会让上述排除变成 401 死锁——对这类
//     请求在上游 401 后重放一次（带 token），上游 token 分支优先验签、直接
//     重铸 cookie，浏览器自愈。

/** 上游浏览器会话 cookie 名前缀（dsh-client-connection COOKIE_PREFIX）。 */
const DSH_AUTH_COOKIE_PREFIX = "dsh-auth-";

/**
 * 判断请求是否携带 dsh 浏览器会话 cookie（issue #380）。
 * 按 RFC 6265 口径精确解析：`;` 分段、取 `=` 前名字并 trim、名字前缀匹配——
 * 禁止整头子串匹配（其他 cookie 的值含该子串会造成误判）。
 * 导出供纯函数单测。
 */
export function hasDshAuthCookie(cookieHeader: string | string[] | undefined): boolean {
  const segments = Array.isArray(cookieHeader) ? cookieHeader : cookieHeader !== undefined ? [cookieHeader] : [];
  for (const head of segments) {
    for (const segment of head.split(";")) {
      const eq = segment.indexOf("=");
      if (eq === -1) continue;
      if (segment.slice(0, eq).trim().startsWith(DSH_AUTH_COOKIE_PREFIX)) return true;
    }
  }
  return false;
}

/**
 * 注入候选判定：GET 且出站路径恰为 `/` 且查询串尚无 token 参数。
 * 与上游铸造条件（`GET /`、单一 token）严格对齐；其余请求一律不注入
 * （带 token 的非根请求上游也回 401，注入无意义）。导出供纯函数单测。
 */
export function isTokenMintCandidate(method: string | undefined, url: string | undefined): boolean {
  if (method !== "GET" || url === undefined) return false;
  try {
    const parsed = new URL(url, "http://lan-proxy.local");
    return parsed.pathname === "/" && parsed.searchParams.getAll("token").length === 0;
  } catch {
    return false;
  }
}

/**
 * 把 token 并入请求 URL 的 query（`token` 参数；已存在时覆盖）。解析失败
 * 返回 undefined（调用方降级为不注入）。导出供纯函数单测。
 */
export function withLaunchToken(url: string | undefined, token: string): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url, "http://lan-proxy.local");
    parsed.searchParams.set("token", token);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

/**
 * 压缩桥接上游连接剥离的入站头：hop-by-hop 头（RFC 7230 §6.1，代理不得转发）
 * 与 WS 握手专有头（RFC 6455 §4.1，ws 库客户端按上游握手自行生成——透传浏览器段
 * 的同名头会产生重复头，直接破坏上游握手）。
 */
const BRIDGE_UPSTREAM_HEADER_DENY: ReadonlySet<string> = new Set([
  "connection", "upgrade", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate",
  "te", "trailer", "transfer-encoding",
  "sec-websocket-accept", "sec-websocket-extensions", "sec-websocket-key",
  "sec-websocket-protocol", "sec-websocket-version",
]);

/**
 * 为压缩桥接的上游连接重建请求头（纯函数，导出供单测锁定行为）。
 *
 * 与 HTTP/WS 透传路径的 {@link rewriteHeaders} 不同：桥接是「终结浏览器连接 →
 * 新建上游连接」，入站头必须显式随行转发。dsh 0.1.2 起 `/api/remote.mux` 的升级
 * 处理在 Host/Origin 围栏之外还要校验 authority 绑定的浏览器会话 Cookie
 * （connection.requestRejection → isAuthenticated），丢弃 Cookie 即 401 拒绝
 * 升级、桥接表现为连不上（issue #379）。因此这里透传全部入站头（含 Cookie
 * 等认证凭据），仅做两类例外：
 *   - 覆盖 Host/Origin 为回环目标 authority（/api 浏览器信任围栏的校验条件，
 *     与 rewriteHeaders 语义一致）；
 *   - 剥离 {@link BRIDGE_UPSTREAM_HEADER_DENY} 集合中的头。
 * @param headers 入站升级请求头。
 * @param targetAuthority 回环目标 authority（host:port）。
 * @returns 上游连接请求头（ws 库 headers 选项的键值面）。
 */
export function bridgeUpstreamHeaders(headers: IncomingHttpHeaders, targetAuthority: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "origin" || BRIDGE_UPSTREAM_HEADER_DENY.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  out.host = targetAuthority;
  out.origin = `http://${targetAuthority}`;
  return out;
}

/**
 * 默认配置（单一事实源）：schema 默认值、resolve 兜底、createLanProxy 参数
 * 默认值统一引用本常量，避免默认端口/主机多处硬编码漂移。
 * 注意：cordis.patch.yml 中的 port: 3081 属 bundle 层显式配置，与默认值
 * 保持一致即可，修改默认值需同步该文件注释。
 */
export const DEFAULT_OPTIONS = Object.freeze({ host: "0.0.0.0", port: 3081, httpsPort: 3443, targetHost: "127.0.0.1" });

/** 上游 keep-alive 连接池上限（并发上游连接数；超出排队）。 */
const MAX_UPSTREAM_SOCKETS = 64;

/**
 * 判断某 WS 升级请求路径是否命中「需压缩桥接」白名单。
 * 仅比较 pathname（忽略查询串）。导出供纯函数单测锁定行为。
 * @param paths 压缩白名单（默认含 /api/remote.mux）。
 * @param url 原始请求 URL（可能带查询串）。
 * @returns 是否命中。
 */
export function compressWsPath(paths: readonly string[] | undefined, url: string | undefined): boolean {
  if (!paths || paths.length === 0 || typeof url !== "string" || url.length === 0) return false;
  const pathname = url.split("?")[0];
  return paths.includes(pathname);
}

/** 桥接目标（DSH 端）。 */
export interface WsBridgeTarget {
  targetHost: string;
  targetPort: number;
  logger?: LanLogger;
  /**
   * 半开探活间隔 ms；缺省 {@link DEFAULT_WS_PROBE_INTERVAL_MS}；0 = 关闭探活。
   * 生产走默认值，该字段主要供单测注入小间隔以确定性验证探活行为。
   */
  probeIntervalMs?: number;
  /**
   * 浏览器段压缩协商策略（issue #308）：iOS Safari 启用 permessage-deflate 即
   * 失败，默认经 {@link DEFAULT_DEFLATE_POLICY} 拦截 iPhone/iPad/iPod。
   */
  deflatePolicy?: DeflatePolicy;
  /**
   * 断连分类打点回调（issue #308 测量）：桥接任一端 close/error/半开判死时
   * 以分类上报；缺省不记录。半开判死（halfOpen）是 iOS 后台冻结 / 中继静默
   * 掐断的特征信号，用于诊断「手机端切后台后连接挂起」占比。
   */
  onDisconnect?: (kind: "close" | "error" | "halfOpen") => void;
}

/**
 * WS 压缩桥接的半开探活间隔（issue #268 P0-1）：移动端切后台系统静默掐断 TCP
 * 形成半开连接，两端都收不到 FIN/RST，close/error 事件永不触发 → 桥接僵死。
 * 每 30s 对桥接两端各发一帧 ping；一个周期内未获 pong 即判定半开并 terminate。
 */
export const DEFAULT_WS_PROBE_INTERVAL_MS = 30_000;

/**
 * 给单个 WS 连接挂半开探活（ws 库官方 FAQ「检测并关闭坏连接」标准做法）：
 * interval 每周期检查上一轮标记——已收到 pong 则再发下一轮 ping 并置脏；
 * 未收到（isAlive 仍为脏）即判定半开，terminate 让 close 事件照常成立。
 * 返回清理函数：清定时器 + 摘除 pong 监听器（对照 #278 SSE 心跳 stopHeartbeat
 * 的单入口收敛形态）；unref 使探活不阻止进程退出。
 * @param ws 桥接任意一端的连接。
 * @param intervalMs 探活周期（= pong 宽限窗）。
 * @param onHalfOpen 判死回调（调用方借此经 logger 输出半开判死日志，
 *   与「正常关闭/业务错误」的 upstream error warn 区分；可省略）。
 * @returns 幂等清理函数。
 */
function attachWsLivenessProbe(
  ws: WebSocket,
  intervalMs: number,
  onHalfOpen?: (intervalMs: number) => void,
): () => void {
  let alive = true;
  const markAlive = () => {
    alive = true;
  };
  ws.on("pong", markAlive);
  const timer = setInterval(() => {
    // 连接已在收口路径（close 竞态）：不 ping 不判定，等 close 清理本探活。
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      onHalfOpen?.(intervalMs); // 先报后半开判死，再强拆使 close/error 语义成立
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // send/ping 与 close 的竞态：等待 close 收口即可
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    ws.off("pong", markAlive);
  };
}

/**
 * WebSocket 压缩桥接：终结浏览器连接（permessage-deflate 压缩）× 明文连 DSH
 * （不协商压缩，DSH 即使未来开启也不双重压缩）。双向转发 text/binary 帧，
 * 任何一端关闭/出错即对端终止，避免泄漏。
 *
 * 半开探活（issue #268 P0-1）：对两端**各自独立**计时发 ping（{@link
 * DEFAULT_WS_PROBE_INTERVAL_MS}，可经 {@link WsBridgeTarget.probeIntervalMs} 覆盖），
 * 一个周期内未获 pong 即 terminate 该端——terminate 引发 close，下方既有互断
 * 逻辑自然收口另一端。探活定时器/监听器随连接关闭释放：两端各自的 close/error
 * 四路清理收敛到 stopAllProbes 单入口。
 */
export function bridgeCompressedWs(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: WsBridgeTarget,
): void {
  // 浏览器段：终结 + permessage-deflate（浏览器默认协商并自动解压）。
  // #308：iOS Safari 启用 permessage-deflate 即失败（uWebSockets.js #76 实证），
  // 按 wsDeflatePolicy 判定该 UA 是否允许协商——命中 deny（默认 iPhone/iPad/iPod）
  // 或 browser=false 时浏览器段不协商压缩（帧仍由桥接转发，只是明文），
  // 规避 iOS 端 WS 握手失败/连接被掐。
  const deflateAllowed = deflateAllowedByPolicy(target.deflatePolicy, req.headers["user-agent"]);
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: deflateAllowed ? { threshold: 1024 } : false,
  });
  wss.handleUpgrade(req, socket, head, (browserWs) => {
    // DSH 段：明文（本机/内网），固定不协商 permessage-deflate。
    // 入站头透传（Cookie 等认证凭据；issue #379——0.1.2 起 /api/remote.mux 升级
    // 需 Cookie 认证），Host/Origin 覆盖为回环目标，hop-by-hop 与 sec-websocket-*
    // 剥离（ws 库自生成）。upstreamUrl 经 formatAuthority 拼接：IPv6 targetHost
    // （::1）裸拼接会产出非法 URL（ws 库同步抛 SyntaxError → 本回调无 try/catch
    // 即进程级崩溃），方括号形态才合法（#379 复核 M3 修复）。
    const upstreamUrl = `ws://${formatAuthority(target.targetHost, target.targetPort)}${req.url}`;
    const upstreamWs = new WsClient(upstreamUrl, {
      perMessageDeflate: false,
      headers: bridgeUpstreamHeaders(req.headers, formatAuthority(target.targetHost, target.targetPort)),
    });
    // 半开探活：两端独立计时（各自 pong 判定），probeIntervalMs=0 显式关闭。
    const probeIntervalMs = target.probeIntervalMs ?? DEFAULT_WS_PROBE_INTERVAL_MS;
    let stopProbes: (() => void) | undefined;
    const stopAllProbes = () => {
      stopProbes?.();
      stopProbes = undefined;
    };
    if (probeIntervalMs > 0) {
      // 半开判死日志：与既有 upstream error warn 同通道、可按文案区分
      // 「半开判死强拆」与「正常关闭/业务错误」（issue #268 复核闸修补 2）。
      const onHalfOpen = (intervalMs: number) => {
        target.logger?.warn?.(`lan-proxy: ws-bridge half-open detected, terminating (intervalMs=${intervalMs})`);
        target.onDisconnect?.("halfOpen");
      };
      const stopBrowserProbe = attachWsLivenessProbe(browserWs, probeIntervalMs, onHalfOpen);
      const stopUpstreamProbe = attachWsLivenessProbe(upstreamWs, probeIntervalMs, onHalfOpen);
      stopProbes = () => {
        stopBrowserProbe();
        stopUpstreamProbe();
      };
    }
    // 浏览器 → DSH（握手成功后开始转发）。注意保留原始帧类型 isBinary：
    // ws 的 message 回调 data 恒为 Buffer，若不显式回传 binary 标志，send(Buffer)
    // 会被当二进制帧发出——events 流是文本 JSON，误发 binary 会被客户端拒绝。
    upstreamWs.on("open", () => {
      browserWs.on("message", (data, isBinary) => {
        if (upstreamWs.readyState === WsClient.OPEN) upstreamWs.send(data, { binary: isBinary });
      });
    });
    // DSH → 浏览器。
    upstreamWs.on("message", (data, isBinary) => {
      if (browserWs.readyState === browserWs.OPEN) browserWs.send(data, { binary: isBinary });
    });
    // 任一端关闭/出错 → 对端终止；四路清理收敛到 stopAllProbes（幂等）。
    // 断连分类打点（issue #308 测量）：close/error/halfOpen 各有独立计数。
    const report = (kind: "close" | "error" | "halfOpen") => target.onDisconnect?.(kind);
    upstreamWs.on("close", () => {
      stopAllProbes();
      report("close");
      browserWs.terminate();
    });
    upstreamWs.on("error", (err) => {
      stopAllProbes();
      report("error");
      target.logger?.warn?.(`lan-proxy: ws-bridge upstream error: ${err.message}`);
      browserWs.terminate();
    });
    browserWs.on("close", () => {
      stopAllProbes();
      report("close");
      try { upstreamWs.close(); } catch { /* 已关闭 */ }
    });
    browserWs.on("error", () => {
      stopAllProbes();
      report("error");
      try { upstreamWs.close(); } catch { /* 已关闭 */ }
    });
  });
}

/**
 * 创建 LAN 转发器（HTTP + 可选 HTTPS 并存）。调用 {@link listen} 之前不会绑定端口。
 * @param options 转发选项。
 * @param logger 可选日志器（默认 console）。
 * @returns 转发器实例。
 */
export function createLanProxy(options: LanProxyOptions, logger: LanLogger = console): LanProxy {
  // 入口强校验：targetHost 仅允许回环（配置层/文件层已过滤，此处为最后防线）
  const th = options.targetHost ?? DEFAULT_OPTIONS.targetHost;
  if (!isLoopbackTarget(th)) {
    throw new Error(`lan-proxy: targetHost 仅允许回环地址（收到 "${th}"），拒绝启动——防止开放转发`);
  }

  const host = options.host ?? DEFAULT_OPTIONS.host;
  const port = options.port ?? DEFAULT_OPTIONS.port;
  const httpsPort = options.httpsPort ?? DEFAULT_OPTIONS.httpsPort;
  const targetHost = options.targetHost ?? DEFAULT_OPTIONS.targetHost;
  const targetPort = options.targetPort;
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error(`lan-proxy: targetPort must be a valid port, got ${targetPort}`);
  }
  const targetAuthority = formatAuthority(targetHost, targetPort);
  /** 上游连接的 keep-alive 连接池；close() 时销毁。http-proxy 经 agent 选项复用。 */
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_UPSTREAM_SOCKETS });

  // ---- HTTP 响应压缩（compression 中间件，转发层实现）----
  // filter 复用 dsh-gzip 的 isCompressible 语义（SSE 豁免）；计数为「协商计数」：
  // filter 放行 ≠ 最终一定压缩（库还会按阈值/状态码二次判定），诊断口径见 README。
  const compressStats = { compressed: 0, passthrough: 0 };
  /** 断连原因计数（issue #308；见 LanProxy.connStats 文档）。 */
  const connStats: ConnStats = {
    wsBridgeClosed: 0,
    wsBridgeHalfOpen: 0,
    wsBridgeErrors: 0,
    wsPassthroughDestroyed: 0,
    wsPassthroughErrors: 0,
    httpClientAborted: 0,
    httpProxyErrors: 0,
  };
  /** 桥接路径打点回调（bridgeCompressedWs 的 target 注入，避免直接耦合计数对象）。 */
  const onBridgeDisconnect: NonNullable<WsBridgeTarget["onDisconnect"]> = (kind) => {
    if (kind === "halfOpen") connStats.wsBridgeHalfOpen += 1;
    else if (kind === "error") connStats.wsBridgeErrors += 1;
    else connStats.wsBridgeClosed += 1;
  };
  // 本地直接生成的响应（403 围栏 / PNA 预检 / 502 网关错误）标记：不进入压缩
  // 协商计数，避免 health 诊断数字被非转发流量污染（实测 403+预检即 +2）。
  const LOCAL_RESPONSE = Symbol("lan-proxy.localResponse");
  let compressMiddleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
  if (options.httpCompress?.enabled) {
    // @types/compression 的中间件签名用 express Request/Response 泛型；本处只传
    // node:http 原生对象（compression 运行时仅使用其上存在的字段），做一次收窄。
    const middleware = compression({
      ...resolveCompressionOptions(options.httpCompress.level),
      threshold: 1024,
      filter: (_req, res) => {
        if ((res as ServerResponse & { [LOCAL_RESPONSE]?: boolean })[LOCAL_RESPONSE]) return false;
        const ok = isCompressible(res.getHeader("content-type"));
        if (ok) compressStats.compressed += 1;
        else compressStats.passthrough += 1;
        return ok;
      },
    }) as unknown as (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
    compressMiddleware = middleware;
  }
  /** 标记本地响应：跳过压缩协商计数。 */
  const markLocal = (res: ServerResponse) => {
    (res as ServerResponse & { [LOCAL_RESPONSE]?: boolean })[LOCAL_RESPONSE] = true;
  };
  /** 压缩启用时包一层中间件，否则原样透传（零开销路径）。 */
  const withCompress = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
    compressMiddleware
      ? (req: IncomingMessage, res: ServerResponse) => compressMiddleware!(req, res, () => handler(req, res))
      : handler;
  /**
   * 本服务器接受过的全部 socket（含 WebSocket 升级后的 socket）。Node 的
   * closeAllConnections() 只管普通连接，升级 socket 需要显式销毁，
   * 否则 server.close() 的回调永远不会触发。
   */
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  // ---- 转发核心：http-proxy 接管（安全围栏之后） ----
  // 目标为回环上游（isLoopbackTarget 已强校验）；keep-alive 连接池经 agent
  // 选项交给库；不用 changeOrigin——Host/Origin 重写由自有 rewriteHeaders
  // 前置完成（围栏逻辑不出本模块）。
  const proxy = httpProxy.createProxyServer({
    target: { host: targetHost, port: targetPort },
    agent,
  });
  /** 每请求转发选项：rewriteHeaders 前置重写 Host/Origin 后整体覆盖出站头。 */
  const forwardOptions = (req: IncomingMessage): { headers: Record<string, string> } => ({
    // IncomingHttpHeaders 的值域含 string[]（多值头）；http-proxy 仅将其原样
    // extend 进出站头对象，不做窄化处理，运行时无需收窄。
    headers: rewriteHeaders(req.headers, targetAuthority) as Record<string, string>,
  });
  // #308 断连传播：客户端提前断开（移动端切后台系统静默掐断 TCP / fetch abort / 
  // 超时中断）时，http-proxy@1.18 只监听 req 'aborted'——请求体被消费完成后该
  // 事件永不触发，上游（dsh web）收不到中断信号，宿主端 handler 继续跑完
  // （锁内取数最长 5s 才释放），且 agent keep-alive 槽位被半开连接占用、累积后
  // 新请求排队。此处监听 req 'close'（任意断连路径都会触发）并在响应未开始时
  // destroy 上游请求：宿主的 res 'close' 随之触发（provider-usage #308 接线依赖
  // 这一点取消取数），agent 槽位同步释放。
  // 注意：req 'close' 在 Node 中对 IncomingMessage 是「请求体读完 + 连接准备
  // 复用」也会触发，**不等价于客户端断连**——故以 `proxyResReceived` 为闸：
  // 仅当「未收到上游响应头」时 close 才视为断连（收到响应后客户端 close 属
  // 正常完成/响应截断，交由 proxyRes aborted 处理）。实测复现：若用
  // res.writableEnded 判定，正常请求会在转发完成前被误杀（socket hang up）。
  const proxyResReceived = new WeakSet<ServerResponse>();
  /** injectToken 重放上下文（issue #380）：失效 cookie 候选请求经
   *  selfHandleResponse 转发，上游 401 时带 token 重放一次自愈。 */
  const replayContexts = new WeakMap<ServerResponse, { originalUrl: string; token: string }>();
  proxy.on("proxyRes", (proxyRes, req, res) => {
    proxyResReceived.add(res);
    const abortDownstream = () => {
      connStats.httpClientAborted += 1;
      res.destroy();
    };
    proxyRes.on("aborted", abortDownstream);
    proxyRes.on("error", abortDownstream);
    const replay = replayContexts.get(res);
    if (replay === undefined) return;
    replayContexts.delete(res);
    if (proxyRes.statusCode === 401) {
      // 失效 cookie（签名 secret 重置等）：上游验签失败回 401。排干 401 响应体
      // （keep-alive 槽位可复用），以注入 token 的等价请求重放一次——上游 token
      // 分支优先于 cookie 校验，直接重铸 cookie，303 + Set-Cookie 透传回浏览器。
      // 重放请求 URL 已带 token 参数，不再满足候选条件，天然封顶一次。
      proxyRes.resume();
      const nextUrl = withLaunchToken(replay.originalUrl, replay.token);
      if (nextUrl !== undefined) {
        req.url = nextUrl;
        proxy.web(req, res, forwardOptions(req));
        return;
      }
      // token 并入失败（怪异 URL，理论不可达）：继续走下方手动透传 401。
    }
    // 非 401（有效 cookie 的正常 200 等）或重放改写失败：手动透传上游响应
    // （selfHandleResponse 下 http-proxy 不自动写头）。hop-by-hop 头交由 Node
    // 自行管理，显式删除；body 原样字节 pipe（压缩由入口 compression 中间件
    // 在 res 层协商，不受影响）。
    const headers = { ...proxyRes.headers };
    delete headers.connection;
    delete headers["keep-alive"];
    delete headers["transfer-encoding"];
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
  });
  proxy.on("proxyReq", (proxyReq, req, res) => {
    // 监听底层 TCP socket 的 close（而非 req 的 close——后者在 Node 中对
    // IncomingMessage 是「请求体读完可复用连接」即触发，正常请求也会命中，
    // 实测复现误杀；socket close 才反映真实连接断开/客户端 abort）。
    // 已收到上游响应头（proxyResReceived）后不再算断连——此时客户端 close
    // 属正常完成或响应截断，交由 proxyRes aborted 处理。
    const sock = req.socket;
    const onSockClose = () => {
      if (proxyResReceived.has(res)) return;
      proxyReq.destroy();
    };
    sock.on("close", onSockClose);
    proxyReq.on("close", () => sock.off("close", onSockClose));
    proxyReq.on("error", () => sock.off("close", onSockClose));
  });
  // 转发错误收口（上游不可达 / 客户端提前断开等）：HTTP 请求回 502 bad gateway
  // （本地响应，不计入压缩协商）；WS 升级路径第三个参数是对端 socket，直接断开。
  proxy.on("error", (err, _req, res) => {
    connStats.httpProxyErrors += 1;
    logger.warn?.(`lan-proxy: proxy error: ${err.message}`);
    if ("writeHead" in res) {
      markLocal(res);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      if (!res.writableEnded) res.end("bad gateway");
    } else {
      res.destroy();
    }
  });

  /** HTTP(S) 普通请求处理（HTTP/HTTPS 两个 server 共享）。 */
  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (!hostnameAllowed(req.headers.host)) {
      markLocal(res);
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden: only IP-literal or localhost Host headers are accepted");
      return;
    }
    // Private Network Access（PNA）预检：Chrome/Edge 对"非安全上下文页面 →
    // 私网 WebSocket"会先发 OPTIONS 预检（带 access-control-request-private-network），
    // 服务器必须回放行头，否则预检 404 → WS 握手被拖慢/拒绝。
    // 页面与 WS 经 lan-proxy 同源，这里直接放行预检。
    if (req.method === "OPTIONS" && req.headers["access-control-request-private-network"] !== undefined) {
      markLocal(res);
      res.writeHead(204, {
        "access-control-allow-origin": req.headers.origin ?? "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
        "access-control-max-age": "86400",
      });
      res.end();
      return;
    }
    // injectToken（issue #380）：铸造候选（`GET /`、无 token 参数、无会话
    // cookie）→ 注入当前 token 后正常透传，上游一次跳转即铸会话；失效候选
    // （已带会话 cookie——可能已失效）→ selfHandleResponse 转发，上游 401 时
    // 带 token 重放一次自愈（proxyRes 监听器内处理）。provider 未就绪或读取
    // 失败一律降级为普通透传（行为与未开启一致）。注入必须放在 hostnameAllowed
    // 围栏之后（DNS 重绑定防护前置，见文件头注 2）。
    const tokenOptions = options.injectToken;
    if (tokenOptions !== undefined && isTokenMintCandidate(req.method, req.url)) {
      const token = tokenOptions.getToken();
      if (token !== undefined) {
        if (!hasDshAuthCookie(req.headers.cookie)) {
          // 铸造候选：URL 注入 token（改写失败则原样透传，fail-safe）。
          const injected = withLaunchToken(req.url, token);
          if (injected !== undefined) req.url = injected;
        } else {
          // 失效候选：selfHandle 转发，401 → 重放自愈；非 401 → 手动透传。
          replayContexts.set(res, { originalUrl: req.url ?? "/", token });
          proxy.web(req, res, { ...forwardOptions(req), selfHandleResponse: true });
          return;
        }
      }
    }
    // 围栏（hostnameAllowed / rewriteHeaders）前置完成后，http-proxy 接管转发。
    proxy.web(req, res, forwardOptions(req));
  };

  /** WebSocket 升级转发（HTTP/HTTPS 两个 server 共享；HTTPS 即 wss）。 */
  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!hostnameAllowed(req.headers.host)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // WebSocket 压缩桥接：命中白名单路径 → 终结 + permessage-deflate（浏览器段压缩、
    // DSH 段明文）。其余 WebSocket 由 http-proxy 接管 TCP 字节透传。
    if (options.wsCompress?.enabled && compressWsPath(options.wsCompress.paths, req.url)) {
      bridgeCompressedWs(req, socket, head, {
        targetHost,
        targetPort,
        logger,
        probeIntervalMs: options.wsCompress.probeIntervalMs,
        deflatePolicy: options.wsDeflatePolicy ?? DEFAULT_DEFLATE_POLICY,
        onDisconnect: onBridgeDisconnect,
      });
      return;
    }
    // 透传路径（纯字节流，无法改写已协商帧）：按 deflate 策略删除升级请求头的
    // sec-websocket-extensions——上游（DSH）不确认压缩则浏览器段不会启用压缩。
    // 仅对 UA 命中 deny 的端删（桌面 Chrome 等保留压缩协商，不影响省流量）。
    const opts = forwardOptions(req);
    if (!deflateAllowedByPolicy(options.wsDeflatePolicy ?? DEFAULT_DEFLATE_POLICY, req.headers["user-agent"])) {
      delete opts.headers["sec-websocket-extensions"];
    }
    // 透传路径断连观测（issue #308）：TCP 字节流看不到 WS close 帧，以 socket
    // destroyed（未走正常关闭握手）与 error（ECONNRESET 等）近似「被掐断」。
    socket.on("close", () => {
      if (socket.destroyed) connStats.wsPassthroughDestroyed += 1;
    });
    socket.on("error", () => {
      connStats.wsPassthroughErrors += 1;
    });
    proxy.ws(req, socket, head, opts);
  };

  const server = createServer(withCompress(handleRequest));
  server.on("upgrade", handleUpgrade);
  server.on("connection", trackSocket);

  /** HTTPS 监听器（仅当同时提供 httpsPort 与 tls 时创建）。 */
  let httpsServer: HttpsServer | undefined;
  if (options.httpsPort !== undefined && options.tls !== undefined) {
    httpsServer = createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, withCompress(handleRequest));
    httpsServer.on("upgrade", handleUpgrade);
    httpsServer.on("connection", trackSocket);
  }

  /**
   * 绑定端口；resolve 为实际监听结果（EADDRINUSE 等错误时 reject）。
   * HTTPS 绑定失败只降级为 HTTP-only（warn 日志），不影响 HTTP 可用性；
   * HTTP 绑定失败则整体 reject。
   */
  const listen = () =>
    new Promise<LanListenResult>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        server.on("error", (err) => logger.error?.(`lan-proxy: http server error: ${err.message}`));
        const httpPort = (server.address() as AddressInfo).port;
        if (!httpsServer) {
          resolve({ httpPort });
          return;
        }
        let httpsSettled = false;
        httpsServer.once("error", (err) => {
          if (httpsSettled) return;
          httpsSettled = true;
          logger.warn?.(`lan-proxy: https server failed (${err.message}) — serving HTTP only`);
          httpsServer?.close();
          resolve({ httpPort });
        });
        httpsServer.listen(httpsPort, host, () => {
          httpsSettled = true;
          httpsServer.on("error", (err) => logger.error?.(`lan-proxy: https server error: ${err.message}`));
          resolve({ httpPort, httpsPort: (httpsServer.address() as AddressInfo).port });
        });
      });
    });

  /** 停止接受连接、断开全部连接并释放连接池。 */
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const servers = httpsServer ? [server, httpsServer] : [server];
      let remaining = servers.length;
      for (const s of servers) {
        s.close(() => {
          if (--remaining === 0) resolve();
        });
        s.closeAllConnections();
      }
      agent.destroy();
    });

  return {
    server,
    httpsServer,
    listen,
    close,
    targetAuthority,
    httpCompressStats: () => ({ ...compressStats }),
    connStats: () => ({ ...connStats }),
  };
}
