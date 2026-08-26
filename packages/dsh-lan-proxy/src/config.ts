/**
 * dsh-lan-proxy — 配置模型与校验（#276 方案 A 阶段 3 拆出）。
 *
 * 职责：插件配置 schema（schemastery Config）、配置类型面
 * （LanProxyConfig / HttpCompressSnapshot / ResolvedConfig）、存量过滤与
 * 客户端提交校验（FILE_CONFIG_VALIDATORS + SETTING_FIELD_HINTS +
 * sanitizeSettings / validateSettings）。路由/接线/迁移/挂载各司其职于
 * config-routes.ts / settings.ts / migrate.ts / apply.ts。
 */
import z from "schemastery";
import { DEFAULT_OPTIONS, isLoopbackTarget } from "./proxy.ts";

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
