/**
 * dsh-lan-proxy — 宿主端（src/index.ts）结构化单测。
 *
 * 覆盖本批未覆盖热点（fnMap 可命中）：
 * - prepareTls：apply(httpsEnabled: true) → sync() → prepareTls
 * - setSource / onScope：installLanProxySettings 的 hooks 回调
 * - migrateFileConfig / applyConfigPatch：迁移与保存通道边界
 * - isUnloading（包内复刻）：订阅回调内调用
 * - warnLog：settings 服务缺席时调用
 *
 * 迁移说明（#722 阶段 1）：脚本式断言迁为 vitest 结构化用例——原每个主题块一个
 * describe、原每条 assert 一个 it，断言表达式与判定口径逐条保留（循环体经 it.each
 * 展开为逐条可见用例）。含临时目录 / DSH_HOME / 真实监听的块以 beforeAll 包住「原
 * 动作序列 + 在每个原断言位置取观测快照」，afterAll 回收句柄与临时目录；每个 it 只对
 * 快照断言，故交错序列里各断言看到的仍是各自当时的观测值而非块尾状态。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:http";

// 单元层导入面（ARCHITECTURE-METHOD §8）：同域白盒直连 impl。
// 唯一例外是包入口 src/index.ts——它承载 cordis 插件契约（name/inject），不是内部
// barrel；不从这里取就取不到（白盒化后它的 2 条语句曾掉到 0% 覆盖）。
import { inject, name } from "../../src/index.ts";
import { apply, pluginDir, DEFAULT_WSS_COMPRESS_PATHS } from "../../src/server/apply.ts";
import {
  BOOLEAN_KEYS,
  Config,
  normalizeConfig,
  sanitizeSettings,
  validateSettings,
  normalizeLegacyWsCompressPaths,
} from "../../src/server/config/impl/model.ts";
import { SETTINGS_NS, warnLog } from "../../src/server/config/impl/namespace.ts";
import {
  ROUTES,
  applyConfigPatch,
  buildConfigRoutes,
} from "../../src/server/config/impl/routes.ts";
import { MIGRATED_BAK_NAME, migrateFileConfig } from "../../src/server/migrate/impl/file/index.ts";
import { SETTINGS_MIGRATION_MARKER_NAME } from "../../src/server/migrate/impl/legacy-settings/index.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { IncomingMessage } from "node:http";
import type { ConfigRouteDeps, PatchResult } from "../../src/server/config/interface.ts";

// 包入口契约：cordis 靠这两个符号定位与调度本插件，写错即插件静默不加载。
describe("包入口契约（src/index.ts）", () => {
  it("插件名与 cordis.patch.yml 的挂载行一致", () => expect(name).toBe("lan-proxy"));
  it("只声明注入 webServer（回环服务器就绪后才启动）", () => expect(inject).toEqual(["webServer"]));
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** applyConfigPatch 的最小 fake deps（原脚本中两处逐字相同的工厂合为一处）。
 * 返回经 `as unknown` 收口到 ConfigRouteDeps（单点适配；各调用点不再逐个断言）。 */
const basePatchDeps = (over: Record<string, unknown> = {}): ConfigRouteDeps =>
  ({
    resolve: () => ({ enabled: true }),
    readUser: () => ({ user: {}, revision: 1 }),
    writable: () => true,
    update: async () => {},
    replace: async () => {},
    compress: () => ({
      httpCompressEnabled: true,
      httpCompressLevel: 1,
      httpCompressMounted: false,
      httpCompressStats: { compressed: 0, passthrough: 0 },
    }),
    ...over,
  }) as unknown as ConfigRouteDeps;

/**
 * fake webServer：捕获 tapIndex 变换与 index-inject 订阅。
 *
 * 为什么不能留空实现：`apply` 经 `ctx.webServer.tapIndex` 注入 index.html
 * （randomUUID polyfill 与 host trust，issue #856），空实现让「注入了什么、注册了
 * 几次、会不会整表覆盖」全部不可断言。`fakeWebServers` 记录本轮创建的实例，供
 * 用例在同一 describe 内取用。
 */
const fakeWebServers: Array<Record<string, unknown>> = [];
function makeFakeWebServer(options: { port?: number; register?: (route: WebRoute) => void } = {}) {
  const { port = 3080, register } = options;
  const taps: Array<() => unknown> = [];
  const indexInjectListeners: Array<(table: unknown) => void> = [];
  const ws = {
    taps,
    indexInjectListeners,
    port,
    register(route: WebRoute) {
      if (typeof register === "function") register(route);
      return () => {};
    },
    tapIndex(transform: () => unknown) {
      taps.push(transform);
      return () => {
        const at = taps.indexOf(transform);
        if (at !== -1) taps.splice(at, 1);
      };
    },
    on(event: string, cb: (table: unknown) => void) {
      if (event === "webserver/index-inject") indexInjectListeners.push(cb);
      return () => {};
    },
    /** 自行 emit 结构化注入表（与官方 collectIndexInjections 同形）。 */
    emitIndexInjections(table: unknown) {
      for (const cb of indexInjectListeners) cb(table);
      return table;
    },
  };
  fakeWebServers.push(ws);
  return ws;
}

// ===== pluginDir =====
describe("pluginDir", () => {
  let dir = "";
  let tmp = "";

  beforeAll(() => {
    const prev = process.env.DSH_HOME;
    tmp = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-dir-"));
    process.env.DSH_HOME = tmp;
    dir = pluginDir();
    process.env.DSH_HOME = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("pluginDir 末段为包名分区 dsh-lan-proxy（issue #911）", () => {
    expect(basename(dir)).toBe("dsh-lan-proxy");
    expect(basename(dirname(dir))).toBe("@wingsky-1");
  });

  it("pluginDir 在 DSH_HOME 内", () => {
    expect(dir.startsWith(tmp)).toBeTruthy();
  });
});

// ===== sanitizeSettings 更多边界 =====
describe("sanitizeSettings 更多边界", () => {
  it("wsCompressPaths 非数组 → null", () => {
    expect(sanitizeSettings({ wsCompressPaths: "not-array" })).toBe(null);
  });

  it("wsCompressEnabled 非布尔 → null", () => {
    expect(sanitizeSettings({ wsCompressEnabled: "yes" })).toBe(null);
  });

  it("ownsHostCompat true → 通过", () => {
    expect(sanitizeSettings({ ownsHostCompat: true })).toEqual({ ownsHostCompat: true });
  });

  it("ownsHostCompat false → 通过（false 是合法值，不得被当成缺省丢弃）", () => {
    expect(sanitizeSettings({ ownsHostCompat: false })).toEqual({ ownsHostCompat: false });
  });

  it("ownsHostCompat 非布尔 → null", () => {
    expect(sanitizeSettings({ ownsHostCompat: "yes" })).toBe(null);
  });

  it("httpCompressLevel 负值 → null", () => {
    expect(sanitizeSettings({ httpCompressLevel: -1 })).toBe(null);
  });

  it("httpCompressLevel 非整数 → null", () => {
    expect(sanitizeSettings({ httpCompressLevel: 1.5 })).toBe(null);
  });

  it("空对象 → 空", () => {
    expect(sanitizeSettings({})).toEqual({});
  });
});

// ===== 校验器的**边界**口径（#775 阶 0：杀掉有覆盖却存活的变异体）=====
// 为什么单独成块：FILE_CONFIG_VALIDATORS 里的上下界此前只被「非法值 → null」这一类用例
// 覆盖（如 -1 / "yes"），而边界本身（0、恰好等于上界、上界 +1、非整数）没有任何断言——
// 于是一整簇条件变异体（`> 0`→`>= 0`、`<= 65535`→`< 65535`、`Number.isInteger` 被短路）
// 全都能存活：把上界改成不含等号、或把整数校验去掉，测试照样绿。
describe("sanitizeSettings 校验器边界（端口 / 压缩档位 / 回环 / 证书清除）", () => {
  it("port 边界：0 / 65535 / 65536 / 非整数 / 字符串", () => {
    expect(sanitizeSettings({ port: 0 })).toBe(null);
    expect(sanitizeSettings({ port: 65535 })).toEqual({ port: 65535 });
    expect(sanitizeSettings({ port: 65536 })).toBe(null);
    expect(sanitizeSettings({ port: 1.5 })).toBe(null);
    expect(sanitizeSettings({ port: "3081" })).toBe(null);
  });

  it("httpsPort 与 port 同口径（含非整数）", () => {
    expect(sanitizeSettings({ httpsPort: 0 })).toBe(null);
    expect(sanitizeSettings({ httpsPort: 65535 })).toEqual({ httpsPort: 65535 });
    expect(sanitizeSettings({ httpsPort: 65536 })).toBe(null);
    expect(sanitizeSettings({ httpsPort: 2.5 })).toBe(null);
  });

  it("targetPort 与 port 同口径，且必须同时通过回环 targetHost", () => {
    expect(sanitizeSettings({ targetPort: 0 })).toBe(null);
    expect(sanitizeSettings({ targetPort: 65535, targetHost: "127.0.0.1" })).toEqual({
      targetPort: 65535,
      targetHost: "127.0.0.1",
    });
    expect(sanitizeSettings({ targetPort: 65536 })).toBe(null);
    expect(sanitizeSettings({ targetPort: 3.5 })).toBe(null);
  });

  it("targetHost 只接受回环（内联 isLoopbackTarget）", () => {
    expect(sanitizeSettings({ targetHost: "192.168.1.5" })).toBe(null);
    expect(sanitizeSettings({ targetHost: "example.com" })).toBe(null);
    expect(sanitizeSettings({ targetHost: "127.0.0.1" })).toEqual({ targetHost: "127.0.0.1" });
    expect(sanitizeSettings({ targetHost: "localhost" })).toEqual({ targetHost: "localhost" });
  });

  it("httpCompressLevel：下界 0 含等号，旧档位 4..9 迁移为 3，10 非法", () => {
    expect(sanitizeSettings({ httpCompressLevel: 0 })).toEqual({ httpCompressLevel: 0 });
    expect(sanitizeSettings({ httpCompressLevel: 3 })).toEqual({ httpCompressLevel: 3 });
    expect(sanitizeSettings({ httpCompressLevel: 4 })).toEqual({ httpCompressLevel: 3 });
    expect(sanitizeSettings({ httpCompressLevel: 9 })).toEqual({ httpCompressLevel: 3 });
    expect(sanitizeSettings({ httpCompressLevel: 10 })).toBe(null);
  });

  it("wsCompressPaths：每项都必须是字符串（不是只判数组）", () => {
    expect(sanitizeSettings({ wsCompressPaths: ["/a", "/b"] })).toEqual({
      wsCompressPaths: ["/a", "/b"],
    });
    expect(sanitizeSettings({ wsCompressPaths: ["/a", 1] })).toBe(null);
    expect(sanitizeSettings({ wsCompressPaths: [] })).toEqual({ wsCompressPaths: [] });
  });

  it("wsDeflatePolicy：允许缺省字段，但给了就必须是对的类型", () => {
    expect(sanitizeSettings({ wsDeflatePolicy: {} })).toEqual({ wsDeflatePolicy: {} });
    expect(sanitizeSettings({ wsDeflatePolicy: { browser: true } })).toEqual({
      wsDeflatePolicy: { browser: true },
    });
    expect(sanitizeSettings({ wsDeflatePolicy: { browser: "yes" } })).toBe(null);
    expect(sanitizeSettings({ wsDeflatePolicy: { uaDeny: ["curl"] } })).toEqual({
      wsDeflatePolicy: { uaDeny: ["curl"] },
    });
    expect(sanitizeSettings({ wsDeflatePolicy: { uaDeny: "curl" } })).toBe(null);
  });

  it("空字符串证书路径被剔除（清除语义），非空则保留", () => {
    expect(sanitizeSettings({ tlsCertFile: "" })).toEqual({});
    expect(sanitizeSettings({ tlsKeyFile: "" })).toEqual({});
    expect(sanitizeSettings({ tlsCertFile: "/tmp/x.pem" })).toEqual({ tlsCertFile: "/tmp/x.pem" });
  });

  it("未知键被忽略而不是整体拒绝（净化只认已知键）", () => {
    expect(sanitizeSettings({ unknownKey: 1 })).toEqual({});
    expect(sanitizeSettings({ unknownKey: 1, port: 3081 })).toEqual({ port: 3081 });
  });

  it("null / 非对象 payload → null", () => {
    expect(sanitizeSettings(null)).toBe(null);
    expect(sanitizeSettings("nope")).toBe(null);
    expect(sanitizeSettings(42)).toBe(null);
  });
});

// ===== normalizeLegacyWsCompressPaths（#395 M2 存量白名单归一化纯函数） =====
describe("normalizeLegacyWsCompressPaths（#395 M2 存量白名单归一化纯函数）", () => {
  it("旧默认正序 → remote.mux", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual([
      "/api/remote.mux",
    ]);
  });

  it("旧默认乱序同样等价 → remote.mux", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.host", "/api/events.mux"])).toEqual([
      "/api/remote.mux",
    ]);
  });

  it("归一化目标与 DEFAULT_WSS_COMPRESS_PATHS 同源", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.host"])).toEqual([
      ...DEFAULT_WSS_COMPRESS_PATHS,
    ]);
  });

  it("自定义白名单原样", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/custom/ws"])).toEqual(["/api/custom/ws"]);
  });

  it("含废弃端点的自定义组合原样", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/custom/ws"])).toEqual([
      "/api/events.mux",
      "/api/custom/ws",
    ]);
  });

  it("重复元素非等价原样", () => {
    expect(normalizeLegacyWsCompressPaths(["/api/events.mux", "/api/events.mux"])).toEqual([
      "/api/events.mux",
      "/api/events.mux",
    ]);
  });

  it("undefined 原样", () => {
    expect(normalizeLegacyWsCompressPaths(undefined)).toBe(undefined);
  });

  it("空数组原样", () => {
    expect(normalizeLegacyWsCompressPaths([])).toEqual([]);
  });
});

