/**
 * dsh-lan-proxy — apply 的 launch token 提供者接线（src/server/apply.ts:118-173）。
 *
 * integration 层（ARCHITECTURE-METHOD §8）：真实 cordis 生命周期（fake ctx）+ 真实
 * 转发器 + fake 官方 connection 服务，锁住「connection.authenticatedUrl → token」这段
 * 接线——它是 injectToken 唯一的 token 来源，此前全仓零覆盖（createLanProxy 层的注入
 * 判据只证明「拿到 token 之后怎么用」，证明不了「token 从哪来」）。
 *
 * 观测面：真实转发一次，看 fake 上游收到的 req.url。转发器端口不写死——apply 不返回
 * 句柄，故捕获其原生 console 出口的 `listening http://host:PORT` 行回读端口（apply
 * 用原生 console 而非 cordis logger，见 apply.ts:37-41），配 listen(0) 动态分配，避免
 * 固定端口在并发/残留进程下的 EADDRINUSE 假阳性。
 */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apply } from "../../src/server/apply.ts";

type LogEntry = { level: "info" | "warn"; text: string };
type Scenario = {
  upstreamUrls: string[];
  get: (headers?: Record<string, string>) => Promise<{ status: number | undefined; body: string }>;
  stop: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 起一套 apply + 真实转发器 + fake 上游；connectionValue 即 inject 回调收到的服务。 */
async function startScenario(connectionValue: unknown): Promise<Scenario> {
  const home = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-token-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const upstreamUrls: string[] = [];
  const upstream = createServer((req, res) => {
    upstreamUrls.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

  const logs: LogEntry[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => {
    logs.push({ level: "info", text: a.join(" ") });
  };
  console.warn = (...a: unknown[]) => {
    logs.push({ level: "warn", text: a.join(" ") });
  };

  const disposers: Array<() => void> = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: {
      port: (upstream.address() as AddressInfo).port,
      register: () => () => {},
      tapIndex: () => () => {},
    },
    inject(services: string[], fn: (c: unknown) => void) {
      if (services.includes("connection")) {
        fn({ connection: connectionValue, effect: (f: () => unknown) => f() });
      }
    },
    effect(fn: () => unknown) {
      const d = fn();
      if (typeof d === "function") disposers.push(d as () => void);
      return d;
    },
  };

  const stop = async (): Promise<void> => {
    console.log = origLog;
    console.warn = origWarn;
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {}
    }
    await new Promise<void>((r) => upstream.close(() => r()));
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  };

  try {
    apply(ctx as unknown as Parameters<typeof apply>[0], {
      host: "127.0.0.1",
      port: 0,
      httpsEnabled: false,
      enabled: true,
    });
    // 端口回读用轮询而非固定 sleep（防 flake 纪律）。
    const deadline = Date.now() + 8000;
    let httpPort: number | undefined;
    while (Date.now() < deadline) {
      const line = logs.find((l) => l.text.includes("listening http://"));
      if (line !== undefined) {
        httpPort = Number(/listening http:\/\/[^:]+:(\d+)/.exec(line.text)?.[1]);
        break;
      }
      await sleep(20);
    }
    if (httpPort === undefined || Number.isNaN(httpPort)) {
      throw new Error("apply 未在 8s 内启动转发器（无 listening 日志）");
    }
    const port = httpPort;
    return {
      upstreamUrls,
      get: (headers: Record<string, string> = {}) =>
        new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: "127.0.0.1",
              port,
              path: "/",
              method: "GET",
              headers: { host: "127.0.0.1:3081", ...headers },
            },
            (r) => {
              let body = "";
              r.on("data", (c) => (body += c));
              r.on("end", () => resolve({ status: r.statusCode, body }));
            },
          );
          req.on("error", reject);
          req.end();
        }),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

const SCENARIOS: Array<{ label: string; connection: unknown; expectedUrl: string }> = [
  {
    label: "authenticatedUrl 返回带 token 的 URL → 上游收到该 token",
    connection: { authenticatedUrl: () => "http://lan-proxy.local/?token=minted-826" },
    expectedUrl: "/?token=minted-826",
  },
  {
    label: "authenticatedUrl 返回不带 token 的 URL → 不注入",
    connection: { authenticatedUrl: () => "http://lan-proxy.local/" },
    expectedUrl: "/",
  },
  {
    label: "authenticatedUrl 抛异常 → 降级为不注入",
    connection: {
      authenticatedUrl: () => {
        throw new Error("connection boom");
      },
    },
    expectedUrl: "/",
  },
  {
    label: "connection 服务缺少 authenticatedUrl → 不注入",
    connection: { rpc: {} },
    expectedUrl: "/",
  },
];

for (const sc of SCENARIOS) {
  describe(`integration: apply launch token 提供者 — ${sc.label}`, () => {
    let scenario: Scenario | undefined;
    beforeAll(async () => {
      scenario = await startScenario(sc.connection);
    }, 30_000);
    afterAll(async () => {
      if (scenario !== undefined) await scenario.stop();
    });

    it("无会话 cookie 的 GET / 到达上游时的 URL 符合接线预期", async () => {
      if (scenario === undefined) throw new Error("scenario 未建立");
      const res = await scenario.get();
      expect(res.status).toBe(200);
      expect(scenario.upstreamUrls.at(-1)).toBe(sc.expectedUrl);
    });
  });
}
