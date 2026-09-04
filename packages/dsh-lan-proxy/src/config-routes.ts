/**
 * dsh-lan-proxy — loopback HTTP 配置路由（#276 方案 A 阶段 3 拆出）。
 *
 * 职责：与客户端共享的路由表（ROUTES，单一来源）、配置保存纯函数
 * （applyConfigPatch）与路由组装（buildConfigRoutes）。路由表归此模块而非
 * apply.ts：config-routes 与 apply 都要引用 ROUTES，放在本模块可避免
 * apply ↔ config-routes 循环引用（apply.ts 不得 import index.ts 的同一纪律）。
 */
import { writeJson, readBody, errorMessage, guardLoopbackMethod } from "../../../shared/host-utils.js";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { sanitizeSettings, validateSettings } from "./config.ts";
import type { HttpCompressSnapshot, ResolvedConfig } from "./config.ts";

/** 与客户端共享的路由（单一来源）。 */
export const ROUTES = {
  health: "/api/dsh-lan-proxy/health",
  /** 配置读写路由：GET 快照 / PUT patch（loopback 围栏）。 */
  config: "/api/dsh-lan-proxy/config",
};

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
  // 证书成对约束（#467 固化成对语义）：raw 层按「键是否显式出现」判定形态——
  // 只显式给出单侧（另一侧未提交 = undefined）即拒绝；"一空一缺"与"一非空一缺"
  // 同属单侧出现。注意须用键存在性（rawSrc[key] !== undefined）而非字符串判型：
  // 单侧显式空串意在清除，另一侧缺席时若漏判会进入 clearingTls 分支，删除循环
  // 只剔"显式空串"侧，user 层残留另一侧孤儿（半套证书）。"同空（双空串）"=
  // 整套清除、"同非空"= 整套设置，均两侧同时显式出现，不落此分支。
  const rawCertExplicit = rawSrc.tlsCertFile !== undefined;
  const rawKeyExplicit = rawSrc.tlsKeyFile !== undefined;
  if (rawCertExplicit !== rawKeyExplicit) {
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
      // #467：清除语义固化为"整套成对剔除"（同空 = 整套清除）——raw 层已保证
      // 显式空串两侧同现，但仍整体剔除两键，杜绝单侧剔除遗留另一半的可能。
      for (const key of TLS_PAIR_KEYS) {
        if (rawSrc[key] === "" || user[key] !== undefined) delete section[key];
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
      if (!guardLoopbackMethod(req, res, ["GET", "PUT"])) return;
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