/**
 * dsh-lan-proxy — loopback HTTP 配置面。
 *
 * 路由表（ROUTES）与保存纯函数（applyConfigPatch）同处：两者只服务配置读写，
 * 且 ROUTES 是与客户端共享的来源（构建期经 __DSH_ROUTES__ 注入）。
 */
import {
  writeJson,
  readBody,
  errorMessage,
  guardLoopbackMethod,
} from "../../../../../../shared/host-utils.js";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { sanitizeSettings, validateSettings } from "./model.ts";
import type { HttpCompressSnapshot, ResolvedConfig } from "./model.ts";
import type { DownloadCertResult } from "../../tls/interface.ts";

/** 与客户端共享的路由（单一来源；客户端经 shared/contract.ts 镜像 + __DSH_ROUTES__ 注入消费）。 */
export const ROUTES = {
  health: "/api/dsh-lan-proxy/health",
  /** 配置读写路由：GET 快照 / PUT patch（loopback 围栏）。 */
  config: "/api/dsh-lan-proxy/config",
  /** CA/自签证书下发路由：GET 只读（loopback 围栏；issue #911 移动设备安装信任用）。 */
  caCert: "/api/dsh-lan-proxy/ca-cert",
  /**
   * 一键 CA 动作路由：POST 只写（loopback 围栏；#930 Phase 2 自签首建 / 托管轮换）。
   * 处理器归 ca 域（buildCaActionRoutes），本表只收路径名（F16 ROUTES 单源；
   * 本文件头“只服务配置读写”指处理器归属，路径名作为共享来源例外——caCert
   * 路由同例：路径在此、语义在 tls 域）。
   */
  caGenerate: "/api/dsh-lan-proxy/ca/generate",
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

/** CA 公钥路径键（issue #911）：独立清除，不与 leaf/key 成对绑定（空字符串 = 显式清除）。 */
const CA_CERT_KEY = "tlsCaCertFile";

/** PUT 负载包络：raw patch、期望版本与 raw 键视图（三处共用同一空对象回退口径）。 */
interface PatchEnvelope {
  readonly rawPatch: unknown;
  readonly expectedRevision: number | undefined;
  readonly rawSrc: Record<string, unknown>;
}

/** 解析 PUT 负载包络（原 applyConfigPatch 首段：body 回退 + 版本归一化 + raw 视图）。 */
function extractPatchEnvelope(payload: unknown): PatchEnvelope {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    patch?: unknown;
    expectedRevision?: unknown;
  };
  const expectedRevision =
    typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision)
      ? body.expectedRevision
      : undefined;
  const rawPatch = body.patch;
  const rawSrc = (typeof rawPatch === "object" && rawPatch !== null ? rawPatch : {}) as Record<
    string,
    unknown
  >;
  return { rawPatch, expectedRevision, rawSrc };
}

/** TLS 成对错误（两层共用同一文案与状态码）。 */
function tlsPairError(): PatchResult {
  return {
    ok: false,
    status: 400,
    code: "tls-pair",
    details: "证书文件与私钥文件必须成对提供（或都留空以使用自签名证书）",
  };
}

/**
 * 证书成对约束（#467 固化成对语义）：raw 层按「键是否显式出现」判定形态——
 * 只显式给出单侧（另一侧未提交 = undefined）即拒绝；"一空一缺"与"一非空一缺"
 * 同属单侧出现。注意须用键存在性（rawSrc[key] !== undefined）而非字符串判型：
 * 单侧显式空串意在清除，另一侧缺席时若漏判会进入 clearingTls 分支，删除循环
 * 只剔"显式空串"侧，user 层残留另一侧孤儿（半套证书）。"同空（双空串）"=
 * 整套清除、"同非空"= 整套设置，均两侧同时显式出现，不落此分支。
 * 成对约束第二层（sanitize 后判定，口径与历史版本一致）：只给单侧值。
 * 返回 undefined 表示通过，否则为直接返回的错误结果。
 */
function checkTlsPair(
  rawSrc: Record<string, unknown>,
  sanitized: NonNullable<ReturnType<typeof sanitizeSettings>>,
): PatchResult | undefined {
  const rawCertExplicit = rawSrc.tlsCertFile !== undefined;
  const rawKeyExplicit = rawSrc.tlsKeyFile !== undefined;
  if (rawCertExplicit !== rawKeyExplicit) return tlsPairError();
  if (Boolean(sanitized.tlsCertFile) !== Boolean(sanitized.tlsKeyFile)) return tlsPairError();
  return undefined;
}

