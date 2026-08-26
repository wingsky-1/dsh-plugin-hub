/**
 * dsh-lan-proxy — 主机端。dsh web UI 的零依赖 LAN 转发器：等回环 web 服务器
 * 绑定后，在 0.0.0.0:<port> 上监听并把 HTTP + WebSocket 转发到
 * 127.0.0.1:<webServer.port>（默认 3080），重写 Host/Origin 使 /api 浏览器
 * 信任围栏接受这些请求。
 *
 * 端口不是固定的：默认 3081，可通过两层途径修改（都实时生效）——
 *   1. GUI 设置卡片（设置 → 插件 → dsh-lan-proxy）：经 loopback HTTP 配置路由
 *      写入官方 settings 命名空间（scope.update/replace），scope.watch 触发热更新；
 *      settings 服务不可解析时自动降级并打 warn 日志。
 *   2. 组合层配置（profile 的 cordis.patch.yml 覆盖 lan-proxy 行的 config，
 *      或启动时 --patch overlay）——作为 settings 命名空间的 base 层生效。
 *
 * 配置单一通道（issue #110）：不再维护自建 `~/.dsh/lan-proxy/config.json` 与
 * RPC state/config 端点；配置一律存官方 settings 存储（settings.register 注册的
 * `dsh-lan-proxy` 命名空间，owner scope get/watch/update/replace）。存量
 * config.json 在 settings 服务 attach 后做一次性 marker 迁移（原子改名
 * `config.json.migrated.bak` 幂等标记 → 校验过滤 → scope.update 增量写入，
 * 失败回滚改名）；此后手改 config.json 不再生效。
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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import z from "schemastery";
import { createLanProxy, DEFAULT_OPTIONS, isLoopbackTarget } from "./proxy.js";
import type { TlsMaterials, LanProxy } from "./proxy.js";
import { ensureSelfSignedTls, loadTlsFromFiles } from "./cert.js";
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";
// 官方类型层（issue #16/#48，锁版见 pnpm-workspace catalog；仅 import type，
// 编译期擦除，禁止运行时值导入——contract-check 有门禁）。dsh-host-webserver
// 经 declare module 注入 ctx.webServer，必须引入其类型面。
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

/** 稳定的 cordis 插件名。 */
export const name = "lan-proxy";

/** 等回环 web 服务器绑定并初始化后再启动。 */
export const inject = ["webServer"];

/** 与客户端共享的路由（单一来源）。 */
export const ROUTES = {
  health: "/api/dsh-lan-proxy/health",
  /** 配置读写路由：GET 快照 / PUT patch（loopback 围栏）。 */
  config: "/api/dsh-lan-proxy/config",
};

/** WebSocket 压缩桥接默认路径白名单（会话事件流两个大流量端点）。 */
export const DEFAULT_WSS_COMPRESS_PATHS: readonly string[] = ["/api/events.mux", "/api/events.host"];

/** 本插件在官方 settings 服务中的命名空间。 */
export const SETTINGS_NS = "dsh-lan-proxy";

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
  /** HTTP 响应压缩总开关（默认 true；合并自 dsh-gzip）。经 compression 中间件按 Accept-Encoding 协商，Brotli/gzip 双生效。 */
  httpCompressEnabled?: boolean;
  /** 压缩档位预设 0..3（默认 1 低）：0 默认 / 1 低 / 2 中 / 3 高，对 gzip 与 Brotli 同时生效。 */
  httpCompressLevel?: number;
}

/** HTTP 压缩运行快照（issue #33 子项 3：GUI 可见的压缩生效状态）。 */
export interface HttpCompressSnapshot {
  /** 配置意图：HTTP 响应压缩开关。 */
  httpCompressEnabled: boolean;
  /** 压缩档位预设 0..3。 */
  httpCompressLevel: number;
  /** 是否实际挂载在存活转发器上（enabled 且配置开启且转发器监听中）。 */
  httpCompressMounted: boolean;
  /** 协商计数（compressed = 按协商压缩/计入口径，passthrough = 豁免直通）。 */
  httpCompressStats: { compressed: number; passthrough: number };
}

