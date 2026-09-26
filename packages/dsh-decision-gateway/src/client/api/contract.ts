/**
 * dsh-decision-gateway — 客户端契约消费层（api/ 域内模块，经 interface.ts 门面引用）。
 *
 * 类型直接复用共享 ConfigV1/HistoryEntry/DecisionLang/DecisionTier/AutomationCap/AutomationLevel；
 * 解析/归一/校验为纯函数（可单测直连）。主代理裁决：automationCap 三档 0|1|2；
 * GET /config 裸 v1 掩码体并兼容 {config}/{data} 包装；失败体含 errorCode + category。
 * 零 bare import。
 */
import type {
  AutomationCap,
  AutomationLevel,
  ConfigV1 as SharedConfigV1,
  HistoryEntry as SharedHistoryEntry,
  HistoryQuestion,
  DecisionLang,
  DecisionTier,
} from "../../shared/interface.ts";
import { t } from "../locale.ts";

/** 共享类型复出（子模块经 api/interface.ts 消费）。 */
export type { AutomationCap, AutomationLevel, DecisionLang, DecisionTier };
export type DecisionConfigV1 = SharedConfigV1;
export type DecisionHistoryEntry = SharedHistoryEntry;

/** 预设开关项（配置 v1.presets 元素形态）。 */
export type DecisionPresetConfigEntry = SharedConfigV1["presets"][number];

/** 模板库目录项（GET /presets 元素形态；服务端字段缺失时容错）。 */
export interface DecisionPresetInfo {
  readonly id: string;
  readonly templateVersion?: number;
  readonly label?: string;
  readonly description?: string;
  readonly custom?: boolean;
}

/** 嵌套 error 面里的类别键（按优先级取首个非空串）。 */
const NESTED_CATEGORY_KEYS = ["category", "errorCode", "code"] as const;
/** 顶层类别键（error 面未命中后按此优先级取；顶层 "error" 可能是串类别）。 */
const TOP_CATEGORY_KEYS = ["category", "errorCode", "error", "code"] as const;
/** 兜底键（类别与 code 都没有时取人类可读 message）。 */
const MESSAGE_KEYS = ["message"] as const;

/** 候选键里取第一个非空串（无命中回 null）。类别取值优先级就写在这三张键表里。 */
function firstNonEmptyStr(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pickCategory(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const nested = body["error"];
  const fromNested = isRecord(nested) ? firstNonEmptyStr(nested, NESTED_CATEGORY_KEYS) : null;
  if (fromNested !== null) return fromNested;
  return firstNonEmptyStr(body, TOP_CATEGORY_KEYS) ?? firstNonEmptyStr(body, MESSAGE_KEYS);
}

export function failureCategory(status: number, body: unknown): string {
  const hit = pickCategory(body);
  if (hit !== null) return hit;
  if (status === 403) return "forbidden-non-loopback";
  if (status === 405) return "method-not-allowed";
  if (status === 400) return "bad-request";
  return "http-" + status;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** automationCap 归一到 0|1|2（非法回 0=none）。 */

/** 串别名 → 档（high/2 → 2，low/1 → 1；未命中回 null，调用方回落 none）。 */
function capFromString(v: string): AutomationCap | null {
  if (v === "high" || v === "2") return 2;
  if (v === "low" || v === "1") return 1;
  return null;
}

/** 数值区间 → 档（≥2 封 high，≥1 封 low，其余 none；小数与负数都落 none）。 */
function capFromNumber(v: number): AutomationCap {
  if (v >= 2) return 2;
  if (v >= 1) return 1;
  return 0;
}

export function normalizeCap(v: unknown): AutomationCap {
  if (v === 1 || v === 2) return v;
  if (v === 0) return 0;
  if (typeof v === "string") return capFromString(v) ?? 0;
  if (typeof v === "number" && Number.isFinite(v)) return capFromNumber(v);
  return 0;
}

export function capLabel(cap: AutomationCap): string {
  if (cap === 2) return "high";
  if (cap === 1) return "low";
  return t("capNone");
}

/** GET /config 的三种载体（裸 v1 / {config} / {data}）解包；都不匹配即原样回传交后续判。 */
function unwrapConfig(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if ("config" in payload) return payload["config"];
  if ("data" in payload && isRecord(payload["data"])) return payload["data"];
  return payload;
}

/** config 三段（connection/history/presets）形状门；任一不对即整份拒收。 */
function configSections(raw: Record<string, unknown>): {
  readonly conn: Record<string, unknown>;
  readonly hist: Record<string, unknown>;
  readonly presets: readonly unknown[];
} | null {
  const conn = raw["connection"];
  const hist = raw["history"];
  const presets = raw["presets"];
  if (!isRecord(conn) || !isRecord(hist) || !Array.isArray(presets)) return null;
  return { conn, hist, presets };
}

/** 预设开关项归一（id 必须是串；缺 id 的整项丢弃，不猜默认）。 */
function parsePresetItem(item: unknown): DecisionPresetConfigEntry | null {
  if (!isRecord(item)) return null;
  const id = item["id"];
  if (typeof id !== "string") return null;
  return {
    id,
    enabled: item["enabled"] === true,
    automationCap: normalizeCap(item["automationCap"]),
  };
}

/** 防御式解析 GET /config（裸 v1 或 {config}/{data} 包装均接受）。 */
export function parseConfigPayload(payload: unknown): DecisionConfigV1 | null {
  const raw = unwrapConfig(payload);
  if (!isRecord(raw)) return null;
  if (raw["version"] !== 1) return null;
  const sections = configSections(raw);
  if (sections === null) return null;
  const conn = sections.conn;
  const hist = sections.hist;
  const presets: Array<{
    readonly id: string;
    readonly enabled: boolean;
    readonly automationCap: AutomationCap;
  }> = [];
  for (const item of sections.presets) {
    const parsed = parsePresetItem(item);
    if (parsed !== null) presets.push(parsed);
  }
  const apiKeyRef = conn["apiKeyRef"];
  return {
    version: 1,
    connection: {
      apiKeyRef: typeof apiKeyRef === "string" ? apiKeyRef : undefined,
      hasPlaintextKey: conn["hasPlaintextKey"] === true,
      timeoutMs: asNumber(conn["timeoutMs"], 8000),
      maxConcurrency: asNumber(conn["maxConcurrency"], 4),
      truncBudget: asNumber(conn["truncBudget"], 32000),
    },
    presets,
    history: {
      perSession: asNumber(hist["perSession"], 200),
      totalSessions: asNumber(hist["totalSessions"], 50),
    },
  };
}

/** 防御式解析 GET /presets（裸数组或 {presets} 包装均接受）。 */
export function parsePresetsPayload(payload: unknown): DecisionPresetInfo[] {
  const out: DecisionPresetInfo[] = [];
  for (const item of unwrapPresets(payload)) {
    const info = parsePresetInfo(item);
    if (info !== null) out.push(info);
  }
  return out;
}

/** GET /presets 的三种载体（裸数组 / {presets} / {data}）解包；都不匹配即空列表。 */
function unwrapPresets(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload["presets"])) return payload["presets"];
  if (Array.isArray(payload["data"])) return payload["data"];
  return [];
}

