// dsh-lan-proxy integration：转发层 HTTP 压缩（compression 中间件）——真 upstream × 真转发器。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。断言与 describe 名逐字保留。
// 层归属：真 socket / 真端口 / 真实组合根（DEVELOPMENT 测试分层表 integration 行）。
// 端口一律 bind(0) 动态分配（#690 S2c）。
import { beforeAll, describe, expect, it } from "vitest";
import { gzipSync, gunzipSync, brotliDecompressSync } from "node:zlib";
import { createServer, request as httpRequest } from "node:http";
import { createLanProxy } from "../../src/server/proxy/interface.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 原脚本把「正常完整请求 200」写在准备循环内，故按轮次展开为逐条可见用例；
// 案例表须在使用它的 describe 之前建立（it.each 表在收集期即求值）。
const normalRequestRounds = [0, 1, 2, 3, 4].map((round) => ({ round }));

// 共享观测状态与辅助函数提到文件级（#1174 A1）：提取出的注册函数是独立作用域，
// 状态必须在其外层可见。钩子仍注册在本 describe 内（vitest 钩子作用域语义）。
const bigBody = JSON.stringify({ data: "y".repeat(300_000) });

interface CompressResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface CompressStats {
  compressed: number;
  passthrough: number;
}

let rBig!: CompressResponse;

let rBigBr!: CompressResponse;

let rBigPlain!: CompressResponse;

let rRange!: CompressResponse;

let rSse!: CompressResponse;

let rPregzip!: CompressResponse;

let statsOn!: CompressStats;

let statsBefore403!: CompressStats;

let statsAfter403!: CompressStats;

let cut!: { how: string; bytes: number; ms: number };

let upstreamDestroyedDelta = 0;

let sseHoldActive = 0;

let sseHoldClosed = 0;

let normalRequestStatuses: number[] = [];

let upstreamDestroyedAfterNormal = 0;

let rOff!: CompressResponse;

// 场景族提取为注册函数（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function。
// 提取的是完整的一级子 describe（场景族），其内容与名字逐字保留，嵌套顺序不变。
function registerGzipFamily() {
  describe("转发层：大 JSON 经代理被 gzip 且解压逐字节一致", () => {
    it("响应带 content-encoding: gzip", () => {
      expect(rBig.headers["content-encoding"]).toBe("gzip");
    });

    it("content-length 已删除", () => {
      expect(rBig.headers["content-length"]).toBe(undefined);
    });

    it("解压后逐字节一致", () => {
      expect(gunzipSync(rBig.body).toString()).toBe(bigBody);
    });
  });
}

function registerBrotliFamily() {
  describe("转发层：Accept-Encoding: br 且上游未压缩 → 协商为 br", () => {
    it("响应带 content-encoding: br", () => {
      expect(rBigBr.headers["content-encoding"]).toBe("br");
    });

    it("brotli 解压后逐字节一致", () => {
      expect(brotliDecompressSync(rBigBr.body).toString()).toBe(bigBody);
    });
  });
}

function registerPlainFamily() {
  describe("转发层：无 Accept-Encoding 透传原文", () => {
    it("不压（无 content-encoding）", () => {
      expect(rBigPlain.headers["content-encoding"]).toBe(undefined);
    });

    it("正文为原文", () => {
      expect(rBigPlain.body.toString()).toBe(bigBody);
    });
  });
}

function registerRangeFamily() {
  describe("转发层：Range/206 豁免不压", () => {
    it("status 206", () => {
      expect(rRange.status).toBe(206);
    });

    it("不压", () => {
      expect(rRange.headers["content-encoding"]).toBe(undefined);
    });

    it("content-range 透传", () => {
      expect(rRange.headers["content-range"]).toBe(`bytes 0-9/${bigBody.length}`);
    });
  });
}

function registerSseFamily() {
  describe("转发层：SSE 豁免不压", () => {
    it("不压", () => {
      expect(rSse.headers["content-encoding"]).toBe(undefined);
    });

    it("正文为原文", () => {
      expect(rSse.body.toString()).toBe("data: x\n\n");
    });
  });
}

function registerPregzipFamily() {
  describe("转发层：上游已压缩让位（dsh-gzip 宿主端共存，仅单层）", () => {
    it("保留上游 content-encoding", () => {
      expect(rPregzip.headers["content-encoding"]).toBe("gzip");
    });

    it("gunzip 一次即原文（无双层）", () => {
      expect(gunzipSync(rPregzip.body).toString()).toBe(bigBody);
    });
  });
}

function registerStatsFamily() {
  describe("转发层：协商计数递增（协商口径：206 计入 compressed、无 AE 不进 filter）", () => {
    it("compressed 至少 3（/big + /range + /pregzip）", () => {
      expect(statsOn.compressed >= 3).toBeTruthy();
    });

    it("passthrough 至少 1（SSE）", () => {
      expect(statsOn.passthrough >= 1).toBeTruthy();
    });
  });
}