/**
 * 落盘 patch（原 applyConfigPatch 尾段：clearing 分流 + 写入 + 错误映射）。
 * 默认走 update 增量 merge；仅当 raw patch 以空字符串表达「清除证书路径」时
 * 走 replace（update 是 merge 语义无法 unset，owner scope 无 mutate 面）：
 * 从当前用户层复制全节、剔除被清除的键后整节替换，其余语义不变。
 */
async function persistPatchedConfig(
  deps: ConfigRouteDeps,
  sanitized: NonNullable<ReturnType<typeof sanitizeSettings>>,
  rawSrc: Record<string, unknown>,
  expectedRevision: number | undefined,
): Promise<PatchResult> {
  // #467 叶对：显式空串任一侧即整套剔除（raw 层已保证同空同现）。
  const clearingLeaf = TLS_PAIR_KEYS.some((key) => rawSrc[key] === "");
  // #911 CA：独立清除，不与叶对绑定（单清 CA 不得触碰叶子配置）。
  const clearingCa = rawSrc[CA_CERT_KEY] === "";
  try {
    if (clearingLeaf || clearingCa) {
      // update 是 merge 语义无法 unset，owner scope 无 mutate 面 → 走 replace：
      // 从当前用户层复制全节、剔除被清除的键后整节替换，其余语义不变。
      // readUser 整段只调一次（末尾回 value 时还要再调一次，那是返回值，不是这条路径）。
      const { user } = deps.readUser();
      await deps.replace(
        replacedSection(
          user,
          sanitized as Record<string, unknown>,
          rawSrc,
          clearingLeaf,
          clearingCa,
        ),
        expectedRevision,
      );
    } else {
      await deps.update(sanitized as Record<string, unknown>, expectedRevision);
    }
  } catch (err) {
    return writeFailureOf(deps, err);
  }
  return { ok: true, value: deps.readUser() };
}

/**
 * replace 用的整节：从用户层复制 → 剔除被清除的键 → 铺上净化后的 patch。
 *
 * 叶对的剔除条件是「raw 层显式空串 **或** 用户层本来就有」——后者覆盖「raw 给了新值但
 * 用户层残留旧空串」这类半迁移形态。CA 独立清除，不与叶对绑定（单清 CA 不得触碰叶子配置）。
 * 纯函数：读 user、给 raw，不碰 deps，故可被直接单测。
 */
function replacedSection(
  user: Record<string, unknown>,
  sanitized: Record<string, unknown>,
  rawSrc: Record<string, unknown>,
  clearingLeaf: boolean,
  clearingCa: boolean,
): Record<string, unknown> {
  const section: Record<string, unknown> = { ...user };
  if (clearingLeaf) {
    for (const key of TLS_PAIR_KEYS) {
      if (rawSrc[key] === "" || user[key] !== undefined) delete section[key];
    }
  }
  if (clearingCa) delete section[CA_CERT_KEY];
  return { ...section, ...sanitized };
}

/** 写入失败的对外映射：409 走冲突文案，其余收敛为固定 500 文案（原文只进日志）。 */
function writeFailureOf(deps: ConfigRouteDeps, err: unknown): PatchResult {
  const code = (err as { code?: unknown })?.code;
  if (code === "SETTINGS_CONFLICT") {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      details: "设置已被其他窗口修改，请刷新后重试",
    };
  }
  // P2-2：对外收敛固定文案，不把底层异常原文（可能含路径等内部信息）回给
  // 客户端；完整原因走服务端日志。
  deps.logWarn?.(`lan-proxy: 配置保存写入设置存储失败 — ${errorMessage(err)}`);
  return { ok: false, status: 500, code: "error", details: "保存失败，请查看服务端日志" };
}

/**
 * 配置保存纯函数（PUT /config 的主体，独立导出供 smoke 单测）：
 * validate 定位首个非法键 → sanitize 净化 → tls 成对校验 → 写入官方存储。
 * 默认走 update 增量 merge；仅当 raw patch 以空字符串表达「清除证书路径」时
 * 走 replace（update 是 merge 语义无法 unset，owner scope 无 mutate 面）：
 * 从当前用户层复制全节、剔除被清除的键后整节替换，其余语义不变。
 */