/** 模板库目录项归一（id 必须是串；缺 id 的整项丢弃。字段缺失时该键不存在）。 */
function parsePresetInfo(item: unknown): DecisionPresetInfo | null {
  if (!isRecord(item)) return null;
  const id = item["id"];
  if (typeof id !== "string") return null;
  const tv = item["templateVersion"];
  const label = item["label"];
  const desc = item["description"];
  const custom = item["custom"];
  return {
    id,
    templateVersion: typeof tv === "number" && Number.isFinite(tv) ? tv : undefined,
    label: typeof label === "string" ? label : undefined,
    description: typeof desc === "string" ? desc : undefined,
    custom: custom === true ? true : undefined,
  };
}

function normalizeAutomation(v: unknown): AutomationLevel {
  if (v === "assisted" || v === "auto" || v === "manual") return v;
  return "manual";
}

/** 串项谓词（供 every 用，命中即把数组收窄成 string[]，免去元素断言）。 */
function isStringItem(v: unknown): v is string {
  return typeof v === "string";
}

/** 选项/分档的串项条件展开（非数组或含非串项即不写该键）。 */
function stringItems(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw) || !raw.every(isStringItem)) return undefined;
  return raw.slice();
}

/** 单题归一（id/text 必为串，kind 限 choice|score；任一不合即整列丢弃）。 */
function parseQuestionItem(item: unknown): HistoryQuestion | null {
  if (!isRecord(item)) return null;
  const id = item["id"];
  const text = item["text"];
  if (typeof id !== "string" || typeof text !== "string") return null;
  const kind = item["kind"];
  if (kind !== "choice" && kind !== "score") return null;
  const options = stringItems(item["options"]);
  const levels = stringItems(item["levels"]);
  return {
    id,
    text,
    kind,
    ...(options !== undefined ? { options } : {}),
    ...(levels !== undefined ? { levels } : {}),
  };
}

/** 防御式解析题目快照（形状不对即丢整列，不阻断条目）。 */
function parseQuestions(raw: unknown): DecisionHistoryEntry["questions"] {
  if (!Array.isArray(raw)) return undefined;
  const out: HistoryQuestion[] = [];
  for (const item of raw) {
    const question = parseQuestionItem(item);
    if (question === null) return undefined;
    out.push(question);
  }
  return out;
}

/** 防御式解析 GET /history（裸数组或 {entries}/{items}/{history}/{data} 包装均接受）。 */
const str = (v: unknown, fb = ""): string => (typeof v === "string" ? v : fb);
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, fb: number): number => asNumber(v, fb);
const enumOf = <T extends string>(v: unknown, xs: readonly T[], fb: T): T =>
  xs.find((x) => x === v) ?? fb;
const optScore = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const nonEmptyStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const normTier = (v: unknown): DecisionTier => enumOf(v, ["high", "low"], "none");
const normLang = (v: unknown): DecisionLang => enumOf(v, ["en", "zh"], "unknown");