function registerTopLevelFamilies() {
  it("转发层：本地 403 响应不污染协商计数", () => {
    expect(statsAfter403).toEqual(statsBefore403);
  });

  it("转发层：上游中途断连 → 客户端快速终止（不悬挂回归）", () => {
    expect(cut.ms < 4000).toBeTruthy();
  });

  // 原脚本把「正常完整请求 200」写在准备循环内，故按轮次展开为逐条可见用例。
  it.each(normalRequestRounds)("转发层：完整短请求 #$round 返回 200", ({ round }) => {
    expect(normalRequestStatuses[round]).toBe(200);
  });

  it("转发层：完整短请求不触发上游销毁（防误杀）", () => {
    expect(upstreamDestroyedAfterNormal).toBe(0);
  });
}

function registerSseDropFamily() {
  describe("转发层：客户端断开 SSE → 上游连接被销毁（issue #528 反向回归）", () => {
    it("httpUpstreamDestroyed +3", () => {
      expect(upstreamDestroyedDelta).toBe(3);
    });

    it("上游 active SSE 回落 0", () => {
      expect(sseHoldActive).toBe(0);
    });

    it("上游 close 计数 3", () => {
      expect(sseHoldClosed).toBe(3);
    });
  });
}

function registerDisabledFamily() {
  describe("转发层：enabled=false 全透传", () => {
    it("不压", () => {
      expect(rOff.headers["content-encoding"]).toBe(undefined);
    });

    it("正文为原文", () => {
      expect(rOff.body.toString()).toBe(bigBody);
    });
  });
}

describe("integration: 转发层 HTTP 压缩（compression 中间件）", () => {
  beforeAll(prepareCompressionScenario);

  registerGzipFamily();
  registerBrotliFamily();
  registerPlainFamily();
  registerRangeFamily();
  registerSseFamily();
  registerPregzipFamily();
  registerStatsFamily();
  registerTopLevelFamilies();
  registerSseDropFamily();
  registerDisabledFamily();
});

/** 准备段按语义族提取（#1174 A1）：起上游与代理 / 基础响应 / 中途断连 /
 * 正常短请求 / disabled 代理，逐段采集各 it 要断言的观测值。
 * 共享局部态（upstream / requestThrough / 计数器）留在闭包内，不外扩为通用 harness。
 */
async function prepareCompressionScenario() {
  const sseHold = { active: 0, closed: 0 };
  const upstreamCompress = createUpstream(bigBody, sseHold);
  await new Promise<void>((r) => upstreamCompress.listen(0, "127.0.0.1", () => r()));
  const upPort = (upstreamCompress.address() as import("node:net").AddressInfo).port;
  const requestThrough = makeRequester();
  const proxyOn = createLanProxy(
    {
      host: "127.0.0.1",
      port: 0,
      targetHost: "127.0.0.1",
      targetPort: upPort,
      httpCompress: { enabled: true, level: 1 },
    },
    console,
  );
  const { httpPort: pxPort } = await proxyOn.listen();

  await collectNegotiationResponses(requestThrough, pxPort);
  await collectLocal403(proxyOn, pxPort);
  cut = await collectCutResponse(pxPort);
  await collectSseDrop(proxyOn, requestThrough, pxPort, sseHold);
  await collectNormalRequests(proxyOn, requestThrough, pxPort);
  await proxyOn.close();

  await collectDisabledProxy(requestThrough, upPort);
  upstreamCompress.close();
}

/** 上游测试服务器：/big /range /sse /sse-hold /pregzip /cut + 404 兜底。 */
function createUpstream(body: string, sseHold: { active: number; closed: number }) {
  return createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p === "/big") {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    } else if (p === "/range") {
      res.writeHead(206, {
        "content-type": "application/json",
        "content-range": `bytes 0-9/${body.length}`,
        "content-length": "10",
      });
      res.end("y".repeat(10));
    } else if (p === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: x\n\n");
    } else if (p === "/sse-hold") {
      // issue #528：模拟 SSE/长响应——发头 + 首帧后保持连接不 end；客户端断开时
      // 若代理不销毁上游，本路由 res 的 close 永不触发（残留）→ 计数不增。
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: x\n\n");
      sseHold.active += 1;
      res.on("close", () => {
        sseHold.active -= 1;
        sseHold.closed += 1;
      });
    } else if (p === "/pregzip") {
      // 模拟 dsh-gzip 独立包在宿主端已压缩：转发层必须让位（单层）。
      const gz = gzipSync(Buffer.from(body));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gz);
    } else if (p === "/cut") {
      // 悬挂回归：上游发头 + 部分 body 后暴力断连，客户端必须快速终止。
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(9_000_000),
      });
      res.write("y".repeat(300_000));
      setTimeout(() => {
        res.socket?.destroy();
      }, 30);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