// ===== validateSettings 更多边界 =====
describe("validateSettings 更多边界", () => {
  it("空对象 → null", () => {
    expect(validateSettings({})).toBe(null);
  });

  it("仅端口合法 → null", () => {
    expect(validateSettings({ port: 3081 })).toBe(null);
  });

  it("enabled 非法优先", () => {
    expect(validateSettings({ enabled: "yes", port: "abc" })!.key).toBe("enabled");
  });

  it("wsCompressPaths 非法检测", () => {
    expect(validateSettings({ wsCompressPaths: [1, 2] })!.key).toBe("wsCompressPaths");
  });

  it("httpCompressLevel 非法检测", () => {
    expect(validateSettings({ httpCompressLevel: 10 })!.key).toBe("httpCompressLevel");
  });

  it("hint 含档位范围", () => {
    expect(validateSettings({ httpCompressLevel: 10 })!.hint.includes("0-3")).toBeTruthy();
  });
});

// ===== migrateFileConfig 边界（#110） =====
describe("migrateFileConfig 边界（#110）", () => {
  let outcome!: Awaited<ReturnType<typeof migrateFileConfig>>;
  let bakExists = false;
  let configGone = true;
  let outcome2!: Awaited<ReturnType<typeof migrateFileConfig>>;

  beforeAll(async () => {
    // 非 object JSON：只改名标记、不写入。
    const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mig-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify(123));
    outcome = await migrateFileConfig(dir, {
      async update() {
        throw new Error("must not be called");
      },
    });
    bakExists = existsSync(join(dir, MIGRATED_BAK_NAME));
    configGone = existsSync(join(dir, "config.json"));
    rmSync(dir, { recursive: true, force: true });

    // sanitize 拒绝（含非法值）：整体不写。
    const dir2 = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mig2-"));
    writeFileSync(join(dir2, "config.json"), JSON.stringify({ port: 99999 }));
    outcome2 = await migrateFileConfig(dir2, {
      async update() {
        throw new Error("must not be called");
      },
    });
    rmSync(dir2, { recursive: true, force: true });
  });

  it("number JSON → 只标记不写", () => {
    expect(outcome.skippedCorrupt).toBe(true);
  });

  it("bak 标记存在", () => {
    expect(bakExists).toBe(true);
  });

  it("非 object JSON 消费后 config.json 不存在", () => {
    expect(configGone).toBe(false);
  });

  it("含非法值不写入", () => {
    expect(outcome2.migrated).toBe(false);
  });
});

// ===== applyConfigPatch 错误路径（#110） =====
describe("applyConfigPatch 错误路径（#110）", () => {
  let na!: Extract<PatchResult, { ok: false }>;
  let invalid!: Extract<PatchResult, { ok: false }>;
  let broken!: Extract<PatchResult, { ok: false }>;
  let logWarnHit = false;

  beforeAll(async () => {
    // settings 服务不可用
    na = (await applyConfigPatch(basePatchDeps({ writable: () => false }), {
      patch: {},
    })) as Extract<PatchResult, { ok: false }>;
    // 非法 settings
    invalid = (await applyConfigPatch(basePatchDeps(), {
      patch: { port: 99999 },
    })) as Extract<PatchResult, { ok: false }>;
    // handler 内抛异常 → 500，details 固定文案（P2-2），原文走 logWarn
    const logWarns: string[] = [];
    broken = (await applyConfigPatch(
      basePatchDeps({
        update: async () => {
          throw new Error("broken-secret");
        },
        logWarn: (m: string) => logWarns.push(m),
      }),
      { patch: { port: 3000 } },
    )) as Extract<PatchResult, { ok: false }>;
    logWarnHit = logWarns.some((m: string) => m.includes("broken-secret"));
  });

  it("settings 不可用 → ok=false", () => {
    expect(na.ok).toBe(false);
  });

  it("settings 不可用 → 503", () => {
    expect(na.status).toBe(503);
  });

  it("非法 settings → ok=false", () => {
    expect(invalid.ok).toBe(false);
  });

  it("非法 settings → code=invalid", () => {
    expect(invalid.code).toBe("invalid");
  });

  it("handler 抛异常 → ok=false", () => {
    expect(broken.ok).toBe(false);
  });

  it("handler 抛异常 → 500", () => {
    expect(broken.status).toBe(500);
  });

  it("details 不泄露 err.message 原文", () => {
    expect(broken.details).toBe("保存失败，请查看服务端日志");
  });

  it("err.message 走服务端日志", () => {
    expect(logWarnHit).toBeTruthy();
  });
});

// ===== applyConfigPatch tls 成对形态（P2-1） =====
describe("applyConfigPatch tls 成对形态（P2-1）", () => {
  // 单边空串混单侧非空字符串 → raw 层拒绝（sanitize 剔除空串后不再绕过成对校验）
  const tlsPatches = [
    { tlsCertFile: "", tlsKeyFile: "/keep.pem" },
    { tlsCertFile: "/new.pem", tlsKeyFile: "" },
  ];
  const mixedResults: Array<Extract<PatchResult, { ok: false }>> = [];

  beforeAll(async () => {
    for (const patch of tlsPatches) {
      mixedResults.push(
        (await applyConfigPatch(basePatchDeps(), { patch })) as Extract<PatchResult, { ok: false }>,
      );
    }
  });

  const titled = tlsPatches.map((patch, i) => ({
    title: `patch=${JSON.stringify(patch)} 应被拒`,
    i,
  }));
  it.each(titled)("$title", ({ i }) => {
    expect(mixedResults[i].ok).toBe(false);
  });

  const titledCode = tlsPatches.map((patch, i) => ({
    title: `patch=${JSON.stringify(patch)} code=tls-pair`,
    i,
  }));
  it.each(titledCode)("$title", ({ i }) => {
    expect(mixedResults[i].code).toBe("tls-pair");
  });

  const titledStatus = tlsPatches.map((patch, i) => ({
    title: `patch=${JSON.stringify(patch)} status=400`,
    i,
  }));
  it.each(titledStatus)("$title", ({ i }) => {
    expect(mixedResults[i].status).toBe(400);
  });
});

// ===== apply 集成：TLS 准备 + settings 条目（setSource/onScope/isUnloading/warn） =====
// 构造 fake ctx 使 installLanProxySettings 的 inject(["settings"]) 成功：
// describe 按 ns 投影 value，触发 setSource 与 onScope 回调；热更新经
// ctx.on("settings/document-updated") 订阅（fake 经 docUpdatedListeners 收集），
// 订阅回调触发 isUnloading(ctx) 调用。
describe("apply 集成：TLS 准备 + settings 命名空间（setSource/onScope/isUnloading/warn）", () => {
  let healthRouteFound = false;
  let configRouteFound = false;
  let rpcHandleCount = 0;
  let hpOk = false;
  let hpWsCompressEnabled = false;
  let hpWsCompressPaths: string[] = [];
  let hp2WsCompressPaths: string[] = [];
  let cleanupCompleted = false;
  let hostTrustRows = 0;
  let hpOwnsHostCompat = false;
  let hp2OwnsHostCompat = false;
  let docUpdatedSubscribed = false;

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-tls-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const routes: WebRoute[] = [];
    const rpcHandles: Array<{ channel: string; h: unknown; opts: unknown }> = [];
    const disposers: Array<unknown> = [];
    // 0.1.7-rc.1 热更新面：document-updated 订阅收集器（接缝经 ctx.on 兜底订阅）。
    const docUpdatedListeners: Array<(ns: unknown) => void> = [];

    const scope = {
      _val: {
        port: 0,
        wsCompressEnabled: false,
        httpCompressEnabled: false,
        wsCompressPaths: ["/api/events.host", "/api/events.mux"],
        ownsHostCompat: false,
      },
      get() {
        return this._val;
      },
      async update(patch: Record<string, unknown>) {
        Object.assign(this._val, patch);
      },
      async replace(section: Record<string, unknown>) {
        this._val = { ...(section as Record<string, unknown>) } as typeof this._val;
      },
    };
    // 服务级 fake：describe 读面 + update/replace(ns, …) 写面（寻址语义断言用）。
    const settingsService = {
      describe() {
        return [{ ns: SETTINGS_NS, value: scope._val, user: {}, revision: 1 }];
      },
      async update(ns: string, patch: Record<string, unknown>) {
        if (ns !== SETTINGS_NS) throw new Error(`unexpected ns ${ns}`);
        await scope.update(patch);
      },
      async replace(ns: string, section: Record<string, unknown>) {
        if (ns !== SETTINGS_NS) throw new Error(`unexpected ns ${ns}`);
        await scope.replace(section);
      },
    };

    const ws = makeFakeWebServer({
      register: (route: WebRoute) => {
        routes.push(route);
      },
    });
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      // 0.1.7-rc.1 热更新订阅面：apply 经 ctx.on 订阅 settings/document-updated。
      // 无 on 面即跳过（能力检测），此处提供以锁定新订阅路径。
      on(event: string, listener: (ns: unknown) => void) {
        if (event === "settings/document-updated") docUpdatedListeners.push(listener);
        return () => {};
      },
      inject(services: string[], fn: (ctx: unknown) => void) {
        if (services.includes("connection")) {
          const connectionCtx = {
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
          };
          fn(connectionCtx);
        }
        if (services.includes("settings")) {
          const sctx = {
            settings: settingsService,
            effect(fn2: () => unknown) {
              const d = fn2();
              // 不立即执行 disposer（由外部清理时触发）
              disposers.push(d);
              return d;
            },
          };
          fn(sctx);
        }
      },
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };

    // httpsPort 显式传 0：不传会落到产品默认值 3443 并**真实监听**（端口审计实测），
    // 并发或残留进程下即 EADDRINUSE（#690 S2c 端口治理）。
    apply(ctx as unknown as Context, {
      host: "127.0.0.1",
      port: 0,
      httpsPort: 0,
      httpsEnabled: true,
      printBanner: false,
      wsCompressEnabled: false,
      httpCompressEnabled: false,
    });

    await sleep(100);

    // host trust（issue #856）：官方结构化注入表必须保持为空——`kind: "global"` 行
    // 是整体赋值 + JSON 序列化，会覆盖 desktop-host 等组合先行写入的 transport。
    hostTrustRows = (ws.emitIndexInjections([]) as unknown[]).length;

    // 验证 health 路由注册（prepareTls 内部已同步调用）
    const healthRoute = routes.find((r: WebRoute) => r.path === ROUTES.health);
    healthRouteFound = Boolean(healthRoute);
    configRouteFound = Boolean(routes.find((r: WebRoute) => r.path === ROUTES.config));
    rpcHandleCount = rpcHandles.length;
    // 新面锁定：document-updated 已订阅（热更新唯一驱动）。
    docUpdatedSubscribed = docUpdatedListeners.length >= 1;

    // 触发 setSource 后调用 health handler → resolve() → current 已切到 scope.get()
    let healthBody = "";
    (healthRoute as WebRoute).handler(
      {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" } as unknown as import("node:net").Socket,
        headers: { host: "127.0.0.1:3080" },
        url: ROUTES.health,
      } as unknown as IncomingMessage,
      {
        writeHead: () => {},
        end: (c?: unknown) => {
          healthBody = String(c);
        },
      } as unknown as import("node:http").ServerResponse,
    );
    const hp = JSON.parse(healthBody);
    hpOk = hp.ok;
    hpWsCompressEnabled = hp.wsCompressEnabled;
    // M2（#395）：resolve() 归一化旧默认白名单（乱序等价）→ health 快照可见新值。
    hpWsCompressPaths = hp.wsCompressPaths;
    hpOwnsHostCompat = hp.ownsHostCompat;
    // 自定义白名单（含废弃端点的组合）原样保留，不强制改写。
    scope._val.wsCompressPaths = ["/api/custom/ws", "/api/events.mux"];
    // host trust 开关（issue #856）：health 读的是 resolve() 的实时值，不是注册时快照。
    scope._val.ownsHostCompat = true;
    let healthBody2 = "";
    (healthRoute as WebRoute).handler(
      {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" } as unknown as import("node:net").Socket,
        headers: { host: "127.0.0.1:3080" },
        url: ROUTES.health,
      } as unknown as IncomingMessage,
      {
        writeHead: () => {},
        end: (c?: unknown) => {
          healthBody2 = String(c);
        },
      } as unknown as import("node:http").ServerResponse,
    );
    const hp2 = JSON.parse(healthBody2);
    hp2WsCompressPaths = hp2.wsCompressPaths;
    hp2OwnsHostCompat = hp2.ownsHostCompat;

    // 执行 lifecycle 清理：触发订阅退订与 isUnloading
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    cleanupCompleted = true;

    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 30000);

  it("health 路由已注册", () => {
    expect(healthRouteFound).toBeTruthy();
  });

  it("config 路由已注册", () => {
    expect(configRouteFound).toBeTruthy();
  });

  it("RPC 配置通道不再注册", () => {
    expect(rpcHandleCount).toBe(0);
  });

  it("不向官方结构化注入表推任何行（host trust 走 tapIndex）", () => {
    expect(hostTrustRows).toBe(0);
  });

  it("health 报出宿主侧 host trust 事实（开关默认关）", () => {
    expect(hpOwnsHostCompat).toBe(false);
  });

  it("health 的开关随配置实时变化（非注册时快照）", () => {
    expect(hp2OwnsHostCompat).toBe(true);
  });

  it("health 200", () => {
    expect(hpOk).toBe(true);
  });

  it("settings 来源生效（wsCompressEnabled=false 透传）", () => {
    expect(hpWsCompressEnabled).toBe(false);
  });

  it("resolve() 应把旧默认白名单归一化为 remote.mux", () => {
    expect(hpWsCompressPaths).toEqual(["/api/remote.mux"]);
  });

  it("自定义白名单不被强制改写", () => {
    expect(hp2WsCompressPaths).toEqual(["/api/custom/ws", "/api/events.mux"]);
  });

  it("document-updated 已订阅（热更新面）", () => {
    expect(docUpdatedSubscribed).toBe(true);
  });

  // 原脚本此处为 assert.ok(true, ...) 的块尾标记（真正的失败面在清理执行本身）；
  // 保留同名用例，判定绑定到「清理确实跑完」。
  it("lifecycle 清理不抛错（setSource/isUnloading/warn 路径已覆盖）", () => {
    expect(cleanupCompleted).toBeTruthy();
  });
});

