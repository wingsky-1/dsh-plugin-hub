// dsh-lan-proxy integration：apply 装配的 HTTP 压缩面（挂载 / 关闭 / 运行中热关闭 /
// enabled=false 启动态）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。断言与 describe 名逐字保留。
// 层归属：真实 apply 组合根 + fake webServer 装配面（DEVELOPMENT 测试分层表
// integration 行）。共享替身见 ./apply-support.ts（只服务本族两个文件）。
import { beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { apply } from "../../src/server/apply.ts";
import { ROUTES } from "../../src/server/config/interface.ts";
import { MIGRATED_BAK_NAME } from "../../src/server/migrate/impl/file/index.ts";
import {
  FakeRes,
  makeReq,
  makeSettings,
  makeWebServer,
  type SmokeTestHandler,
} from "./apply-support.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("apply: HTTP 压缩集成（转发 + 压缩并存 / 标记路由 / health 扩展）", () => {
  let apiHandlerPreserved = false;
  let healthRegisteredBeforeCleanup = false;
  let healthPayload: Record<string, unknown> & {
    httpCompressStats: { compressed: number };
  } = { httpCompressStats: { compressed: 0 } };
  let apiHandlerPreservedAfterCleanup = false;
  let healthRemovedAfterCleanup = false;

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-httpc-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const ws = makeWebServer();
    const apiHandler = (req: unknown, res: FakeRes) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: 1, data: "y".repeat(300) }));
    };
    ws.prefixes.set("/api", {
      kind: "prefix",
      path: "/api",
      handler: apiHandler as SmokeTestHandler,
    });
    const disposers: Array<unknown> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject() {},
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    apply(ctx as unknown as Context, { host: "127.0.0.1", port: 0, httpsEnabled: false });

    const apiRoute = ws.prefixes.get("/api")!;
    apiHandlerPreserved = apiRoute.handler === apiHandler;

    const healthRoute = ws.exact.get(ROUTES.health)!;
    healthRegisteredBeforeCleanup = ws.exact.has(ROUTES.health);
    const hRes = new FakeRes();
    healthRoute.handler(makeReq(), hRes);
    healthPayload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));

    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    apiHandlerPreservedAfterCleanup = ws.prefixes.get("/api")!.handler === apiHandler;
    healthRemovedAfterCleanup = ws.exact.has(ROUTES.health);
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  it("webServer handler 不被触碰（压缩在转发层，非宿主端 patch）", () => {
    expect(apiHandlerPreserved).toBe(true);
  });

  describe("health 扩展返回压缩配置与生效状态", () => {
    it("health 路由已注册", () => {
      expect(healthRegisteredBeforeCleanup).toBe(true);
    });

    it("httpCompressEnabled 为 true", () => {
      expect(healthPayload.httpCompressEnabled).toBe(true);
    });

    it("httpCompressLevel 为 1", () => {
      expect(healthPayload.httpCompressLevel).toBe(1);
    });

    it("httpCompressMounted 为 true", () => {
      expect(healthPayload.httpCompressMounted).toBe(true);
    });

    it("httpCompressStats.compressed 为 number", () => {
      expect(typeof healthPayload.httpCompressStats.compressed).toBe("number");
    });
  });

  describe("lifecycle 卸载撤下 health 路由且 webServer 原样", () => {
    it("/api handler 全程原样", () => {
      expect(apiHandlerPreservedAfterCleanup).toBe(true);
    });

    it("health 路由移除", () => {
      expect(healthRemovedAfterCleanup).toBe(false);
    });
  });
});

describe("apply: httpCompressEnabled=false 关闭压缩", () => {
  let apiHandlerPreserved = false;
  let healthRegistered = false;
  let healthPayload: Record<string, unknown> = {};

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-httpc-off-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const ws = makeWebServer();
    const apiHandler = (req: unknown, res: FakeRes) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":1}');
    };
    ws.prefixes.set("/api", {
      kind: "prefix",
      path: "/api",
      handler: apiHandler as SmokeTestHandler,
    });
    const disposers: Array<unknown> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject() {},
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    apply(ctx as unknown as Context, {
      host: "127.0.0.1",
      port: 0,
      httpsEnabled: false,
      httpCompressEnabled: false,
    });
    apiHandlerPreserved = ws.prefixes.get("/api")!.handler === apiHandler;
    healthRegistered = ws.exact.has(ROUTES.health);
    const hRes = new FakeRes();
    ws.exact.get(ROUTES.health)!.handler(makeReq(), hRes);
    healthPayload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  describe("关闭压缩：health mounted=false", () => {
    it("webServer handler 原样", () => {
      expect(apiHandlerPreserved).toBe(true);
    });

    it("health 路由仍注册（转发功能不受影响）", () => {
      expect(healthRegistered).toBe(true);
    });

    it("httpCompressEnabled 为 false", () => {
      expect(healthPayload.httpCompressEnabled).toBe(false);
    });

    it("httpCompressMounted 为 false", () => {
      expect(healthPayload.httpCompressMounted).toBe(false);
    });
  });
});

