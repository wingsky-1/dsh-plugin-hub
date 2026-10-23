// dsh-lan-proxy integration：apply 装配的注册面与围栏（health / config / 一键 CA 全链）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。断言与 describe 名逐字保留。
// 层归属：真实 apply 组合根 + 隔离 DSH_HOME（DEVELOPMENT 测试分层表 integration 行）。
// 共享替身见 ./apply-support.ts（只服务本族三个文件）。
import { beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { apply } from "../../src/server/apply.ts";
import { ROUTES } from "../../src/server/config/interface.ts";
import { MIGRATED_BAK_NAME } from "../../src/server/migrate/impl/file/index.ts";
import { makeConfigCaller, makeSettings } from "./apply-support.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 共享观测状态与辅助函数提到文件级（#1174 A1）：提取出的注册函数是独立作用域，
// 状态必须在其外层可见。钩子仍注册在本 describe 内（vitest 钩子作用域语义）。
let rpcHandleCount = 0;

let healthRoute!: WebRoute;

let configRoute!: WebRoute;

let migratedBakExists = false;

let legacyConfigMoved = false;

let settingsUpdates: unknown[] = [];

let settingsUserPort: unknown;

let settingsRegisteredNs: unknown;

let settingsUserPrintBanner: unknown;

let settingsWatchersLength = 0;

let settingsWatchDisposed = 0;

let snapshot!: { status: number; body: string };

let snapshotPayload!: {
  ok: unknown;
  effective: { port: number; host: string };
  compress: { httpCompressMounted: boolean; httpCompressStats: { compressed: number } };
  user: unknown;
  revision: unknown;
  writable: unknown;
};

let cfg403!: { status: number; body: string };

let cfg405!: { status: number; body: string };

let put!: { status: number; body: string };

let putPayload!: { ok: unknown; user: unknown };

let res403Status = 0;

let res405Status = 0;

let res405Body = "";

let res200Status = 0;

let res200Payload: Record<string, unknown> = {};

let caDlRoute!: WebRoute;

let caGenRoute!: WebRoute;

let dlSelfSigned!: { status: number; body: string };

let healthSelfSigned!: Record<string, unknown>;

let caGenFence403 = 0;

let caGenFence405 = 0;

let customPost409!: { status: number; body: string };

let genCreated!: { status: number; body: string };

let dlManaged!: { status: number; headers: Record<string, string>; head: number };

let healthManaged!: {
  caState: string;
  caConfigured: boolean;
  certInfo: { leafValidTo: string; leafSans: unknown; currentIps: unknown };
};

let genNeedsConfirm!: { status: number; body: string };

let leafRotated!: { status: number; body: string };

// 场景族提取为注册函数（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function。
// 提取的是完整的一级子 describe（场景族），其内容与名字逐字保留，嵌套顺序不变。
function registerMigrationFamily() {
  describe("apply 后存量 config.json 自动迁移进官方存储（attach 即迁移）", () => {
    it(".bak 幂等标记存在（命名空间目录）", () => {
      expect(migratedBakExists).toBe(true);
    });
    it("旧目录 config.json 已搬走", () => {
      expect(legacyConfigMoved).toBe(true);
    });

    it("写入 scope 的 patch 与 revision", () => {
      expect(settingsUpdates).toEqual([{ patch: { port: 19997 }, expectedRevision: undefined }]);
    });

    it("user 层已写入", () => {
      expect(settingsUserPort).toBe(19997);
    });

    it("settings 命名空间已接线（describe 被调）", () => {
      expect((settingsRegisteredNs as number) >= 1).toBe(true);
    });
  });
}

function registerConfigSnapshotFamily() {
  describe("GET /config 快照含 effective 生效值 + 压缩快照 + user 层 + revision", () => {
    it("status 200", () => {
      expect(snapshot.status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(snapshotPayload.ok).toBe(true);
    });

    it("迁移后的生效端口可见", () => {
      expect(snapshotPayload.effective.port).toBe(19997);
    });

    it("组合层 entry 兜底生效", () => {
      expect(snapshotPayload.effective.host).toBe("127.0.0.1");
    });

    it("转发器已监听 → 压缩已挂载", () => {
      expect(snapshotPayload.compress.httpCompressMounted).toBe(true);
    });

    it("压缩协商计数为 number", () => {
      expect(typeof snapshotPayload.compress.httpCompressStats.compressed).toBe("number");
    });

    it("user 层", () => {
      expect(snapshotPayload.user).toEqual({ port: 19997 });
    });

    it("revision 为 number", () => {
      expect(typeof snapshotPayload.revision).toBe("number");
    });

    it("writable", () => {
      expect(snapshotPayload.writable).toBe(true);
    });
  });
}

function registerConfigFenceFamily() {
  describe("config 路由非回环 403", () => {
    it("status 403", () => {
      expect(cfg403.status).toBe(403);
    });

    // #473 批 1（B1-4）：403 body 围栏文案（守卫收敛后逐字节锁定）
    it("403 body 围栏文案", () => {
      expect(JSON.parse(cfg403.body).error).toBe("forbidden: loopback-only");
    });
  });
}

function registerConfigMethodFenceFamily() {
  describe("config 路由 DELETE 405", () => {
    it("status 405", () => {
      expect(cfg405.status).toBe(405);
    });

    // #473 批 1（B1-3）：405 body 文案断言
    it("405 body 文案", () => {
      expect(JSON.parse(cfg405.body).error).toBe("method not allowed: DELETE");
    });
  });
}

function registerConfigPutFamily() {
  describe("PUT 经路由写入官方存储并触发订阅回调", () => {
    it("status 200", () => {
      expect(put.status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(putPayload.ok).toBe(true);
    });

    it("存储 user.printBanner 已写入", () => {
      expect(settingsUserPrintBanner).toBe(false);
    });

    it("订阅已挂接未释放", () => {
      expect(settingsWatchersLength >= 1 && settingsWatchDisposed).toBe(0);
    });
  });
}

function registerHealthMethodFenceFamily() {
  describe("health 405 for non-GET", () => {
    it("status 405", () => {
      expect(res405Status).toBe(405);
    });

    // #473 批 1（B1-3）：health（GET 白名单）405 body 文案断言
    it("405 body 文案", () => {
      expect(JSON.parse(res405Body).error).toBe("method not allowed: POST");
    });
  });
}

function registerHealthStatusFamily() {
  describe("health 200 with status summary", () => {
    it("status 200", () => {
      expect(res200Status).toBe(200);
    });

    it("payload.ok 为 true", () => {
      expect(res200Payload.ok).toBe(true);
    });

    it("payload.plugin 为 dsh-lan-proxy", () => {
      expect(res200Payload.plugin).toBe("dsh-lan-proxy");
    });
  });
}

function registerCaRouteRegistrationFamily() {
  describe("一键 CA 路由注册（#930 Phase 2）", () => {
    it("下发路由注册", () => {
      expect(caDlRoute).toBeTruthy();
    });

    it("动作路由注册", () => {
      expect(caGenRoute).toBeTruthy();
    });
  });
}

function registerCaSelfSignedFamily() {
  describe("Phase 1 自签下载 404 + health 联合（口径诚实）", () => {
    it("自签下载 404 ca-unconfigured", () => {
      expect(dlSelfSigned.status).toBe(404);
      expect(JSON.parse(dlSelfSigned.body).error.code).toBe("ca-unconfigured");
    });

    it("404 指引一键生成", () => {
      expect(JSON.parse(dlSelfSigned.body).error.details).toContain("一键生成");
    });

    it("health 自签三元组", () => {
      expect(healthSelfSigned.caState).toBe("self-signed");
      expect(healthSelfSigned.certInfo).toBe(null);
      expect(healthSelfSigned.caConfigured).toBe(false);
    });
  });
}

function registerCaFenceFamily() {
  describe("caGenerate 围栏（403 先于 405）", () => {
    it("非回环 403", () => {
      expect(caGenFence403).toBe(403);
    });

    it("回环 GET 405", () => {
      expect(caGenFence405).toBe(405);
    });
  });
}

function registerCaCustomGateFamily() {
  describe("custom 服务端门控（curl 不可绕过）", () => {
    it("带确认亦 409 ca-customized", () => {
      expect(customPost409.status).toBe(409);
      expect(JSON.parse(customPost409.body).error.code).toBe("ca-customized");
    });
  });
}

function registerCaGenerateFamily() {
  describe("首建 200 + 托管下发 200 + health managed", () => {
    it("首建 200 generated", () => {
      expect(genCreated.status).toBe(200);
      expect(JSON.parse(genCreated.body)).toEqual({ ok: true, mode: "generated" });
    });

    it("托管下发 200 DER", () => {
      expect(dlManaged.status).toBe(200);
      expect(dlManaged.headers["content-type"]).toBe("application/x-x509-ca-cert");
      expect(dlManaged.head).toBe(0x30);
    });

    it("health managed 三元组 + certInfo 形态", () => {
      expect(healthManaged.caState).toBe("managed");
      expect(healthManaged.caConfigured).toBe(true);
      expect(typeof healthManaged.certInfo.leafValidTo).toBe("string");
      expect(Number.isNaN(Date.parse(healthManaged.certInfo.leafValidTo))).toBe(false);
      expect(Array.isArray(healthManaged.certInfo.leafSans)).toBe(true);
      expect(Array.isArray(healthManaged.certInfo.currentIps)).toBe(true);
    });
  });
}

function registerCaRotateFamily() {
  describe("复发确认 + 叶轮换 200", () => {
    it("无确认 409 needs-confirm", () => {
      expect(genNeedsConfirm.status).toBe(409);
      expect(JSON.parse(genNeedsConfirm.body).error.code).toBe("needs-confirm");
    });

    it("确认后 200 leaf-rotated", () => {
      expect(leafRotated.status).toBe(200);
      expect(JSON.parse(leafRotated.body)).toEqual({ ok: true, mode: "leaf-rotated" });
    });
  });
}

describe("apply: 注册、围栏与 settings 命名空间接线", () => {
  beforeAll(async () => {
    await prepareApplyWiring();
  }, 120_000);

  it("RPC 配置通道不再注册（自建通道移除）", () => {
    expect(rpcHandleCount).toBe(0);
  });

  it("health route registered", () => {
    expect(healthRoute).toBeTruthy();
  });

  it("config route registered", () => {
    expect(configRoute).toBeTruthy();
  });

  it("health 403 for non-loopback", () => {
    expect(res403Status).toBe(403);
  });

  registerMigrationFamily();
  registerConfigSnapshotFamily();
  registerConfigFenceFamily();
  registerConfigMethodFenceFamily();
  registerConfigPutFamily();
  registerHealthMethodFenceFamily();
  registerHealthStatusFamily();
  registerCaRouteRegistrationFamily();
  registerCaSelfSignedFamily();
  registerCaFenceFamily();
  registerCaCustomGateFamily();
  registerCaGenerateFamily();
  registerCaRotateFamily();
});

/** 准备段按语义族提取（#1174 A1）：真实 apply 组合根装配与各场景族的观测采集。
 *
 * 共享局部态（ctx / callRoute / caCall / probes…）留在辅助函数闭包内，
 * 只把各 it 要断言的结果写入文件级观测量；不外扩为通用 harness。
 */
async function prepareApplyWiring() {
  const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-"));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = applyHome;
  // 预置存量 config.json → apply 后应自动迁移进官方存储。
  mkdirSync(join(applyHome, "lan-proxy"), { recursive: true });
  writeFileSync(join(applyHome, "lan-proxy", "config.json"), JSON.stringify({ port: 19997 }));
  // base 即组合层 entry 投影（真实宿主 describe 返回 resolved value）：host 来自 entry，port 待迁移覆盖。
  const { state: settingsState, service } = makeSettings(
    {},
    { host: "127.0.0.1", port: 0, httpsEnabled: false },
  );
  const { ctx, routes, rpcHandles, disposers } = makeApplyContext(service);
  apply(ctx as unknown as Context, { host: "127.0.0.1", port: 0, httpsEnabled: false });
  const cleanup = () => {
    for (const d of disposers.reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
  };

  rpcHandleCount = rpcHandles.length;
  healthRoute = routes.filter((r) => r.path === ROUTES.health)[0];
  configRoute = routes.filter((r) => r.path === ROUTES.config)[0];
  caDlRoute = routes.filter((r) => r.path === ROUTES.caCert)[0];
  caGenRoute = routes.filter((r) => r.path === ROUTES.caGenerate)[0];

  await collectMigration(applyHome, settingsState);
  const callRoute = makeConfigCaller(configRoute);
  await collectConfigRoutes(callRoute, settingsState);
  const probes = makeHealthProbes();
  collectHealthProbes(healthRoute, probes);

  // 一键 CA 全链（#930 Phase 1+2，lib 产物层）：自签 404 → 围栏 → custom 门控 →
  // 首建 200 → 托管下发 200 → 复发确认 → 叶轮换。真签发（forge）只跑两轮。
  const caRoutes: CaRoutes = { caDlRoute, caGenRoute, healthRoute, probes };
  await collectCaSelfSigned(caRoutes);
  await collectCaCustomGate(caRoutes, callRoute, settingsState);
  await collectCaGenerate(caRoutes, settingsState);

  cleanup();
  process.env.DSH_HOME = prevHome;
  rmSync(applyHome, { recursive: true, force: true });
}

/** 迁移族观测：.bak 幂等标记、旧文件搬走、settings 侧 patch / user / describeCalls。 */
async function collectMigration(
  applyHome: string,
  settingsState: ReturnType<typeof makeSettings>["state"],
) {
  // 迁移是 async fire-and-forget：轮询等待（防 flake 纪律，不用固定 sleep）。
  // issue #911 起旧目录先迁入命名空间，.bak 落在新目录（旧文件搬走不断言残留）。
  const nsDir = join(applyHome, "@wingsky-1", "dsh-lan-proxy");
  const migratedDeadline = Date.now() + 5000;
  while (!existsSync(join(nsDir, MIGRATED_BAK_NAME)) && Date.now() < migratedDeadline)
    await sleep(25);
  migratedBakExists = existsSync(join(nsDir, MIGRATED_BAK_NAME));
  legacyConfigMoved = !existsSync(join(applyHome, "lan-proxy", "config.json"));
  // 必须复制：后续 PUT 会继续往同一个 updates 数组里 push，存引用会让断言看到块尾状态
  settingsUpdates = settingsState.updates.map((u) => ({ ...u }));
  settingsUserPort = settingsState.user.port;
  settingsRegisteredNs = settingsState.describeCalls;
}

/** config 路由观测：GET 快照 / 非回环 403 / DELETE 405 / PUT 写入与订阅回调。 */
async function collectConfigRoutes(
  callRoute: ReturnType<typeof makeConfigCaller>,
  settingsState: ReturnType<typeof makeSettings>["state"],
) {
  // GET /config 快照（经真实路由 handler）：effective + compress + user + revision。
  snapshot = await callRoute("GET");
  snapshotPayload = JSON.parse(snapshot.body);
  cfg403 = await callRoute("GET", { socket: { remoteAddress: "192.168.100.9" } });
  cfg405 = await callRoute("DELETE");
  // PUT 写入：经路由 → deps.update（fake service）→ document-updated 触发订阅。
  put = await callRoute(
    "PUT",
    {},
    { patch: { printBanner: false }, expectedRevision: settingsState.revision },
  );
  putPayload = JSON.parse(put.body);
  // 原断言读取的存储侧观测值在此点取快照（后续 cleanup 会退订）
  settingsUserPrintBanner = settingsState.user.printBanner;
  settingsWatchersLength = settingsState.listeners.length;
  settingsWatchDisposed = settingsState.unsubscribed;
}

/** health 路由的请求 / 响应替身（只服务本族调用方，不外扩）。 */
function makeHealthProbes() {
  const fakeReq = (overrides: Record<string, unknown> = {}): IncomingMessage =>
    Object.assign(
      {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080" },
        url: ROUTES.health,
      },
      overrides,
    ) as unknown as IncomingMessage;
  const fakeRes = (): {
    status: () => number;
    body: () => string;
    writeHead: (s: number) => void;
    end: (payload?: unknown) => void;
  } => {
    let status = 0;
    let body = "";
    return {
      status: (): number => status,
      body: (): string => body,
      writeHead(s: number) {
        status = s;
      },
      end(payload?: unknown) {
        body = payload as string;
      },
    };
  };
  return { fakeReq, fakeRes };
}

/** health 路由观测：非回环 403 / 非 GET 405 / GET 200 摘要。 */
function collectHealthProbes(healthRoute: WebRoute, probes: ReturnType<typeof makeHealthProbes>) {
  const { fakeReq, fakeRes } = probes;
  const res403 = fakeRes();
  healthRoute.handler(
    fakeReq({ socket: { remoteAddress: "192.168.1.9" } }),
    res403 as unknown as ServerResponse,
  );
  res403Status = res403.status();
  const res405 = fakeRes();
  healthRoute.handler(fakeReq({ method: "POST" }), res405 as unknown as ServerResponse);
  res405Status = res405.status();
  res405Body = res405.body();
  const res200 = fakeRes();
  healthRoute.handler(fakeReq(), res200 as unknown as ServerResponse);
  res200Status = res200.status();
  res200Payload = JSON.parse(res200.body());
}

/** apply 组合根替身：只记录注册面与 disposer（不替被测代码做决定，testing skill §3）。 */
function makeApplyContext(service: ReturnType<typeof makeSettings>["service"]) {
  const routes: WebRoute[] = [];
  const rpcHandles: Array<{ channel: string; h: unknown; opts: unknown }> = [];
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
    inject(services: string[], fn: (ctx: unknown) => void) {
      if (services.includes("connection")) {
        fn({
          connection: {
            rpc: {
              handle(channel: string, h: unknown, opts: unknown) {
                rpcHandles.push({ channel, h, opts });
                return () => {};
              },
            },
          },
          effect(fn2: () => unknown) {
            return fn2();
          },
        });
      }
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
  return { ctx, routes, rpcHandles, disposers };
}

/** CA 段共用依赖：两条 CA 路由 + health 读取探针。 */
interface CaRoutes {
  caDlRoute: WebRoute;
  caGenRoute: WebRoute;
  healthRoute: WebRoute;
  probes: ReturnType<typeof makeHealthProbes>;
}
type CaCallResult = { status: number; headers: Record<string, string>; body: Buffer };

/** CA 路由调用器：经真实 handler，带 body 时以 async iterator 喂字节。 */
function makeCaCaller(caRoutes: CaRoutes) {
  const { healthRoute, probes } = caRoutes;
  const caCall = async (
    route: WebRoute,
    method: string,
    overrides: Record<string, unknown> = {},
    body?: unknown,
    raw?: string,
  ): Promise<CaCallResult> => {
    const text = raw !== undefined ? raw : body === undefined ? "" : JSON.stringify(body);
    const req = Object.assign(
      {
        method,
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080" },
        url: route.path,
        [Symbol.asyncIterator]: async function* () {
          if (text.length > 0) yield Buffer.from(text);
        },
      },
      overrides,
    );
    let status = 0;
    let headersOut: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = {
      writeHead(c: number, h?: Record<string, string>) {
        status = c;
        headersOut = h ?? {};
      },
      end(c?: unknown) {
        if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      },
    };
    await route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return { status: status || 200, headers: headersOut, body: Buffer.concat(chunks) };
  };
  const healthNow = async (): Promise<Record<string, unknown>> => {
    const r = probes.fakeRes();
    healthRoute.handler(probes.fakeReq(), r as unknown as ServerResponse);
    return JSON.parse(r.body());
  };
  return { caCall, healthNow };
}

/** CA 自签段（#930 Phase 1）：自签下载 404 → health 自签三元组 → 围栏 403/405。 */
async function collectCaSelfSigned(caRoutes: CaRoutes) {
  const { caDlRoute, caGenRoute } = caRoutes;
  const { caCall, healthNow } = makeCaCaller(caRoutes);
  const dlSelf = await caCall(caDlRoute, "GET");
  dlSelfSigned = { status: dlSelf.status, body: dlSelf.body.toString("utf8") };
  healthSelfSigned = await healthNow();
  const fence403 = await caCall(
    caGenRoute,
    "POST",
    { socket: { remoteAddress: "192.168.100.9" } },
    {},
  );
  caGenFence403 = fence403.status;
  caGenFence405 = (await caCall(caGenRoute, "GET")).status;
}

/** custom 门控：经真实 PUT 置孤叶子 → 带确认 POST 亦 409 → 清空恢复自签。 */
async function collectCaCustomGate(
  caRoutes: CaRoutes,
  callRoute: ReturnType<typeof makeConfigCaller>,
  settingsState: ReturnType<typeof makeSettings>["state"],
) {
  const { caGenRoute } = caRoutes;
  const customPut = await callRoute(
    "PUT",
    {},
    {
      patch: { tlsCertFile: "/x/c.pem", tlsKeyFile: "/x/k.pem" },
      expectedRevision: settingsState.revision,
    },
  );
  if (customPut.status !== 200) throw new Error("custom PUT setup failed: " + customPut.body);
  const { caCall } = makeCaCaller(caRoutes);
  const customPost = await caCall(
    caGenRoute,
    "POST",
    {},
    { confirmed: true, expectedRevision: settingsState.revision },
  );
  customPost409 = { status: customPost.status, body: customPost.body.toString("utf8") };
  const restorePut = await callRoute(
    "PUT",
    {},
    { patch: { tlsCertFile: "", tlsKeyFile: "" }, expectedRevision: settingsState.revision },
  );
  if (restorePut.status !== 200) throw new Error("restore PUT setup failed: " + restorePut.body);
}

/** CA 生成段：首建 200 → 托管下发 200 → health managed → 复发确认 → 叶轮换 200。 */
async function collectCaGenerate(
  caRoutes: CaRoutes,
  settingsState: ReturnType<typeof makeSettings>["state"],
) {
  const { caDlRoute, caGenRoute } = caRoutes;
  const { caCall, healthNow } = makeCaCaller(caRoutes);
  const created = await caCall(
    caGenRoute,
    "POST",
    {},
    { expectedRevision: settingsState.revision },
  );
  genCreated = { status: created.status, body: created.body.toString("utf8") };
  const dlMan = await caCall(caDlRoute, "GET");
  dlManaged = { status: dlMan.status, headers: dlMan.headers, head: dlMan.body[0] };
  healthManaged = (await healthNow()) as typeof healthManaged;
  const again = await caCall(caGenRoute, "POST", {}, { expectedRevision: settingsState.revision });
  genNeedsConfirm = { status: again.status, body: again.body.toString("utf8") };
  const rotated = await caCall(
    caGenRoute,
    "POST",
    {},
    { confirmed: true, expectedRevision: settingsState.revision },
  );
  leafRotated = { status: rotated.status, body: rotated.body.toString("utf8") };
}