/** 经代理发一次请求并收全量响应（真实 socket + bind(0) 端口）。 */
function makeRequester() {
  return (port: number, path: string, headers: Record<string, string>): Promise<CompressResponse> =>
    new Promise<CompressResponse>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path, headers: { host: "127.0.0.1", ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
}

/** 基础响应段：gzip / br / 无 AE 透传 / Range 206 / SSE / 上游已压缩 让位。 */
async function collectNegotiationResponses(
  requestThrough: ReturnType<typeof makeRequester>,
  pxPort: number,
) {
  rBig = await requestThrough(pxPort, "/big", { "accept-encoding": "gzip" });
  rBigBr = await requestThrough(pxPort, "/big", { "accept-encoding": "br" });
  rBigPlain = await requestThrough(pxPort, "/big", {});
  rRange = await requestThrough(pxPort, "/range", { "accept-encoding": "gzip" });
  rSse = await requestThrough(pxPort, "/sse", { "accept-encoding": "gzip" });
  rPregzip = await requestThrough(pxPort, "/pregzip", { "accept-encoding": "gzip" });
}

/** 转发层本地 403：Host 围栏拒绝时协商计数不得被污染（仅用 current proxy 的 httpCompressStats）。 */
async function collectLocal403(proxy: { httpCompressStats: () => CompressStats }, pxPort: number) {
  statsOn = proxy.httpCompressStats();
  statsBefore403 = proxy.httpCompressStats();
  await new Promise<void>((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: pxPort, path: "/big", headers: { host: "evil.example.com" } },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", () => resolve());
    req.end();
  });
  statsAfter403 = proxy.httpCompressStats();
}

/** 中途断连段：上游发头 + 部分 body 后暴力断连，客户端必须快速终止。 */
async function collectCutResponse(
  pxPort: number,
): Promise<{ how: string; bytes: number; ms: number }> {
  return new Promise<{ how: string; bytes: number; ms: number }>((resolve) => {
    const t0 = Date.now();
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: pxPort,
        path: "/cut",
        headers: { host: "127.0.0.1", "accept-encoding": "gzip" },
      },
      (res) => {
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
        });
        const finish = (how: string) => resolve({ how, bytes, ms: Date.now() - t0 });
        res.on("end", () => finish("end"));
        res.on("close", () => finish(`close(aborted=${res.aborted})`));
        res.on("error", (e: NodeJS.ErrnoException) => finish(`error:${e.code ?? e.message}`));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ how: `reqError:${e.code ?? e.message}`, bytes: 0, ms: Date.now() - t0 }),
    );
    req.end();
  });
}

/** SSE 断开段：客户端断开 → 上游连接被销毁（issue #528 反向回归）。 */
async function collectSseDrop(
  proxy: { connStats: () => { httpUpstreamDestroyed: number } },
  requestThrough: ReturnType<typeof makeRequester>,
  pxPort: number,
  sseHold: { active: number; closed: number },
) {
  const upDestroyBefore = proxy.connStats().httpUpstreamDestroyed;
  const openAndDrop = () =>
    new Promise<void>((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: pxPort, path: "/sse-hold", headers: { host: "127.0.0.1" } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          }); // 收首帧后客户端断开
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
  for (let i = 0; i < 3; i += 1) await openAndDrop();
  await sleep(500);
  upstreamDestroyedDelta = proxy.connStats().httpUpstreamDestroyed - upDestroyBefore;
  sseHoldActive = sseHold.active;
  sseHoldClosed = sseHold.closed;
}

/** 正常短请求段：5 轮完整请求 200，且不触发上游销毁（防误杀）。 */
async function collectNormalRequests(
  proxy: { connStats: () => { httpUpstreamDestroyed: number } },
  requestThrough: ReturnType<typeof makeRequester>,
  pxPort: number,
) {
  const upDestroyBefore2 = proxy.connStats().httpUpstreamDestroyed;
  normalRequestStatuses = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await requestThrough(pxPort, "/big", { "accept-encoding": "gzip" });
    normalRequestStatuses.push(r.status);
  }
  await sleep(100);
  upstreamDestroyedAfterNormal = proxy.connStats().httpUpstreamDestroyed - upDestroyBefore2;
}

/** disabled 代理段：enabled=false 全透传。 */
async function collectDisabledProxy(
  requestThrough: ReturnType<typeof makeRequester>,
  upPort: number,
) {
  const proxyOff = createLanProxy(
    {
      host: "127.0.0.1",
      port: 0,
      targetHost: "127.0.0.1",
      targetPort: upPort,
      httpCompress: { enabled: false, level: 1 },
    },
    console,
  );
  const { httpPort: pxPortOff } = await proxyOff.listen();
  rOff = await requestThrough(pxPortOff, "/big", { "accept-encoding": "gzip" });
  await proxyOff.close();
}
