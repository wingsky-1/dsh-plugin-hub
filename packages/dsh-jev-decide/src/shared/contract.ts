/**
 * dsh-jev-decide 双端共享契约（纯模块：零 import，宿主 tsc 直连、客户端 esbuild 直连）。
 *
 * 两端必须一致，谁也不许单方面改；缺口上报主代理。
 * 主代理裁决（已落实）：automationCap 用 0|1|2（0=none,1=low,2=high）；
 * GET /config 返回裸 v1 掩码体，两端同时兼容裸体与 {config}/{data} 包装；
 * 失败体必须同时含 errorCode + category（error/code 可选）。
 */

/** 插件在 DSH home 下的独立命名空间目录（与其它插件隔离）。 */
export const PACKAGE_DIR = "@wingsky-1/dsh-jev-decide";

/** 配置版本（config.json version 字段唯一合法值）。 */
export const CONFIG_VERSION = 1;

/** 预设模板版本（5 预设 frozen，templateVersion 恒为 1）。 */
export const TEMPLATE_VERSION = 1;

/** 官方 SystemOne 基址（写死常量；加载断言防篡改，PUT 拒收 baseUrl 类键）。 */
export const JEV_BASE_URL = "https://api.typesafe.ai/v1/systemone";
if (JEV_BASE_URL !== "https://api.typesafe.ai/v1/systemone") {
  throw new Error("dsh-jev-decide: JEV_BASE_URL 被篡改，拒绝加载");
}

/** 存储文件名（命名空间目录下独立四文件 + 版本刻度；custom-presets.json 缺席即空列表）。 */
export const CONFIG_FILE_NAME = "config.json";
export const PRESETS_FILE_NAME = "presets.json";
export const SECRETS_FILE_NAME = "secrets.json";
export const CUSTOM_PRESETS_FILE_NAME = "custom-presets.json";
export const VERSION_FILE_NAME = "VERSION";

/** 回环路由表（宿主 ROUTES 单一事实源经构建期注入客户端；此处常量是宿主侧定义）。 */
export const ROUTES = {
  health: "/api/dsh-jev-decide/health",
  config: "/api/dsh-jev-decide/config",
  presets: "/api/dsh-jev-decide/presets",
  history: "/api/dsh-jev-decide/history",
  testConnection: "/api/dsh-jev-decide/test-connection",
} as const;

/** ENV 引用名形状（与客户端 validApiKeyRef 同正则）。 */
export const API_KEY_REF_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** preset id 形状（ASCII 小写+数字+连字符；中文直接 400）。 */
export const PRESET_ID_RE = /^[a-z0-9-]{1,64}$/;
/** question id 形状（同上）。 */
export const QUESTION_ID_RE = /^[a-z0-9-]{1,64}$/;
/** 会话 id 形状（落盘文件名安全集）。 */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** CJK 探测（preset/question id 含中文即 400；state 正文不受此限）。 */
export const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 已退役配置键（加载迁移时剥离并告警；PUT 显式拒收 400）。 */
export const RETIRED_KEYS = ["baseUrl", "apiBaseUrl", "endpoint", "apiEndpoint", "url"] as const;

/** 单题文本上限（codepoints；超限 400）。 */
export const MAX_QUESTION_TEXT = 255;
/** 单次 override 最多题数。 */
export const MAX_QUESTIONS = 20;
/** 历史 snippet 上限（字；超限截断）。 */
export const SNIPPET_MAX = 200;

/** 状态语言（state.lang 全集；缺省即 400，不设默认）。 */
export type JevLang = "en" | "zh" | "unknown";
/** 置信分层。 */
export type JevTier = "none" | "high" | "low";
/** 自动化上限/分级：0=none（只人工），1=low，2=high。 */
export type AutomationCap = 0 | 1 | 2;
/** 自动化实际等级（suggest-only：输入被截断时的强制降级，仅建议不执行；local-precheck 的 manual 不受影响）。 */
export type AutomationLevel = "manual" | "assisted" | "auto" | "suggest-only";

/** frozen 预设模板：只存英文出题规范（一段自由描述），不存固定考题。调用方每次经 questions_override 自带全量题目。 */
export interface PresetTemplate {
  readonly id: string;
  readonly label: string;
  /** English asking guide: goal, dimensions, mutual exclusion, good vs bad asking examples, prohibitions, how to call. Free-form prose, length-checked only. */
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly automationCap: AutomationCap;
}

