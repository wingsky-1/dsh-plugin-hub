/**
 * config 域实现：配置形态（默认值 / 迁移归一 / PUT 校验；纯函数，可单测）。
 *
 * PUT 校验规则（与任务契约一一对应）：
 * - apiKeyRef 须匹配 ^[A-Z][A-Z0-9_]{1,63}$，否则 400；
 * - apiKeyRef 与 apiKeyPlaintext 互斥（同传即 400）；
 * - 明文须二次确认（confirm===true），否则 400；形状拒收 400 仅回类别；
 * - 退役键（baseUrl 等，见 RETIRED_KEYS）显式 400；其余未知键 400；
 * - 嵌套包络（D1）：{version, connection:{...}, presets, history, apiKeyPlaintext} 归一化为扁平键
 *   后再校验；未知键（包络内外）仍 400；hasPlaintextKey 为只读派生，回显即忽略。
 * - GET 永不回显密钥原文（掩码面由 toMaskedConfig 保证：config 本就不存明文）。
 */
import {
  API_KEY_REF_RE,
  CONFIG_VERSION,
  FROZEN_PRESETS,
  MAX_CUSTOM_DESCRIPTION,
  MAX_CUSTOM_LABEL,
  MAX_CUSTOM_PRESETS,
  PRESET_ID_RE,
  RETIRED_KEYS,
  containsCjk,
  keyShapeCategory,
} from "../../../shared/interface.ts";
import type {
  AutomationCap,
  ConfigV1,
  CustomPreset,
  KeyShapeCategory,
} from "../../../shared/interface.ts";

/** PUT 允许键（白名单；之外一律 400。envelope.ts 共用，故导出）。 */
export const ALLOWED_PUT_KEYS = [
  "apiKeyRef",
  "apiKeyPlaintext",
  "confirm",
  "timeoutMs",
  "maxConcurrency",
  "truncBudget",
  "presets",
  "customPresets",
  "history",
] as const;

/** PUT 补丁（调用方只填变更键；null 表清除 ENV 引用）。 */
export interface ConfigPutPatch {
  readonly apiKeyRef?: string | null;
  readonly apiKeyPlaintext?: string;
  readonly confirm?: boolean;
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly truncBudget?: number;
  readonly presets?: readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly automationCap: AutomationCap;
  }[];
  readonly history?: { readonly perSession?: number; readonly totalSessions?: number };
  readonly customPresets?: readonly CustomPreset[];
}

/** 校验失败（HTTP 400 的负载来源；必含 errorCode + category）。 */
export interface PutFailure {
  readonly errorCode: string;
  readonly category: string;
  readonly message: string;
}

/** 包络归一化已迁 envelope.ts（normalizePutEnvelope），此处删除避免双事实源。 */

/** 新鲜默认配置（每次调用返回新对象，不共享引用）。 */
export function buildDefaultConfig(): ConfigV1 {
  return {
    version: CONFIG_VERSION,
    connection: { hasPlaintextKey: false, timeoutMs: 8000, maxConcurrency: 4, truncBudget: 32000 },
    presets: FROZEN_PRESETS.map((preset) => ({
      id: preset.id,
      enabled: preset.defaultEnabled,
      automationCap: preset.automationCap,
    })),
    history: { perSession: 200, totalSessions: 50 },
  };
}

/** 是否为普通记录（数组/空不算。envelope.ts 共用，故导出）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 有限数（NaN/Inf/非数一律回落）。 */
function asFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 整数区间校验。 */
function checkInt(value: unknown, min: number, max: number): number | undefined {
  const num = asFinite(value);
  if (num === undefined || !Number.isInteger(num) || num < min || num > max) return undefined;
  return num;
}