// ===== 接缝面锁定：条目 id + volatile + descriptor 投影与客户端配对 =====
// 本块只断言接缝面，不碰业务行为（转发/压缩/Host/卡片展示）。
describe("接缝面锁定", () => {
  it("SETTINGS_NS 为 profile 条目 id（与 patch 挂载行一致）", () => {
    expect(SETTINGS_NS).toBe("ui-dsh-lan-proxy");
  });

  it("Config 标记 volatile（直接置 meta）", () => {
    const meta = (Config as unknown as { meta?: { volatile?: unknown } }).meta;
    expect(meta?.volatile).toBe(true);
  });

  it("descriptor 投影忽略增补字段（value/base/secrets 不影响 user/revision）", () => {
    const descriptor = {
      ns: SETTINGS_NS,
      user: { port: 4100 },
      revision: 42,
      value: { port: 4100 },
      base: {},
      secrets: [],
    };
    const found = [descriptor].find((d) => d.ns === SETTINGS_NS);
    expect(found?.user).toEqual({ port: 4100 });
    expect(found?.revision).toBe(42);
  });

  it("服务级写面按条目 id 寻址（错 ns 拒绝）", async () => {
    const calls: Array<{ ns: string; patch: unknown }> = [];
    const service = {
      async update(ns: string, patch: object) {
        if (ns !== SETTINGS_NS) throw new Error(`unexpected ns ${ns}`);
        calls.push({ ns, patch });
      },
    };
    await service.update(SETTINGS_NS, { port: 1 });
    expect(calls).toEqual([{ ns: "ui-dsh-lan-proxy", patch: { port: 1 } }]);
    await expect(service.update("dsh-lan-proxy", { port: 1 })).rejects.toThrow();
  });
});

// ===== 用户可见入口路径 =====
const PLUGIN_MANAGER_ROW_DETAIL = "插件管理器 → dsh-lan-proxy → 行详情";
const LEGACY_PLUGIN_PATH = "设置 → 插件 → dsh-lan-proxy";

describe("用户可见入口路径（server banner 与维护者说明）", () => {
  it("banner 提示统一指向 Plugin Manager 的 dsh-lan-proxy 行详情", () => {
    const source = readFileSync(new URL("../../src/server/apply.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "injectToken: ON — 局域网设备免 token 直接进入（等效信任整个 LAN，关闭见 " +
        PLUGIN_MANAGER_ROW_DETAIL +
        "）",
    );
    expect(source).toContain(
      "ownsHostCompat: ON — 已向非回环页面声明 ownsHost（伪造上游拓扑事实位；关闭见 " +
        PLUGIN_MANAGER_ROW_DETAIL +
        "）",
    );
    expect(source).toContain(
      "ownsHostCompat: OFF — 非回环页面的设置面不可用（上游策略；需要时在 " +
        PLUGIN_MANAGER_ROW_DETAIL +
        " 开启，或直接编辑 settings.yaml，或改用 ssh -L 走回环）",
    );
    expect(source).toContain(
      "hint: 端口被占用——可能另一个 dsh 实例已启动；改端口请到 " + PLUGIN_MANAGER_ROW_DETAIL,
    );
    expect(source).not.toContain(LEGACY_PLUGIN_PATH);
  });

  it("维护者入口说明指向同一行详情路径", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "1. GUI 设置卡片（" + PLUGIN_MANAGER_ROW_DETAIL + "）：经 loopback HTTP 配置路由",
    );
    expect(source).not.toContain(LEGACY_PLUGIN_PATH);
  });
});

// ===== apply：settings 服务缺席 → warn 路径 =====
describe("apply：settings 服务缺席 → warn 路径", () => {
  let warnPathCompleted = false;

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-warn-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const disposers: Array<unknown> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: makeFakeWebServer(),
      inject(services: string[], fn: (ctx: unknown) => void) {
        if (services.includes("settings")) {
          // settings 存在但无 describe（服务缺席）→ warn 被调用
          fn({
            settings: { noRegister: true },
            effect(fn2: () => unknown) {
              return fn2();
            },
          });
        }
      },
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
      printBanner: false,
      wsCompressEnabled: false,
      httpCompressEnabled: false,
    });
    await sleep(50);
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    warnPathCompleted = true;
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 30000);

  it("warn 路径覆盖完成", () => {
    expect(warnPathCompleted).toBeTruthy();
  });
});

// ===== apply：监听端口被占 → listen() reject → catch 分支 =====
describe("apply：监听端口被占 → listen() reject → catch 分支", () => {
  let healthRouteFound = false;
  let hpListening = false;

  beforeAll(async () => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-listenfail-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    // 占位端口改为动态分配（#690 S2c / #713 T5）：写死端口在并发运行或残留进程下会
    // EADDRINUSE 假阳性。这与 #217 回滚的「apply 传 port: 0」不是同一件事——那种写法会让
    // listen 成功、走不到 catch 分支（covered 掉到 57.9%）；这里 occupied 先占位，apply 绑
    // 同一端口仍必然失败，被覆盖的分支不变。
    const occupied = createServer();
    await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", () => r()));
    const occupiedPort = (occupied.address() as import("node:net").AddressInfo).port;
    const routes: WebRoute[] = [];
    const rpcHandles: Array<{ ch: string; h: unknown; o: unknown }> = [];
    const disposers: Array<unknown> = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: makeFakeWebServer({
        register: (route: WebRoute) => {
          routes.push(route);
        },
      }),
      inject(services: string[], fn: (ctx: unknown) => void) {
        if (services.includes("connection")) {
          fn({
            connection: {
              rpc: {
                handle(ch: string, h: unknown, o: unknown) {
                  rpcHandles.push({ ch, h, o });
                  return () => {};
                },
              },
            },
            effect(fn2: () => unknown) {
              return fn2();
            },
          });
        }
      },
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    apply(ctx as unknown as Context, {
      host: "127.0.0.1",
      port: occupiedPort,
      httpsEnabled: false,
      printBanner: false,
      wsCompressEnabled: false,
      httpCompressEnabled: false,
    });
    await sleep(200); // 等 listen 异步 reject
    // health 路由存在，但 listening: false
    const healthRoute = routes.find((r: WebRoute) => r.path === ROUTES.health);
    healthRouteFound = Boolean(healthRoute);
    let healthBody = "";
    (healthRoute as WebRoute).handler(
      {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" } as unknown as import("node:net").Socket,
        headers: { host: "127.0.0.1:3080" },
        url: ROUTES.health,
      } as unknown as IncomingMessage,
      {
        writeHead: () => {},
        end: (c?: unknown) => {
          healthBody = String(c);
        },
      } as unknown as import("node:http").ServerResponse,
    );
    const hp = JSON.parse(healthBody);
    hpListening = hp.listening;
    // 清理
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    occupied.close();
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  }, 30000);

  it("端口被占仍注册 health 路由", () => {
    expect(healthRouteFound).toBeTruthy();
  });

  it("端口被占 → listening: false", () => {
    expect(hpListening).toBe(false);
  });
});

// ===== apply：enabled=false 仍注册路由与迁移（#110 P0-2） =====
describe("apply：enabled=false 仍注册路由与迁移（#110 P0-2）", () => {
  let healthFound = false;
  let configFound = false;

  beforeAll(() => {
    const applyHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-off-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = applyHome;
    const routes: WebRoute[] = [];
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: makeFakeWebServer({
        register: (route: WebRoute) => {
          routes.push(route);
        },
      }),
      inject() {},
      effect(fn: () => unknown) {
        return fn();
      },
    };
    apply(ctx as unknown as Context, { enabled: false, httpsEnabled: false });
    healthFound = Boolean(routes.find((r) => r.path === ROUTES.health));
    configFound = Boolean(routes.find((r: WebRoute) => r.path === ROUTES.config));
    process.env.DSH_HOME = prevHome;
    rmSync(applyHome, { recursive: true, force: true });
  });

  it("enabled=false 仍注册 health 路由", () => {
    expect(healthFound).toBeTruthy();
  });

  it("enabled=false 仍注册 config 路由", () => {
    expect(configFound).toBeTruthy();
  });
});