/** 插件配置，由同名 schemastery schema 校验，也用于 GUI 设置面板渲染。
 * 显式注解：官方类型层与本包 devDep schemastery 各带同名全局命名空间合并后，
 * Config 的推断类型声明发射不再可移植（TS2883），按 TS 建议显式标注。 */
export const Config: z<LanProxyConfig> = z.object({
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
  /** 压缩档位预设 0..3（默认 1 低）：0 默认 / 1 低 / 2 中 / 3 高，对 gzip 与 Brotli 同时生效（见 proxy.resolveCompressionOptions 映射）。 */
  httpCompressLevel: z.natural().max(3).default(1),
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

/** 插件目录（<DSH_HOME>/lan-proxy）：自签名证书缓存 + 存量迁移备份所在。 */
export function pluginDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lan-proxy");
}

/**
 * 允许的配置键及其类型校验（未知键/类型非法一律丢弃）。
 * 双重身份（issue #110 后）：① 存量 config.json 迁移过滤器；
 * ② 客户端提交 patch 的校验器。键集合与 SETTING_FIELD_HINTS 平行维护。
 */
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
  httpCompressLevel: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3,
};

/**
 * 净化提交的配置（迁移过滤与客户端保存共用）：只接受已知键；任一键类型非法 →
 * 整体拒绝（返回 null，避免静默丢键造成"保存了但没生效"的困惑）；空字符串
 * 证书路径被剔除（保存通道据 raw 判定清除语义，迁移场景等价于未设置）。
 */
export function sanitizeSettings(raw: unknown): Partial<LanProxyConfig> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<LanProxyConfig> = {};
  for (const key of Object.keys(FILE_CONFIG_VALIDATORS)) {
    let value = src[key];
    // 旧档位（0..9）迁移：整数 4..9 视为「高」档；其余仍走校验器
    if (key === "httpCompressLevel" && typeof value === "number" && Number.isInteger(value) && value > 3 && value <= 9) value = 3;
    if (value === undefined || value === null) continue;
    if (!FILE_CONFIG_VALIDATORS[key](value)) return null;
    if ((key === "tlsCertFile" || key === "tlsKeyFile") && value === "") continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * 各配置键的合法范围描述（issue #33 子项 1）：校验失败时向用户指明
 * 「哪个字段、合法值是什么」，替代原先硬编码的整体拒绝文案。
 * 与 FILE_CONFIG_VALIDATORS 平行维护；键集合一致（同一批 Object.keys 遍历）。
 */
const SETTING_FIELD_HINTS: Record<string, string> = {
  enabled: "需为布尔值",
  host: "需为字符串",
  port: "需为 1-65535 的整数",
  httpsEnabled: "需为布尔值",
  httpsPort: "需为 1-65535 的整数",
  tlsCertFile: "需为字符串（PEM 文件路径，留空 = 自签名证书）",
  tlsKeyFile: "需为字符串（PEM 文件路径，留空 = 自签名证书）",
  targetHost: "需为回环地址或主机名",
  targetPort: "需为 1-65535 的整数",
  printBanner: "需为布尔值",
  wsCompressEnabled: "需为布尔值",
  wsCompressPaths: "需为字符串数组（路径白名单）",
  httpCompressEnabled: "需为布尔值",
  httpCompressLevel: "需为 0-3 的档位整数（4-9 自动迁移为高档 3）",
};

/** validateSettings 的校验结果：null = 全部合法。 */
export interface SettingInvalid {
  /** 首个非法的配置键名。 */
  key: string;
  /** 该键的合法范围描述（面向用户的文案）。 */
  hint: string;
}

/**
 * 校验客户端提交的配置（不净化）：返回首个非法键与其合法范围，全部合法返回
 * null（issue #33 子项 1）。遍历顺序与 sanitizeSettings 一致（FILE_CONFIG_VALIDATORS
 * 键序），保证「首个非法键」口径相同。导出供 smoke 单测。
 */
export function validateSettings(raw: unknown): SettingInvalid | null {
  if (typeof raw !== "object" || raw === null) return { key: "(payload)", hint: "需为配置对象" };
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(FILE_CONFIG_VALIDATORS)) {
    const value = src[key];
    // 与 sanitizeSettings 同口径：旧档位整数 4..9 先迁移再校验。
    const normalized =
      key === "httpCompressLevel" && typeof value === "number" && Number.isInteger(value) && value > 3 && value <= 9
        ? 3
        : value;
    if (normalized === undefined || normalized === null) continue;
    if (!FILE_CONFIG_VALIDATORS[key](normalized)) {
      return { key, hint: SETTING_FIELD_HINTS[key] ?? "类型非法" };
    }
  }
  return null;
}

