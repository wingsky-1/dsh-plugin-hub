// dsh-lan-proxy integration：apply 在 settings 服务缺失时的降级（卡片可读不可写）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。断言与 describe 名逐字保留。
// 层归属：真实 apply 组合根 + 隔离 DSH_HOME（DEVELOPMENT 测试分层表 integration 行）。
// 独立成文件的理由：与 apply-wiring 的「注册面/围栏」是不同场景族，且其 beforeAll
// 准备链独立；合并会让两个文件都逼近 max-lines。
import { beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { createServer } from "node:http";
import { apply } from "../../src/server/apply.ts";
import { ROUTES } from "../../src/server/config/interface.ts";

/** 取一个当前空闲的端口（bind(0) 后立即释放）。 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const chosen = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return chosen;
}

describe("apply: settings 服务缺失降级", () => {
  let healthRegistered = false;
  let configRoute!: WebRoute;
  let degradedPort = 0;
  let degradedStatus = 0;
  let degradedPayload: Record<string, unknown> & {
    effective: { port: number };
  } = { effective: { port: 0 } };

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-nosettings-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const routes: WebRoute[] = [];
    const disposers: Array<unknown> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: {
        port: 3080,
        register(route: WebRoute) {
          routes.push(route);
          return () => {};
        },
        tapIndex() {
          return () => {};
        },
      },
      inject() {},
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    const chosenPort = await freePort();
    degradedPort = chosenPort;
    apply(ctx as unknown as Context, { host: "127.0.0.1", port: chosenPort, httpsEnabled: false });
    healthRegistered = Boolean(routes.find((r: WebRoute) => r.path === ROUTES.health));
    configRoute = routes.find((r: WebRoute) => r.path === ROUTES.config)!;
    const req = {
      method: "GET",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3080" },
    };
    const chunks: string[] = [];
    let status = 0;
    (configRoute as WebRoute).handler(
      req as unknown as IncomingMessage,
      {
        writeHead: (c: number) => {
          status = c;
        },
        end: (c?: unknown) => {
          if (c !== undefined) chunks.push(String(c));
        },
        getHeader: () => undefined,
        setHeader: () => {},
      } as unknown as ServerResponse,
    );
    degradedStatus = status;
    degradedPayload = JSON.parse(chunks.join(""));
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  describe("降级态：health 与 config 路由仍注册（卡片可读）", () => {
    it("health 路由已注册", () => {
      expect(healthRegistered).toBeTruthy();
    });

    it("config 路由已注册", () => {
      expect(configRoute).toBeTruthy();
    });
  });

  describe("降级态 GET：writable=false 且 effective 为组合层兜底", () => {
    it("status 200", () => {
      expect(degradedStatus).toBe(200);
    });

    it("writable=false", () => {
      expect(degradedPayload.writable).toBe(false);
    });

    it("effective.port 为组合层传入端口", () => {
      expect(degradedPayload.effective.port).toBe(degradedPort);
    });
  });
});