/** 归一化磁盘读到的 config.json（退役键剥离+缺口补默认；返回剥离名单供告警）。 */
export function normalizeLoadedConfig(raw: unknown): {
  readonly config: ConfigV1;
  readonly retired: string[];
} {
  const fallback = buildDefaultConfig();
  if (!isRecord(raw)) return { config: fallback, retired: [] };
  const retired: string[] = [];
  const scanScopes: Record<string, unknown>[] = [raw];
  for (const scope of [raw["connection"], raw["history"]]) {
    if (isRecord(scope)) scanScopes.push(scope);
  }
  for (const key of RETIRED_KEYS) {
    if (scanScopes.some((scope) => key in scope) && !retired.includes(key)) retired.push(key);
  }
  const connRaw = isRecord(raw["connection"]) ? (raw["connection"] as Record<string, unknown>) : {};
  const histRaw = isRecord(raw["history"]) ? (raw["history"] as Record<string, unknown>) : {};
  const presetsRaw = Array.isArray(raw["presets"]) ? (raw["presets"] as unknown[]) : [];
  const byId = new Map(fallback.presets.map((entry) => [entry.id, entry]));
  for (const item of presetsRaw) {
    if (!isRecord(item) || typeof item["id"] !== "string") continue;
    const prev = byId.get(item["id"] as string);
    if (prev === undefined) continue;
    const enabled =
      typeof item["enabled"] === "boolean" ? (item["enabled"] as boolean) : prev.enabled;
    const cap = item["automationCap"];
    const automationCap =
      cap === 0 || cap === 1 || cap === 2 ? (cap as AutomationCap) : prev.automationCap;
    byId.set(item["id"] as string, { id: prev.id, enabled, automationCap });
  }
  const refRaw = connRaw["apiKeyRef"];
  const apiKeyRef = typeof refRaw === "string" && API_KEY_REF_RE.test(refRaw) ? refRaw : undefined;
  const timeout = checkInt(connRaw["timeoutMs"], 1000, 120000) ?? fallback.connection.timeoutMs;
  const concurrency =
    checkInt(connRaw["maxConcurrency"], 1, 16) ?? fallback.connection.maxConcurrency;
  const budget = checkInt(connRaw["truncBudget"], 1000, 200000) ?? fallback.connection.truncBudget;
  const perSession = checkInt(histRaw["perSession"], 10, 1000) ?? fallback.history.perSession;
  const totalSessions =
    checkInt(histRaw["totalSessions"], 1, 200) ?? fallback.history.totalSessions;
  return {
    config: {
      version: CONFIG_VERSION,
      connection: {
        ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
        hasPlaintextKey: connRaw["hasPlaintextKey"] === true,
        timeoutMs: timeout,
        maxConcurrency: concurrency,
        truncBudget: budget,
      },
      presets: FROZEN_PRESETS.map(
        (preset) =>
          byId.get(preset.id) ?? {
            id: preset.id,
            enabled: preset.defaultEnabled,
            automationCap: preset.automationCap,
          },
      ),
      history: { perSession: perSession, totalSessions: totalSessions },
    },
    retired,
  };
}

/** 校验 PUT 体（成功即补丁；失败只回类别+码，不回显原文）。 */
/** 校验自建自定义预设整列（全量替换语义；id 保留字/形状/唯一，名与描述长度，cap 三档）。 */
export function validateCustomPresets(
  raw: unknown,
):
  | { readonly ok: true; readonly list: CustomPreset[] }
  | { readonly ok: false; readonly failure: PutFailure } {
  const bad = (
    errorCode: string,
    message: string,
  ): { readonly ok: false; readonly failure: PutFailure } => ({
    ok: false,
    failure: { errorCode, category: "bad-request", message },
  });
  if (!Array.isArray(raw)) return bad("INVALID_CUSTOM", "customPresets must be an array");
  if (raw.length > MAX_CUSTOM_PRESETS) {
    return bad("INVALID_CUSTOM", "customPresets holds <=" + MAX_CUSTOM_PRESETS + " entries");
  }
  const frozenIds = new Set(FROZEN_PRESETS.map((preset) => preset.id));
  const seen = new Set<string>();
  const list: CustomPreset[] = [];
  const now = Date.now();
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item["id"] !== "string") {
      return bad("INVALID_CUSTOM", "custom preset needs id");
    }
    const id = item["id"] as string;
    if (!PRESET_ID_RE.test(id) || containsCjk(id)) {
      return bad("BAD_CUSTOM_ID", "custom id must be ASCII a-z0-9- 1..64");
    }
    if (frozenIds.has(id)) {
      return bad("RESERVED_PRESET", "custom id collides with a frozen preset: " + id);
    }
    if (seen.has(id)) return bad("DUPLICATE_CUSTOM_ID", "custom ids must be unique");
    seen.add(id);
    const label = item["label"];
    if (
      typeof label !== "string" ||
      label.trim().length === 0 ||
      Array.from(label).length > MAX_CUSTOM_LABEL
    ) {
      return bad("INVALID_CUSTOM", "custom label must be 1.." + MAX_CUSTOM_LABEL + " chars");
    }
    const description = item["description"];
    if (
      typeof description !== "string" ||
      description.trim().length === 0 ||
      Array.from(description).length > MAX_CUSTOM_DESCRIPTION
    ) {
      return bad(
        "INVALID_CUSTOM",
        "custom description must be 1.." + MAX_CUSTOM_DESCRIPTION + " chars",
      );
    }
    if (typeof item["enabled"] !== "boolean") {
      return bad("INVALID_CUSTOM", "custom entry needs boolean enabled");
    }
    const cap = item["automationCap"];
    if (cap !== 0 && cap !== 1 && cap !== 2) {
      return bad("INVALID_CUSTOM", "automationCap must be 0|1|2");
    }
    const stamp = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : now;
    list.push({
      id,
      label: label as string,
      description: description as string,
      enabled: item["enabled"] as boolean,
      automationCap: cap as AutomationCap,
      createdAt: stamp(item["createdAt"]),
      updatedAt: now,
    });
  }
  return { ok: true, list };
}