/** resolve() 合并后的完整生效配置（GET /config 的 effective 展示用）。 */
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

// ---------------------------------------------------------------------------
// 官方 settings 命名空间接线（issue #110：包内实现，不动 shared/ 契约层）
// ---------------------------------------------------------------------------

/**
 * 是否正处于插件自身 fiber 卸载中（区别于「仅丢失 settings 服务」）。
 * 与 shared/settings-namespace.js 同款判据：fiber.state ∈ { unloading, unloaded,
 * disposed }。（包内复刻：coder 规程禁止改 shared/，而 owner scope 写能力需要
 * 拿到 register 返回值，shared 版 hooks 不外露 scope。）
 */
function isUnloading(ctx: unknown): boolean {
  const fiber =
    ctx && typeof ctx === "object" && "fiber" in ctx
      ? (ctx as { fiber?: { state?: unknown } }).fiber
      : undefined;
  const state = fiber && typeof fiber === "object" ? fiber.state : undefined;
  return state === "unloading" || state === "unloaded" || state === "disposed";
}

/** 日志兜底：logger 可能确实没有（极端降级），全部可选调用。 */
function warnLog(ctx: unknown, message: string): void {
  const logger =
    ctx && typeof ctx === "object" && "logger" in ctx
      ? (ctx as { logger?: { warn?: (...a: unknown[]) => void } }).logger
      : undefined;
  if (typeof logger?.warn === "function") logger.warn(message);
}

/**
 * owner scope 最小类型面（官方 SettingsScope<T> 的子集；仅 import type 无法
 * 从运行时拿到该包，这里按 @deepseek-ai/dsh-settings@0.1.1-rc.2 类型层收窄）。
 */
export interface OwnerScopeLike {
  /** 当前解析值（schema defaults → base → user 层）。 */
  get(): LanProxyConfig;
  /** 提交后异步串行回调，返回 disposer。 */
  watch(cb: (next: LanProxyConfig, prev: LanProxyConfig) => void): () => void;
  /** 增量 merge patch 进 user 层并持久化。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
  /** 整节替换 user 层，缺省键回落 base/schema 默认。 */
  replace(section: object, expectedRevision?: number): Promise<void>;
}

/** settings 服务最小类型面（register/describe）。 */
interface SettingsServiceLike {
  register(ns: string, schema: unknown, options?: { base?: unknown }): OwnerScopeLike;
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown; revision: number }>;
}

/** installLanProxySettings 的 hooks 面（含 onScope：attach 后交出 owner scope）。 */
export interface LanProxySettingsHooks {
  /** 把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。 */
  setSource(source: () => LanProxyConfig): void;
  /** 来源切换或命名空间值变化时触发，插件据此刷新/重建转发器。 */
  onChange(): void;
  /** scope attach 后回调（迁移在此执行）；服务缺失时不触发。 */
  onScope(scope: OwnerScopeLike, service: SettingsServiceLike): void;
}

/**
 * 注册插件自有 settings 命名空间并把 owner scope 交给调用方
 * （服务面注入，零包依赖；语义等值复刻官方 installSettingsSection 与
 * shared/installSettingsNamespace——差异仅在把 register 返回的 owner scope
 * 经 onScope 外露，供存量配置迁移写入）。
 *
 * 为什么不用官方 @deepseek-ai/dsh-settings 包：插件运行时沿自身 lib/ 向上
 * 解析不到该包（MODULE_NOT_FOUND），动态 import 会静默失败——与
 * shared/settings-namespace.js 相同的服务面注入方案。
 *
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param entry - 组合层配置，作为命名空间的 base 层。
 * @param hooks - source 收藏、变更通知与 scope 移交。
 */
