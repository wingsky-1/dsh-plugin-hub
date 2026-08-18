// dsh-lan-proxy — 传输核心（不依赖 cordis，可独立单测）。
//
// 在 0.0.0.0:<port> 上监听，把所有 HTTP 请求与 WebSocket 升级转发到
// 127.0.0.1:<targetPort>（dsh web 服务器）。提供 `tls` + `httpsPort` 时，
// 额外在 0.0.0.0:<httpsPort> 上监听 HTTPS（与 HTTP 并存，同一转发核心），
// WebSocket 升级同步支持 wss。两个设计点使它适配 dsh 的安全模型：
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
import { createServer, request as httpRequest, Agent } from "node:http";
import type { Server, IncomingMessage, IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpsServer } from "node:https";
import { connect, isIP } from "node:net";
import type { Socket, AddressInfo } from "node:net";
import { WebSocket as WsClient, WebSocketServer } from "ws";

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
   * 浏览器段压缩、DSH 段明文；其余 WebSocket 继续 TCP 字节透传。默认作用于大流量
   * 的 `events.mux` / `events.host`（会话事件流）。DSH 服务端即使未来自身开启
   * permessage-deflate，这里 DSH 段固定不协商、浏览器段独立协商，天然避免双重压缩。
   */
  wsCompress?: {
    enabled: boolean;
    paths: readonly string[];
  };
  logger?: LanLogger;
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

/** 为上游一跳重建请求头（Host/Origin 重写）。导出供纯函数单测锁定行为。 */
export function rewriteHeaders(headers: IncomingHttpHeaders, targetAuthority: string): IncomingHttpHeaders {
  const out = { ...headers };
  out.host = targetAuthority;
  if (out.origin !== undefined) out.origin = `http://${targetAuthority}`;
  return out;
}

/**
 * 根据原始线路请求头序列化 WebSocket 升级请求，重写 Host/Origin。
 * `req.rawHeaders` 保留浏览器的原始大小写；原有的
 * `Connection: Upgrade` / `Upgrade: websocket` 原样透传。
 */
function serializeUpgradeRequest(req: IncomingMessage, targetAuthority: string): string {
  const raw = req.rawHeaders;
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  const skip = new Set(["host", "origin"]);
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (skip.has(raw[i].toLowerCase())) continue;
    lines.push(`${raw[i]}: ${raw[i + 1]}`);
  }
  lines.push(`Host: ${targetAuthority}`);
  if (req.headers.origin !== undefined) lines.push(`Origin: http://${targetAuthority}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
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
 * @param paths 压缩白名单（默认含 /api/events.mux、/api/events.host）。
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
}

/**
 * WebSocket 压缩桥接：终结浏览器连接（permessage-deflate 压缩）× 明文连 DSH
 * （不协商压缩，DSH 即使未来开启也不双重压缩）。双向转发 text/binary 帧，
 * 任何一端关闭/出错即对端终止，避免泄漏。
 */
export function bridgeCompressedWs(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: WsBridgeTarget,
): void {
  // 浏览器段：终结 + permessage-deflate（浏览器默认协商并自动解压）。
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
  wss.handleUpgrade(req, socket, head, (browserWs) => {
    // DSH 段：明文（本机/内网），固定不协商 permessage-deflate。
    const upstreamUrl = `ws://${target.targetHost}:${target.targetPort}${req.url}`;
    const upstreamWs = new WsClient(upstreamUrl, {
      perMessageDeflate: false,
      headers: { origin: `http://${target.targetHost}:${target.targetPort}` },
    });
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
    // 任一端关闭/出错 → 对端终止。
    upstreamWs.on("close", () => browserWs.terminate());
    upstreamWs.on("error", (err) => {
      target.logger?.warn?.(`lan-proxy: ws-bridge upstream error: ${err.message}`);
      browserWs.terminate();
    });
    browserWs.on("close", () => {
      try { upstreamWs.close(); } catch { /* 已关闭 */ }
    });
    browserWs.on("error", () => {
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
  /** 上游连接的 keep-alive 连接池；close() 时销毁。 */
  const agent = new Agent({ keepAlive: true, maxSockets: MAX_UPSTREAM_SOCKETS });
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

  /** HTTP(S) 普通请求转发（HTTP/HTTPS 两个 server 共享）。 */
  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    if (!hostnameAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden: only IP-literal or localhost Host headers are accepted");
      return;
    }
    // Private Network Access（PNA）预检：Chrome/Edge 对"非安全上下文页面 →
    // 私网 WebSocket"会先发 OPTIONS 预检（带 access-control-request-private-network），
    // 服务器必须回放行头，否则预检 404 → WS 握手被拖慢/拒绝。
    // 页面与 WS 经 lan-proxy 同源，这里直接放行预检。
    if (req.method === "OPTIONS" && req.headers["access-control-request-private-network"] !== undefined) {
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
    const upstream = httpRequest(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: rewriteHeaders(req.headers, targetAuthority),
        agent,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      logger.warn?.(`lan-proxy: upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    });
    req.on("error", (err) => {
      logger.warn?.(`lan-proxy: request error: ${err.message}`);
      upstream.destroy(err);
    });
    // 客户端连接提前关闭（响应尚未写完，如用户关标签页/断网）时销毁上游请求。
    // 否则悬挂请求会占住 keep-alive 连接池槽位：SSE/WS 等长响应场景反复断开
    // 客户端会耗尽连接池（MAX_UPSTREAM_SOCKETS=64），之后所有新请求排队挂死
    // （实测：浏览器重连几次后 lan-proxy 整体无响应，重载才恢复）。
    // 注意：必须监听 res 的 close（连接关闭信号），不能监听 req 的 close——
    // req 的 close 在请求消息接收完成时就触发（与连接无关），会误杀正常请求。
    // 正常完成（res 已 end）时连接照常回池复用，不影响 keep-alive。
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  };

  /** WebSocket 升级转发（HTTP/HTTPS 两个 server 共享；HTTPS 即 wss）。 */
  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!hostnameAllowed(req.headers.host)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // WebSocket 压缩桥接：命中白名单路径 → 终结 + permessage-deflate（浏览器段压缩、
    // DSH 段明文）。其余 WebSocket 保持下方 TCP 字节透传。
    if (options.wsCompress?.enabled && compressWsPath(options.wsCompress.paths, req.url)) {
      bridgeCompressedWs(req, socket, head, { targetHost, targetPort, logger });
      return;
    }
    const upstream = connect(targetPort, targetHost, () => {
      upstream.write(serializeUpgradeRequest(req, targetAuthority));
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (err) => {
      logger.warn?.(`lan-proxy: upgrade error: ${err.message}`);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  };

  const server = createServer(handleRequest);
  server.on("upgrade", handleUpgrade);
  server.on("connection", trackSocket);

  /** HTTPS 监听器（仅当同时提供 httpsPort 与 tls 时创建）。 */
  let httpsServer: HttpsServer | undefined;
  if (options.httpsPort !== undefined && options.tls !== undefined) {
    httpsServer = createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handleRequest);
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

  return { server, httpsServer, listen, close, targetAuthority };
}