/** 可缺失的键：形状不对/为空即整个 key 不存在（写入面一律条件展开，六键同写法）。 */
type OptionalKey = "choice" | "score" | "errorCode" | "presetTitle" | "sessionTitle" | "questions";
/** 归一器覆盖的必填键（键名笔误越出该联合，tsc 报 TS2536/TS2345，不必等运行期字段 undefined）。 */
type RequiredKey =
  | "rootHash"
  | "rootDisplay"
  | "presetId"
  | "templateVersion"
  | "stateHash"
  | "snippetRedacted"
  | "resultKind"
  | "tier"
  | "lang"
  | "automation"
  | "truncated"
  | "originalLength"
  | "confidence"
  | "latencyMs";
type NormalizedKey = RequiredKey | OptionalKey;
type NormalizerFor<K extends NormalizedKey> = (v: unknown) => DecisionHistoryEntry[K];

/**
 * 键 → 归一器：键与归一器返回类型逐键绑定，这层标注就是编译期护栏。
 *
 * 漏键/多键报 TS2741/TS2353，归一器返回类型与 DecisionHistoryEntry[K] 不符报 TS2322。
 * 表项不是一维的 [string, fn] 对：键的取值域由 NormalizedKey 锁死，所以
 * ["confidenceMs", …] 这类笔误在 tsc 阶段判红，而不是运行期该字段 undefined。
 */
const NORMALIZERS: { [K in NormalizedKey]: NormalizerFor<K> } = {
  rootHash: str,
  rootDisplay: str,
  presetId: str,
  templateVersion: (v) => num(v, 1),
  stateHash: str,
  snippetRedacted: str,
  resultKind: str,
  tier: normTier,
  lang: normLang,
  automation: normalizeAutomation,
  truncated: (v) => v === true,
  originalLength: (v) => num(v, 0),
  confidence: (v) => num(v, 0),
  latencyMs: (v) => num(v, 0),
  choice: optStr,
  score: optScore,
  errorCode: optStr,
  presetTitle: optStr,
  sessionTitle: nonEmptyStr,
  questions: parseQuestions,
};

/** 按键取归一值：K 同时约束键与返回类型，调用点写错键名 tsc 即报 TS2345。 */
function norm<K extends NormalizedKey>(
  key: K,
  raw: Record<string, unknown>,
): DecisionHistoryEntry[K] {
  return NORMALIZERS[key](raw[key]);
}

/** 六个可缺失键的归一结果面（缺键即不写，供 toHistoryEntry 一次展开）。 */
function optionalHistoryFields(
  raw: Record<string, unknown>,
): Partial<Pick<DecisionHistoryEntry, OptionalKey>> {
  const choice = norm("choice", raw);
  const score = norm("score", raw);
  const errorCode = norm("errorCode", raw);
  const presetTitle = norm("presetTitle", raw);
  const sessionTitle = norm("sessionTitle", raw);
  const questions = norm("questions", raw);
  return {
    ...(choice !== undefined ? { choice } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(presetTitle !== undefined ? { presetTitle } : {}),
    ...(sessionTitle !== undefined ? { sessionTitle } : {}),
    ...(questions !== undefined ? { questions } : {}),
  };
}
export function toHistoryEntry(it: unknown): DecisionHistoryEntry | null {
  if (!isRecord(it)) return null;
  if (typeof it.ts !== "number" || typeof it.sessionId !== "string") return null;
  return {
    ts: it.ts,
    sessionId: it.sessionId,
    provider: "official",
    rootHash: norm("rootHash", it),
    rootDisplay: norm("rootDisplay", it),
    presetId: norm("presetId", it),
    templateVersion: norm("templateVersion", it),
    stateHash: norm("stateHash", it),
    snippetRedacted: norm("snippetRedacted", it),
    resultKind: norm("resultKind", it),
    tier: norm("tier", it),
    lang: norm("lang", it),
    automation: norm("automation", it),
    truncated: norm("truncated", it),
    originalLength: norm("originalLength", it),
    confidence: norm("confidence", it),
    latencyMs: norm("latencyMs", it),
    ...optionalHistoryFields(it),
  };
}
export function parseHistoryPayload(payload: unknown): DecisionHistoryEntry[] {
  let list: unknown = [];
  if (Array.isArray(payload)) list = payload;
  else if (isRecord(payload)) {
    for (const key of ["entries", "items", "history", "data"]) {
      const v = payload[key];
      if (Array.isArray(v)) {
        list = v;
        break;
      }
    }
  }
  const out: DecisionHistoryEntry[] = [];
  for (const item of list as unknown[]) {
    const entry = toHistoryEntry(item);
    if (entry !== null) out.push(entry);
  }
  return out;
}

/** ENV 名本地校验（与共享 API_KEY_REF_RE 同正则）。 */
export function validApiKeyRef(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(name);
}

/** 0..1 概率钳制（概率条宽度与文案同源；与 automationCap 三档无关）。 */
export function clamp01(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