export function installLanProxySettings(ctx: Context, entry: LanProxyConfig, hooks: LanProxySettingsHooks): void {
  type InjectFn = (services: string[], fn: (c: any) => void) => void;
  if (typeof (ctx as unknown as { inject?: InjectFn })?.inject !== "function") {
    warnLog(ctx, `${SETTINGS_NS}: ctx.inject 不可用 — 设置命名空间未注册，设置卡降级`);
    return;
  }
  (ctx.inject as unknown as InjectFn)(["settings"], (sctx) => {
    const settings = sctx && (sctx.settings as SettingsServiceLike | undefined);
    if (!settings || typeof settings.register !== "function") {
      warnLog(ctx, `${SETTINGS_NS}: settings 服务缺少 register 能力 — 设置命名空间未注册，设置卡降级`);
      return;
    }
    let scope: OwnerScopeLike;
    try {
      scope = settings.register(SETTINGS_NS, Config, { base: entry });
    } catch (err) {
      warnLog(ctx, `${SETTINGS_NS}: settings.register 失败 — ${errorMessage(err)}`);
      return;
    }
    hooks.onScope(scope, settings);
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    // 热更新统一走官方 scope.watch（提交后异步串行回调）。
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
  });
}

// ---------------------------------------------------------------------------
// 存量 config.json 一次性迁移（rename-first marker，幂等）
// ---------------------------------------------------------------------------

/** 迁移备份文件名（同时是幂等标记：存在即「已处理过」）。 */
export const MIGRATED_BAK_NAME = "config.json.migrated.bak";

/** migrateFileConfig 的结果（导出供单测断言）。 */
export interface MigrationOutcome {
  /** 本次是否执行了改名标记（false = config.json 不存在，或仅从中断态重放）。 */
  performed: boolean;
  /** 是否有有效键写入了 owner scope（含中断态重放成功）。 */
  migrated: boolean;
  /** 写入失败后是否已回滚改名（config.json 已还原）。 */
  rolledBack: boolean;
  /** 损坏/空 JSON：仅改名标记、不写入（防固化 schema 默认值）。 */
  skippedCorrupt: boolean;
  /** 本次是否为中断态重放（.bak 存在且 config.json 不存在）。 */
  resumed: boolean;
}

/**
 * 中断态重放：上次「改名成功 → scope.update 完成前」进程被杀的现场是
 * `.bak` 存在且 `config.json` 不存在——此时不能按幂等跳过（否则配置永滞
 * .bak 且无提示），视为未完成迁移，从 bak 重放「解析→sanitize→scope.update」。
 * 成功后保留 bak（update 同值 merge 幂等，后续启动重放无害）；损坏/无效/
 * 写入失败则 warn 明示手动恢复路径。
 */
async function resumeMigrateFromBak(
  bakPath: string,
  scope: Pick<OwnerScopeLike, "update">,
  logger?: { warn?: (...a: unknown[]) => void },
): Promise<MigrationOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bakPath, "utf8"));
  } catch {
    logger?.warn?.(`lan-proxy: 检测到上次未完成的迁移残留 ${MIGRATED_BAK_NAME}，但文件不是合法 JSON — 无法自动恢复，请手动检查该文件（原始 config.json 内容应在其内）或删除它`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: true };
  }
  const sanitized =
    typeof parsed === "object" && parsed !== null ? sanitizeSettings(parsed) : null;
  if (sanitized === null || Object.keys(sanitized).length === 0) {
    logger?.warn?.(`lan-proxy: 上次未完成的迁移残留 ${MIGRATED_BAK_NAME} 无可迁移的有效键 — 已跳过，确认无误后可手动删除该文件`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: true };
  }
  try {
    await scope.update(sanitized as Record<string, unknown>);
    logger?.warn?.(`lan-proxy: 检测到上次未完成的迁移 — 已从 ${MIGRATED_BAK_NAME} 重放写入设置；确认运行正常后可手动删除该备份`);
    return { performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, resumed: true };
  } catch (err) {
    logger?.warn?.(`lan-proxy: 未完成的迁移从 ${MIGRATED_BAK_NAME} 重放写入设置失败（${errorMessage(err)}）— 配置仍保留在该备份中，请排查后重启重试，或手动将其内容恢复到设置`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: true };
  }
}