// 场景族提取为文件级声明（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function。
// 原脚本以函数参数化两个热关闭场景；这里只把准备动作提到文件级，describe 名的
// 嵌套与逐条用例不变。

/**
 * 单次热关闭场景：起 fake ctx + settings service → apply → PUT /config → 等 watch 生效。
 * 原脚本以函数参数化两个场景，这里按场景展开为逐条可见用例。
 */
const runHotOffCase = async (patch: Record<string, unknown>, expectProxyOff: boolean) => {
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-hotoff-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  const ws = makeWebServer();
  const apiHandler = (req: unknown, res: FakeRes) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":1}');
  };
  ws.prefixes.set("/api", {
    kind: "prefix",
    path: "/api",
    handler: apiHandler as SmokeTestHandler,
  });
  const disposers: Array<unknown> = [];
  const { service } = makeSettings();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    webServer: ws,
    inject(services: string[], fn: (ctx: unknown) => void) {
      if (services.includes("settings")) {
        fn({
          settings: service,
          effect(fn2: () => unknown) {
            const d = fn2();
            if (typeof d === "function") disposers.push(d);
            return d;
          },
          on: service.on,
        });
      }
    },
    effect(fn: () => unknown) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return d;
    },
  };
  apply(ctx as unknown as Context, { host: "127.0.0.1", port: 0, httpsEnabled: false });
  const healthPayloadOf = () => {
    const hRes = new FakeRes();
    ws.exact.get(ROUTES.health)!.handler(makeReq(), hRes);
    return JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
  };
  const mountedBefore = healthPayloadOf().httpCompressMounted;

  const finish = () => {
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  };
  if (!mountedBefore) {
    finish();
    return {
      mountedBefore,
      putStatus: undefined,
      payload: undefined,
      apiHandlerPreserved: undefined,
    };
  }

  // 运行中经配置路由保存（客户端同链路）：PUT → scope.update → watch 触发
  // onChange=scheduleSync（3s 防抖）→ sync 重建。轮询等待生效，不用固定 sleep
  // （防 flake 纪律）；deadline 覆盖 3s 防抖窗口。
  const putBody = JSON.stringify({ patch });
  const putStatus = await new Promise((resolveRoute) => {
    let status = 0;
    const stream = Object.assign(
      new EventEmitter(),
      makeReq({ method: "PUT" }),
    ) as unknown as IncomingMessage;
    const chunks: string[] = [];
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(c?: unknown) {
        if (c !== undefined) chunks.push(String(c));
        resolveRoute(status || 200);
      },
      getHeader() {
        return undefined;
      },
      setHeader() {},
    } as unknown as ServerResponse;
    process.nextTick(() => {
      stream.emit("data", Buffer.from(putBody));
      stream.emit("end");
    });
    void (async () => {
      await ws.exact.get(ROUTES.config)!.handler(stream, res);
    })();
  });

  let payload;
  if (expectProxyOff) {
    // 整插件关闭：listening 反映转发器实例存活，须等 watch 驱动 sync 重建才翻转。
    const deadline = Date.now() + 12000;
    while (healthPayloadOf().listening && Date.now() < deadline) await sleep(100);
    payload = healthPayloadOf();
  } else {
    // 只关压缩：生效值经 resolve() 立即可见（GET 快照不撒谎），转发器由
    // watch 防抖后按新配置重建（不影响 listening）。
    payload = healthPayloadOf();
  }
  const apiHandlerPreserved = ws.prefixes.get("/api")!.handler === apiHandler;
  finish();
  return { mountedBefore, putStatus, payload, apiHandlerPreserved };
};

