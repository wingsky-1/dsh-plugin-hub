/**
 * config 域实现：配置形态（默认值 / 迁移归一 / PUT 校验；纯函数，可单测）。
 *
 * PUT 校验规则（与任务契约一一对应）：
 * - apiKeyRef 须匹配 ^[A-Z][A-Z0-9_]{1,63}$，否则 400；
 * - apiKeyRef 与 apiKeyPlaintext 互斥（同传即 400）；
 * - 明文免二次确认（confirm 字段若出现则忽略，保持向后兼容）；形状拒收 400 仅回类别；
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

/** automationCap 三档谓词（0|1|2）。收窄成类型谓词后调用点免断言。 */
function isCap(v: unknown): v is AutomationCap {
  return v === 0 || v === 1 || v === 2;
}

/** 退役键扫描：根 + connection + history 三个作用域，键名去重后回名单（供告警，不阻断启动）。 */
function scanRetiredKeys(raw: Record<string, unknown>): string[] {
  const scopes: Record<string, unknown>[] = [raw];
  for (const scope of [raw["connection"], raw["history"]]) {
    if (isRecord(scope)) scopes.push(scope);
  }
  const retired: string[] = [];
  for (const key of RETIRED_KEYS) {
    if (scopes.some((scope) => key in scope) && !retired.includes(key)) retired.push(key);
  }
  return retired;
}

/** 预设列归一：磁盘项覆写 frozen 默认项；未知 id 整项忽略（磁盘不得新增预设）。 */
function mergePresets(
  presetsRaw: readonly unknown[],
  fallback: ConfigV1,
): Map<string, ConfigV1["presets"][number]> {
  const byId = new Map(fallback.presets.map((entry) => [entry.id, entry]));
  for (const item of presetsRaw) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    if (typeof id !== "string") continue;
    const prev = byId.get(id);
    if (prev === undefined) continue;
    const rawEnabled = item["enabled"];
    const enabled = typeof rawEnabled === "boolean" ? rawEnabled : prev.enabled;
    const cap = item["automationCap"];
    const automationCap = isCap(cap) ? cap : prev.automationCap;
    byId.set(id, { id: prev.id, enabled, automationCap });
  }
  return byId;
}

/** connection 面归一：apiKeyRef 形状、三项区间数回落默认、hasPlaintextKey 只读派生。 */
function normalizeConnection(
  connRaw: Record<string, unknown>,
  fallback: ConfigV1,
): ConfigV1["connection"] {
  const refRaw = connRaw["apiKeyRef"];
  const apiKeyRef = typeof refRaw === "string" && API_KEY_REF_RE.test(refRaw) ? refRaw : undefined;
  return {
    ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
    hasPlaintextKey: connRaw["hasPlaintextKey"] === true,
    timeoutMs: checkInt(connRaw["timeoutMs"], 1000, 120000) ?? fallback.connection.timeoutMs,
    maxConcurrency:
      checkInt(connRaw["maxConcurrency"], 1, 16) ?? fallback.connection.maxConcurrency,
    truncBudget: checkInt(connRaw["truncBudget"], 1000, 200000) ?? fallback.connection.truncBudget,
  };
}

/** history 面归一：两项区间数，缺省/越界回落默认。 */
function normalizeHistory(
  histRaw: Record<string, unknown>,
  fallback: ConfigV1,
): ConfigV1["history"] {
  return {
    perSession: checkInt(histRaw["perSession"], 10, 1000) ?? fallback.history.perSession,
    totalSessions: checkInt(histRaw["totalSessions"], 1, 200) ?? fallback.history.totalSessions,
  };
}

/** 归一化磁盘读到的 config.json（退役键剥离+缺口补默认；返回剥离名单供告警）。 */
export function normalizeLoadedConfig(raw: unknown): {
  readonly config: ConfigV1;
  readonly retired: string[];
} {
  const fallback = buildDefaultConfig();
  if (!isRecord(raw)) return { config: fallback, retired: [] };
  const connRaw = isRecord(raw["connection"]) ? raw["connection"] : {};
  const histRaw = isRecord(raw["history"]) ? raw["history"] : {};
  const presetsRaw = Array.isArray(raw["presets"]) ? raw["presets"] : [];
  const byId = mergePresets(presetsRaw, fallback);
  return {
    config: {
      version: CONFIG_VERSION,
      connection: normalizeConnection(connRaw, fallback),
      presets: FROZEN_PRESETS.map(
        (preset) =>
          byId.get(preset.id) ?? {
            id: preset.id,
            enabled: preset.defaultEnabled,
            automationCap: preset.automationCap,
          },
      ),
      history: normalizeHistory(histRaw, fallback),
    },
    retired: scanRetiredKeys(raw),
  };
}