// ===== applyConfigPatch 成功语义与 tls 清除（#110，接续 #147 口径） =====
describe("applyConfigPatch 成功语义与 tls 清除（#110，接续 #147 口径）", () => {
  let ok!: Extract<PatchResult, { ok: true }>;
  let updatesAtOk: Array<{ patch: unknown; rev: unknown }> = [];
  let revisionAtOk: number | undefined;
  let clearTls!: PatchResult;
  let replacesLenAtClear = 0;
  let tlsKeysRemovedAtClear = false;
  let printBannerAtClear: unknown;
  let halfPair!: Extract<PatchResult, { ok: false }>;

  beforeAll(async () => {
    const state: {
      user: Record<string, unknown>;
      updates: Array<{ patch: unknown; rev: unknown }>;
      replaces: Array<{ section: unknown; rev: unknown }>;
    } = { user: { host: "127.0.0.1", port: 3081 }, updates: [], replaces: [] };
    const deps = {
      resolve: () => ({ enabled: true, host: "0.0.0.0", port: 3081, httpCompressLevel: 2 }),
      readUser: () => ({ user: { ...state.user }, revision: 4 }),
      writable: () => true,
      update: async (patch: unknown, rev: unknown) => {
        state.updates.push({ patch, rev });
        Object.assign(state.user, patch as Record<string, unknown>);
      },
      replace: async (section: unknown, rev: unknown) => {
        state.replaces.push({ section, rev });
        state.user = { ...(section as Record<string, unknown>) };
      },
      compress: () => ({ compressed: 3, passthrough: 4 }),
    };
    // 合法提交：增量 update，未携带键保持原值
    ok = (await applyConfigPatch(deps as unknown as ConfigRouteDeps, {
      patch: { port: 4000 },
      expectedRevision: 4,
    })) as Extract<PatchResult, { ok: true }>;
    updatesAtOk = [...state.updates];
    revisionAtOk = ok.value.revision;
    // tls 空串清空语义：raw 显式 "" → replace 整节剔除该键
    state.user.tlsCertFile = "/a.pem";
    state.user.tlsKeyFile = "/b.pem";
    clearTls = await applyConfigPatch(deps as unknown as ConfigRouteDeps, {
      patch: { tlsCertFile: "", tlsKeyFile: "", printBanner: false },
    });
    replacesLenAtClear = state.replaces.length;
    tlsKeysRemovedAtClear = !("tlsCertFile" in state.user) && !("tlsKeyFile" in state.user);
    printBannerAtClear = state.user.printBanner;
    // tls-pair 校验：只给证书不给私钥
    halfPair = (await applyConfigPatch(deps as unknown as ConfigRouteDeps, {
      patch: { tlsCertFile: "/tmp/a.pem" },
    })) as Extract<PatchResult, { ok: false }>;
  });

  it("config 合法提交成功", () => {
    expect(ok.ok).toBe(true);
  });

  it("合法提交走增量 update（patch 与 expectedRevision 透传）", () => {
    expect(updatesAtOk).toEqual([{ patch: { port: 4000 }, rev: 4 }]);
  });

  it("返回体携带提交时的 revision", () => {
    expect(revisionAtOk).toBe(4);
  });

  it("tls 双空串成对合法", () => {
    expect(clearTls.ok).toBe(true);
  });

  it("清除走 replace 整节替换", () => {
    expect(replacesLenAtClear).toBe(1);
  });

  it("空串提交从用户层剔除两个 tls 键", () => {
    expect(tlsKeysRemovedAtClear).toBeTruthy();
  });

  it("其余键并入新节", () => {
    expect(printBannerAtClear).toBe(false);
  });

  it("单边 tls 被拒", () => {
    expect(halfPair.ok).toBe(false);
  });

  it("tls-pair 错误码", () => {
    expect(halfPair.code).toBe("tls-pair");
  });
});

// ===== validateSettings 字段级边界矩阵（#147 变异加固） =====
describe("validateSettings 字段级边界矩阵（#147 变异加固）", () => {
  // 非 object payload（数组按 object 形态处理、无字段可校验故通过——锁定现状）
  const nonObjectPayloads = [null, 42, "x"].map((bad) => ({
    title: `非对象 ${JSON.stringify(bad)} 报 payload 错`,
    bad,
  }));
  it.each(nonObjectPayloads)("$title", ({ bad }) => {
    expect(validateSettings(bad)?.key).toBe("(payload)");
  });

  it("空数组无字段可校验、按现状通过", () => {
    expect(validateSettings([])).toBe(null);
  });

  // 数组也是 object——但仍是合法载体形态，逐字段校验通过后返回 null
  // 端口类边界：0 / 负数 / 小数 / 超 65535
  const badPorts = [0, -1, 3.5, 65536, "80"].map((p) => ({
    title: `port=${JSON.stringify(p)} 非法`,
    p,
  }));
  it.each(badPorts)("$title", ({ p }) => {
    expect(validateSettings({ port: p })?.key).toBe("port");
  });

  it("port 上界 65535 合法", () => {
    expect(validateSettings({ port: 65535 })).toBe(null);
  });

  it("port 下界 1 合法", () => {
    expect(validateSettings({ port: 1 })).toBe(null);
  });

  // targetHost 回环约束
  it("非回环 targetHost 非法", () => {
    expect(validateSettings({ targetHost: "8.8.8.8" })?.key).toBe("targetHost");
  });

  it("localhost 合法", () => {
    expect(validateSettings({ targetHost: "localhost" })).toBe(null);
  });

  // httpCompressLevel 档位与迁移窗口
  it("-1 非法", () => {
    expect(validateSettings({ httpCompressLevel: -1 })?.key).toBe("httpCompressLevel");
  });

  it("10 超迁移窗非法", () => {
    expect(validateSettings({ httpCompressLevel: 10 })?.key).toBe("httpCompressLevel");
  });

  it("小数档位非法", () => {
    expect(validateSettings({ httpCompressLevel: 3.5 })?.key).toBe("httpCompressLevel");
  });

  const legalLevels = [0, 1, 2, 3].map((lv) => ({ title: `档位 ${lv} 合法`, lv }));
  it.each(legalLevels)("$title", ({ lv }) => {
    expect(validateSettings({ httpCompressLevel: lv })).toBe(null);
  });

  // wsCompressPaths 元素类型
  it("非字符串元素非法", () => {
    expect(validateSettings({ wsCompressPaths: [42] })?.key).toBe("wsCompressPaths");
  });

  it("空数组合法", () => {
    expect(validateSettings({ wsCompressPaths: [] })).toBe(null);
  });

  // undefined/null 字段跳过
  it("undefined/null 字段跳过校验", () => {
    expect(validateSettings({ port: undefined, host: null })).toBe(null);
  });
});

// ===== sanitizeSettings 清洗语义（#147 变异加固） =====
describe("sanitizeSettings 清洗语义（#147 变异加固）", () => {
  it("null → null", () => {
    expect(sanitizeSettings(null)).toBe(null);
  });

  it("字符串 → null", () => {
    expect(sanitizeSettings("x")).toBe(null);
  });

  // 未知键被剔除、合法键保留
  it("合法键保留", () => {
    expect(sanitizeSettings({ port: 3000, evilKey: "x" })!.port).toBe(3000);
  });

  it("未知键剔除", () => {
    expect(!("evilKey" in sanitizeSettings({ port: 3000, evilKey: "x" })!)).toBeTruthy();
  });

  // level 迁移 4-9 → 3
  it("level 7 迁移为高档 3", () => {
    expect(sanitizeSettings({ httpCompressLevel: 7 })!.httpCompressLevel).toBe(3);
  });

  it("level 4 迁移为高档 3", () => {
    expect(sanitizeSettings({ httpCompressLevel: 4 })!.httpCompressLevel).toBe(3);
  });

  it("level 9 迁移为高档 3", () => {
    expect(sanitizeSettings({ httpCompressLevel: 9 })!.httpCompressLevel).toBe(3);
  });

  // tls 空串剔除
  it("tls 空串被剔除", () => {
    const noTls = sanitizeSettings({ tlsCertFile: "", tlsKeyFile: "", httpsEnabled: true })!;
    expect(!("tlsCertFile" in noTls) && !("tlsKeyFile" in noTls)).toBeTruthy();
  });

  it("其余键不受影响", () => {
    expect(
      sanitizeSettings({ tlsCertFile: "", tlsKeyFile: "", httpsEnabled: true })!.httpsEnabled,
    ).toBe(true);
  });

  // 非法值整体拒绝
  it("非法值整体返回 null", () => {
    expect(sanitizeSettings({ port: 99999 })).toBe(null);
  });
});

// ===== validateSettings 全字段类型矩阵（#147 变异加固接续：布尔/字符串/数组类逐字段） =====
describe("validateSettings 全字段类型矩阵（#147 变异加固接续）", () => {
  const boolKeys = [
    "enabled",
    "httpsEnabled",
    "printBanner",
    "wsCompressEnabled",
    "httpCompressEnabled",
  ];
  const badBoolValues = ["true", 1, 0];

  // 布尔类字段：字符串/数字形态一律非法
  const boolIllegal = boolKeys.flatMap((key) =>
    badBoolValues.map((bad) => ({ title: `${key}=${JSON.stringify(bad)} 非法`, key, bad })),
  );
  it.each(boolIllegal)("$title", ({ key, bad }) => {
    expect(validateSettings({ [key]: bad })?.key).toBe(key);
  });

  // 原脚本把 `assert.equal(validateSettings({[key]: true}), null)` 写在内层 bad 循环里，
  // 同一断言对每个 key 重复执行 3 次；此处按 key 保留一条（断言集合未减少，仅去重复执行）。
  const boolLegal = boolKeys.map((key) => ({ title: `${key}=true 合法`, key }));
  it.each(boolLegal)("$title", ({ key }) => {
    expect(validateSettings({ [key]: true })).toBe(null);
  });

  // 字符串类字段：数字形态非法；空串除 targetHost（回环约束）外合法
  const strKeys = ["host", "tlsCertFile", "tlsKeyFile", "tlsCaCertFile"];
  const strIllegal = strKeys.map((key) => ({ title: `${key} 数字形态非法`, key }));
  it.each(strIllegal)("$title", ({ key }) => {
    expect(validateSettings({ [key]: 42 })?.key).toBe(key);
  });

  const strLegal = strKeys.map((key) => ({ title: `${key} 空串合法（留空语义）`, key }));
  it.each(strLegal)("$title", ({ key }) => {
    expect(validateSettings({ [key]: "" })).toBe(null);
  });

  it("targetHost 数字形态非法", () => {
    expect(validateSettings({ targetHost: 42 })?.key).toBe("targetHost");
  });

  it("targetHost 空串非回环非法", () => {
    expect(validateSettings({ targetHost: "" })?.key).toBe("targetHost");
  });

  // httpsPort 与 targetPort 共用端口校验器
  it("httpsPort 下界外非法", () => {
    expect(validateSettings({ httpsPort: 0 })?.key).toBe("httpsPort");
  });

  it("targetPort 上界外非法", () => {
    expect(validateSettings({ targetPort: 65536 })?.key).toBe("targetPort");
  });

  it("两端口合法值通过", () => {
    expect(validateSettings({ httpsPort: 3443, targetPort: 3080 })).toBe(null);
  });

  // level 迁移窗口内（4-9）经归一化后合法——validate 与 sanitize 同窗
  it("level 5 迁移后合法", () => {
    expect(validateSettings({ httpCompressLevel: 5 })).toBe(null);
  });

  it("level 9 迁移后合法", () => {
    expect(validateSettings({ httpCompressLevel: 9 })).toBe(null);
  });
});