/** 5 预设 frozen 规范（secret-leak 默认关闭；模板零考题）。 */
export const FROZEN_PRESETS: readonly PresetTemplate[] = [
  {
    id: "general",
    label: "general",
    description:
      "Goal: teach callers how to ask a binary choice question over two comparable options. " +
      "Dimensions: option completeness, comparability, single conclusion. " +
      "Mutual exclusion: the verdict must be one of the caller-supplied candidates, never a third option and never an abstention. " +
      "Good asking: background in state.text plus two reachable, comparable candidates via questions_override (unique ids, 2-10 options per choice question). " +
      "Bad asking: listing phenomena with no candidates, which forces a restating non-answer. " +
      "Prohibitions: no preset questions; no third-option verdicts; no restating without deciding. " +
      "How to call: state.text carries background, questions_override carries the two candidates.",
    defaultEnabled: true,
    automationCap: 2,
  },
  {
    id: "secret-leak",
    label: "secret-leak",
    description:
      "Goal: teach callers how to ask whether a text contains a real secret that must not leave the device. " +
      "Dimensions: secret-shape match, surrounding semantics, certainty grading. " +
      "Mutual exclusion: a local shape hit goes straight to human review with no automated verdict. " +
      "Good asking: put the text under review in state.text with leak/clean candidates; genuine key shapes yield leak and human handoff. " +
      "Bad asking: asking about key-management concepts in general yields clean. " +
      "Prohibitions: never store real secret examples in templates; never judge concept discussion as a leak; never let secret text leave the device. " +
      "How to call: state.text carries the text under review (any language), candidates are leak/clean. Disabled by default.",
    defaultEnabled: false,
    automationCap: 0,
  },
  {
    id: "plan-review",
    label: "plan-review",
    description:
      "Goal: teach callers how to ask a 1-5 plan rating question. " +
      "Dimensions: completeness, feasibility, risk exposure. " +
      "Mutual exclusion: score only, no go/no-go decision; the score never substitutes for a proceed decision. " +
      "Good asking: per-dimension sub-scores rolled up into a total, e.g. landing at 4/5. " +
      "Bad asking: demanding a total with no dimensions. " +
      "Prohibitions: no preset plans in templates. " +
      "How to call: state.text carries the plan, questions_override carries one score question (no options allowed).",
    defaultEnabled: true,
    automationCap: 1,
  },
  {
    id: "risk-check",
    label: "risk-check",
    description:
      "Goal: teach callers how to ask a binary proceed-or-not question. " +
      "Dimensions: safety, compliance, reversibility. " +
      "Mutual exclusion: safe/risky only, no middle state. " +
      "Good asking: all three dimensions pass, verdict safe. " +
      "Bad asking: judging safe while one dimension is doubtful. " +
      "Prohibitions: no preset checklists in templates; never substitute hand-waving for a dimension verdict. " +
      "How to call: state.text carries the change, candidates safe/risky come from the caller.",
    defaultEnabled: true,
    automationCap: 1,
  },
  {
    id: "custom",
    label: "custom",
    description:
      "Goal: the caller brings the full question set (1-20 questions); the template presets nothing. " +
      "Mutual exclusion: questions_override is required and must be non-empty. " +
      "Good calling: three mutually exclusive binary questions execute normally. " +
      "Bad calling: empty questions are rejected outright. " +
      "Prohibitions: no execution without questions; never rewrite caller questions. " +
      "How to call: preset_id custom plus a full questions_override (unique ids, choice carries options, score carries none).",
    defaultEnabled: true,
    automationCap: 2,
  },
];

/** 自建自定义预设存储版本（custom-presets.json version 字段唯一合法值）。 */
export const CUSTOM_PRESETS_VERSION = 1;
/** 自定义预设上限（条）。 */
export const MAX_CUSTOM_PRESETS = 50;
/** 自定义名上限（codepoints）。 */
export const MAX_CUSTOM_LABEL = 64;
/** 自定义描述上限（codepoints，超限 400）。 */
export const MAX_CUSTOM_DESCRIPTION = 2000;

/** 用户自建预设（单 description 英文自由文本，可抄 frozen 写作约定，也可自由发挥；题目永随调用传入，不存）。 */
export interface CustomPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly automationCap: AutomationCap;
  readonly createdAt: number;
  readonly updatedAt: number;
}
/** 按 id 取 frozen 模板（无则 undefined）。 */
export function frozenPresetOf(id: string): PresetTemplate | undefined {
  for (const preset of FROZEN_PRESETS) {
    if (preset.id === id) return preset;
  }
  return undefined;
}

/** 配置 v1（connection 无明文、无 BaseURL；密钥只经 secrets.json/ENV）。 */
export interface ConfigV1 {
  readonly version: 1;
  readonly connection: {
    readonly apiKeyRef?: string;
    readonly hasPlaintextKey: boolean;
    readonly timeoutMs: number;
    readonly maxConcurrency: number;
    readonly truncBudget: number;
  };
  readonly presets: readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly automationCap: AutomationCap;
  }[];
  readonly history: {
    readonly perSession: number;
    readonly totalSessions: number;
  };
}

