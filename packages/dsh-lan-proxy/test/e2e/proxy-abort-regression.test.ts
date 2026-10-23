// dsh-lan-proxy e2e 回归：客户端中途断开不悬挂上游连接（keep-alive 池泄漏）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 的「e2e: 真实转发」外壳内拆出为独立场景文件。
// 断言与 describe 名逐字保留；端口一律 bind(0) 动态分配。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createLanProxy, ensureSelfSignedTls } from "../../lib/index.js";
import {
  LAN_HOST,
  closeUpstreamServer,
  createUpstreamServer,
  getViaHttpsProxy,
  getViaProxy,
  listenEphemeral,
} from "./forward-upstream.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let PROXY_PORT = 0;
let PROXY_HTTPS_PORT = 0;
let certDir = "";
let tls!: ReturnType<typeof ensureSelfSignedTls>;
const upstream = createUpstreamServer();
let proxy!: ReturnType<typeof createLanProxy>;

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-test-"));
  tls = ensureSelfSignedTls({ dir: certDir, extraSans: [LAN_HOST] });
  const upPort = (await listenEphemeral(upstream)).port;
  proxy = createLanProxy({
    host: "127.0.0.1",
    port: 0,
    httpsPort: 0,
    tls,
    targetHost: "127.0.0.1",
    targetPort: upPort,
  });
  const listening = await proxy.listen();
  PROXY_PORT = listening.httpPort;
  PROXY_HTTPS_PORT = listening.httpsPort ?? 0;
});

afterAll(async () => {
  await proxy.close();
  await closeUpstreamServer(upstream);
  rmSync(certDir, { recursive: true, force: true });
});

describe("regression: 客户端中途断开不悬挂上游连接（keep-alive 池泄漏）", () => {
  let afterAbort!: { status: number; body: string };
  let afterAbortTls!: { status: number; body: string };

  beforeAll(async () => {
    // 上游 /hang 永不响应；客户端连上 30ms 后即断开（模拟关标签页/断网）。
    // 70 次超过上游池上限（64），修复前悬挂请求占满池 → 后续请求排队挂死；
    // 修复后每次断开都会销毁上游请求，池始终有可用槽位。
    const hangAndAbort = (port: number) =>
      new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/hang",
            method: "GET",
            headers: { host: `${LAN_HOST}:${port}` },
          },
          () => {},
        );
        req.on("error", () => {});
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 30);
      });
    for (let i = 0; i < 70; i += 1) await hangAndAbort(PROXY_PORT);
    await sleep(300); // 等销毁传播到上游
    afterAbort = await Promise.race([
      getViaProxy(PROXY_PORT, "/hello", { host: `${LAN_HOST}:${PROXY_PORT}` }),
      sleep(3000).then(() => ({ status: 0, body: "timeout" })),
    ]);
    afterAbortTls = await Promise.race([
      getViaHttpsProxy(PROXY_HTTPS_PORT, "/hello", { host: `${LAN_HOST}:${PROXY_HTTPS_PORT}` }),
      sleep(3000).then(() => ({ status: 0, body: "timeout" })),
    ]);
  }, 120_000);

  it("http pool not leaked after 70 aborted clients", () => {
    expect(afterAbort.status).toBe(200);
  });

  it("https pool not leaked after 70 aborted clients", () => {
    expect(afterAbortTls.status).toBe(200);
  });
});
