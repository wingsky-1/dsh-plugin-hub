/**
 * dsh-lan-proxy — 插件挂载主流程（apply）与转发常量（#276 方案 A 阶段 3 拆出）。
 *
 * apply 内 sync/TLS/横幅生命周期闭环紧密，不宜再拆：转发器按当前配置重建
 * （settings 命名空间解析值优先、组合层 entry 兜底），health/config 路由与
 * randomUUID polyfill 同处装配。路由表归 config-routes.ts，settings 接线归
 * settings.ts，存量迁移归 migrate.ts；本模块不 import index.ts（防循环）。
 */
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, errorMessage } from "../../../shared/host-utils.js";
import { createLanProxy, DEFAULT_OPTIONS, DEFAULT_DEFLATE_POLICY } from "./proxy.ts";
import type { TlsMaterials, LanProxy } from "./proxy.ts";
import { ensureSelfSignedTls, loadTlsFromFiles } from "./cert.ts";
// 配置层值依赖单向 apply → config：默认白名单常量（单一事实源）与存量归一化纯函数
// 均定义于 config.ts，本模块消费并 re-export（保持 apply.ts 既有导出面不变）。
import { normalizeLegacyWsCompressPaths, DEFAULT_WSS_COMPRESS_PATHS } from "./config.ts";
import type { HttpCompressSnapshot, LanProxyConfig, ResolvedConfig } from "./config.ts";
import { SETTINGS_NS, installLanProxySettings, warnLog } from "./settings.ts";
import type { OwnerScopeLike, SettingsServiceLike } from "./settings.ts";
import { migrateFileConfig } from "./migrate.ts";
import { ROUTES, buildConfigRoutes } from "./config-routes.ts";
import type { ConfigRouteDeps } from "./config-routes.ts";

// 重新导出默认压缩白名单（定义见 config.ts），保持 `from "./apply.ts"` 的既有消费面。
export { DEFAULT_WSS_COMPRESS_PATHS };

/**
 * 终端横幅输出（用户可感知信息走原生 console：cordis logger 只进内存 buffer，
 * 终端不可见——与官方 dsh web 启动横幅的 console.log 做法一致）。
 */
const out = {
  info: (...args: unknown[]) => console.log("[lan-proxy]", ...args),
  warn: (...args: unknown[]) => console.warn("[lan-proxy]", ...args),
  error: (...args: unknown[]) => console.error("[lan-proxy]", ...args),
};

/** 本机非回环 IPv4 地址，用于启动时的 LAN URL 日志行。 */
function lanIpv4Addresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/** 插件目录（<DSH_HOME>/lan-proxy）：自签名证书缓存 + 存量迁移备份所在。 */
export function pluginDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lan-proxy");
}

/**
 * 挂载 LAN 转发器。配置来源（settings 命名空间解析值优先、组合层 entry 兜底）
 * 变化时通过 sync 重建转发器，实现端口等配置的热更新（统一由 scope.watch 驱动）。
 *
 * 注意：apply 必须同步返回——转发器在 sync() 里立即启动，settings 命名空间的
 * 注册通过 inject(["settings"]) 异步补挂（失败仅降级 warn）。enabled 早退已移除
 * （issue #110 P0-2）：禁用态仍注册 settings 命名空间与路由，保证存量
 * config.json 迁移先行于 enabled 判定；转发器是否启动由 sync() 内 enabled 决定。
 * @param ctx 携带已初始化 webServer 服务的宿主插件上下文。
 * @param config 解析后的插件配置（loader 已应用 schema 默认值）。
 */