/** 历史条目快照的问题（调用方传入原样存档；文本/选项经同 snippet 的脱敏后存）。 */
export interface HistoryQuestion {
  readonly id: string;
  readonly text: string;
  readonly kind: "choice" | "score";
  readonly options?: readonly string[];
}

/** 历史条目（任务契约；原始密钥永不入库，snippetRedacted≤200；questions 为调用题目快照）。 */
export interface HistoryEntry {
  readonly ts: number;
  readonly rootHash: string;
  /** 仅 basename。 */
  readonly rootDisplay: string;
  readonly sessionId: string;
  readonly presetId: string;
  readonly templateVersion: number;
  readonly stateHash: string;
  readonly snippetRedacted: string;
  readonly lang: JevLang;
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly resultKind: string;
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
  readonly tier: JevTier;
  readonly automation: AutomationLevel;
  readonly provider: "official";
  readonly latencyMs: number;
  readonly errorCode?: string;
  readonly questions?: readonly HistoryQuestion[];
  /** 读取时 enrich 的展示标题（只存 id，缺失回退短 id）；永不落盘。 */
  readonly presetTitle?: string;
}

/** 成功输出必带字段（provider/appliedSource/truncated/originalLength/tier/automation/计费 codepoints/重试次数）。 */
export interface DecideOutput {
  readonly ok: true;
  readonly provider: "official";
  readonly appliedSource: "override" | "custom" | "local-precheck";
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly tier: JevTier;
  readonly automation: AutomationLevel;
  readonly codepoints: number;
  readonly retries: number;
  readonly latencyMs: number;
  readonly resultKind: string;
  readonly choice?: string;
  readonly score?: number;
  readonly confidence: number;
}

/** 失败包络（无概率字段；必含 errorCode + category 供客户端 failureCategory 识别）。 */
export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly errorCode: string;
    readonly category: string;
    readonly message: string;
  };
}

/** 密钥形状类别（400 仅回此类别，原文永不回显）。 */
export type KeyShapeCategory = "empty" | "too-short" | "charset";

/**
 * 全大写长串拒收阈值（P0 硬化）。
 *
 * 取 20 的理由：AWS AKIA/ASIA 访问键恰为 20 位全大写字母数字；阈值卡在“前缀可辨”线上——
 * 短通用名（KEY/TOKEN 等 ≤16 位）本就落在 too-short，不在此分支；16-19 位全大写（如
 * "ABCDEFGHIJKLMNOP"）无前缀可辨、误伤真实厂商大写键的风险高于收益，仍放行；
 * ≥20 位全大写字母数字混合＝高熵随机串特征，或命中 AKIA/ASIA 已泄露前缀，即判 charset。
 * 误伤取舍：极少数厂商确发全大写长键，被拦后走 ENV 引用轨（apiKeyRef 不走本判定）即可——
 * 明文轨从严、ENV 轨放行正是双轨设计本意。类别沿用 charset，不扩 KeyShapeCategory 并集。
 */
const ALL_CAPS_REJECT_MIN_LEN = 20;

/** 全大写字母数字下划线整串（ENV 名同形，长度+前缀/熵另行收口）。 */
const ALL_CAPS_RUN_RE = /^[A-Z0-9_]+$/;

/** 已泄露前缀（AWS 访问键族；后续前缀在此增补，不动判定骨架）。 */
function hasExposedPrefix(key: string): boolean {
  return key.startsWith("AKIA") || key.startsWith("ASIA");
}

/** 全大写长串是否拒收（短串/无熵串放行，防误伤正常 ENV 名）。 */
function rejectAllCapsLongRun(key: string): boolean {
  if (key.length < ALL_CAPS_REJECT_MIN_LEN) return false;
  if (!ALL_CAPS_RUN_RE.test(key)) return false;
  if (hasExposedPrefix(key)) return true;
  return /[A-Z]/.test(key) && /[0-9]/.test(key);
}

/** 密钥形状判定（有效：16-256 位可见字符集、含字母、非全大写长串；返回 null 即有效）。 */
export function keyShapeCategory(key: string): KeyShapeCategory | null {
  if (key.length === 0) return "empty";
  if (key.length < 16) return "too-short";
  if (key.length > 256 || !/^[A-Za-z0-9._~-]+$/.test(key)) return "charset";
  if (!/[A-Za-z]/.test(key)) return "charset";
  if (rejectAllCapsLongRun(key)) return "charset";
  return null;
}

/** 按 codepoints 截断（中文按字不断字节）。 */
export function truncateCodePoints(
  text: string,
  budget: number,
): { readonly text: string; readonly truncated: boolean; readonly originalLength: number } {
  const points = Array.from(text);
  if (points.length <= budget) return { text, truncated: false, originalLength: points.length };
  return { text: points.slice(0, budget).join(""), truncated: true, originalLength: points.length };
}

/** id 是否含 CJK（含即中文 400）。 */
export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}