/** 自建预设校验失败（类别恒为 bad-request；错误码区分形状/保留字/重复三类）。 */
function badCustom(
  errorCode: string,
  message: string,
): { readonly ok: false; readonly failure: PutFailure } {
  return { ok: false, failure: { errorCode, category: "bad-request", message } };
}

/** 跨条目共享的判定上下文（保留字表与已用 id 集在整列内累积）。 */
interface CustomEntryCtx {
  readonly frozenIds: ReadonlySet<string>;
  /** 整列累积：checkCustomId 只读，母体在每条通过后补记——故此处是可写集。 */
  readonly seen: Set<string>;
  readonly now: number;
}

type CustomIdCheck =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly failure: PutFailure };

/** 自建 id 面：缺 id、ASCII 形状、撞 frozen 保留字、列内重复（都归「这条 id 能不能用」）。 */
function checkCustomId(item: Record<string, unknown>, ctx: CustomEntryCtx): CustomIdCheck {
  const id = item["id"];
  if (typeof id !== "string") return badCustom("INVALID_CUSTOM", "custom preset needs id");
  if (!PRESET_ID_RE.test(id) || containsCjk(id)) {
    return badCustom("BAD_CUSTOM_ID", "custom id must be ASCII a-z0-9- 1..64");
  }
  if (ctx.frozenIds.has(id)) {
    return badCustom("RESERVED_PRESET", "custom id collides with a frozen preset: " + id);
  }
  if (ctx.seen.has(id)) return badCustom("DUPLICATE_CUSTOM_ID", "custom ids must be unique");
  return { ok: true, id };
}

/** 展示面：label 与 description 同一规则（1..max 码点、非纯空白），只是上限不同。 */
function customText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return Array.from(value).length > max ? null : value;
}

/** 开关/档位面：enabled 布尔 + automationCap 三档（收窄成谓词后免断言）。 */
function checkCustomSwitch(
  item: Record<string, unknown>,
):
  | { readonly ok: true; readonly enabled: boolean; readonly cap: AutomationCap }
  | { readonly ok: false; readonly failure: PutFailure } {
  const enabled = item["enabled"];
  if (typeof enabled !== "boolean") {
    return badCustom("INVALID_CUSTOM", "custom entry needs boolean enabled");
  }
  const cap = item["automationCap"];
  if (!isCap(cap)) return badCustom("INVALID_CUSTOM", "automationCap must be 0|1|2");
  return { ok: true, enabled, cap };
}

/** createdAt 归一：非负有限数向下取整，否则回本轮 now。 */
function entryStamp(v: unknown, now: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : now;
}

/** 单条自建预设：id 面 + 展示面 + 开关档位面 + 时间戳面。 */
function toCustomEntry(
  item: unknown,
  ctx: CustomEntryCtx,
):
  | { readonly ok: true; readonly preset: CustomPreset }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (!isRecord(item)) return badCustom("INVALID_CUSTOM", "custom preset needs id");
  const idR = checkCustomId(item, ctx);
  if (!idR.ok) return idR;
  const label = customText(item["label"], MAX_CUSTOM_LABEL);
  if (label === null) {
    return badCustom("INVALID_CUSTOM", "custom label must be 1.." + MAX_CUSTOM_LABEL + " chars");
  }
  const description = customText(item["description"], MAX_CUSTOM_DESCRIPTION);
  if (description === null) {
    return badCustom(
      "INVALID_CUSTOM",
      "custom description must be 1.." + MAX_CUSTOM_DESCRIPTION + " chars",
    );
  }
  const sw = checkCustomSwitch(item);
  if (!sw.ok) return sw;
  return {
    ok: true,
    preset: {
      id: idR.id,
      label,
      description,
      enabled: sw.enabled,
      automationCap: sw.cap,
      createdAt: entryStamp(item["createdAt"], ctx.now),
      updatedAt: ctx.now,
    },
  };
}