export function apply(ctx: Context, config: LanProxyConfig = {}): void {
  // 插件目录（<DSH_HOME>/lan-proxy）：自签名证书缓存目录（配置已迁官方 settings）。
  const configDir = pluginDir();
  mkdirSync(configDir, { recursive: true });
  /** 配置实时来源：settings 命名空间 attach 后为 scope.get()，否则组合层 entry。 */
  let current: () => LanProxyConfig = () => ({ ...config });
  let disposeProxy: (() => void) | undefined;
  /** 当前存活转发器（health 读取压缩协商计数用）。 */
  let activeProxy: LanProxy | undefined;
  let disposed = false;
  /** settings 命名空间 attach 状态（readUser/writable 依据）。 */
  let attachedService: SettingsServiceLike | undefined;
  /** attach 后的 owner scope（由 onScope 回调赋值；写路由经此 update/replace）。 */
  let attachedScope: OwnerScopeLike | undefined;
  /** 上一次打印的横幅（防刷屏：监听结果没变化不重复打印）。 */
  let lastBanner = "";

  /** 合并默认值，得到一份完整配置（settings 缺失时兜底组合层 entry）。 */
  const resolve = (): ResolvedConfig => {
    const value = current();
    return {
      enabled: value.enabled ?? true,
      host: value.host ?? DEFAULT_OPTIONS.host,
      port: value.port ?? DEFAULT_OPTIONS.port,
      httpsEnabled: value.httpsEnabled ?? true,
      httpsPort: value.httpsPort ?? DEFAULT_OPTIONS.httpsPort,
      tlsCertFile: value.tlsCertFile,
      tlsKeyFile: value.tlsKeyFile,
      targetHost: value.targetHost ?? DEFAULT_OPTIONS.targetHost,
      targetPort: value.targetPort,
      printBanner: value.printBanner ?? true,
      wsCompressEnabled: value.wsCompressEnabled ?? true,
      // 存量迁移（issue #395 M2）：显式保存过旧默认白名单
      // ["/api/events.mux", "/api/events.host"] 的 settings 用户层值升级后仍要
      // 归一化为新默认 ["/api/remote.mux"]，否则压缩桥接对新 mux 端点静默失效。
      wsCompressPaths: normalizeLegacyWsCompressPaths(value.wsCompressPaths) ?? DEFAULT_WSS_COMPRESS_PATHS,
      wsDeflatePolicy: value.wsDeflatePolicy ?? DEFAULT_DEFLATE_POLICY,
      httpCompressEnabled: value.httpCompressEnabled ?? true,
      httpCompressLevel: value.httpCompressLevel ?? 1,
      injectToken: value.injectToken ?? true,
    };
  };

  // ---- injectToken（issue #380）：launch token 动态提供者 ----
  // 官方 connection 服务（@deepseek-ai/dsh-client-connection）以 cordis 服务
  // "connection" 提供；公开方法 authenticatedUrl(baseUrl) 返回带当前 launch
  // token 的 URL。token 进程内恒定、跨重启变化——getter 每次现读不缓存，重启
  // 后自动跟随新值。服务晚于转发器 attach 是常态：getter 在 attach 前返回
  // undefined，逐请求降级为不注入（与未开启一致），attach 后自动生效。
  /** 官方 connection 服务最小类型面（公开 API；仅取 token 所需）。 */
  interface ConnectionLike {
    authenticatedUrl(baseUrl: string): string;
  }
  /** connection 内层 attach 后就绪的 token 读取器（未 attach 前 undefined）。 */
  let readLaunchToken: (() => string | undefined) | undefined;
  /** 提供者状态（absent/ready/error），变化时各 warn 一次——不造节流器。 */
  let tokenProviderState: "absent" | "ready" | "error" = "absent";
  const setTokenProviderState = (next: "ready" | "error"): void => {
    if (tokenProviderState === next) return;
    tokenProviderState = next;
    if (next === "error") {
      out.warn("injectToken: 读取 dsh web launch token 失败 — 自动注入逐请求降级关闭（官方行为面变更？请按 dsh-upgrade 流程复核）");
    } else {
      out.info("injectToken: launch token 提供者就绪 — LAN 设备首次访问将自动铸造会话");
    }
  };
  /** 转发器消费的提供者：转发器随配置重建，getter 引用保持同一份（禁快照）。 */
  const tokenProvider = { getToken: (): string | undefined => readLaunchToken?.() ?? undefined };
  if (typeof (ctx as unknown as { inject?: unknown })?.inject === "function") {
    (ctx as unknown as { inject: (services: string[], fn: (c: unknown) => void) => void }).inject(
      ["connection"],
      (connectionCtx: unknown) => {
        const connection = (connectionCtx as { connection?: ConnectionLike } | undefined)?.connection;
        if (connection === undefined || typeof connection.authenticatedUrl !== "function") {
          setTokenProviderState("error");
          return;
        }
        readLaunchToken = () => {
          try {
            // 官方公开 API：返回「根 URL + ?token=当前 launch token」。
            const mint = connection.authenticatedUrl("http://lan-proxy.local");
            const token = new URL(mint).searchParams.get("token");
            if (token === null || token === "") {
              setTokenProviderState("error");
              return undefined;
            }
            setTokenProviderState("ready");
            return token;
          } catch {
            setTokenProviderState("error");
            return undefined;
          }
        };
      },
    );
  }

  /**
   * HTTP 压缩运行快照（issue #33 子项 3）：health 与 GET /config 共用的单一来源，
   * GUI 据此显示「压缩是否在工作 + 协商计数」。
   */
  const compressSnapshot = (): HttpCompressSnapshot => {
    const v = resolve();
    return {
      httpCompressEnabled: v.httpCompressEnabled,
      httpCompressLevel: v.httpCompressLevel,
      httpCompressMounted: v.enabled !== false && v.httpCompressEnabled !== false && disposeProxy !== undefined,
      httpCompressStats: activeProxy?.httpCompressStats() ?? { compressed: 0, passthrough: 0 },
    };
  };

  /**
   * 准备 TLS 材料：用户配置了 tlsCertFile/tlsKeyFile 则加载文件，
   * 否则自动生成（或复用缓存里的）自签名证书。返回 undefined 表示
   * HTTPS 不可用（缺配置或证书准备失败），调用方降级为 HTTP-only。
   */
  const prepareTls = (value: ResolvedConfig): TlsMaterials | undefined => {
    if (value.tlsCertFile || value.tlsKeyFile) {
      if (!value.tlsCertFile || !value.tlsKeyFile) {
        out.warn("tlsCertFile 与 tlsKeyFile 必须成对提供 — HTTPS 已禁用");
        return undefined;
      }
      try {
        return loadTlsFromFiles(value.tlsCertFile, value.tlsKeyFile);
      } catch (err) {
        out.warn(`TLS 证书加载失败（${(err as Error).message}）— HTTPS 已禁用`);
        return undefined;
      }
    }
    try {
      return ensureSelfSignedTls({ dir: pluginDir(), extraSans: lanIpv4Addresses() });
    } catch (err) {
      out.warn(`自签名证书生成失败（${(err as Error).message}）— HTTPS 已禁用`);
      return undefined;
    }
  };

  /** 按当前配置重建转发器（先拆旧再建新，重复调用不会冲突）。 */
  const sync = () => {
    if (disposed) return;
    if (disposeProxy) {
      disposeProxy();
      disposeProxy = undefined;
    }
    const value = resolve();
    // HTTP 响应压缩开关（随转发器在 sync() 内一并生效/关闭）。
    const httpCompressEnabled = value.enabled !== false && value.httpCompressEnabled !== false;
    if (!value.enabled) {
      return;
    }
    const targetPort = value.targetPort ?? ctx.webServer.port;
    if (targetPort === undefined) {
      ctx.logger.error("lan-proxy: webServer has no bound port yet — cannot start");
      return;
    }
    const tls = value.httpsEnabled === false ? undefined : prepareTls(value);
    // HTTP 响应压缩随转发器整体重建：配置热更新（scope.watch 驱动）走同一条
    // sync() 路径，无需独立拆装生命周期。
    const proxy = createLanProxy(
      {
        host: value.host,
        port: value.port,
        httpsPort: value.httpsPort,
        tls,
        targetHost: value.targetHost,
        targetPort,
        wsCompress: {
          enabled: value.wsCompressEnabled !== false,
          paths: value.wsCompressPaths ?? DEFAULT_WSS_COMPRESS_PATHS,
        },
        wsDeflatePolicy: value.wsDeflatePolicy ?? DEFAULT_DEFLATE_POLICY,
        httpCompress: {
          enabled: httpCompressEnabled,
          level: value.httpCompressLevel,
        },
        // 自动注入启动令牌（issue #380）：仅开关开启时交给转发器；提供者 getter
        // 跨重建共享（connection 服务 attach 前返回 undefined，逐请求降级）。
        injectToken: value.injectToken ? tokenProvider : undefined,
      },
      ctx.logger,
    );
    activeProxy = proxy;
    proxy
      .listen()
      .then(({ httpPort, httpsPort }) => {
        // 终端横幅：3 行式（监听 / HTTPS / LAN 访问），参考官方 dsh web 启动横幅
        // 的 console.log 做法；监听结果没变化不重复打印（防热更新刷屏）。
        const source = value.tlsCertFile ? value.tlsCertFile : "self-signed";
        const lines = [
          `listening http://${value.host}:${httpPort} -> http://${proxy.targetAuthority} (dsh web UI)`,
        ];
        if (httpsPort !== undefined) {
          lines.push(`https https://${value.host}:${httpsPort} -> http://${proxy.targetAuthority} (${source})`);
        }
        for (const ip of lanIpv4Addresses()) {
          lines.push(`LAN access http://${ip}:${httpPort}${httpsPort !== undefined ? ` · https://${ip}:${httpsPort}` : ""}`);
        }
        // injectToken 开启警示（issue #380）：开启 = LAN 内设备免 token 直入，
        // 横幅每次监听结果变化都带此行，保持可感知。
        if (value.injectToken) {
          lines.push("injectToken: ON — 局域网设备免 token 直接进入（等效信任整个 LAN，关闭见 设置 → 插件 → dsh-lan-proxy）");
        }
        const banner = lines.map((line) => `  ${line}`).join("\n");
        if (value.printBanner !== false && banner !== lastBanner) {
          lastBanner = banner;
          console.log(`[lan-proxy]\n${banner}`);
        }
      })
      .catch((err) => {
        const msg = (err as Error)?.message ?? String(err);
        out.error(`listen failed: ${msg}`);
        if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
          out.error("hint: 端口被占用——可能另一个 dsh 实例已启动；改端口请到 设置 → 插件 → dsh-lan-proxy");
        }
        // 绑定失败（如端口被占）：关闭已创建的资源并清空引用，避免残留
        // 转发器；配置变化触发下次 sync 时可干净重建。
        proxy.close().catch(() => {});
        disposeProxy = undefined;
      });
    disposeProxy = () => {
      proxy.close().catch(() => {});
    };
  };

  /** 重建防抖：设置保存 / 来源切换后先把成功回执送达，再延迟重建 lan-proxy。
   *  重建会 dispose 当前转发器、断开经 lan-proxy（3443/3081）正访问的页面连接，
   *  过早重建会丢失 HTTP 响应（保存误报「失败」）。延迟 3s 足够回执发出；
   *  连续保存只重建最后一次。 */
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSync = () => {
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      // 压缩随转发器在 sync() 内一并重建（含标记路由挂撤）。
      sync();
    }, 3000);
  };

  // 转发器立即启动（不依赖任何异步解析）。
  sync();

  // 局域网 HTTP 非安全上下文的 crypto.randomUUID polyfill：浏览器只在安全
  // 上下文（HTTPS/localhost）暴露该 API，LAN 明文 HTTP 下缺失会导致 dsh
  // client 的 RPC（mintRpcId）全部抛错。经 webServer 官方 tapIndex 钩子注入
  // （幂等，localhost 不受影响）。
  ctx.effect(() => ctx.webServer.tapIndex!((html) => {
    if (html.includes("__dshRandomUuidPolyfill__")) return html;
    const polyfill = [
      "<script id=\"__dshRandomUuidPolyfill__\">",
      "(() => {",
      "  if (typeof crypto.randomUUID === \"function\") return;",
      "  try {",
      "    crypto.randomUUID = () => {",
      "      const bytes = crypto.getRandomValues(new Uint8Array(16));",
      "      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);",
      "      view.setUint8(6, (view.getUint8(6) & 15) | 64);",
      "      view.setUint8(8, (view.getUint8(8) & 63) | 128);",
      "      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, \"0\"));",
      "      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;",
      "    };",
      "  } catch {}",
      "})();",
      "</script>",
    ].join("\n");
    return html.replace("</head>", `${polyfill}\n</head>`);
  }), "lan-proxy: randomUUID polyfill");

  // GUI 设置卡片数据面 + 存量迁移（issue #110）：settings 命名空间 attach 后——
  //   1. onScope 内先做存量 config.json rename-first 迁移（前置于一切 enabled
  //      判定，禁用用户升级同样迁移）；
  //   2. setSource 把读取来源切到 scope.get()（schema defaults → base(entry) →
  //      user 层的官方解析顺序，无双轨合并）；
  //   3. 热更新统一由 scope.watch 驱动 scheduleSync。
  installLanProxySettings(ctx, config ?? {}, {
    setSource: (source) => {
      current = source;
      // 先更新读取来源使 resolve() 用新值；重建推迟到下一轮事件循环：
      // sync() 会 dispose 当前转发器（含经 lan-proxy 转发到设置页面的连接），
      // 若在成功回执前同步重建会丢失响应（保存误报 "load failed"）。
      scheduleSync();
    },
    onChange: scheduleSync,
    onScope: (scope, service) => {
      attachedService = service;
      attachedScope = scope;
      void migrateFileConfig(configDir, scope, ctx.logger).catch((err) => {
        warnLog(ctx, `lan-proxy: 存量 config.json 迁移异常 — ${errorMessage(err)}`);
      });
    },
  });

  // 配置路由依赖装配：user 层读 describe({redactSecrets:true}) 的 descriptor
  // （raw user section 存在即「用户设过值」，revision 供乐观并发）；写走 owner
  // scope.update/replace（validate + per-ns 序列化写队列由官方服务承担）。
  const configDeps: ConfigRouteDeps = {
    resolve,
    readUser: () => {
      if (!attachedService) return { user: {}, revision: undefined };
      try {
        const descriptor = attachedService.describe({ redactSecrets: true }).find((d) => d.ns === SETTINGS_NS);
        return {
          user: (descriptor?.user && typeof descriptor.user === "object" ? descriptor.user : {}) as Record<string, unknown>,
          revision: descriptor?.revision,
        };
      } catch {
        return { user: {}, revision: undefined };
      }
    },
    writable: () => attachedService !== undefined,
    update: (patch, expectedRevision) => {
      const scope = attachedScope;
      if (!scope) return Promise.reject(new Error("settings service unavailable"));
      return scope.update(patch, expectedRevision);
    },
    replace: (section, expectedRevision) => {
      const scope = attachedScope;
      if (!scope) return Promise.reject(new Error("settings service unavailable"));
      return scope.replace(section, expectedRevision);
    },
    compress: compressSnapshot,
    // 写入异常原文只进终端日志（P2-2），响应 details 用固定文案。
    logWarn: (message) => out.warn(message),
  };

  // 配置读写路由（loopback 围栏 + GET/PUT 白名单；客户端 fetch 同源访问）。
  for (const route of buildConfigRoutes(configDeps)) {
    const routeDisposer = ctx.webServer.register(route);
    ctx.effect(() => routeDisposer, `lan-proxy: route ${route.path}`);
  }

  // health 路由（loopback 围栏 + GET 限定）。
  const healthDisposer = ctx.webServer.register({
    path: ROUTES.health,
    kind: "exact",
    handler(req, res) {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + req.method });
      const v = resolve();
      // 压缩快照与 GET /config 同源（compressSnapshot 单一来源）。
      const compress = compressSnapshot();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-lan-proxy",
        enabled: v.enabled,
        httpPort: v.port,
        httpsEnabled: v.httpsEnabled,
        httpsPort: v.httpsPort,
        listening: disposeProxy !== undefined,
        // 运行时生效的 WS 压缩配置（诊断：配置 vs 实际生效一致性）
        wsCompressEnabled: v.wsCompressEnabled,
        wsCompressPaths: v.wsCompressPaths,
        // —— HTTP 响应压缩（转发层 compression 中间件）：配置 + 生效状态 + 协商计数 ——
        ...compress,
        // —— 断连原因计数（issue #308；转发器重建后重置）——
        connStats: activeProxy?.connStats() ?? null,
        configDir,
      });
    },
  });

  ctx.effect(() => () => {
    disposed = true;
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    try {
      healthDisposer();
    } catch {
      // 忽略
    }
    if (disposeProxy) {
      disposeProxy();
      disposeProxy = undefined;
    }
  }, "lan-proxy: lifecycle");
}