/**
 * 存量 config.json 一次性迁移到官方 settings 命名空间（rename-first marker）。
 *
 * 时序（issue #110 修订路线）：
 * 0. 中断态（`.bak` 存在且 `config.json` 不存在，即上次改名后写入未完成）→
 *    从 bak 重放写入（见 resumeMigrateFromBak），不静默跳过；
 * 1. `config.json` 不存在（且无中断态残留）→ 直接返回（幂等：二次启动跳过）；
 * 2. 先原子改名 `config.json` → `config.json.migrated.bak`（POSIX rename 原子；
 *    Windows 目标已存在会抛错，故先 unlink 旧 bak——bak 仅是保险副本，被新的
 *    用户手动恢复内容取代可接受）；改名成功即视为「已处理」，无论后续成败；
 * 3. 解析 bak：损坏/非对象/无有效键 → 到此为止（只标记不写入，避免把 schema
 *    默认值固化进用户层、压制后续默认值演进）；
 * 4. sanitizeSettings 过滤后经 owner scope.update 增量写入（只写文件里显式
 *    存在的键，schema 默认保持动态兜底——spike 结论优先 update，replace 仅当
 *    需要整节割接时使用）；
 * 5. 写入失败 → 回滚改名（bak 还原为 config.json）并 warn，下次启动重试。
 *
 * 必须在 settings 服务 attach 后调用（installLanProxySettings 的 onScope 内），
 * 且先于任何 enabled 早退——禁用用户跨版本升级同样要完成迁移。
 */