/** 校验 PUT 体（成功即补丁；失败只回类别+码，不回显原文）。 */
/** 校验自建自定义预设整列（全量替换语义；id 保留字/形状/唯一，名与描述长度，cap 三档）。 */
export function validateCustomPresets(
  raw: unknown,
):
  | { readonly ok: true; readonly list: CustomPreset[] }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (!Array.isArray(raw)) return badCustom("INVALID_CUSTOM", "customPresets must be an array");
  if (raw.length > MAX_CUSTOM_PRESETS) {
    return badCustom("INVALID_CUSTOM", "customPresets holds <=" + MAX_CUSTOM_PRESETS + " entries");
  }
  const ctx: CustomEntryCtx = {
    frozenIds: new Set(FROZEN_PRESETS.map((preset) => preset.id)),
    seen: new Set<string>(),
    now: Date.now(),
  };
  const list: CustomPreset[] = [];
  for (const item of raw) {
    const entry = toCustomEntry(item, ctx);
    if (!entry.ok) return entry;
    ctx.seen.add(entry.preset.id);
    list.push(entry.preset);
  }
  return { ok: true, list };
}

interface PutIntField {
  readonly key: string;
  readonly min: number;
  readonly max: number;
  readonly message: string;
}
const PUT_INT_FIELDS: readonly PutIntField[] = [
  { key: "timeoutMs", min: 1000, max: 120000, message: "timeoutMs must be int 1000..120000" },
  { key: "maxConcurrency", min: 1, max: 16, message: "maxConcurrency must be int 1..16" },
  { key: "truncBudget", min: 1000, max: 200000, message: "truncBudget must be int 1000..200000" },
];
const HISTORY_INT_FIELDS: readonly PutIntField[] = [
  { key: "perSession", min: 10, max: 1000, message: "perSession must be int 10..1000" },
  { key: "totalSessions", min: 1, max: 200, message: "totalSessions must be int 1..200" },
];
function putRangedInt(
  source: Record<string, unknown>,
  field: PutIntField,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly failure: PutFailure } {
  const raw = source[field.key];
  if (raw === undefined) return { ok: true, value: undefined };
  const value = checkInt(raw, field.min, field.max);
  if (value === undefined)
    return {
      ok: false,
      failure: { errorCode: "INVALID_RANGE", category: "bad-request", message: field.message },
    };
  return { ok: true, value };
}
function checkApiKeyRef(
  ref: unknown,
):
  | { readonly ok: true; readonly value: string | null | undefined }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (ref === undefined) return { ok: true, value: undefined };
  if (ref === null) return { ok: true, value: null };
  if (typeof ref !== "string" || !API_KEY_REF_RE.test(ref)) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_REF",
        category: "shape",
        message: "apiKeyRef must match ^[A-Z][A-Z0-9_]{1,63}$",
      },
    };
  }
  return { ok: true, value: ref };
}
function checkApiKeyPlaintext(
  plain: unknown,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (plain === undefined) return { ok: true, value: undefined };
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
  return { ok: true, value: plain };
}
function checkPresetsField(value: unknown):
  | {
      readonly ok: true;
      readonly list:
        | {
            readonly id: string;
            readonly enabled: boolean;
            readonly automationCap: AutomationCap;
          }[]
        | undefined;
    }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (value === undefined) {
    return { ok: true, list: undefined };
  }
  if (!Array.isArray(value)) {
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
  for (const item of value as unknown[]) {
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
    if (!isCap(cap)) {
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
      automationCap: cap,
    });
  }
  return { ok: true, list };
}
function checkHistoryField(value: unknown):
  | {
      readonly ok: true;
      readonly history:
        { readonly perSession?: number; readonly totalSessions?: number } | undefined;
    }
  | { readonly ok: false; readonly failure: PutFailure } {
  if (value === undefined) {
    return { ok: true, history: undefined };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_HISTORY",
        category: "bad-request",
        message: "history must be an object",
      },
    };
  }
  const hist = value as Record<string, unknown>;
  const histVals: Record<string, number | undefined> = {};
  for (const field of HISTORY_INT_FIELDS) {
    const checked = putRangedInt(hist, field);
    if (!checked.ok) return checked;
    if (checked.value !== undefined) histVals[field.key] = checked.value;
  }
  const perSession = histVals["perSession"];
  const totalSessions = histVals["totalSessions"];
  return {
    ok: true,
    history: {
      ...(perSession !== undefined ? { perSession } : {}),
      ...(totalSessions !== undefined ? { totalSessions } : {}),
    },
  };
}
function checkPutKeys(body: unknown): { ok: false; failure: PutFailure } | null {
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
  return null;
}
function checkPutApiKey(
  body: unknown,
):
  | { ok: true; apiKeyRef: string | null | undefined; apiKeyPlaintext: string | undefined }
  | { ok: false; failure: PutFailure } {
  if (!isRecord(body))
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_BODY",
        category: "bad-request",
        message: "body must be an object",
      },
    };
  const ref = body["apiKeyRef"];
  const plain = body["apiKeyPlaintext"];
  // confirm 字段保留在白名单仅作向后兼容（老客户端仍发 confirm:true），此处不再读取。
  const refChecked = checkApiKeyRef(ref);
  if (!refChecked.ok) return refChecked;
  const apiKeyRef = refChecked.value;
  const plainChecked = checkApiKeyPlaintext(plain);
  if (!plainChecked.ok) return plainChecked;
  const apiKeyPlaintext = plainChecked.value;
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
  return { ok: true, apiKeyRef: apiKeyRef, apiKeyPlaintext: apiKeyPlaintext };
}
function checkPutInts(
  body: unknown,
): { ok: true; intVals: Record<string, number | undefined> } | { ok: false; failure: PutFailure } {
  if (!isRecord(body))
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_BODY",
        category: "bad-request",
        message: "body must be an object",
      },
    };
  const intVals: Record<string, number | undefined> = {};
  for (const field of PUT_INT_FIELDS) {
    const checked = putRangedInt(body, field);
    if (!checked.ok) return checked;
    if (checked.value !== undefined) intVals[field.key] = checked.value;
  }
  return { ok: true, intVals: intVals };
}
function checkPutCustom(
  body: unknown,
):
  | { ok: true; customPresets: ConfigPutPatch["customPresets"] }
  | { ok: false; failure: PutFailure } {
  if (!isRecord(body))
    return {
      ok: false,
      failure: {
        errorCode: "INVALID_BODY",
        category: "bad-request",
        message: "body must be an object",
      },
    };
  let customPresets: ConfigPutPatch["customPresets"];
  if (body["customPresets"] !== undefined) {
    const checked = validateCustomPresets(body["customPresets"]);
    if (!checked.ok) return checked;
    customPresets = checked.list;
  }
  return { ok: true, customPresets: customPresets };
}
function buildPutPatch(
  apiKeyRef: ConfigPutPatch["apiKeyRef"],
  apiKeyPlaintext: ConfigPutPatch["apiKeyPlaintext"],
  timeoutMs: ConfigPutPatch["timeoutMs"],
  maxConcurrency: ConfigPutPatch["maxConcurrency"],
  truncBudget: ConfigPutPatch["truncBudget"],
  presets: ConfigPutPatch["presets"],
  history: ConfigPutPatch["history"],
  customPresets: ConfigPutPatch["customPresets"],
): ConfigPutPatch {
  return {
    ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
    ...(apiKeyPlaintext !== undefined ? { apiKeyPlaintext } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(truncBudget !== undefined ? { truncBudget } : {}),
    ...(presets !== undefined ? { presets } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(customPresets !== undefined ? { customPresets } : {}),
  };
}
export function validatePutBody(
  body: unknown,
):
  | { readonly ok: true; readonly patch: ConfigPutPatch }
  | { readonly ok: false; readonly failure: PutFailure } {
  const keysFailed = checkPutKeys(body);
  if (keysFailed !== null) return keysFailed;
  const apiR = checkPutApiKey(body);
  if (!apiR.ok) return apiR;
  const apiKeyRef = apiR.apiKeyRef;
  const apiKeyPlaintext = apiR.apiKeyPlaintext;
  const intsR = checkPutInts(body);
  if (!intsR.ok) return intsR;
  const intVals = intsR.intVals;
  const timeoutMs = intVals["timeoutMs"];
  const maxConcurrency = intVals["maxConcurrency"];
  const truncBudget = intVals["truncBudget"];
  const checkedPresets = checkPresetsField((body as Record<string, unknown>)["presets"]);
  if (!checkedPresets.ok) {
    return checkedPresets;
  }
  const presets = checkedPresets.list;
  const checkedHistory = checkHistoryField((body as Record<string, unknown>)["history"]);
  if (!checkedHistory.ok) {
    return checkedHistory;
  }
  const history = checkedHistory.history;
  const customR = checkPutCustom(body);
  if (!customR.ok) return customR;
  const customPresets = customR.customPresets;
  return {
    ok: true,
    patch: buildPutPatch(
      apiKeyRef,
      apiKeyPlaintext,
      timeoutMs,
      maxConcurrency,
      truncBudget,
      presets,
      history,
      customPresets,
    ),
  };
}
