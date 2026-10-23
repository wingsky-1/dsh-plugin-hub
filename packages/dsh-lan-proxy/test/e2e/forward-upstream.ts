// e2e 转发族共享夹具：fake dsh web server（回显请求要素 + WebSocket 升级应答字节回显）
// 与真实转发器族共用的请求 helper。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。只服务本转发族场景文件
// （proxy-forward / proxy-abort-regression），不进任何测试层、不计 --min。
// 假件只提供原始事实与记录，不替被测代码做决定。
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";

/** 局域网侧示例客户端 Host（IP 字面量；代理只接受 IP 字面量或 localhost）。 */
export const LAN_HOST = "192.168.1.50";

/** 上游回显体（fake dsh web server 的回显 JSON 形态）。 */
export interface UpstreamEcho {
  method: string;
  url: string;
  host: string;
  origin: string | null;
  secFetchSite: string | null;
}

/** 经真实转发器的请求回执（状态 + 正文）。 */
export interface ProxyResponse {
  status: number;
  body: string;
}

/** fake upstream 接受的连接；teardown 时显式销毁，避免升级后的 TLS 连接阻塞 close。 */
const upstreamSockets = new WeakMap<ReturnType<typeof createServer>, Set<Socket>>();

/** fake dsh web server：HTTP 回显请求要素；/hang 永不响应（模拟长响应被客户端断开）。 */
export function createUpstreamServer() {
  const server = createServer((req, res) => {
    // 回归用例路径：永不响应（模拟 SSE/WS 类长响应被客户端断开）。
    if (req.url === "/hang") return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin ?? null,
        secFetchSite: req.headers["sec-fetch-site"] ?? null,
      }),
    );
  });
  const sockets = new Set<Socket>();
  upstreamSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      socket.write(chunk); // 回显
      if (bytes.length >= 32) socket.end();
    });
    socket.on("end", () => socket.destroy());
  });
  return server;
}

/** 先销毁 fake upstream 已接受的连接，再关闭监听端口。 */
export function closeUpstreamServer(server: ReturnType<typeof createServer>): Promise<void> {
  for (const socket of upstreamSockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** server 监听 bind(0) 临时端口并回填地址（#690 S2c：写死端口会 EADDRINUSE 假阳性）。 */
export function listenEphemeral(server: ReturnType<typeof createServer>): Promise<AddressInfo> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address() as AddressInfo));
  });
}

/** 经真实转发器的 HTTP 端口发一个 GET（headers 决定围栏与重写分支）。 */
export function getViaProxy(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** HTTPS 版 GET（自签证书：rejectUnauthorized 关闭）。 */
export function getViaHttpsProxy(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** WebSocket 升级穿透（ws）：写入固定探针串，收满 16 字节回显即判升级成功。 */
export function upgradeViaProxy(port: number): Promise<{ status: number; echoed: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/socket",
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        host: `${LAN_HOST}:${port}`,
        origin: `http://${LAN_HOST}:${port}`,
      },
    });
    req.on("upgrade", (res, socket) => {
      let echoed = "";
      socket.on("data", (c) => {
        echoed += c.toString();
        if (echoed.length >= 16) {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, echoed });
        }
      });
      socket.write("ping-from-lan-client");
    });
    req.on("error", reject);
    req.end();
  });
}

/** HTTPS 版 WebSocket 升级穿透（wss）。 */
export function upgradeViaHttpsProxy(port: number): Promise<{ status: number; echoed: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/socket",
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          host: `${LAN_HOST}:${port}`,
          origin: `https://${LAN_HOST}:${port}`,
        },
      },
      () => {},
    );
    req.on("upgrade", (res, socket) => {
      let echoed = "";
      socket.on("error", () => {});
      socket.on("data", (c) => {
        echoed += c.toString();
        if (echoed.length >= 16) {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, echoed });
        }
      });
      socket.write("ping-over-wss-0123456789");
    });
    req.on("error", reject);
    req.end();
  });
}

/** 手写一条原始 HTTP/1.1 请求（无隐式 Host，用于缺失 Host 围栏判据）。 */
export function rawRequest(
  port: number,
  requestText: string,
): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let raw = "";
    socket.on("connect", () => socket.write(requestText));
    socket.on("data", (c) => {
      raw += c.toString();
      const at = raw.indexOf("\r\n\r\n");
      if (at !== -1) {
        socket.destroy();
        resolve({ statusLine: raw.slice(0, raw.indexOf("\r\n")), body: raw.slice(at + 4) });
      }
    });
    socket.on("error", reject);
  });
}
