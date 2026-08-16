/**
 * dsh-lan-proxy — 主机端。dsh web UI 的零依赖 LAN 转发器：等回环 web 服务器
 * 绑定后，在 0.0.0.0:<port> 上监听并把 HTTP + WebSocket 转发到
 * 127.0.0.1:<webServer.port>（默认 3080），重写 Host/Origin 使 /api 浏览器
 * 信任围栏接受这些请求。
 *
 * 端口不是固定的：默认 3081，可通过两层途径修改（都实时生效）——
 *   1. GUI 设置面板（设置 → 插件 → dsh-lan-proxy）：需要 dsh-settings 服务
 *      可解析；不可解析时自动降级并打 warn 日志。
 *   2. 组合层配置（profile 的 cordis.patch.yml 覆盖 lan-proxy 行的 config，
 *      或启动时 --patch overlay）。
 *
 * 激活方式：把本包安装进某个 profile，其 cordis.patch.yml（通过
 * `dsh.bundle.patch` 声明）会插入 `lan-proxy` 这一行：
 *
 *   dsh plugin --profile web add link:<本包路径>
 *
 * 该行是普通 cordis 插件：主机端（exports "."）在宿主进程运行，注入
 * `webServer`，因此只在回环服务器监听后启动，并从 ctx.webServer.port
 * 解析真实上游端口（`--port 0` 与自定义 `--port` 均可用）。
 */
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import z from "schemastery";
import { createLanProxy, DEFAULT_OPTIONS, isLoopbackTarget } from "./proxy.js";
import type { TlsMaterials } from "./proxy.js";
import { ensureSelfSignedTls, loadTlsFromFiles } from "./cert.js";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
import type { PluginContext } from "../../../types/dsh.js";

/** 稳定的 cordis 插件名。 */
export const name = "lan-proxy";

/** 等回环 web 服务器绑定并初始化后再启动。 */
export const inject = ["webServer"];

/** 与客户端共享的 health 路由（单一来源）。 */
export const ROUTES = {
  health: "/api/dsh-lan-proxy/health",
};

/** RPC 通道（客户端设置卡片 connection.rpc.call 同款）。 */
export const CHANNEL = "/dsh-lan-proxy";

/**
 * 终端横幅输出（用户可感知信息走原生 console：cordis logger 只进内存 buffer，
 * 终端不可见——与官方 dsh web 启动横幅的 console.log 做法一致）。
 */
const out = {
  info: (...args: unknown[]) => console.log("[lan-proxy]", ...args),
  warn: (...args: unknown[]) => console.warn("[lan-proxy]", ...args),
  error: (...args: unknown[]) => console.error("[lan-proxy]", ...args),
};

/** 插件配置（loader 应用 schema 默认值后传入；apply 内仍有合并兜底）。 */
export interface LanProxyConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  /** HTTPS 监听开关（默认开启；与 HTTP 并存）。 */
  httpsEnabled?: boolean;
  /** HTTPS 监听端口（默认 3443）。 */
  httpsPort?: number;
  /** 自定义 TLS 证书 PEM 文件路径（可选；缺省自动生成自签名证书）。 */
  tlsCertFile?: string;
  /** 自定义 TLS 私钥 PEM 文件路径（可选；与 tlsCertFile 成对）。 */
  tlsKeyFile?: string;
  targetHost?: string;
  targetPort?: number;
  /** 启动时是否向终端打印监听横幅（LAN 访问地址等；默认 true）。 */
  printBanner?: boolean;
}

/** 插件配置，由同名 schemastery schema 校验，也用于 GUI 设置面板渲染。 */
export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** LAN 绑定地址。 */
  host: z.string().default(DEFAULT_OPTIONS.host),
  /** LAN 监听端口（不是固定值，默认 3081）。 */
  port: z.natural().max(65535).default(DEFAULT_OPTIONS.port),
  /** HTTPS 监听开关（默认开启；与 HTTP 并存，转发逻辑一致）。 */
  httpsEnabled: z.boolean().default(true),
  /** HTTPS 监听端口（默认 3443）。 */
  httpsPort: z.natural().max(65535).default(DEFAULT_OPTIONS.httpsPort),
  /**
   * 自定义 TLS 证书 PEM 文件路径（可选）。提供 tlsCertFile + tlsKeyFile
   * 时使用该证书（正式证书 / mkcert 本地 CA 证书）；缺省时自动生成
   * 自签名证书并缓存到 <DSH_HOME>/lan-proxy/。
   */
  tlsCertFile: z.string(),
  /** 自定义 TLS 私钥 PEM 文件路径（可选；与 tlsCertFile 成对）。 */
  tlsKeyFile: z.string(),
  /** 回环上游主机。 */
  targetHost: z.string().default(DEFAULT_OPTIONS.targetHost),
  /**
   * 上游端口；缺省时取 web 服务器实际绑定端口（ctx.webServer.port），
   * 因此无需配置即可跟随 `--port` 变化。schemastery 中不带 `.required()`
   * 的字段默认可选（3.18 无 `.optional()` 方法）。
   */
  targetPort: z.natural().max(65535),
  /** 启动横幅（终端 console.log；默认开，可经 GUI 设置面板关闭）。 */
  printBanner: z.boolean().default(true),
});

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

