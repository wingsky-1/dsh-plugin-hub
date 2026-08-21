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
import { createLanProxy, DEFAULT_OPTIONS, isLoopbackTarget, normalizeLevel } from "./proxy.js";
import type { TlsMaterials, LanProxy } from "./proxy.js";
import { ensureSelfSignedTls, loadTlsFromFiles } from "./cert.js";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson } from "../../../shared/host-utils.js";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import type { PluginContext } from "../../../types/dsh.js";

/** 稳定的 cordis 插件名。 */
export const name = "lan-proxy";

/** 等回环 web 服务器绑定并初始化后再启动。 */
export const inject = ["webServer"];

/** 与客户端共享的 health 路由（单一来源）。 */
export const ROUTES = {
  health: "/api/dsh-lan-proxy/health",
  /**
   * 合并版压缩标记路由（exact，loopback 围栏）：dsh-gzip v0.1.10+ 以本路由
   * 存在为准判定「lan-proxy 已内置 HTTP 压缩」并跳过自身安装（防双装双压）。
   */
  compression: "/api/dsh-lan-proxy/compression",
};

/** RPC 通道（客户端设置卡片 connection.rpc.call 同款）。 */
export const CHANNEL = "/dsh-lan-proxy";

/** WebSocket 压缩桥接默认路径白名单（会话事件流两个大流量端点）。 */
export const DEFAULT_WSS_COMPRESS_PATHS: readonly string[] = ["/api/events.mux", "/api/events.host"];

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
  /** WebSocket 压缩桥接总开关（默认 true）。 */
  wsCompressEnabled?: boolean;
  /** 参与 WebSocket 压缩桥接的路径白名单。 */
  wsCompressPaths?: string[];
  /** HTTP 响应 gzip 压缩总开关（默认 true；合并自 dsh-gzip）。 */
  httpCompressEnabled?: boolean;
  /** HTTP 响应 gzip 压缩级别 1..9（默认 1）。 */
  httpCompressLevel?: number;
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
  /**
   * WebSocket 压缩桥接总开关（默认开）：对 wsCompressPaths 命中的 WS 升级做
   * 「终结 + permessage-deflate」——浏览器段压缩、DSH 段明文，大流量会话事件流
   * （events.mux/events.host）经远程/慢链路访问时显著省流量。
   */
  wsCompressEnabled: z.boolean().default(true),
  /** 参与 WebSocket 压缩桥接的路径白名单（默认：会话事件流两个端点）。 */
  wsCompressPaths: z.array(z.string()).default(["/api/events.mux", "/api/events.host"]),
  /**
   * HTTP 响应 gzip 压缩总开关（默认开；合并自 dsh-gzip）：对 /api、/plugins、
   * 静态资源等可压缩响应做应用层 gzip。安装失败仅 warn 降级，不阻断转发。
   */
  httpCompressEnabled: z.boolean().default(true),
  /** HTTP 响应 gzip 压缩级别 1..9（默认 1：静态文本场景性价比最高）。 */
  httpCompressLevel: z.natural().max(9).default(1),
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
  wsCompressEnabled: (v) => typeof v === "boolean",
  wsCompressPaths: (v) => Array.isArray(v) && v.every((s) => typeof s === "string"),
  httpCompressEnabled: (v) => typeof v === "boolean",
  httpCompressLevel: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9,
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
  wsCompressEnabled: boolean;
  wsCompressPaths: readonly string[];
  httpCompressEnabled: boolean;
  httpCompressLevel: number;
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
  /** 合并版压缩标记路由的 disposer（随压缩开关在 sync() 内挂撤）。 */
  let disposeMarker: (() => void) | undefined;
  /** 当前存活转发器（health 读取压缩协商计数用）。 */
  let activeProxy: LanProxy | undefined;
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
      wsCompressEnabled: value.wsCompressEnabled ?? true,
      wsCompressPaths: value.wsCompressPaths ?? DEFAULT_WSS_COMPRESS_PATHS,
      httpCompressEnabled: value.httpCompressEnabled ?? true,
      httpCompressLevel: value.httpCompressLevel ?? 1,
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
    // HTTP 响应压缩开关（整插件关闭时标记路由一并撤下——与启动态
    // 「enabled=false 不注册任何东西」语义一致）。
    const httpCompressEnabled = value.enabled !== false && value.httpCompressEnabled !== false;
    // 合并版标记路由（exact，loopback 围栏）：dsh-gzip v0.1.10+ 据此跳过自身
    // 安装。仅压缩启用时存在——关闭压缩即撤下，gzip 兼容版会恢复接管。
    // 纯随配置状态挂撤，不依赖转发器端口解析结果。
    if (httpCompressEnabled && disposeMarker === undefined) {
      disposeMarker = ctx.webServer.register({
        kind: "exact",
        path: ROUTES.compression,
        handler(req, res) {
          if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
          if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed: " + req.method });
          writeJson(res, 200, { merged: true, plugin: "dsh-lan-proxy" });
        },
      });
    } else if (!httpCompressEnabled && disposeMarker !== undefined) {
      disposeMarker();
      disposeMarker = undefined;
    }
    if (!value.enabled) {
      return;
    }
    const targetPort = value.targetPort ?? ctx.webServer.port;
    if (targetPort === undefined) {
      ctx.logger.error("lan-proxy: webServer has no bound port yet — cannot start");
      return;
    }
    const tls = value.httpsEnabled === false ? undefined : prepareTls(value);
    // HTTP 响应压缩随转发器整体重建：配置热更新（GUI 保存 / config.json watch）
    // 走同一条 sync() 路径，无需独立拆装生命周期。
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
        httpCompress: {
          enabled: httpCompressEnabled,
          level: normalizeLevel(value.httpCompressLevel),
        },
      },
      ctx.logger,
    );
    activeProxy = proxy;
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

  /** 重建防抖：RPC 保存 / 设置变更后先把成功回执送达，再延迟重建 lan-proxy。
   *  重建会 dispose 当前转发器、断开经 lan-proxy（3443/3081）正访问的页面连接，
   *  过早重建会丢失 RPC 响应（保存误报「失败」）。延迟 3s 足够回执发出；
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
      "      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, \"0\")).join(\"\");",
      "      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;",
      "    };",
      "  } catch {}",
      "})();",
      "</script>",
    ].join("\n");
    return html.replace("</head>", `${polyfill}\n</head>`);
  }), "lan-proxy: randomUUID polyfill");

  // GUI 设置面板（设置 → 插件 → dsh-lan-proxy）：注册 settings 命名空间，
  // 使 rc.7 的 configurable 面板 serve `dsh-lan-proxy` 并分发本卡。
  // 说明：不用官方 @deepseek-ai/dsh-settings（插件运行时解析不到，会静默失败），
  // 改用共享的服务面注入 installSettingsNamespace，等值复刻官方 installSettingsSection。
  // 设置值优先于 config.json；设置未保存的键回落 config.json / 组合层 entry。
  installSettingsNamespace(ctx, "dsh-lan-proxy", Config, config ?? {}, {
    setSource: (source) => {
      // 合并：GUI 命名空间的解析值优先，未覆盖的键回落文件/组合层配置。
      // ⚠️ wsCompress 两个键例外：以持久化层（config.json，含 GUI 面板 rpc 保存的真实值）
      // 优先——否则 settings 命名空间会用 Config 的 schema 默认 true 无条件覆盖
      // config.json=false，导致「改了 false 也不生效、始终压缩」（fix）。
      current = () => {
        const s = (source as () => LanProxyConfig)();
        return {
          ...s,
          wsCompressEnabled: fileConfig.wsCompressEnabled ?? s.wsCompressEnabled,
          wsCompressPaths: fileConfig.wsCompressPaths ?? s.wsCompressPaths,
          // ⚠️ httpCompress 两个键同理：以持久化层（config.json）优先，避免
          // settings 命名空间用 schema 默认 true 无条件覆盖 config.json=false。
          httpCompressEnabled: fileConfig.httpCompressEnabled ?? s.httpCompressEnabled,
          httpCompressLevel: fileConfig.httpCompressLevel ?? s.httpCompressLevel,
        };
      };
      // 先更新读取来源使 resolve() 用新值；重建推迟到下一轮事件循环：
      // sync() 会 dispose 当前转发器（含经 lan-proxy 转发到设置面板的 RPC 长连接），
      // 若在成功回执前同步重建会丢失响应（保存误报 "load failed"）。
      scheduleSync();
    },
    onChange: scheduleSync,
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
      // 压缩随转发器在 sync() 内一并重建（幂等）。
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
      writeConfigFile(configDir, settings); // 先落盘
      fileConfig = settings; // 立即更新内存生效值（watch 触发 reload 时 JSON 相等即跳过，幂等）
      // 重建延迟（scheduleSync 防抖 3s）：sync() 会 dispose 当前转发器（含经 lan-proxy
      // 转发到页面的 RPC 长连接），若在成功回执前重建会断掉连接、丢失回执（保存误报失败）；
      // 延迟 3s 保证回执送达，再安全重建。
      scheduleSync();
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
        // 运行时生效的 WS 压缩配置（诊断：磁盘配置 vs 实际生效一致性）
        wsCompressEnabled: v.wsCompressEnabled,
        wsCompressPaths: v.wsCompressPaths,
        // 诊断：持久化层实际读到的值 + 插件目录（判断是否读错 config）
        fileWsCompressEnabled: fileConfig.wsCompressEnabled,
        // —— HTTP 响应压缩（转发层 compression 中间件）：配置 + 生效状态 + 协商计数 ——
        httpCompressEnabled: v.httpCompressEnabled,
        httpCompressLevel: v.httpCompressLevel,
        httpCompressMounted: v.enabled !== false && v.httpCompressEnabled !== false && disposeProxy !== undefined,
        httpCompressStats: activeProxy?.httpCompressStats() ?? { compressed: 0, passthrough: 0 },
        configDir,
      });
    },
  });

  ctx.effect(() => () => {
    disposed = true;
    if (syncTimer !== undefined) clearTimeout(syncTimer);
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
    // 撤下压缩标记路由（压缩随转发器重建，无独立资源需释放）。
    if (disposeMarker) {
      disposeMarker();
      disposeMarker = undefined;
    }
  }, "lan-proxy: lifecycle");
}

// 测试面 re-export（smoke 只依赖主入口，避免发布物保留内部模块）
export { createLanProxy, hostnameAllowed, formatAuthority, rewriteHeaders, isLoopbackTarget, DEFAULT_OPTIONS, compressWsPath, isCompressible, normalizeLevel } from "./proxy.js";
export { ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT } from "./cert.js";
