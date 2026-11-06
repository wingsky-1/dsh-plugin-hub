/** native LAN SSE：admitted Peer 生命周期与旧 loopback 快路径的隔离反例。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { TrendTracker } from "../../../src/server/aggregate/interface.ts";
import type { StatsService } from "../../../src/server/pipeline/interface.ts";
import type { LayerErrorSurface } from "../../../src/server/shared/interface.ts";
import { UiRoutesContext, handleEvents } from "../../../src/server/ui-routes/interface.ts";
import type { RemotePeerAdmissionSource } from "../../../src/server/ui-routes/context.ts";
import { DEFAULT_UI_CONFIG } from "../../../src/shared/interface.ts";

function req(method = "GET", remoteAddress = "10.0.0.2"): IncomingMessage {
  return {
    method,
    socket: { remoteAddress },
    headers: { host: remoteAddress === "127.0.0.1" ? "127.0.0.1:3080" : "192.0.2.10:3080" },
  } as unknown as IncomingMessage;
}

function context(remotePeerAdmission?: RemotePeerAdmissionSource): UiRoutesContext {
  return new UiRoutesContext({
    statsService: {} as StatsService,
    trend: {} as TrendTracker,
    uiConfig: { ...DEFAULT_UI_CONFIG },
    sseClients: new Set<ServerResponse>(),
    broadcastUiConfigChanged: () => {},
    layerErrors: {} as LayerErrorSurface,
    remotePeerAdmission,
  });
}

function response(): {
  readonly res: ServerResponse;
  readonly status: () => number;
  readonly destroys: () => number;
} {
  const listeners = new Map<string, Array<() => void>>();
  let status = 0;
  let destroys = 0;
  let destroyed = false;
  const res = {
    get destroyed() {
      return destroyed;
    },
    get writableEnded() {
      return false;
    },
    writeHead(code: number) {
      status = code;
    },
    write() {},
    end() {},
    on(event: string, handler: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    destroy() {
      destroys += 1;
      destroyed = true;
      for (const handler of listeners.get("close") ?? []) handler();
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, destroys: () => destroys };
}

describe("native LAN SSE lifecycle", () => {
  it("Peer 释放主动移除并关闭流", () => {
    let cleanup: (() => void) | undefined;
    const ctx = context(() => () => ({
      peer: {
        ctx: {
          effect(execute: () => () => void, label?: string) {
            expect(label).toContain("admitted Peer");
            cleanup = execute();
            return () => cleanup?.();
          },
        },
      },
    }));
    const stream = response();
    handleEvents(req(), stream.res, ctx);
    expect(stream.status()).toBe(200);
    expect(ctx.sseClients.size).toBe(1);

    cleanup?.();
    expect(ctx.sseClients.size).toBe(0);
    expect(stream.destroys()).toBe(1);
  });

  it("拒绝或 effect 注册失败时不写 200/注册流", () => {
    const denied = context(() => () => ({ rejection: 401 }));
    const rejected = response();
    handleEvents(req(), rejected.res, denied);
    expect(rejected.status()).toBe(401);
    expect(denied.sseClients.size).toBe(0);

    const broken = context(() => () => ({
      peer: {
        ctx: {
          effect() {
            throw new Error("peer disposed");
          },
        },
      },
    }));
    const unavailable = response();
    handleEvents(req(), unavailable.res, broken);
    expect(unavailable.status()).toBe(403);
    expect(broken.sseClients.size).toBe(0);
  });

  it("拒绝先于方法判定，已认证错方法 405 且不绑定流", () => {
    const denied = context(() => () => ({ rejection: 401 }));
    const anonymous = response();
    handleEvents(req("POST"), anonymous.res, denied);
    expect(anonymous.status()).toBe(401);

    let effects = 0;
    const admitted = context(() => () => ({
      peer: {
        ctx: {
          effect() {
            effects += 1;
          },
        },
      },
    }));
    const wrongMethod = response();
    handleEvents(req("POST"), wrongMethod.res, admitted);
    expect(wrongMethod.status()).toBe(405);
    expect(effects).toBe(0);
    expect(admitted.sseClients.size).toBe(0);
  });

  it("loopback 保留插件生命周期且不调用官方 peer admission", () => {
    let calls = 0;
    const ctx = context(() => {
      calls += 1;
      return () => ({ rejection: 403 });
    });
    const stream = response();
    handleEvents(req("GET", "127.0.0.1"), stream.res, ctx);
    expect(stream.status()).toBe(200);
    expect(ctx.sseClients.size).toBe(1);
    expect(calls).toBe(0);
  });
});