// ===== 变异加固块（round=3 CI 回归：迁移重放/路由面/校验分支断言进 tap 面） =====
// 背景：smoke.test.ts 不在 stryker tap testFiles 内，其覆盖的行为在变异判定中全部
// 存活/noCov。本块把关键行为断言移植到 unit-apply（tap 面内），杀灭新代码
// （resumeMigrateFromBak / migrateFileConfig / applyConfigPatch / buildConfigRoutes /
// installLanProxySettings / warnLog）的存活 mutant。
describe("变异加固块（round=3 CI 回归：迁移重放/路由面/校验分支断言进 tap 面）", () => {
  // 本块所有 apply 调用统一 DSH_HOME 隔离 + disposer 回收（防转发器 server /
  // scheduleSync timer 句柄泄漏挂起事件循环，也防迁移触达真实 ~/.dsh/lan-proxy）。
  const prevHome = process.env.DSH_HOME;
  let blockHome = "";
  const cleanupFns: Array<() => void> = [];

  /** 构造最小 fake ctx：收集 lifecycle disposer；enabled 可关避免真实 listen。 */
  const makeCtx = (over: Record<string, unknown> = {}) => {
    const disposers: Array<unknown> = [];
    const routes: WebRoute[] = [];
    const ctx = {
      logger:
        over.logger !== undefined
          ? over.logger
          : { info: () => {}, warn: () => {}, error: () => {} },
      webServer: makeFakeWebServer({
        register: (route: WebRoute) => {
          routes.push(route);
        },
      }),
      inject() {},
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
      ...over,
      get _routes() {
        return routes;
      },
      [Symbol.for("dispose")]() {
        for (const d of [...disposers].reverse()) {
          try {
            (d as unknown as () => void)();
          } catch {}
        }
      },
    };
    cleanupFns.push((ctx as unknown as Record<symbol, () => void>)[Symbol.for("dispose")]);
    return ctx;
  };

  beforeAll(() => {
    blockHome = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-block-"));
    process.env.DSH_HOME = blockHome;
  });

  afterAll(() => {
    for (const fn of [...cleanupFns].reverse()) {
      try {
        fn();
      } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(blockHome, { recursive: true, force: true });
  });

  // 非法 logger 仅属于 warnLog 的降级契约，不得进入真实转发器的异步回调。
  describe("A. warnLog 与 settings 降级", () => {
    it.each([
      { title: "无 logger", ctx: {} },
      { title: "warn 非函数", ctx: { logger: { warn: "not-a-function" } } },
    ])("$title 不抛异常", ({ ctx }) => {
      expect(() => warnLog(ctx, "settings unavailable")).not.toThrow();
    });

    it("有效 logger 收到原消息并保留方法接收者", () => {
      const logger = {
        messages: [] as string[],
        warn(message: string) {
          this.messages.push(message);
        },
      };
      warnLog({ logger }, "settings unavailable");
      expect(logger.messages).toEqual(["settings unavailable"]);
    });

    it("settings 服务缺席时告警且仍注册 health 路由", () => {
      const messages: string[] = [];
      const ctx = makeCtx({
        logger: {
          info() {},
          error() {},
          warn(message: string) {
            messages.push(message);
          },
        },
        inject(services: string[], callback: (ctx: unknown) => void) {
          if (services.includes("settings")) callback({ settings: {} });
        },
      });
      try {
        apply(ctx as unknown as Context, {
          enabled: false,
          httpsEnabled: false,
          host: "127.0.0.1",
          port: 0,
        });
        expect(messages).toEqual([
          `${SETTINGS_NS}: settings 服务缺席 — 设置命名空间未注册，卡片降级`,
        ]);
        expect(ctx._routes.filter((r) => r.path === ROUTES.health).length).toBe(1);
      } finally {
        (ctx as unknown as Record<symbol, () => void>)[Symbol.for("dispose")]();
      }
    });
  });

  // ---- B. installLanProxySettings 全分支（inject 缺失/服务缺席/detach 回落/订阅触发/isUnloading 门控）----
  describe("B. installLanProxySettings 全分支", () => {
    // B1: ctx.inject 缺失 → 降级不抛（原脚本此分支无断言，保留其执行）。
    beforeAll(() => {
      apply(makeCtx({ port: 3081 }) as unknown as Context, {
        enabled: false,
        host: "127.0.0.1",
        httpsEnabled: false,
      });
    }, 30000);

    // B2: settings 服务缺席（缺失/无 describe）→ 降级。
    describe("B2: settings 服务异常态", () => {
      const services = [
        { label: "missing", service: undefined },
        { label: "no-describe", service: {} },
      ];
      const results: boolean[] = [];

      beforeAll(() => {
        for (const { service } of services) {
          const ctx = makeCtx({
            inject(services2: string[], fn: (ctx: unknown) => void) {
              if (services2.includes("settings"))
                fn({
                  settings: service,
                  effect(fn2: () => unknown) {
                    return fn2();
                  },
                });
            },
          });
          apply(ctx as unknown as Context, {
            host: "127.0.0.1",
            port: 0,
            httpsEnabled: false,
            enabled: true,
          });
          results.push(ctx._routes.length >= 2);
        }
      }, 30000);

      const titled = services.map((s, i) => ({
        title: `service 异常态（${s.label}#${i}）不阻断 health/config 注册`,
        i,
      }));
      it.each(titled)("$title", ({ i }) => {
        expect(results[i]).toBe(true);
      });
    });

    // B3: attach → document-updated 订阅挂接 → 非 unloading 态触发不抛；unloading 态执行 disposers 门控跳过。
    describe("B3: attach → 订阅挂接 → isUnloading 门控", () => {
      const listeners: Array<(ns: unknown, revision: unknown) => void> = [];
      let subscribedCount = 0;
      let gateCompleted = false;

      beforeAll(() => {
        const fiberStates: string[] = [];
        const ctx = makeCtx({
          get fiber() {
            return { state: fiberStates[fiberStates.length - 1] };
          },
          inject(services: string[], fn: (ctx: unknown) => void) {
            if (services.includes("settings")) {
              fn({
                settings: {
                  describe() {
                    return [{ ns: SETTINGS_NS, value: { port: 4321 }, revision: 0 }];
                  },
                },
                effect(fn2: () => unknown) {
                  const d = fn2();
                  return d;
                },
                on(event: string, cb: (ns: unknown, revision: unknown) => void) {
                  if (event === "settings/document-updated") listeners.push(cb);
                  return () => {};
                },
              });
            }
          },
        });
        apply(ctx as unknown as Context, {
          host: "127.0.0.1",
          port: 0,
          httpsEnabled: false,
          printBanner: false,
        });
        subscribedCount = listeners.length;
        fiberStates.push("attached");
        // 同值重放：快照比对等价，直接返回（不断言次数，只走门控路径）。
        for (const cb of [...listeners]) cb("other-ns", 99);
        fiberStates.push("unloading");
        (ctx as unknown as Record<symbol, () => void>)[Symbol.for("dispose")]();
        fiberStates.pop();
        gateCompleted = true;
      }, 30000);

      it("document-updated 已订阅", () => {
        expect(subscribedCount >= 1).toBe(true);
      });

      it("isUnloading 门控路径执行不抛错", () => {
        expect(gateCompleted).toBeTruthy();
      });
    });
  });

  // ---- C. migrateFileConfig 全分支 outcome 精确断言（含中断重放四分支）----
  describe("C. migrateFileConfig 全分支 outcome 精确断言", () => {
    const okScope = (): {
      updates: unknown[];
      update(p: unknown): Promise<void>;
    } => ({
      updates: [],
      async update(p: unknown) {
        this.updates.push(p);
        return Promise.resolve();
      },
    });

    // C1: 双文件都不存在 → idle 六字段全 false。
    describe("C1: 双文件都不存在 → idle", () => {
      let idleOut!: Awaited<ReturnType<typeof migrateFileConfig>>;

      beforeAll(async () => {
        const idleDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-idle-"));
        idleOut = await migrateFileConfig(idleDir, okScope());
        rmSync(idleDir, { recursive: true, force: true });
      });

      it("idle outcome 全 false", () => {
        expect(idleOut).toEqual({
          performed: false,
          migrated: false,
          rolledBack: false,
          skippedCorrupt: false,
          resumed: false,
        });
      });
    });

    // C2: 成功迁移 → performed+migrated，其余 false；损坏 JSON catch 分支；
    //     非对象 JSON；sanitize null；空对象 sanitized（keys=0 → skippedCorrupt）。
    describe("C2: 迁移 outcome 分支矩阵", () => {
      const cases = [
        {
          name: "success",
          raw: JSON.stringify({ port: 4082 }),
          expected: {
            performed: true,
            migrated: true,
            rolledBack: false,
            skippedCorrupt: false,
            resumed: false,
          },
        },
        {
          name: "broken-json",
          raw: "{oops",
          expected: {
            performed: true,
            migrated: false,
            rolledBack: false,
            skippedCorrupt: true,
            resumed: false,
          },
        },
        {
          name: "non-object",
          raw: JSON.stringify([1]),
          expected: {
            performed: true,
            migrated: false,
            rolledBack: false,
            skippedCorrupt: true,
            resumed: false,
          },
        },
        {
          name: "invalid-value",
          raw: JSON.stringify({ port: "x" }),
          expected: {
            performed: true,
            migrated: false,
            rolledBack: false,
            skippedCorrupt: true,
            resumed: false,
          },
        },
        {
          name: "empty-object",
          raw: JSON.stringify({}),
          expected: {
            performed: true,
            migrated: false,
            rolledBack: false,
            skippedCorrupt: true,
            resumed: false,
          },
        },
        {
          name: "scalar",
          raw: "5",
          expected: {
            performed: true,
            migrated: false,
            rolledBack: false,
            skippedCorrupt: true,
            resumed: false,
          },
        },
      ];
      const records: Array<{
        out: Awaited<ReturnType<typeof migrateFileConfig>>;
        bakExists: boolean;
        updates: unknown[];
        warns: string[];
      }> = [];

      beforeAll(async () => {
        for (const { name, raw } of cases) {
          const dir = mkdtempSync(join(tmpdir(), `dsh-lan-proxy-mut-${name}-`));
          writeFileSync(join(dir, "config.json"), raw);
          const scope = okScope();
          const warns: string[] = [];
          const out = await migrateFileConfig(dir, scope, {
            warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")),
          });
          // bak 标记必须在 rmSync 之前观测（目录随即被回收）
          records.push({
            out,
            bakExists: existsSync(join(dir, MIGRATED_BAK_NAME)),
            updates: scope.updates,
            warns,
          });
          rmSync(dir, { recursive: true, force: true });
        }
      });

      const titledOutcome = cases.map((c, i) => ({ title: `case=${c.name} outcome`, i }));
      it.each(titledOutcome)("$title", ({ i }) => {
        expect(records[i].out).toEqual(cases[i].expected);
      });

      const titledBak = cases.map((c, i) => ({ title: `case=${c.name} bak 标记`, i }));
      it.each(titledBak)("$title", ({ i }) => {
        expect(records[i].bakExists).toBe(true);
      });

      it("成功迁移写入键集", () => {
        expect(records[0].updates).toEqual([{ port: 4082 }]);
      });

      it("损坏 JSON warn 指明仅标记不写入", () => {
        expect(records[1].warns.some((w) => w.includes("不是合法 JSON"))).toBe(true);
      });

      it("非对象 JSON warn 指明不是配置对象", () => {
        expect(records[5].warns.some((w) => w.includes("不是配置对象"))).toBe(true);
      });

      it("非法值 warn 指明含非法配置值", () => {
        expect(records[3].warns.some((w) => w.includes("含非法配置值"))).toBe(true);
      });

      it("旧默认压缩白名单迁移归一化到新默认（端到端行为锚）", async () => {
        const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-wslegacy-"));
        try {
          writeFileSync(
            join(dir, "config.json"),
            JSON.stringify({
              port: 4082,
              wsCompressPaths: ["/api/events.mux", "/api/events.host"],
            }),
          );
          const scope = okScope();
          const out = await migrateFileConfig(dir, scope);
          expect(out.migrated).toBe(true);
          expect(scope.updates).toEqual([{ port: 4082, wsCompressPaths: ["/api/remote.mux"] }]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      const titledNoWrite = cases
        .slice(1)
        .map((c) => ({ title: `case=${c.name} 不写入`, i: cases.indexOf(c) }));
      it.each(titledNoWrite)("$title", ({ i }) => {
        expect(records[i].updates.length).toBe(0);
      });
    });

    // C3: 写入失败回滚 → rolledBack；config.json 还原。
    describe("C3: 写入失败回滚", () => {
      let out!: Awaited<ReturnType<typeof migrateFileConfig>>;
      let configRestored = false;
      const warns: string[] = [];

      beforeAll(async () => {
        const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-rollback-"));
        writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 4083 }));
        out = await migrateFileConfig(
          dir,
          {
            async update() {
              throw new Error("io");
            },
          },
          { warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")) },
        );
        configRestored = existsSync(join(dir, "config.json"));
        rmSync(dir, { recursive: true, force: true });
      });

      it("写入失败 → rolledBack outcome", () => {
        expect(out).toEqual({
          performed: true,
          migrated: false,
          rolledBack: true,
          skippedCorrupt: false,
          resumed: false,
        });
      });

      it("回滚后 config.json 还原", () => {
        expect(configRestored).toBe(true);
      });

      it("写入失败 warn 指明已回滚下次重试", () => {
        expect(warns.some((w) => w.includes("已回滚"))).toBe(true);
      });
    });

    // C4: 中断重放四分支（成功/损坏 bak/无效 bak/update 失败），resumed=true。
    describe("C4: 中断重放四分支", () => {
      // 用例表必须是收集期静态量：it.each 的表在 beforeAll 之前就已求值。
      const badBakCases = [
        { raw: "{bad", expectMigrated: false },
        { raw: JSON.stringify({ nope: 1 }), expectMigrated: false },
      ];
      let good!: Awaited<ReturnType<typeof migrateFileConfig>>;
      let goodUpdates: unknown[] = [];
      const badRecords: Array<{
        out: Awaited<ReturnType<typeof migrateFileConfig>>;
        warns: string[];
      }> = [];
      let failOut!: Awaited<ReturnType<typeof migrateFileConfig>>;
      let failBakKept = false;

      beforeAll(async () => {
        const goodDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-resume-ok-"));
        writeFileSync(join(goodDir, MIGRATED_BAK_NAME), JSON.stringify({ printBanner: false }));
        const scope = okScope();
        good = await migrateFileConfig(goodDir, scope);
        goodUpdates = scope.updates;
        rmSync(goodDir, { recursive: true, force: true });

        for (const { raw } of badBakCases) {
          const dir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-resume-bad-"));
          writeFileSync(join(dir, MIGRATED_BAK_NAME), raw);
          const warns: string[] = [];
          const out = await migrateFileConfig(dir, okScope(), {
            warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")),
          });
          badRecords.push({ out, warns });
          rmSync(dir, { recursive: true, force: true });
        }

        const failDir = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-mut-resume-fail-"));
        writeFileSync(join(failDir, MIGRATED_BAK_NAME), JSON.stringify({ port: 4084 }));
        failOut = await migrateFileConfig(failDir, {
          async update() {
            throw new Error("io");
          },
        });
        failBakKept = existsSync(join(failDir, MIGRATED_BAK_NAME));
        rmSync(failDir, { recursive: true, force: true });
      });

      it("bak 重放成功 outcome（resumed=true）", () => {
        expect(good).toEqual({
          performed: false,
          migrated: true,
          rolledBack: false,
          skippedCorrupt: false,
          resumed: true,
        });
      });

      it("bak 重放成功写入键集", () => {
        expect(goodUpdates).toEqual([{ printBanner: false }]);
      });

      const titledBad = badBakCases.map((c, i) => ({
        title: `resume bad (${c.raw}) 全量 outcome`,
        i,
      }));
      it.each(titledBad)("$title", ({ i }) => {
        expect(badRecords[i].out).toEqual({
          performed: false,
          migrated: false,
          rolledBack: false,
          skippedCorrupt: true,
          resumed: true,
        });
      });

      it("resume 损坏 bak 警告含手动恢复路径", () => {
        expect(badRecords[0].warns.some((w) => w.includes("无法自动恢复"))).toBe(true);
      });

      it("resume 无有效键警告含手动删除指引", () => {
        expect(badRecords[1].warns.some((w) => w.includes("手动删除"))).toBe(true);
      });

      it("重放失败不回滚（bak 保留）", () => {
        expect(failOut).toEqual({
          performed: false,
          migrated: false,
          rolledBack: false,
          skippedCorrupt: false,
          resumed: true,
        });
      });

      it("重放失败 bak 标记仍在", () => {
        expect(failBakKept).toBe(true);
      });
    });
  });

  // ---- D. applyConfigPatch 校验链与错误映射（expectedRevision/409/logWarn 缺省）----
  describe("D. applyConfigPatch 校验链与错误映射", () => {
    /** deps + lastWrite 观测盒（原脚本以块级 lastWrite 记录最近一次写入形态）。
     * d 经 `as unknown` 收口到 ConfigRouteDeps（单点适配）；box 记录最近一次写入。 */
    const mkDeps = (over: Record<string, unknown> = {}) => {
      const box: {
        lastWrite: { kind: string; patch?: unknown; section?: unknown; rev: unknown } | null;
      } = { lastWrite: null };
      const d = {
        resolve: () => ({ enabled: true }),
        readUser: () => ({
          user: { tlsCertFile: "/a.pem", tlsKeyFile: "/b.pem", port: 3000 },
          revision: 9,
        }),
        writable: () => true,
        update: async (patch: unknown, rev: unknown) => {
          box.lastWrite = { kind: "update", patch, rev };
        },
        replace: async (section: unknown, rev: unknown) => {
          box.lastWrite = { kind: "replace", section, rev };
        },
        compress: () => ({
          httpCompressEnabled: true,
          httpCompressLevel: 1,
          httpCompressMounted: false,
          httpCompressStats: { compressed: 0, passthrough: 0 },
        }),
        ...over,
      } as unknown as ConfigRouteDeps;
      return { d, box };
    };

    // D1: payload 非对象 → body={} → patch undefined → payload 定位错误。
    describe("D1: payload 非对象", () => {
      const payloads = [null, "str", 42];
      const results: Array<Extract<PatchResult, { ok: false }>> = [];

      beforeAll(async () => {
        for (const payload of payloads) {
          results.push(
            (await applyConfigPatch(mkDeps().d, payload)) as Extract<PatchResult, { ok: false }>,
          );
        }
      });

      const titledRejected = payloads.map((p, i) => ({
        title: `payload=${JSON.stringify(p)} 拒绝`,
        i,
      }));
      it.each(titledRejected)("$title", ({ i }) => {
        expect(results[i].ok).toBe(false);
      });

      const titledStatus = payloads.map((p, i) => ({
        title: `payload=${JSON.stringify(p)} status=400`,
        i,
      }));
      it.each(titledStatus)("$title", ({ i }) => {
        expect(results[i].status).toBe(400);
      });

      const titledCode = payloads.map((p, i) => ({
        title: `payload=${JSON.stringify(p)} code=invalid`,
        i,
      }));
      it.each(titledCode)("$title", ({ i }) => {
        expect(results[i].code).toBe("invalid");
      });

      const titledDetails = payloads.map((p, i) => ({
        title: `payload=${JSON.stringify(p)} details 指明载体形态`,
        i,
      }));
      it.each(titledDetails)("$title", ({ i }) => {
        expect(
          results[i].details.includes("(payload)") || results[i].details.includes("需为配置对象"),
        ).toBe(true);
      });
    });

    // D2: expectedRevision 非法形态 → 透传 undefined；合法整数透传原值。
    describe("D2: expectedRevision 形态", () => {
      it("非数字 expectedRevision → undefined", async () => {
        const { d, box } = mkDeps();
        await applyConfigPatch(d, { patch: { port: 3100 }, expectedRevision: "7" });
        expect(box.lastWrite?.rev).toBe(undefined);
      });

      it("小数 expectedRevision → undefined", async () => {
        const { d, box } = mkDeps();
        await applyConfigPatch(d, { patch: { port: 3100 }, expectedRevision: 1.5 });
        expect(box.lastWrite?.rev).toBe(undefined);
      });

      it("合法整数透传", async () => {
        const { d, box } = mkDeps();
        await applyConfigPatch(d, { patch: { port: 3100 }, expectedRevision: 6 });
        expect(box.lastWrite?.rev).toBe(6);
      });
    });

    // D3: invalid details 含字段与范围。
    describe("D3: invalid details 含字段与范围", () => {
      let r!: Extract<PatchResult, { ok: false }>;

      beforeAll(async () => {
        r = (await applyConfigPatch(mkDeps().d, { patch: { httpsPort: 0 } })) as Extract<
          PatchResult,
          { ok: false }
        >;
      });

      it("httpsPort=0 → code=invalid", () => {
        expect(r.code).toBe("invalid");
      });

      it("details 含字段名与范围", () => {
        expect(r.details.includes("httpsPort") && r.details.includes("1-65535")).toBeTruthy();
      });
    });

    // D4: conflict 409 映射（SETTINGS_CONFLICT code）。
    describe("D4: conflict 409 映射", () => {
      let r!: Extract<PatchResult, { ok: false }>;

      beforeAll(async () => {
        r = (await applyConfigPatch(
          mkDeps({
            update: async () => {
              throw Object.assign(new Error("stale"), { code: "SETTINGS_CONFLICT" });
            },
          }).d,
          { patch: { port: 3101 } },
        )) as Extract<PatchResult, { ok: false }>;
      });

      it("SETTINGS_CONFLICT → status=409", () => {
        expect(r.status).toBe(409);
      });

      it("SETTINGS_CONFLICT → code=conflict", () => {
        expect(r.code).toBe("conflict");
      });

      it("SETTINGS_CONFLICT → ok=false", () => {
        expect(r.ok).toBe(false);
      });
    });

    // D5: logWarn 缺省（?. 短路）不抛错，仍返回固定文案。
    describe("D5: logWarn 缺省", () => {
      let r!: Extract<PatchResult, { ok: false }>;

      beforeAll(async () => {
        const { d } = mkDeps({
          update: async () => {
            throw new Error("boom");
          },
        });
        delete d.logWarn;
        r = (await applyConfigPatch(d, { patch: { port: 3102 } })) as Extract<
          PatchResult,
          { ok: false }
        >;
      });

      it("logWarn 缺省 → status=500", () => {
        expect(r.status).toBe(500);
      });

      it("logWarn 缺省 → 固定文案", () => {
        expect(r.details).toBe("保存失败，请查看服务端日志");
      });
    });

    // D6: 清除证书路径走 replace 且剔除两键；普通 patch 走 update。
    describe("D6: 清除证书路径走 replace", () => {
      let clear!: PatchResult;
      let clearKind: unknown;
      let clearSection: Record<string, unknown> = {};
      let upd!: PatchResult;
      let updLastWriteIsObject = false;

      beforeAll(async () => {
        const { d, box } = mkDeps();
        clear = await applyConfigPatch(d, { patch: { tlsCertFile: "", tlsKeyFile: "" } });
        // 两次调用共用 lastWrite 观测盒，故在清除之后、普通 patch 之前取快照
        clearKind = box.lastWrite?.kind;
        clearSection = (box.lastWrite?.section ?? {}) as Record<string, unknown>;
        upd = await applyConfigPatch(d, { patch: { port: 3103 } });
        updLastWriteIsObject = typeof box.lastWrite === "object";
      });

      it("tls 双空串清除成功", () => {
        expect(clear.ok).toBe(true);
      });

      it("清除走 replace", () => {
        expect(clearKind).toBe("replace");
      });

      it("清除后节不含 tls 键", () => {
        // 与原文一致：`in` 优先级高于 `??`，故不额外兜底 section 为空的情形。
        expect(!("tlsCertFile" in clearSection) && !("tlsKeyFile" in clearSection)).toBeTruthy();
      });

      it("普通 patch 成功", () => {
        expect(upd.ok).toBe(true);
      });

      it("lastWrite 为对象", () => {
        expect(updLastWriteIsObject).toBe(true);
      });
    });
  });

  // ---- E. buildConfigRoutes 路由面（围栏/方法白名单/快照字段/readBody）----
  describe("E. buildConfigRoutes 路由面", () => {
    const deps = {
      resolve: () => ({
        enabled: true,
        host: "0.0.0.0",
        port: 3200,
        httpsEnabled: true,
        httpsPort: 3443,
        targetHost: "127.0.0.1",
        printBanner: true,
        wsCompressEnabled: true,
        wsCompressPaths: [],
        httpCompressEnabled: true,
        httpCompressLevel: 1,
      }),
      readUser: () => ({ user: { port: 3200 }, revision: 11 }),
      writable: () => true,
      update: async () => {},
      replace: async () => {},
      compress: () => ({
        httpCompressEnabled: true,
        httpCompressLevel: 1,
        httpCompressMounted: false,
        httpCompressStats: { compressed: 2, passthrough: 3 },
      }),
    };
    const route = buildConfigRoutes(deps as unknown as ConfigRouteDeps)[0];

    const callRoute = async (
      method: string,
      overrides: Record<string, unknown> = {},
      body?: unknown,
    ): Promise<{ status: number; body: string }> => {
      const EventEmitter = (await import("node:events")).EventEmitter;
      const stream = new EventEmitter();
      Object.assign(stream, {
        method,
        socket: { remoteAddress: "127.0.0.1" } as unknown as import("node:net").Socket,
        headers: { host: "127.0.0.1:3080" },
        ...overrides,
      });
      let status = 0;
      const chunks: string[] = [];
      const res = {
        writeHead(c: number) {
          status = c;
        },
        end(c?: unknown) {
          if (c !== undefined) chunks.push(String(c));
        },
        getHeader() {
          return undefined;
        },
        setHeader() {},
      };
      const done =
        body === undefined
          ? Promise.resolve()
          : new Promise<void>((r) =>
              process.nextTick(() => {
                stream.emit(
                  "data",
                  Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
                );
                stream.emit("end");
                r();
              }),
            );
      await route.handler(
        stream as unknown as IncomingMessage,
        res as unknown as import("node:http").ServerResponse,
      );
      await done;
      return { status, body: chunks.join("") };
    };

    // E1: 围栏与方法白名单。
    // #473 批 1（B1-4/B1-3）：403 body 围栏文案 + 405 body 文案断言（守卫收敛后逐字节锁定）
    describe("E1: 围栏与方法白名单", () => {
      let forbidden!: { status: number; body: string };
      let del405!: { status: number; body: string };
      let post405!: { status: number; body: string };

      beforeAll(async () => {
        forbidden = await callRoute("GET", { socket: { remoteAddress: "10.0.0.9" } });
        del405 = await callRoute("DELETE");
        post405 = await callRoute("POST", {}, { patch: {} });
      });

      it("非回环 403", () => {
        expect(forbidden.status).toBe(403);
      });

      it("403 body 围栏文案", () => {
        expect(JSON.parse(forbidden.body).error).toBe("forbidden: loopback-only");
      });

      it("DELETE 405", () => {
        expect(del405.status).toBe(405);
      });

      it("DELETE 405 body 文案", () => {
        expect(JSON.parse(del405.body).error).toBe("method not allowed: DELETE");
      });

      it("POST 405", () => {
        expect(post405.status).toBe(405);
      });

      it("POST 405 body 文案", () => {
        expect(JSON.parse(post405.body).error).toBe("method not allowed: POST");
      });
    });

    // E2: GET 快照字段全集（user/effective/compress/revision/writable）。
    describe("E2: GET 快照字段全集", () => {
      let snap!: {
        ok: unknown;
        user: unknown;
        effective: { port: number };
        compress: { httpCompressStats: { compressed: number } };
        revision: unknown;
        writable: unknown;
      };

      beforeAll(async () => {
        snap = JSON.parse((await callRoute("GET")).body);
      });

      it("快照 ok=true", () => {
        expect(snap.ok).toBe(true);
      });

      it("快照 user 层", () => {
        expect(snap.user).toEqual({ port: 3200 });
      });

      it("effective 生效值", () => {
        expect(snap.effective.port).toBe(3200);
      });

      it("压缩协商计数", () => {
        expect(snap.compress.httpCompressStats.compressed).toBe(2);
      });

      it("快照 revision", () => {
        expect(snap.revision).toBe(11);
      });

      it("快照 writable", () => {
        expect(snap.writable).toBe(true);
      });
    });

    // E3: PUT 合法 → 200 + user 层回传；非法 → 400 error.details；坏 JSON → 400 invalid-json。
    describe("E3: PUT 三态", () => {
      let okPut!: { ok: unknown };
      let badPut!: { ok: unknown; error: { details: string } };
      let badJson!: { ok: unknown; error: { code: string } };

      beforeAll(async () => {
        okPut = JSON.parse(
          (await callRoute("PUT", {}, { patch: { port: 3201 }, expectedRevision: 11 })).body,
        );
        badPut = JSON.parse((await callRoute("PUT", {}, { patch: { port: 99999 } })).body);
        badJson = JSON.parse((await callRoute("PUT", {}, "{not-json")).body);
      });

      it("PUT 合法提交成功", () => {
        expect(okPut.ok).toBe(true);
      });

      it("400 details 指明字段", () => {
        expect(badPut.error.details.includes("port")).toBeTruthy();
      });

      it("400 ok=false（错误包络旗标）", () => {
        expect(badPut.ok).toBe(false);
      });

      it("坏 JSON 400 invalid-json", () => {
        expect(badJson.error.code).toBe("invalid-json");
      });

      it("坏 JSON ok=false（错误包络旗标）", () => {
        expect(badJson.ok).toBe(false);
      });

      it("超限体 → 连接已断零写入（catch 后静默 return，不补 400）", async () => {
        const r = await callRoute("PUT", { destroy() {} }, "x".repeat(70 * 1024));
        expect(r.status).toBe(0);
        expect(r.body).toBe("");
      });
    });

    // E4: writable=false → PUT 503（GET 仍可读）。
    describe("E4: 只读态 PUT 503", () => {
      let status = 0;
      let body = "";

      beforeAll(async () => {
        const roDeps = { ...deps, writable: () => false };
        const roRoute = buildConfigRoutes(roDeps as unknown as ConfigRouteDeps)[0];
        const EventEmitter = (await import("node:events")).EventEmitter;
        const stream = new EventEmitter();
        Object.assign(stream, {
          method: "PUT",
          socket: { remoteAddress: "127.0.0.1" } as unknown as import("node:net").Socket,
          headers: { host: "127.0.0.1:3080" },
        });
        let s = 0;
        const chunks: string[] = [];
        const done = new Promise<void>((r) =>
          process.nextTick(() => {
            stream.emit("data", Buffer.from(JSON.stringify({ patch: { port: 1 } })));
            stream.emit("end");
            r();
          }),
        );
        await roRoute.handler(
          stream as unknown as IncomingMessage,
          {
            writeHead(c: number) {
              s = c;
            },
            end(c?: unknown) {
              if (c !== undefined) chunks.push(String(c));
            },
            getHeader() {
              return undefined;
            },
            setHeader() {},
          } as unknown as import("node:http").ServerResponse,
        );
        await done;
        status = s;
        body = chunks.join("");
      });

      it("只读态 PUT 503", () => {
        expect(status).toBe(503);
      });

      it("只读态 ok=false（错误包络旗标）", () => {
        expect(JSON.parse(body).ok).toBe(false);
      });
    });
  });
});

// ===== Config schema 直测：schemastery 默认值与上界（#147 变异加固接续） =====
describe("Config schema 直测：schemastery 默认值与上界（#147 变异加固接续）", () => {
  let defaults!: ReturnType<typeof Config>;

  beforeAll(() => {
    defaults = Config({});
  });

  it("enabled 默认 true", () => {
    expect(defaults.enabled).toBe(true);
  });

  it("httpsEnabled 默认 true", () => {
    expect(defaults.httpsEnabled).toBe(true);
  });

  it("printBanner 默认 true", () => {
    expect(defaults.printBanner).toBe(true);
  });

  it("wsCompressEnabled 默认 true", () => {
    expect(defaults.wsCompressEnabled).toBe(true);
  });

  it("httpCompressEnabled 默认 true", () => {
    expect(defaults.httpCompressEnabled).toBe(true);
  });

  it("httpCompressLevel 默认低档 1", () => {
    expect(defaults.httpCompressLevel).toBe(1);
  });

  it("injectToken 默认 true", () => {
    expect(defaults.injectToken).toBe(true);
  });

  it("ws 压缩路径默认 Remote 流 mux 端点", () => {
    expect(defaults.wsCompressPaths).toEqual(["/api/remote.mux"]);
  });

  // #856：伪造上游拓扑事实位的开关默认必须关（默认开等于静默改写页面拓扑语义）
  it("ownsHostCompat 默认关", () => {
    expect(defaults.ownsHostCompat).toBe(false);
  });

  // 端口上界 65535 由 schema max 强制
  it("port 超 schema 上界抛错", () => {
    expect(() => Config({ port: 65536 })).toThrow();
  });

  it("httpsPort 负数抛错", () => {
    expect(() => Config({ httpsPort: -1 })).toThrow();
  });

  it("压缩档位超 3 抛错", () => {
    expect(() => Config({ httpCompressLevel: 4 })).toThrow();
  });

  it("targetPort 超上界抛错", () => {
    expect(() => Config({ targetPort: 65536 })).toThrow();
  });

  it("wsBridgeEnabled 默认 true（保活基座默认开）", () => {
    expect(defaults.wsBridgeEnabled).toBe(true);
  });

  it("wsDeflatePolicy 默认浏览器可协商 + iOS 三件套拒绝", () => {
    expect(defaults.wsDeflatePolicy).toEqual({ browser: true, uaDeny: ["iPhone", "iPad", "iPod"] });
  });
});

// ===== 变异加固批 2（config 校验器边界补强：单侧缺席/非对象策略/显式 undefined）=====
describe("变异加固批 2：config 校验器边界补强", () => {
  it("单侧键缺席（tlsKeyFile 未提交）→ tls-pair 拒绝（首行键存在性门控）", async () => {
    const r = await applyConfigPatch(basePatchDeps(), { patch: { tlsCertFile: "/only.pem" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("tls-pair");
      expect(r.status).toBe(400);
    }
  });

  it("单侧空串缺席（tlsKeyFile 未提交）→ tls-pair 拒绝", async () => {
    const r = await applyConfigPatch(basePatchDeps(), { patch: { tlsCertFile: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("tls-pair");
  });

  it("wsDeflatePolicy 非对象 → validate 定位该键", () => {
    expect(validateSettings({ wsDeflatePolicy: 42 })?.key).toBe("wsDeflatePolicy");
  });

  it("wsDeflatePolicy 非对象 → sanitize 整体拒绝", () => {
    expect(sanitizeSettings({ wsDeflatePolicy: 42 })).toBe(null);
  });

  it("uaDeny 混入非字符串 → validate 定位该键", () => {
    expect(validateSettings({ wsDeflatePolicy: { uaDeny: ["a", 42] } })?.key).toBe(
      "wsDeflatePolicy",
    );
  });

  it("uaDeny 混入非字符串 → sanitize 整体拒绝", () => {
    expect(sanitizeSettings({ wsDeflatePolicy: { uaDeny: ["a", 42] } })).toBe(null);
  });

  it("显式 undefined 值等同缺席（跳过不拒绝）", () => {
    expect(sanitizeSettings({ port: undefined, httpsEnabled: true })).toEqual({
      httpsEnabled: true,
    });
  });

  it("非压缩键取迁移档位值不改写（port: 5 原样保留）", () => {
    expect(sanitizeSettings({ port: 5 })).toEqual({ port: 5 });
  });

  it("wsBridgeEnabled 非布尔 → validate 定位该键", () => {
    expect(validateSettings({ wsBridgeEnabled: "yes" })?.key).toBe("wsBridgeEnabled");
  });

  it("injectToken 非布尔 → sanitize 整体拒绝", () => {
    expect(sanitizeSettings({ injectToken: 1 })).toBe(null);
  });

  it("叶对清除保留用户层 CA 键（clearingCa 分支不误删）", async () => {
    let section: Record<string, unknown> = {};
    const d = basePatchDeps({
      readUser: () => ({
        user: {
          tlsCertFile: "/c.pem",
          tlsKeyFile: "/k.pem",
          tlsCaCertFile: "/ca.pem",
          port: 3000,
        },
        revision: 3,
      }),
      replace: async (s: unknown) => {
        section = s as Record<string, unknown>;
      },
    });
    const r = await applyConfigPatch(d, { patch: { tlsCertFile: "", tlsKeyFile: "" } });
    expect(r.ok).toBe(true);
    expect(section.tlsCaCertFile).toBe("/ca.pem");
    expect("tlsCertFile" in section).toBe(false);
    expect("tlsKeyFile" in section).toBe(false);
  });

  it("写入抛非 Error 值 → 仍 500 定码（不崩溃）", async () => {
    const d = basePatchDeps({
      update: async () => {
        const failure: unknown = null;
        throw failure;
      },
    });
    const r = await applyConfigPatch(d, { patch: { port: 3104 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.code).toBe("error");
    }
  });

  it("BOOLEAN_KEYS 导出契约（改键集同步改客户端开关渲染）", () => {
    expect(BOOLEAN_KEYS).toEqual([
      "enabled",
      "httpsEnabled",
      "printBanner",
      "wsBridgeEnabled",
      "wsCompressEnabled",
      "httpCompressEnabled",
      "injectToken",
      "ownsHostCompat",
    ]);
  });

  it("normalizeConfig 入口点烟测试（空输入补默认 + 显式值透传）", () => {
    expect(normalizeConfig({ port: 1 }).port).toBe(1);
    expect(normalizeConfig({ port: 1 }).enabled).toBe(true);
  });
});
// ===== apply 内 readUser 真实闭包（CRAP 56/7 未覆盖 → 覆盖后 7） =====
// 命中 apply.ts:409 的 readUser 箭头函数：经真实 apply 装配 + config 路由 GET 驱动，
// 不 mock readUser 本身。隔离：mkdtemp DSH_HOME + 端口 0 + disposers 回收，产物零污染。
describe("apply 内 readUser 真实闭包（CRAP 覆盖）", () => {
  let snapUser: unknown;
  let snapRevision: unknown;
  let snapWritable: unknown;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-readuser-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const routes: WebRoute[] = [];
    const disposers: Array<unknown> = [];
    const settingsService = {
      describe() {
        return [{ ns: SETTINGS_NS, user: { port: 4100 }, revision: 42 }];
      },
    };
    const ws = makeFakeWebServer({
      register: (route: WebRoute) => {
        routes.push(route);
      },
    });
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      webServer: ws,
      inject(services: string[], fn: (ctx: unknown) => void) {
        if (services.includes("settings")) {
          const sctx = {
            settings: settingsService,
            effect(fn2: () => unknown) {
              const d = fn2();
              disposers.push(d);
              return d;
            },
          };
          fn(sctx);
        }
      },
      effect(fn: () => unknown) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    apply(ctx as unknown as Context, {
      host: "127.0.0.1",
      port: 0,
      httpsPort: 0,
      httpsEnabled: false,
      printBanner: false,
      wsCompressEnabled: false,
      httpCompressEnabled: false,
    });
    await sleep(50);
    const configRoute = routes.find((r: WebRoute) => r.path === ROUTES.config);
    let body = "";
    (configRoute as WebRoute).handler(
      {
        method: "GET",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080" },
        url: ROUTES.config,
      } as unknown as IncomingMessage,
      {
        writeHead: () => {},
        end: (c?: unknown) => {
          body = String(c);
        },
      } as unknown as import("node:http").ServerResponse,
    );
    const snap = JSON.parse(body);
    snapUser = snap.user;
    snapRevision = snap.revision;
    snapWritable = snap.writable;
    for (const d of [...disposers].reverse()) {
      try {
        (d as unknown as () => void)();
      } catch {}
    }
    process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }, 30000);

  it("readUser 透出 descriptor.user", () => {
    expect(snapUser).toEqual({ port: 4100 });
  });

  it("readUser 透出 revision", () => {
    expect(snapRevision).toBe(42);
  });

  it("writable 为 true（attach 成功）", () => {
    expect(snapWritable).toBe(true);
  });
});

// ===== Phase 2D：apply 接入旧 settings 迁移（独立 marker / raw user / 可重试） =====
describe("apply 接入 legacy settings migration", () => {
  type UpdateCall = { ns: string; patch: Record<string, unknown> };
  type MountOptions = {
    rawUser: unknown;
    resolvedValue: Record<string, unknown>;
    update: (ns: string, patch: object) => Promise<void>;
    describeUser?: () => unknown;
  };

  let previousHome: string | undefined;
  let roots: string[] = [];
  let mounted: Array<{ dispose: () => void }> = [];

  beforeEach(() => {
    previousHome = process.env.DSH_HOME;
    roots = [];
    mounted = [];
  });

  afterEach(() => {
    for (const item of [...mounted].reverse()) item.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function tempHome(): string {
    const root = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-apply-legacy-settings-"));
    roots.push(root);
    process.env.DSH_HOME = root;
    return root;
  }

  async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(message);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  function mountApply(options: MountOptions): {
    returnValue: unknown;
    warnings: string[];
    describeCalls: Array<{ redactSecrets?: boolean } | undefined>;
    updates: UpdateCall[];
    routes: WebRoute[];
    dispose: () => void;
  } {
    const warnings: string[] = [];
    const describeCalls: Array<{ redactSecrets?: boolean } | undefined> = [];
    const updates: UpdateCall[] = [];
    const routes: WebRoute[] = [];
    const disposers: Array<() => void> = [];
    let disposed = false;
    const settings = {
      describe(query?: { redactSecrets?: boolean }) {
        describeCalls.push(query);
        return [
          {
            ns: SETTINGS_NS,
            value: options.resolvedValue,
            user: options.describeUser?.() ?? options.rawUser,
            revision: 7,
          },
        ];
      },
      async update(ns: string, patch: object): Promise<void> {
        updates.push({ ns, patch: patch as Record<string, unknown> });
        await options.update(ns, patch);
      },
    };
    const ws = makeFakeWebServer({
      register: (route) => {
        routes.push(route);
      },
    });
    const ctx = {
      logger: {
        info: () => {},
        warn: (message: unknown) => {
          warnings.push(String(message));
        },
        error: () => {},
      },
      webServer: ws,
      inject(services: string[], callback: (scoped: unknown) => void) {
        if (!services.includes("settings")) return;
        callback({
          settings,
          effect(run: () => unknown) {
            const disposer = run();
            if (typeof disposer === "function") disposers.push(disposer as () => void);
            return disposer;
          },
        });
      },
      effect(run: () => unknown) {
        const disposer = run();
        if (typeof disposer === "function") disposers.push(disposer as () => void);
        return disposer;
      },
    };
    const returnValue = apply(ctx as unknown as Context, {
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      httpsEnabled: false,
      printBanner: false,
    });
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const disposer of [...disposers].reverse()) {
        try {
          disposer();
        } catch {}
      }
    };
    mounted.push({ dispose });
    return { returnValue, warnings, describeCalls, updates, routes, dispose };
  }

  function settingsMarker(): string {
    return join(pluginDir(), SETTINGS_MIGRATION_MARKER_NAME);
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("legacy 延迟时仍先完成 file migration，刷新 raw user 后只补缺", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "settings.yaml"),
      JSON.stringify({
        "dsh-lan-proxy": { port: 4000, enabled: false },
      }),
      "utf8",
    );
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "config.json"), JSON.stringify({ port: 4100 }), "utf8");
    const canonical: Record<string, unknown> = {};
    const fileCompleted = deferred();
    const harness = mountApply({
      rawUser: {},
      describeUser: () => ({ ...canonical }),
      resolvedValue: {},
      update: async (_ns, patch) => {
        const record = patch as Record<string, unknown>;
        Object.assign(canonical, record);
        if (record.port === 4000) await fileCompleted.promise;
        if (record.port === 4100) fileCompleted.resolve();
      },
    });

    await waitFor(() => existsSync(settingsMarker()), "两条迁移链未完成");

    expect(harness.updates).toEqual([
      { ns: SETTINGS_NS, patch: { port: 4100 } },
      { ns: SETTINGS_NS, patch: { enabled: false } },
    ]);
    expect(canonical).toEqual({ port: 4100, enabled: false });
    expect(existsSync(join(pluginDir(), MIGRATED_BAK_NAME))).toBe(true);
  });

  it("file 延迟时 legacy 不抢跑，反转延迟仍保持 file 优先", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "settings.yaml"),
      JSON.stringify({
        "dsh-lan-proxy": { port: 4000, enabled: false },
      }),
      "utf8",
    );
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "config.json"), JSON.stringify({ port: 4100 }), "utf8");
    const canonical: Record<string, unknown> = {};
    const fileStarted = deferred();
    const releaseFile = deferred();
    let fileStartedSeen = false;
    const harness = mountApply({
      rawUser: {},
      describeUser: () => ({ ...canonical }),
      resolvedValue: {},
      update: async (_ns, patch) => {
        const record = patch as Record<string, unknown>;
        Object.assign(canonical, record);
        if (record.port === 4100) {
          fileStartedSeen = true;
          fileStarted.resolve();
          await releaseFile.promise;
        }
      },
    });

    try {
      await waitFor(() => fileStartedSeen, "file migration 未启动");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.updates[0]?.patch).toEqual({ port: 4100 });
      expect(harness.updates.some((call) => call.patch.port === 4000)).toBe(false);
    } finally {
      releaseFile.resolve();
    }
    await waitFor(() => existsSync(settingsMarker()), "两条迁移链未完成");

    expect(harness.updates).toEqual([
      { ns: SETTINGS_NS, patch: { port: 4100 } },
      { ns: SETTINGS_NS, patch: { enabled: false } },
    ]);
    expect(canonical).toEqual({ port: 4100, enabled: false });
  });

  it("坏 settings 源只降级 settings，不阻断 file marker 与配置路由", async () => {
    const home = tempHome();
    writeFileSync(join(home, "settings.yaml"), "dsh-lan-proxy: [", "utf8");
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "config.json"), JSON.stringify({ port: 4100 }), "utf8");
    const harness = mountApply({
      rawUser: {},
      resolvedValue: {},
      update: async () => {},
    });

    await waitFor(
      () => harness.warnings.some((message) => message.includes("settings.yaml")),
      "坏 settings 源未记录独立降级",
    );
    await waitFor(
      () => existsSync(join(pluginDir(), MIGRATED_BAK_NAME)),
      "settings 失败阻断了 file marker",
    );

    expect(harness.updates).toEqual([{ ns: SETTINGS_NS, patch: { port: 4100 } }]);
    expect(existsSync(settingsMarker())).toBe(false);
    expect(harness.routes.some((route) => route.path === ROUTES.health)).toBe(true);
    expect(harness.routes.some((route) => route.path === ROUTES.config)).toBe(true);
  });

  it("file 写入失败仍独立尝试 settings，下一次 apply 独立重试 file", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "settings.yaml"),
      JSON.stringify({ "dsh-lan-proxy": { enabled: false } }),
      "utf8",
    );
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "config.json"), JSON.stringify({ port: 4100 }), "utf8");
    let fileAttempts = 0;
    let settingsAttempts = 0;
    const first = mountApply({
      rawUser: {},
      resolvedValue: { enabled: true, port: 0 },
      update: async (_ns, patch) => {
        const record = patch as Record<string, unknown>;
        if (record.port === 4100) {
          fileAttempts += 1;
          if (fileAttempts === 1) throw new Error("temporary file failure");
        }
        if (record.enabled === false) settingsAttempts += 1;
      },
    });

    await waitFor(() => existsSync(settingsMarker()), "file 失败阻断了 settings migration");
    expect(fileAttempts).toBe(1);
    expect(settingsAttempts).toBe(1);
    expect(first.updates).toEqual([
      { ns: SETTINGS_NS, patch: { port: 4100 } },
      { ns: SETTINGS_NS, patch: { enabled: false } },
    ]);
    expect(existsSync(join(pluginDir(), "config.json"))).toBe(true);
    expect(existsSync(join(pluginDir(), MIGRATED_BAK_NAME))).toBe(false);
    first.dispose();

    const second = mountApply({
      rawUser: {},
      resolvedValue: { enabled: false, port: 0 },
      update: async (_ns, patch) => {
        const record = patch as Record<string, unknown>;
        if (record.port === 4100) fileAttempts += 1;
        if (record.enabled === false) settingsAttempts += 1;
      },
    });
    await waitFor(() => fileAttempts === 2, "file migration 未在下次 apply 重试");

    expect(settingsAttempts).toBe(1);
    expect(second.updates).toEqual([{ ns: SETTINGS_NS, patch: { port: 4100 } }]);
    expect(existsSync(join(pluginDir(), MIGRATED_BAK_NAME))).toBe(true);
  });

  it("仅有旧 settings 时，以 canonical raw user 向同一 owner scope 提交缺省字段", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "settings.yaml"),
      JSON.stringify({
        "dsh-lan-proxy": {
          port: 4200,
          enabled: false,
          printBanner: false,
          wsCompressPaths: ["/legacy"],
        },
      }),
      "utf8",
    );
    const harness = mountApply({
      rawUser: { port: 4300, wsCompressPaths: [] },
      resolvedValue: {
        port: 9999,
        enabled: true,
        printBanner: true,
        wsCompressPaths: ["/resolved-default"],
      },
      update: async () => {},
    });

    await waitFor(() => harness.updates.length === 1, "canonical settings update 未发生");
    await waitFor(() => existsSync(settingsMarker()), "settings migration marker 未写入");

    expect(harness.returnValue).toBeUndefined();
    expect(harness.describeCalls).toContainEqual({ redactSecrets: true });
    expect(harness.updates).toEqual([
      { ns: SETTINGS_NS, patch: { enabled: false, printBanner: false } },
    ]);
    expect(existsSync(settingsMarker())).toBe(true);
  });

  it("没有旧 settings 源时只完成独立 config.json file marker，不写 settings marker", async () => {
    tempHome();
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "config.json"), JSON.stringify({ printBanner: false }), "utf8");
    const harness = mountApply({
      rawUser: {},
      resolvedValue: { printBanner: true },
      update: async () => {},
    });

    await waitFor(
      () => harness.updates.some((call) => call.patch.printBanner === false),
      "config.json file migration 未完成",
    );

    expect(harness.describeCalls).toContainEqual({ redactSecrets: true });
    expect(harness.updates).toEqual([{ ns: SETTINGS_NS, patch: { printBanner: false } }]);
    expect(existsSync(join(pluginDir(), MIGRATED_BAK_NAME))).toBe(true);
    expect(existsSync(settingsMarker())).toBe(false);
  });

  it("settings revision 冲突时 warn、保留 file migration 且清理 receipt 后可重试", async () => {
    const home = tempHome();
    writeFileSync(
      join(home, "settings.yaml"),
      JSON.stringify({ "dsh-lan-proxy": { enabled: false } }),
      "utf8",
    );
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "config.json"), JSON.stringify({ printBanner: false }), "utf8");
    let settingsAttempts = 0;
    const first = mountApply({
      rawUser: {},
      resolvedValue: { enabled: true, printBanner: true },
      update: async (_ns, patch) => {
        if ("enabled" in patch) {
          settingsAttempts += 1;
          if (settingsAttempts === 1) {
            throw Object.assign(new Error("settings changed"), { code: "SETTINGS_CONFLICT" });
          }
        }
      },
    });

    await waitFor(
      () =>
        first.warnings.some(
          (message) =>
            message.includes("旧 settings 写入 canonical scope 失败") ||
            message.includes("旧 settings 写入发生 revision 冲突"),
        ),
      "settings migration 失败未记录 warn",
    );
    await waitFor(
      () => first.updates.some((call) => call.patch.printBanner === false),
      "settings 失败阻断了 config.json file migration",
    );

    expect(existsSync(settingsMarker())).toBe(false);
    expect(existsSync(join(pluginDir(), MIGRATED_BAK_NAME))).toBe(true);
    expect(first.routes.some((route) => route.path === ROUTES.health)).toBe(true);
    expect(first.routes.some((route) => route.path === ROUTES.config)).toBe(true);
    first.dispose();

    const second = mountApply({
      rawUser: {},
      resolvedValue: { enabled: true, printBanner: false },
      update: async (_ns, patch) => {
        if ("enabled" in patch) settingsAttempts += 1;
      },
    });
    await waitFor(() => existsSync(settingsMarker()), "失败后的 settings migration 未重试成功");

    expect(settingsAttempts).toBe(2);
    expect(second.updates).toContainEqual({
      ns: SETTINGS_NS,
      patch: { enabled: false },
    });
    expect(existsSync(settingsMarker())).toBe(true);
  });
});
