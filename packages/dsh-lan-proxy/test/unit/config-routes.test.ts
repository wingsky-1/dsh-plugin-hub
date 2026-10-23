// dsh-lan-proxy unit：buildConfigRoutes（GET 快照 / PUT 写入 / 围栏）
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出（该文件名为 e2e 却混装 unit 场景族）。
// 断言与 describe 名逐字保留。unit 层直连 src 源码，不 import 包根组合根与构建产物面
// （DEVELOPMENT §I8① 判据）。
// 被测面：src/server/config/impl/routes.ts 的路由注册面。fake req/res 直调 handler，
// 不 listen（真实端口面在 test/integration）。

import { beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildConfigRoutes } from "../../src/server/config/interface.ts";
import type { ConfigRouteDeps, ResolvedConfig } from "../../src/server/config/interface.ts";

/** PUT 路由测试桩记录的写入动作（update 增量 / replace 整节）。 */
type PutRecord =
  | { kind: "update"; patch: unknown; rev: number | undefined }
  | { kind: "replace"; section: unknown; rev: number | undefined };

// 共享观测状态提到文件级：拆出的注册函数只负责登记用例，保持「同一 beforeAll 观测、
// 逐 it 断言快照」的原语义（#1174 A1）。钩子仍注册在本 describe 内（vitest 钩子作用域）。
let putPayload: PutRecord | null = null;

let forbidden!: { status: number; body: string };

let notAllowed!: { status: number; body: string };

let got!: { status: number; body: string };

let gotPayload!: {
  user: unknown;
  effective: { port: number };
  compress: { httpCompressStats: { compressed: number } };
  revision: unknown;
  writable: unknown;
};

let put!: { status: number; body: string };

let putPayloadParsed!: { ok: unknown; user: unknown };

let putBad!: { status: number; body: string };

let putBadPayload!: { error: { details: string } };

// 场景族按语义分组注册（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function
// 阈值。分组依据是「族内用例共享同一被测语义」，不是行数硬切；describe 名与嵌套
// 顺序逐字保留，故拆分前后完整名称路径相同。
function registerFenceScenarios() {
  describe("config 路由非回环 403", () => {
    it("status 403", () => {
      expect(forbidden.status).toBe(403);
    });

    // #473 批 1（B1-4）：403 body 围栏文案（守卫收敛后逐字节锁定）
    it("403 body 围栏文案", () => {
      expect(JSON.parse(forbidden.body).error).toBe("forbidden: loopback-only");
    });
  });

  describe("config 路由 POST 405（仅 GET/PUT）", () => {
    it("status 405", () => {
      expect(notAllowed.status).toBe(405);
    });

    // #473 批 1（B1-3）：405 body 文案断言
    it("405 body 文案", () => {
      expect(JSON.parse(notAllowed.body).error).toBe("method not allowed: POST");
    });
  });
}

function registerReadScenarios() {
  describe("GET 返回 user 层 + effective 生效值 + 压缩快照 + revision（只读面不收缩）", () => {
    it("status 200", () => {
      expect(got.status).toBe(200);
    });

    it("user 层", () => {
      expect(gotPayload.user).toEqual({ port: 3082 });
    });

    it("effective 生效值可见", () => {
      expect(gotPayload.effective.port).toBe(3082);
    });

    it("压缩协商计数可见", () => {
      expect(gotPayload.compress.httpCompressStats.compressed).toBe(5);
    });

    it("revision", () => {
      expect(gotPayload.revision).toBe(3);
    });

    it("writable", () => {
      expect(gotPayload.writable).toBe(true);
    });
  });
}

function registerWriteScenarios() {
  describe("PUT 合法 patch 转 scope.update 并回传新 user 层", () => {
    it("status 200", () => {
      expect(put.status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(putPayloadParsed.ok).toBe(true);
    });

    it("回传 user 层", () => {
      expect(putPayloadParsed.user).toEqual({ port: 3082 });
    });

    it("走 update 路径", () => {
      expect(putPayload!.kind).toBe("update");
    });

    it("expectedRevision 透传", () => {
      expect(putPayload!.rev).toBe(3);
    });
  });

  describe("PUT 非法 patch 400 带 error.details", () => {
    it("status 400", () => {
      expect(putBad.status).toBe(400);
    });

    it("details 含字段名", () => {
      expect(putBadPayload.error.details.includes("port")).toBeTruthy();
    });
  });
}

describe("unit: buildConfigRoutes（GET 快照 / PUT 写入 / 围栏）", () => {
  beforeAll(async () => {
    const deps = {
      resolve: () =>
        ({
          enabled: false,
          host: "0.0.0.0",
          port: 3082,
          httpsEnabled: true,
          httpsPort: 3443,
          targetHost: "127.0.0.1",
          printBanner: true,
          wsCompressEnabled: true,
          wsCompressPaths: [],
          httpCompressEnabled: true,
          httpCompressLevel: 2,
        }) as unknown as ResolvedConfig,
      readUser: () => ({ user: { port: 3082 } as Record<string, unknown>, revision: 3 }),
      writable: () => true,
      update: async (patch: object, rev?: number) => {
        putPayload = { kind: "update", patch, rev };
      },
      replace: async (section: object, rev?: number) => {
        putPayload = { kind: "replace", section, rev };
      },
      compress: () => ({
        httpCompressEnabled: true,
        httpCompressLevel: 1,
        httpCompressMounted: true,
        httpCompressStats: { compressed: 5, passthrough: 6 },
      }),
    } as unknown as ConfigRouteDeps;
    const route = buildConfigRoutes(deps)[0];
    const callRoute = (method: string, overrides: Record<string, unknown> = {}, body?: unknown) =>
      Promise.resolve().then(async () => {
        const req = Object.assign(
          { method, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } },
          overrides,
        ) as unknown as IncomingMessage & { _body?: unknown };
        if (body !== undefined) req._body = body;
        const chunks: string[] = [];
        let status = 0;
        const res = {
          writeHead(code: number) {
            status = code;
          },
          end(c?: unknown) {
            if (c !== undefined) chunks.push(String(c));
          },
          getHeader() {
            return undefined;
          },
          setHeader() {},
        } as unknown as ServerResponse;
        if (body !== undefined) {
          // readBody 从 req 事件流读——这里直接给一个最小可读流形态。
          const { EventEmitter } = await import("node:events");
          const stream = Object.assign(new EventEmitter(), req) as unknown as IncomingMessage;
          process.nextTick(() => {
            stream.emit("data", Buffer.from(JSON.stringify(body)));
            stream.emit("end");
          });
          await route.handler(stream, res);
        } else {
          await route.handler(req, res);
        }
        return { status: status || 200, body: chunks.join("") };
      });

    forbidden = await callRoute("GET", { socket: { remoteAddress: "192.168.1.9" } });
    notAllowed = await callRoute("POST", {}, { patch: {} });
    got = await callRoute("GET");
    gotPayload = JSON.parse(got.body);
    put = await callRoute("PUT", {}, { patch: { port: 4099 }, expectedRevision: 3 });
    putPayloadParsed = JSON.parse(put.body);
    putBad = await callRoute("PUT", {}, { patch: { port: 70000 } });
    putBadPayload = JSON.parse(putBad.body);
  });
  registerFenceScenarios();
  registerReadScenarios();
  registerWriteScenarios();
});