export async function applyConfigPatch(
  deps: ConfigRouteDeps,
  payload: unknown,
): Promise<PatchResult> {
  if (!deps.writable()) {
    return {
      ok: false,
      status: 503,
      code: "settings-unavailable",
      details: "settings 服务不可用，无法保存配置",
    };
  }
  const { rawPatch, expectedRevision, rawSrc } = extractPatchEnvelope(payload);
  // 先定位首个非法键（issue #33 子项 1）：错误文案指明字段与合法范围。
  const invalid = validateSettings(rawPatch);
  if (invalid !== null) {
    return {
      ok: false,
      status: 400,
      code: "invalid",
      details: `配置项「${invalid.key}」非法：${invalid.hint}`,
    };
  }
  const sanitized = sanitizeSettings(rawPatch);
  if (sanitized === null) {
    return { ok: false, status: 400, code: "invalid", details: "非法配置值（未知键或类型错误）" };
  }
  const tlsErr = checkTlsPair(rawSrc, sanitized);
  if (tlsErr !== undefined) return tlsErr;
  return persistPatchedConfig(deps, sanitized, rawSrc, expectedRevision);
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
            writeJson(res, 400, {
              ok: false,
              error: { code: "invalid-json", details: `invalid JSON body: ${message}` },
            });
            return;
          }
          // 超限路径：readBody 已 reject 并 destroy 连接（socket 已断无法再写响应）。
          return;
        }
        const result = await applyConfigPatch(deps, body);
        if (!result.ok) {
          writeJson(res, result.status, {
            ok: false,
            error: { code: result.code, details: result.details },
          });
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
 * buildCaCertRoutes 的依赖注入面（apply 内装配；单测用 fake 直接构造）。
 *
 * 证书装配由 tls 域提供（loadDownloadableCertificate），本域不读证书文件、
 * 不引 tls 值——跨域值边在此终结，装配层组合两域（prepareTls 同口径）。
 */
export interface CaCertRouteDeps {
  /** 证书装配器（逐请求调用，tlsCaCertFile 热更新即时生效）。 */
  loadCertificate(format: "der" | "pem"): DownloadCertResult;
}

/**
 * 下发格式（显式白名单，无静默回落）：der（含 cer 别名，供 iOS 描述文件安装）/
 * pem（文本检查用）；缺失默认 der，未知值由调用方判 400（拼写错误不再静默
 * 当证书下发，fail-closed）。
 */
function parseCertFormat(url: string | undefined): "der" | "pem" | "invalid" {
  let format: string | null;
  try {
    format = new URL(url ?? "/", "http://lan-proxy.local").searchParams.get("format");
  } catch {
    return "invalid";
  }
  if (format === null || format === "der" || format === "cer") return "der";
  if (format === "pem") return "pem";
  return "invalid";
}

/**
 * 组装证书下发路由（GET 只读；loopback 围栏 + GET 白名单；无 Cookie 要求——
 * fresh 设备恰恰没有会话 Cookie，要求即鸡生蛋死锁；边界与 issue #380 同登记）。
 *
 * 本函数只做围栏 + 格式白名单 + 状态映射；证书三态装配（配 CA / 自签回退 /
 * 自定义无 CA 404）与文件读取解析全归 tls 域（loadDownloadableCertificate），
 * 失败码对固定文案（原文只进日志）。导出供单测（fake deps，不依赖网络）。
 */

/** 下发失败码对固定响应文案（P2-2：路径等内部信息不进响应）。 */
const DOWNLOAD_ERROR_DETAILS: Record<string, string> = {
  "ca-unconfigured":
    "未配置 CA 公钥（tlsCaCertFile 为空）：下发的证书无法建立信任。请先一键生成本地 CA（设置页），或配置 CA 公钥后重试。",
  "ca-unavailable": "证书暂不可用，请查看服务端日志",
  "ca-invalid": "证书文件无效（须为 CERTIFICATE PEM/DER），请查看服务端日志",
};
export function buildCaCertRoutes(deps: CaCertRouteDeps): WebRoute[] {
  const caCertRoute: WebRoute = {
    kind: "exact",
    path: ROUTES.caCert,
    handler: (req, res) => {
      if (!guardLoopbackMethod(req, res, ["GET"])) return;
      const format = parseCertFormat(req.url);
      if (format === "invalid") {
        writeJson(res, 400, {
          ok: false,
          error: { code: "bad-format", details: "format 非法（仅支持 der/cer/pem）" },
        });
        return;
      }
      const loaded = deps.loadCertificate(format);
      if (!loaded.ok) {
        writeJson(res, 404, {
          ok: false,
          error: { code: loaded.code, details: DOWNLOAD_ERROR_DETAILS[loaded.code] },
        });
        return;
      }
      // 二进制路由不用 writeJson（host-utils 只管 JSON），手写头：防嗅探 +
      // 附件下载 + 禁缓存（IP 变化即重签，缓存旧 CA 会误导排障）。
      res.writeHead(200, {
        "content-type": loaded.contentType,
        "content-disposition": 'attachment; filename="' + loaded.filename + '"',
        "content-length": loaded.body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(loaded.body);
    },
  };
  return [caCertRoute];
}