const hotOffCases = [
  {
    label: "热关 httpCompressEnabled=false",
    patch: { httpCompressEnabled: false },
    expectProxyOff: false,
    branchName: "保存成功且压缩生效状态随保存翻转",
  },
  {
    label: "热关 enabled=false（整插件）",
    patch: { enabled: false },
    expectProxyOff: true,
    branchName: "保存成功且 watch 热更新停掉转发器",
  },
];

describe("apply: 运行中热关闭（PUT /config → scope.watch → 压缩卸载）", () => {
  describe.each(hotOffCases)("$label", (hotCase) => {
    let observed!: Awaited<ReturnType<typeof runHotOffCase>>;

    beforeAll(async () => {
      observed = await runHotOffCase(hotCase.patch, hotCase.expectProxyOff);
    }, 120_000);

    // 前置条件用例化（qa 复核）：纳入统计且失败信息内联实际值。
    it("前置压缩已生效", () => {
      expect(observed.mountedBefore).toBe(true);
    });

    if (hotCase.expectProxyOff) {
      describe("保存成功且 watch 热更新停掉转发器", () => {
        it("PUT 保存回执成功", () => {
          expect(observed.putStatus).toBe(200);
        });

        it("转发器已停（scope.watch 热更新生效）", () => {
          expect(observed.payload.listening).toBe(false);
        });

        it("压缩已卸载", () => {
          expect(observed.payload.httpCompressMounted).toBe(false);
        });

        it("webServer handler 全程原样", () => {
          expect(observed.apiHandlerPreserved).toBe(true);
        });
      });
    } else {
      describe("保存成功且压缩生效状态随保存翻转", () => {
        it("PUT 保存回执成功", () => {
          expect(observed.putStatus).toBe(200);
        });

        it("health mounted=false（生效配置即时可见）", () => {
          expect(observed.payload.httpCompressMounted).toBe(false);
        });

        it("httpCompressEnabled=false", () => {
          expect(observed.payload.httpCompressEnabled).toBe(false);
        });

        it("webServer handler 全程原样", () => {
          expect(observed.apiHandlerPreserved).toBe(true);
        });
      });
    }
  });
});

describe("apply: enabled=false 启动态", () => {
  let migratedBakExists = false;
  let legacyConfigMoved = false;
  let healthRegistered = false;
  let configRegistered = false;
  let healthPayload: Record<string, unknown> = {};

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-all-off-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    mkdirSync(join(applyHome, "lan-proxy"), { recursive: true });
    writeFileSync(
      join(applyHome, "lan-proxy", "config.json"),
      JSON.stringify({ enabled: false, port: 19996 }),
    );
    const { service: offService } = makeSettings();
    const ws = makeWebServer();
    const disposers: Array<unknown> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject(services: string[], fn: (ctx: unknown) => void) {
        if (services.includes("settings")) {
          fn({
            settings: offService,
            effect(fn2: () => unknown) {
              return fn2();
            },
            on: offService.on,
          });
        }
      },
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    apply(ctx as unknown as Context, { enabled: false });
    const nsDir = join(applyHome, "@wingsky-1", "dsh-lan-proxy");
    const migratedDeadline = Date.now() + 5000;
    while (!existsSync(join(nsDir, MIGRATED_BAK_NAME)) && Date.now() < migratedDeadline)
      await sleep(25);
    migratedBakExists = existsSync(join(nsDir, MIGRATED_BAK_NAME));
    legacyConfigMoved = !existsSync(join(applyHome, "lan-proxy", "config.json"));
    healthRegistered = ws.exact.has(ROUTES.health);
    configRegistered = ws.exact.has(ROUTES.config);
    const hRes = new FakeRes();
    ws.exact.get(ROUTES.health)!.handler(makeReq(), hRes);
    healthPayload = JSON.parse(Buffer.concat(hRes._chunks).toString("utf8"));
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 120_000);

  describe("enabled=false：迁移仍执行、health/config 路由注册、转发器不启动", () => {
    it("禁用态也完成存量迁移", () => {
      expect(migratedBakExists).toBe(true);
    });
    it("禁用态旧目录 config.json 已搬走", () => {
      expect(legacyConfigMoved).toBe(true);
    });

    it("health 路由注册", () => {
      expect(healthRegistered).toBe(true);
    });

    it("config 路由注册", () => {
      expect(configRegistered).toBe(true);
    });

    it("转发器未启动", () => {
      expect(healthPayload.listening).toBe(false);
    });

    it("payload.enabled 为 false", () => {
      expect(healthPayload.enabled).toBe(false);
    });
  });
});
