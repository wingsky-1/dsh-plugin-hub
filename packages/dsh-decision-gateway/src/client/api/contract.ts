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

function pickCategory(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  const nested = rec["error"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const nrec = nested as Record<string, unknown>;
    for (const key of ["category", "errorCode", "code"]) {
      const v = nrec[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  for (const key of ["category", "errorCode", "error", "code"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const msg = rec["message"];
  if (typeof msg === "string" && msg.length > 0) return msg;
  return null;
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
export function normalizeCap(v: unknown): AutomationCap {
  if (v === 1 || v === 2) return v;
  if (v === 0) return 0;
  if (typeof v === "string") {
    if (v === "high" || v === "2") return 2;
    if (v === "low" || v === "1") return 1;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v >= 2) return 2;
    if (v >= 1) return 1;
  }
  return 0;
}

export function capLabel(cap: AutomationCap): string {
  if (cap === 2) return "high";
  if (cap === 1) return "low";
  return t("capNone");
}

/** 防御式解析 GET /config（裸 v1 或 {config}/{data} 包装均接受）。 */
export function parseConfigPayload(payload: unknown): DecisionConfigV1 | null {
  const raw: unknown =
    isRecord(payload) && "config" in payload
      ? (payload as Record<string, unknown>)["config"]
      : isRecord(payload) &&
          "data" in payload &&
          isRecord((payload as Record<string, unknown>)["data"])
        ? (payload as Record<string, unknown>)["data"]
        : payload;
  if (!isRecord(raw)) return null;
  if (raw["version"] !== 1) return null;
  const conn = isRecord(raw["connection"]) ? (raw["connection"] as Record<string, unknown>) : null;
  const hist = isRecord(raw["history"]) ? (raw["history"] as Record<string, unknown>) : null;
  const presetsRaw = Array.isArray(raw["presets"]) ? (raw["presets"] as unknown[]) : null;
  if (conn === null || hist === null || presetsRaw === null) return null;
  const presets: Array<{
    readonly id: string;
    readonly enabled: boolean;
    readonly automationCap: AutomationCap;
  }> = [];
  for (const item of presetsRaw) {
    if (!isRecord(item) || typeof item["id"] !== "string") continue;
    presets.push({
      id: item["id"] as string,
      enabled: item["enabled"] === true,
      automationCap: normalizeCap(item["automationCap"]),
    });
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
  const list: unknown =
    isRecord(payload) && Array.isArray(payload["presets"])
      ? payload["presets"]
      : Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload["data"])
          ? payload["data"]
          : [];
  const out: DecisionPresetInfo[] = [];
  for (const item of list as unknown[]) {
    if (!isRecord(item) || typeof item["id"] !== "string") continue;
    const tv = item["templateVersion"];
    const label = item["label"];
    const desc = item["description"];
    const custom = item["custom"];
    out.push({
      id: item["id"] as string,
      templateVersion: typeof tv === "number" && Number.isFinite(tv) ? tv : undefined,
      label: typeof label === "string" ? label : undefined,
      description: typeof desc === "string" ? desc : undefined,
      custom: custom === true ? true : undefined,
    });
  }
  return out;
}

function normalizeAutomation(v: unknown): AutomationLevel {
  if (v === "assisted" || v === "auto" || v === "manual") return v;
  return "manual";
}

/** 防御式解析题目快照（形状不对即丢整列，不阻断条目）。 */
function parseQuestions(raw: unknown): DecisionHistoryEntry["questions"] {
  if (!Array.isArray(raw)) return undefined;
  const out: {
    readonly id: string;
    readonly text: string;
    readonly kind: "choice" | "score";
    readonly options?: readonly string[];
    readonly levels?: readonly string[];
  }[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const rec = item as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || typeof rec["text"] !== "string") return undefined;
    const kind = rec["kind"];
    if (kind !== "choice" && kind !== "score") return undefined;
    const options = rec["options"];
    const levels = rec["levels"];
    out.push({
      id: rec["id"] as string,
      text: rec["text"] as string,
      kind,
      ...(Array.isArray(options) && options.every((o) => typeof o === "string")
        ? { options: (options as string[]).slice() }
        : {}),
      ...(Array.isArray(levels) && levels.every((o) => typeof o === "string")
        ? { levels: (levels as string[]).slice() }
        : {}),
    });
  }
  return out;
}

/** 防御式解析 GET /history（裸数组或 {entries}/{items}/{history}/{data} 包装均接受）。 */
const str = (v: unknown, fb = ""): string => (typeof v === "string" ? v : fb);
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, fb: number): number => asNumber(v, fb);
const enumOf = <T extends string>(v: unknown, xs: readonly T[], fb: T): T =>
  (xs as readonly unknown[]).includes(v) ? (v as T) : fb;
const optScore = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const F: Array<[string, (v: unknown) => unknown]> = [
  ["rootHash", str],
  ["rootDisplay", str],
  ["presetId", str],
  ["templateVersion", (v) => num(v, 1)],
  ["stateHash", str],
  ["snippetRedacted", str],
  ["resultKind", str],
  ["tier", (v) => enumOf(v, ["high", "low"] as const, "none")],
  ["lang", (v) => enumOf(v, ["en", "zh"] as const, "unknown")],
  ["automation", (v) => normalizeAutomation(v)],
  ["truncated", (v) => v === true],
  ["originalLength", (v) => num(v, 0)],
  ["confidence", (v) => num(v, 0)],
  ["latencyMs", (v) => num(v, 0)],
  ["choice", optStr],
  ["score", optScore],
  ["errorCode", optStr],
];
export function toHistoryEntry(it: unknown): DecisionHistoryEntry | null {
  if (!isRecord(it)) return null;
  if (typeof it.ts !== "number" || typeof it.sessionId !== "string") return null;
  const o: Record<string, unknown> = { ts: it.ts, sessionId: it.sessionId, provider: "official" };
  for (const [k, f] of F) o[k] = f(it[k]);
  o.presetTitle = optStr(it.presetTitle);
  if (typeof it.sessionTitle === "string" && it.sessionTitle.length > 0)
    o.sessionTitle = it.sessionTitle;
  const q = parseQuestions(it.questions);
  if (q !== undefined) o.questions = q;
  return o as unknown as DecisionHistoryEntry;
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