export async function migrateFileConfig(
  configDir: string,
  scope: Pick<OwnerScopeLike, "update">,
  logger?: { warn?: (...a: unknown[]) => void },
): Promise<MigrationOutcome> {
  const cfgPath = join(configDir, "config.json");
  const bakPath = join(configDir, MIGRATED_BAK_NAME);
  // 中断态优先于幂等判定：config.json 与 .bak 同时不存在才是真正的已迁移稳态。
  if (!existsSync(cfgPath)) {
    if (existsSync(bakPath)) return resumeMigrateFromBak(bakPath, scope, logger);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: false };
  }
  // Windows 上 rename 到已存在目标会抛错；先移除历史 bak（见函数注释）。
  if (existsSync(bakPath)) unlinkSync(bakPath);
  renameSync(cfgPath, bakPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bakPath, "utf8"));
  } catch {
    logger?.warn?.(`lan-proxy: 存量 config.json 不是合法 JSON — 仅标记为已迁移（${MIGRATED_BAK_NAME}），不写入设置`);
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    logger?.warn?.(`lan-proxy: 存量 config.json 不是配置对象 — 仅标记为已迁移（${MIGRATED_BAK_NAME}），不写入设置`);
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  const sanitized = sanitizeSettings(parsed);
  if (sanitized === null) {
    // 含类型非法值：整体不写入（与保存通道同口径，宁可不迁也不迁一半）。
    logger?.warn?.(`lan-proxy: 存量 config.json 含非法配置值 — 仅标记为已迁移（${MIGRATED_BAK_NAME}），不写入设置`);
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  if (Object.keys(sanitized).length === 0) {
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  try {
    await scope.update(sanitized as Record<string, unknown>);
    return { performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, resumed: false };
  } catch (err) {
    // 写入失败：回滚改名，让下次启动重试（数据始终存在于 config.json 或 bak 之一）。
    try {
      if (!existsSync(cfgPath)) renameSync(bakPath, cfgPath);
    } catch (rollbackErr) {
      logger?.warn?.(`lan-proxy: 迁移回滚失败（${errorMessage(rollbackErr)}）— 数据保留在 ${MIGRATED_BAK_NAME}，请手动恢复`);
    }
    logger?.warn?.(`lan-proxy: 存量 config.json 迁移写入设置失败（${errorMessage(err)}）— 已回滚，下次启动重试`);
    return { performed: true, migrated: false, rolledBack: true, skippedCorrupt: false, resumed: false };
  }
}

// ---------------------------------------------------------------------------
// loopback HTTP 配置路由（GET 快照 / PUT patch）
// ---------------------------------------------------------------------------

/** buildConfigRoutes 的依赖注入面（apply 内装配；smoke 用 fake 直接构造）。 */
export interface ConfigRouteDeps {
  /** 当前生效配置（含默认值兜底）。 */
  resolve(): ResolvedConfig;
  /** 用户层原始节与 revision（descriptor.user / descriptor.revision）。 */
  readUser(): { user: Record<string, unknown>; revision?: number };
  /** settings 服务是否可用（决定 PUT 是否可写）。 */
  writable(): boolean;
  /** 增量 merge patch 进用户层。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
  /** 整节替换用户层（清除证书路径的 unset 语义）。 */
  replace(section: object, expectedRevision?: number): Promise<void>;
  /** HTTP 压缩运行快照。 */
  compress(): HttpCompressSnapshot;
  /** 服务端日志兜底（写入异常原文只进日志，不进响应 details）。 */
  logWarn?(message: string): void;
}

/** applyConfigPatch 的结果。 */
export type PatchResult =
  | { ok: true; value: { user: Record<string, unknown>; revision?: number } }
  | { ok: false; status: number; code: string; details: string };

/** 清除证书路径时需要从用户层剔除的键（空字符串 = 显式清除，恢复自签名）。 */
const TLS_PAIR_KEYS = ["tlsCertFile", "tlsKeyFile"] as const;

/**
 * 配置保存纯函数（PUT /config 的主体，独立导出供 smoke 单测）：
 * validate 定位首个非法键 → sanitize 净化 → tls 成对校验 → 写入官方存储。
 * 默认走 update 增量 merge；仅当 raw patch 以空字符串表达「清除证书路径」时
 * 走 replace（update 是 merge 语义无法 unset，owner scope 无 mutate 面）：
 * 从当前用户层复制全节、剔除被清除的键后整节替换，其余语义不变。
 */
export async function applyConfigPatch(deps: ConfigRouteDeps, payload: unknown): Promise<PatchResult> {
  if (!deps.writable()) {
    return { ok: false, status: 503, code: "settings-unavailable", details: "settings 服务不可用，无法保存配置" };
  }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    patch?: unknown;
    expectedRevision?: unknown;
  };
  const expectedRevision =
    typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision) ? body.expectedRevision : undefined;
  const rawPatch = body.patch;
  // 先定位首个非法键（issue #33 子项 1）：错误文案指明字段与合法范围。
  const invalid = validateSettings(rawPatch);
  if (invalid !== null) {
    return { ok: false, status: 400, code: "invalid", details: `配置项「${invalid.key}」非法：${invalid.hint}` };
  }
  const sanitized = sanitizeSettings(rawPatch);
  if (sanitized === null) {
    return { ok: false, status: 400, code: "invalid", details: "非法配置值（未知键或类型错误）" };
  }
  const rawSrc = (typeof rawPatch === "object" && rawPatch !== null ? rawPatch : {}) as Record<string, unknown>;
  // 证书成对约束（P2-1）：raw 层先判「显式给出的两侧必须同形态」——一侧空串
  // 而另一侧非空字符串时直接拒绝。否则单边空串经 sanitize 剔除后，剩余的单侧
  // 值会绕过下方 sanitize 后的成对校验（如 {tlsCertFile:"", tlsKeyFile:"/x"}）。
  const rawCert = typeof rawSrc.tlsCertFile === "string" ? rawSrc.tlsCertFile : undefined;
  const rawKey = typeof rawSrc.tlsKeyFile === "string" ? rawSrc.tlsKeyFile : undefined;
  const mixedTlsPair =
    (rawCert === "" && (rawKey ?? "") !== "") ||
    (rawKey === "" && (rawCert ?? "") !== "");
  if (mixedTlsPair) {
    return { ok: false, status: 400, code: "tls-pair", details: "证书文件与私钥文件必须成对提供（或都留空以使用自签名证书）" };
  }
  // 成对约束第二层（sanitize 后判定，口径与历史版本一致）：只给单侧值。
  if (Boolean(sanitized.tlsCertFile) !== Boolean(sanitized.tlsKeyFile)) {
    return { ok: false, status: 400, code: "tls-pair", details: "证书文件与私钥文件必须成对提供（或都留空以使用自签名证书）" };
  }
  const clearingTls = TLS_PAIR_KEYS.some((key) => rawSrc[key] === "");
  try {
    if (clearingTls) {
      const { user } = deps.readUser();
      const section: Record<string, unknown> = { ...user };
      for (const key of TLS_PAIR_KEYS) {
        if (rawSrc[key] === "") delete section[key];
      }
      await deps.replace({ ...section, ...(sanitized as Record<string, unknown>) }, expectedRevision);
    } else {
      await deps.update(sanitized as Record<string, unknown>, expectedRevision);
    }
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === "SETTINGS_CONFLICT") {
      return { ok: false, status: 409, code: "conflict", details: "设置已被其他窗口修改，请刷新后重试" };
    }
    // P2-2：对外收敛固定文案，不把底层异常原文（可能含路径等内部信息）回给
    // 客户端；完整原因走服务端日志。
    deps.logWarn?.(`lan-proxy: 配置保存写入设置存储失败 — ${errorMessage(err)}`);
    return { ok: false, status: 500, code: "error", details: "保存失败，请查看服务端日志" };
  }
  return { ok: true, value: deps.readUser() };
}