export function validatePutBody(
  body: unknown,
):
  | { readonly ok: true; readonly patch: ConfigPutPatch }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (!isRecord(body)) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_BODY",
        category: "bad-request",
        message: "body must be an object",
      },
    };
  }
  for (const key of Object.keys(body)) {
    if ((RETIRED_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        failure: {
          errorCode: "RETIRED_KEY",
          category: "retired-key",
          message: "retired key: " + key,
        },
      };
    }
    if (!(ALLOWED_PUT_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        failure: {
          errorCode: "UNKNOWN_KEY",
          category: "unknown-key",
          message: "unknown key: " + key,
        },
      };
    }
  }
  const ref = body["apiKeyRef"];
  const plain = body["apiKeyPlaintext"];
  const confirm = body["confirm"];
  let apiKeyRef: string | null | undefined;
  if (ref !== undefined) {
    if (ref === null) {
      apiKeyRef = null;
    } else if (typeof ref !== "string" || !API_KEY_REF_RE.test(ref)) {
      return {
        ok: false,
        failure: {
          errorCode: "INVALID_REF",
          category: "shape",
          message: "apiKeyRef must match ^[A-Z][A-Z0-9_]{1,63}$",
        },
      };
    } else {
      apiKeyRef = ref;
    }
  }
  let apiKeyPlaintext: string | undefined;
  if (plain !== undefined) {
    if (typeof plain !== "string") {
      return {
        ok: false,
        failure: {
          errorCode: "INVALID_KEY_SHAPE",
          category: "charset",
          message: "apiKeyPlaintext must be a string",
        },
      };
    }
    const shape: KeyShapeCategory | null = keyShapeCategory(plain);
    if (shape !== null) {
      return {
        ok: false,
        failure: { errorCode: "INVALID_KEY_SHAPE", category: shape, message: "key shape rejected" },
      };
    }
    if (confirm !== true) {
      return {
        ok: false,
        failure: {
          errorCode: "NEED_CONFIRM",
          category: "confirm-required",
          message: "plaintext requires confirm:true",
        },
      };
    }
    apiKeyPlaintext = plain;
  }
  if (apiKeyRef !== undefined && apiKeyRef !== null && apiKeyPlaintext !== undefined) {
    return {
      ok: false,
      failure: {
        errorCode: "MUTUALLY_EXCLUSIVE",
        category: "mutually-exclusive",
        message: "apiKeyRef and apiKeyPlaintext are mutually exclusive",
      },
    };
  }
  const timeoutMs =
    body["timeoutMs"] === undefined ? undefined : checkInt(body["timeoutMs"], 1000, 120000);
  if (body["timeoutMs"] !== undefined && timeoutMs === undefined) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_RANGE",
        category: "bad-request",
        message: "timeoutMs must be int 1000..120000",
      },
    };
  }
  const maxConcurrency =
    body["maxConcurrency"] === undefined ? undefined : checkInt(body["maxConcurrency"], 1, 16);
  if (body["maxConcurrency"] !== undefined && maxConcurrency === undefined) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_RANGE",
        category: "bad-request",
        message: "maxConcurrency must be int 1..16",
      },
    };
  }
  const truncBudget =
    body["truncBudget"] === undefined ? undefined : checkInt(body["truncBudget"], 1000, 200000);
  if (body["truncBudget"] !== undefined && truncBudget === undefined) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_RANGE",
        category: "bad-request",
        message: "truncBudget must be int 1000..200000",
      },
    };
  }
  let presets: ConfigPutPatch["presets"];
  if (body["presets"] !== undefined) {
    if (!Array.isArray(body["presets"])) {
      return {
        ok: false,
        failure: {
          errorCode: "INVALID_PRESETS",
          category: "bad-request",
          message: "presets must be an array",
        },
      };
    }
    const list: {
      readonly id: string;
      readonly enabled: boolean;
      readonly automationCap: AutomationCap;
    }[] = [];
    for (const item of body["presets"] as unknown[]) {
      if (!isRecord(item) || typeof item["id"] !== "string") {
        return {
          ok: false,
          failure: {
            errorCode: "INVALID_PRESETS",
            category: "bad-request",
            message: "preset entry needs id",
          },
        };
      }
      const frozen = FROZEN_PRESETS.find((preset) => preset.id === (item["id"] as string));
      if (frozen === undefined) {
        return {
          ok: false,
          failure: {
            errorCode: "UNKNOWN_PRESET",
            category: "bad-request",
            message: "unknown preset",
          },
        };
      }
      if (typeof item["enabled"] !== "boolean") {
        return {
          ok: false,
          failure: {
            errorCode: "INVALID_PRESETS",
            category: "bad-request",
            message: "preset entry needs boolean enabled",
          },
        };
      }
      const cap = item["automationCap"];
      if (cap !== 0 && cap !== 1 && cap !== 2) {
        return {
          ok: false,
          failure: {
            errorCode: "INVALID_PRESETS",
            category: "bad-request",
            message: "automationCap must be 0|1|2",
          },
        };
      }
      list.push({
        id: item["id"] as string,
        enabled: item["enabled"] as boolean,
        automationCap: cap as AutomationCap,
      });
    }
    presets = list;
  }
  let history: ConfigPutPatch["history"];
  if (body["history"] !== undefined) {
    if (!isRecord(body["history"])) {
      return {
        ok: false,
        failure: {
          errorCode: "INVALID_HISTORY",
          category: "bad-request",
          message: "history must be an object",
        },
      };
    }
    const hist = body["history"] as Record<string, unknown>;
    const perSession =
      hist["perSession"] === undefined ? undefined : checkInt(hist["perSession"], 10, 1000);
    if (hist["perSession"] !== undefined && perSession === undefined) {
      return {
        ok: false,
        failure: {
          errorCode: "INVALID_RANGE",
          category: "bad-request",
          message: "perSession must be int 10..1000",
        },
      };
    }
    const totalSessions =
      hist["totalSessions"] === undefined ? undefined : checkInt(hist["totalSessions"], 1, 200);
    if (hist["totalSessions"] !== undefined && totalSessions === undefined) {
      return {
        ok: false,
        failure: {
          errorCode: "INVALID_RANGE",
          category: "bad-request",
          message: "totalSessions must be int 1..200",
        },
      };
    }
    history = {
      ...(perSession !== undefined ? { perSession } : {}),
      ...(totalSessions !== undefined ? { totalSessions } : {}),
    };
  }
  let customPresets: ConfigPutPatch["customPresets"];
  if (body["customPresets"] !== undefined) {
    const checked = validateCustomPresets(body["customPresets"]);
    if (!checked.ok) return checked;
    customPresets = checked.list;
  }
  return {
    ok: true,
    patch: {
      ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
      ...(apiKeyPlaintext !== undefined ? { apiKeyPlaintext } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      ...(truncBudget !== undefined ? { truncBudget } : {}),
      ...(presets !== undefined ? { presets } : {}),
      ...(history !== undefined ? { history } : {}),
      ...(customPresets !== undefined ? { customPresets } : {}),
    },
  };
}