/** 插件目录（<DSH_HOME>/lan-proxy）：证书缓存 + 插件自身配置文件。 */
export function pluginDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lan-proxy");
}

/** config.json 允许的键及其类型校验（未知键/类型非法一律丢弃）。 */
const FILE_CONFIG_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  enabled: (v) => typeof v === "boolean",
  host: (v) => typeof v === "string",
  port: (v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535,
  httpsEnabled: (v) => typeof v === "boolean",
  httpsPort: (v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535,
  tlsCertFile: (v) => typeof v === "string",
  tlsKeyFile: (v) => typeof v === "string",
  targetHost: (v) => typeof v === "string" && isLoopbackTarget(v),
  targetPort: (v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535,
  printBanner: (v) => typeof v === "boolean",
};

/**
 * 读取插件目录配置文件（<dir>/config.json）。
 * 未知键丢弃、类型非法丢弃；文件缺失或 JSON 解析失败返回空对象
 * （调用方用默认值兜底）。导出供单测。
 */
export function loadFileConfig(dir: string): Partial<LanProxyConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<LanProxyConfig> = {};
  for (const key of Object.keys(FILE_CONFIG_VALIDATORS)) {
    const value = src[key];
    if (value !== undefined && FILE_CONFIG_VALIDATORS[key](value)) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * 原子写插件目录配置文件（tmp + rename）：GUI 设置卡片保存落点。
 * 写文件本身会触发 configWatcher（tmp 名被过滤，rename 到 config.json
 * 才命中），与 apply 内主动 sync 幂等兜底。
 * @param dir - 插件目录（<DSH_HOME>/lan-proxy）。
 * @param settings - 已净化（sanitize）的配置子集。
 */
export function writeConfigFile(dir: string, settings: Partial<LanProxyConfig>): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `config.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, join(dir, "config.json"));
}

/** resolve() 合并后的完整生效配置（RPC state 展示用）。 */
export interface ResolvedConfig {
  enabled: boolean;
  host: string;
  port: number;
  httpsEnabled: boolean;
  httpsPort: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  targetHost: string;
  targetPort?: number;
  printBanner: boolean;
}

/** RPC 通道依赖（apply 内注入；smoke 可直接构造单测）。 */
export interface RpcDeps {
  /** 当前生效配置（含默认值兜底）。 */
  resolve: () => ResolvedConfig;
  /** 持久化层（config.json）当前内容——客户端编辑的落点。 */
  fileConfig: () => Partial<LanProxyConfig>;
  /** 保存新配置：原子写 config.json 并立即生效（watch 幂等兜底）。 */
  save: (settings: Partial<LanProxyConfig>) => void;
}

/** RPC 结果信封（客户端 connection.rpc.call 约定）。 */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; details: string } };

/**
 * 净化客户端提交的配置：只接受已知键；任一键类型非法 → 整体拒绝（返回 null，
 * 避免静默丢键造成"保存了但没生效"的困惑）；空字符串证书路径 = 显式清除
 * （恢复自签证书）。
 */
export function sanitizeSettings(raw: unknown): Partial<LanProxyConfig> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<LanProxyConfig> = {};
  for (const key of Object.keys(FILE_CONFIG_VALIDATORS)) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (!FILE_CONFIG_VALIDATORS[key](value)) return null;
    if ((key === "tlsCertFile" || key === "tlsKeyFile") && value === "") continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * 设置卡片 RPC handler：state（读持久化层 + 生效值）/ config（保存并热更新）。
 * 导出供 smoke 单测（fake deps，不依赖网络）。
 */
export function rpcHandler(deps: RpcDeps): (endpoint: string, payload: unknown) => Promise<RpcResult> {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case "state": {
          return { ok: true, value: { settings: deps.fileConfig(), effective: deps.resolve() } };
        }
        case "config": {
          const settings = sanitizeSettings((payload as { settings?: unknown } | null | undefined)?.settings);
          if (settings === null) {
            return { ok: false, error: { code: "invalid", details: "非法配置值（未知键或类型错误）" } };
          }
          if (Boolean(settings.tlsCertFile) !== Boolean(settings.tlsKeyFile)) {
            return { ok: false, error: { code: "tls-pair", details: "证书文件与私钥文件必须成对提供（或都留空以使用自签名证书）" } };
          }
          deps.save(settings);
          return { ok: true, value: { settings } };
        }
        default:
          return { ok: false, error: { code: "unknown", details: String(endpoint) } };
      }
    } catch (e) {
      return {
        ok: false,
        error: { code: "error", details: String(((e as { message?: unknown } | null | undefined)?.message) ?? e) },
      };
    }
  };
}

/** connection 注入上下文的宽松接口（仅 RPC 通道所需的最小面）。 */
interface ConnectionCtx {
  connection: {
    rpc: {
      handle(channel: string, h: unknown, opts: { authority?: string }): unknown;
    };
  };
  effect<T>(fn: () => T, label?: string): unknown;
  [key: string]: unknown;
}

/**
 * 挂载 LAN 转发器。配置来源（GUI 设置优先、组合层 entry 兜底）变化时通过
 * sync 重建转发器，实现端口等配置的热更新。
 *
 * 注意：apply 必须同步返回——转发器在 sync() 里立即启动，GUI 设置面板的
 * 注册通过动态 import 异步补挂（失败仅降级 warn）。若把动态 import 放在
 * apply 里 await，真实加载器环境下该 import 可能挂起，导致转发器永不启动。
 * @param ctx 携带已初始化 webServer 服务的宿主插件上下文。
 * @param config 解析后的插件配置（loader 已应用 schema 默认值）。
 * @returns 无。
 */
export function apply(ctx: PluginContext, config: LanProxyConfig = {}): void {
  if (config.enabled === false) return;
  // 插件目录（<DSH_HOME>/lan-proxy）：证书缓存 + 插件自身配置文件 config.json。
  const configDir = pluginDir();
  mkdirSync(configDir, { recursive: true });
  /** 插件目录配置文件（config.json）——静态配置，优先级：GUI 设置 > config.json > 组合层 entry > 默认值。 */
  let fileConfig = loadFileConfig(configDir);
  /** 配置实时来源：GUI 设置注册后优先，否则为组合层 entry + 插件配置文件。 */
  let current: () => LanProxyConfig = () => ({ ...config, ...fileConfig });
  let disposeProxy: (() => void) | undefined;
  let disposed = false;
  /** 上一次打印的横幅（防刷屏：监听结果没变化不重复打印）。 */
  let lastBanner = "";

  /** 合并默认值，得到一份完整配置。 */
  const resolve = () => {
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
    };
  };

  /**
   * 准备 TLS 材料：用户配置了 tlsCertFile/tlsKeyFile 则加载文件，
   * 否则自动生成（或复用缓存里的）自签名证书。返回 undefined 表示
   * HTTPS 不可用（缺配置或证书准备失败），调用方降级为 HTTP-only。
   */
  const prepareTls = (value: ReturnType<typeof resolve>): TlsMaterials | undefined => {
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
    if (!value.enabled) return;
    const targetPort = value.targetPort ?? ctx.webServer.port;
    if (targetPort === undefined) {
      ctx.logger.error("lan-proxy: webServer has no bound port yet — cannot start");
      return;
    }
    const tls = value.httpsEnabled === false ? undefined : prepareTls(value);
    const proxy = createLanProxy(
      {
        host: value.host,
        port: value.port,
        httpsPort: value.httpsPort,
        tls,
        targetHost: value.targetHost,
        targetPort,
      },
      ctx.logger,
    );
    proxy
      .listen()
      .then(({ httpPort, httpsPort }) => {
        // 终端横幅：3 行式（监听 / HTTPS / LAN 访问），参考官方 dsh web 启动横幅
        // 的 console.log 做法；监听结果没变化不重复打印（防 config 热更新刷屏）。
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

  // 转发器立即启动（不依赖任何异步解析）。
  sync();

  // 局域网 HTTP 非安全上下文的 crypto.randomUUID polyfill + 显式信任开关：
  // 1) randomUUID：浏览器只在安全上下文（HTTPS/localhost）暴露，LAN 明文
  //    HTTP 下缺失会导致 dsh client 的 RPC（mintRpcId）全部抛错；
  // 2) __dshTrustedLan：配合 dsh-client-connection 的 isLoopback 补丁
  //    （scripts/patch-dsh-connection.mjs），让内网设备获得与回环一致的
  //    settings 读写（主题等持久化）。两者都通过 webServer 官方 tapIndex
  //    钩子注入（幂等，localhost 不受影响）。
  ctx.effect(() => ctx.webServer.tapIndex!((html) => {
    if (html.includes("__dshRandomUuidPolyfill__")) return html;
    const polyfill = [
      "<script id=\"__dshRandomUuidPolyfill__\">",
      "(() => {",
      "  try { window.__dshTrustedLan = true; } catch {}",
      "  if (typeof crypto.randomUUID === \"function\") return;",
      "  try {",
      "    crypto.randomUUID = () => {",
      "      const bytes = crypto.getRandomValues(new Uint8Array(16));",
      "      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);",
      "      view.setUint8(6, (view.getUint8(6) & 15) | 64);",
      "      view.setUint8(8, (view.getUint8(8) & 63) | 128);",
      "      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, \"0\")).join(\"\");",
      "      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;",
      "    };",
      "  } catch {}",
      "})();",
      "</script>",
    ].join("\n");
    return html.replace("</head>", `${polyfill}\n</head>`);
  }), "lan-proxy: randomUUID polyfill");

  // GUI 设置面板（设置 → 插件 → dsh-lan-proxy）：异步补挂，解析失败仅降级。
  // 设置值优先于 config.json；设置未保存的键回落 config.json / 组合层 entry。
  import("@deepseek-ai/dsh-settings")
    .then(({ installSettingsSection, settingsNamespace }) => {
      installSettingsSection(ctx, settingsNamespace("dsh-lan-proxy"), Config, config ?? {}, {
        setSource: (source) => {
          current = () => ({ ...fileConfig, ...(source as () => LanProxyConfig)() });
          sync();
        },
        onChange: sync,
      });
    })
    .catch((err) => {
      ctx.logger.warn(`lan-proxy: @deepseek-ai/dsh-settings unavailable (${err.code ?? err.message}) — GUI settings disabled; configure via config.json or cordis.patch.yml instead`);
    });

  // 插件目录 config.json 热更新（编辑保存即重建转发器，无需重启）。
  // 防抖 150ms：编辑器原子写（tmp+rename）可能触发多次事件，合并为一次重建。
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      const next = loadFileConfig(configDir);
      if (JSON.stringify(next) === JSON.stringify(fileConfig)) return;
      fileConfig = next;
      ctx.logger.info("lan-proxy: config.json changed — reloading");
      sync();
    }, 150);
  };
  const configWatcher = watch(configDir, (_event, filename) => {
    if (filename !== "config.json") return;
    scheduleReload();
  });
  configWatcher.on("error", (err) => ctx.logger.warn(`lan-proxy: config watch error: ${err.message}`));

  // RPC 通道（客户端设置卡片读状态 / 保存配置；authority: loopback 防非回环调用）。
  // 持久化落点就是插件目录 config.json —— 复用上方 configWatcher 实现保存后热更新。
  const handleRpc = rpcHandler({
    resolve,
    fileConfig: () => fileConfig,
    save: (settings) => {
      writeConfigFile(configDir, settings);
      fileConfig = settings; // 立即生效；watch 触发 reload 时 JSON 相等即跳过（幂等）
      sync();
    },
  });
  (ctx.inject as unknown as (services: string[], fn: (c: ConnectionCtx) => void) => void)(
    ["connection"],
    (connectionCtx) => {
      connectionCtx.effect(
        () => connectionCtx.connection.rpc.handle(CHANNEL, handleRpc, { authority: "loopback" }),
        "lan-proxy: rpc"
      );
    }
  );

  // health 路由（loopback 围栏 + GET 限定）。
  const routeDisposer = ctx.webServer.register({
    path: ROUTES.health,
    kind: "exact",
    handler(req, res) {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + req.method });
      const v = resolve();
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-lan-proxy",
        enabled: v.enabled,
        httpPort: v.port,
        httpsEnabled: v.httpsEnabled,
        httpsPort: v.httpsPort,
        listening: disposeProxy !== undefined,
      });
    },
  });

  ctx.effect(() => () => {
    disposed = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    configWatcher.close();
    try {
      routeDisposer();
    } catch {
      // 忽略
    }
    if (disposeProxy) {
      disposeProxy();
      disposeProxy = undefined;
    }
  }, "lan-proxy: lifecycle");
}

// 测试面 re-export（smoke 只依赖主入口，避免发布物保留内部模块）
export { createLanProxy, hostnameAllowed, formatAuthority, rewriteHeaders, isLoopbackTarget, DEFAULT_OPTIONS } from "./proxy.js";
export { ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT } from "./cert.js";