/**
 * 组装配置路由（GET 读快照 + PUT 写 patch；loopback 围栏 + 方法白名单）。
 * 导出供 smoke 单测（fake deps，不依赖网络）。
 */
export function buildConfigRoutes(deps: ConfigRouteDeps): WebRoute[] {
  const configRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.config,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method === "GET") {
        const { user, revision } = deps.readUser();
        writeJson(res, 200, {
          ok: true,
          user,
          revision,
          effective: deps.resolve(),
          compress: deps.compress(),
          writable: deps.writable(),
        });
        return;
      }
      if (req.method === "PUT") {
        let body: unknown;
        try {
          body = await readBody(req, 64 * 1024);
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes("invalid JSON body")) {
            writeJson(res, 400, { ok: false, error: { code: "invalid-json", details: `invalid JSON body: ${message}` } });
            return;
          }
          // 超限路径：readBody 已 reject 并 destroy 连接（socket 已断无法再写响应）。
          return;
        }
        const result = await applyConfigPatch(deps, body);
        if (!result.ok) {
          writeJson(res, result.status, { ok: false, error: { code: result.code, details: result.details } });
          return;
        }
        writeJson(res, 200, { ok: true, user: result.value.user, revision: result.value.revision });
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };
  return [configRoute];
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
      wsCompressPaths: value.wsCompressPaths ?? DEFAULT_WSS_COMPRESS_PATHS,
      httpCompressEnabled: value.httpCompressEnabled ?? true,
      httpCompressLevel: value.httpCompressLevel ?? 1,
    };
  };

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
        httpCompress: {
          enabled: httpCompressEnabled,
          level: value.httpCompressLevel,
        },
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

// 测试面 re-export（smoke 只依赖主入口，避免发布物保留内部模块）
export { createLanProxy, hostnameAllowed, formatAuthority, rewriteHeaders, isLoopbackTarget, DEFAULT_OPTIONS, compressWsPath, isCompressible, resolveCompressionOptions } from "./proxy.js";
export { ensureSelfSignedTls, certStillValid, toSanEntry, loadTlsFromFiles, SELF_SIGNED_KEY, SELF_SIGNED_CERT } from "./cert.js";
