// dsh-lan-proxy e2e：launch token 注入面与 Host 围栏顺序（#380 / #826）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出为独立场景文件（自建独立 fake 上游 + 独立 proxy，
// 与转发族的 upstream 夹具互不共享生命周期）。断言与 describe 名逐字保留。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { createLanProxy } from "../../lib/index.js";

describe("e2e: launch token 注入面与 Host 围栏顺序", () => {
  let fenceProxy!: ReturnType<typeof createLanProxy>;
  let fenceUpstream!: ReturnType<typeof createServer>;
  let fencePort = 0;
  const upstreamUrls: string[] = [];
  let tokenReads = 0;

  /** 经代理发一个 GET /（headers 决定围栏与注入分支）。 */
  const getThroughFence = (
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port: fencePort, path: "/", method: "GET", headers },
        (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    fenceUpstream = createServer((req, res) => {
      upstreamUrls.push(req.url as string);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => fenceUpstream.listen(0, "127.0.0.1", () => r()));
    fenceProxy = createLanProxy({
      host: "127.0.0.1",
      port: 0,
      targetHost: "127.0.0.1",
      targetPort: (fenceUpstream.address() as import("node:net").AddressInfo).port,
      injectToken: {
        getToken: () => {
          tokenReads += 1;
          return "launch-token-826";
        },
      },
    });
    const listening = await fenceProxy.listen();
    fencePort = listening.httpPort;
  }, 30_000);

  afterAll(async () => {
    await fenceProxy.close();
    await new Promise((r) => fenceUpstream.close(r));
  });

  it("非法域名 Host 的 GET / 得 403，且 token 未被读取、上游零请求", async () => {
    const res = await getThroughFence({ host: "evil.example:3081" });
    expect(res.status).toBe(403);
    // 顺序判据（区分度最高）：围栏先返回 ⇒ token 提供者一次都没被调用
    expect(tokenReads).toBe(0);
    // 围栏判据：请求根本没到上游（自然也不存在带 token= 的上游请求）
    expect(upstreamUrls).toEqual([]);
  });

  it("无会话 cookie 的 GET / 带 launch token 到达上游（铸造正路）", async () => {
    const res = await getThroughFence({ host: "127.0.0.1:3081" });
    expect(res.status).toBe(200);
    expect(upstreamUrls.at(-1)).toBe("/?token=launch-token-826");
  });

  it("已带 dsh 会话 cookie 的 GET / 绝不注入 token（防有效 cookie 无限 303）", async () => {
    const before = upstreamUrls.length;
    const res = await getThroughFence({
      host: "127.0.0.1:3081",
      cookie: "dsh-auth-web=still-valid",
    });
    expect(res.status).toBe(200);
    expect(upstreamUrls.length).toBe(before + 1);
    expect(upstreamUrls.at(-1)).toBe("/");
  });
});
