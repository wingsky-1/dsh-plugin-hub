/**
 * tools 域实现：ws_request_verdict 参数校验（纯函数）。
 *
 * 规则（任务契约；模板零考题）：
 * - 双缺省/空串/空数组 400：preset_id 缺省、state.text 缺省或空串、全员缺 override、override 空数组；
 * - 全员显式带题：questions_override 必填（1-20 题任意），appliedSource 为 custom（custom 内建或自建 id）或 override（其余）；
 * - 互斥：题 id 唯一；choice 必须带 options（2-10 个非空串），score 禁止带 options；
 * - 255/长度：单题文本 1-255 codepoints，id ASCII 且 ≤64，总题数 ≤20；
 * - 中文 400：preset/question id 含 CJK 即 400（state 正文不受此限，lang=zh 合法）；
 * - lang 无缺省：en|zh|unknown 必填其一。
 */
import {
  MAX_QUESTIONS,
  MAX_QUESTION_TEXT,
  PRESET_ID_RE,
  QUESTION_ID_RE,
  containsCjk,
  frozenPresetOf,
} from "../../../shared/interface.ts";
import type { CustomPreset, DecisionLang } from "../../../shared/interface.ts";
import type { ValidDecide, ValidQuestion } from "../deps.ts";

/** 校验失败（调用方映射为 400/ErrorEnvelope，不抛）。 */
export interface DecideValidationFailure {
  readonly errorCode: string;
  readonly message: string;
}

type Invalid = { readonly ok: false; readonly failure: DecideValidationFailure };

function fail(errorCode: string, message: string): Invalid {
  return { ok: false, failure: { errorCode, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 题 id 谓词：非空、ASCII a-z0-9-、不含 CJK（题 id 不放行中文，state 正文不受此限）。 */
function isQuestionId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && QUESTION_ID_RE.test(v) && !containsCjk(v);
}

/** 题面文本谓词：1..MAX_QUESTION_TEXT codepoints 且非纯空白（中文正文合法）。 */
function isQuestionText(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const n = Array.from(v).length;
  return n > 0 && n <= MAX_QUESTION_TEXT && v.trim().length > 0;
}

/** 串项谓词：非空、≤64 codepoints、非纯空白（options 元素与 levels 元素同一规则）。 */
function isLabelText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && Array.from(v).length <= 64 && v.trim().length > 0;
}

/**
 * 2..10 个合格串项的形状校验（options 与 levels 共用同一规则）。
 *
 * 返回窄联合而非 boolean：形状不合（缺数组/数量越界）与元素不合是两类不同的失败，
 * 各自映射不同的 errorCode 与文案，由调用方按 kind 分派——所以 reason 不能在这里抹平。
 */
type LabelListCheck =
  | { readonly ok: true; readonly list: readonly string[] }
  | { readonly ok: false; readonly reason: "shape" | "element" };

function checkLabelList(raw: unknown): LabelListCheck {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 10) {
    return { ok: false, reason: "shape" };
  }
  const list: string[] = [];
  for (const item of raw) {
    if (!isLabelText(item)) return { ok: false, reason: "element" };
    list.push(item);
  }
  return { ok: true, list };
}

/** choice 题分支：options 必带 2..10 项、禁带 levels（互斥规则的 choice 侧）。 */
function checkChoiceQuestion(
  item: Record<string, unknown>,
  id: string,
  text: string,
): { readonly ok: true; readonly question: ValidQuestion } | Invalid {
  const options = checkLabelList(item["options"]);
  if (!options.ok) {
    return options.reason === "element"
      ? fail("BAD_OPTIONS", "option must be non-empty string <=64 codepoints")
      : fail("BAD_OPTIONS", "choice question needs 2..10 options");
  }
  if (item["levels"] !== undefined) {
    return fail("BAD_LEVELS", "choice question must not carry levels");
  }
  return { ok: true, question: { id, text, kind: "choice", options: options.list } };
}

/** score 题分支：禁带 options，levels 缺省回默认 1-5、给了就校验 2..10 项（互斥规则的 score 侧）。 */
function checkScoreQuestion(
  item: Record<string, unknown>,
  id: string,
  text: string,
): { readonly ok: true; readonly question: ValidQuestion } | Invalid {
  if (item["options"] !== undefined) {
    return fail("BAD_OPTIONS", "score question must not carry options");
  }
  if (item["levels"] === undefined) {
    return { ok: true, question: { id, text, kind: "score" } };
  }
  const levels = checkLabelList(item["levels"]);
  if (!levels.ok) {
    return levels.reason === "element"
      ? fail("BAD_LEVELS", "level must be non-empty string <=64 codepoints")
      : fail("BAD_LEVELS", "score levels must be 2..10 rubric strings (or omit for default 1-5)");
  }
  return { ok: true, question: { id, text, kind: "score", levels: levels.list } };
}

/** 单题校验：题面骨架（id/text/kind）+ 按 kind 分派到两条互斥分支。 */
function checkQuestion(
  item: unknown,
): { readonly ok: true; readonly question: ValidQuestion } | Invalid {
  if (!isRecord(item)) return fail("BAD_QUESTION", "question must be an object");
  const id = item["id"];
  if (!isQuestionId(id)) {
    return fail("BAD_QUESTION_ID", "question id must be ASCII a-z0-9- 1..64");
  }
  const text = item["text"];
  if (!isQuestionText(text)) {
    return fail("BAD_QUESTION_TEXT", "question text must be 1..255 codepoints and non-blank");
  }
  const kind = item["kind"];
  if (kind !== "choice" && kind !== "score") {
    return fail("BAD_QUESTION_KIND", "question kind must be choice|score");
  }
  return kind === "choice"
    ? checkChoiceQuestion(item, id, text)
    : checkScoreQuestion(item, id, text);
}

/** override 数组校验（非空 + 题数上限 + id 唯一）。 */
function checkOverrideList(
  raw: unknown,
): { readonly ok: true; readonly questions: ValidQuestion[] } | Invalid {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail("EMPTY_OVERRIDE", "questions_override must be a non-empty array");
  }
  if (raw.length > MAX_QUESTIONS) {
    return fail("TOO_MANY_QUESTIONS", "questions_override must hold <=20 questions");
  }
  const questions: ValidQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    const checked = checkQuestion(item);
    if (!checked.ok) return checked;
    if (seen.has(checked.question.id)) {
      return fail("DUPLICATE_QUESTION_ID", "question ids must be unique");
    }
    seen.add(checked.question.id);
    questions.push(checked.question);
  }
  return { ok: true, questions };
}

/** preset_id 解析结果：形状校验通过后判内建/自建归属，appliedSource 由 isCustom 决定。 */
type PresetPick =
  { readonly ok: true; readonly presetId: string; readonly isCustom: boolean } | Invalid;

/**
 * preset_id 校验与内建/自建判定。
 *
 * 内建命中即不看自建表（自建 id 不得覆盖 frozen 预设），所以 customPreset 的查表在
 * template 缺席时才发生——这条优先级是契约，不能简化成两次无条件查表。
 */
function pickPreset(
  args: Record<string, unknown>,
  custom?: ReadonlyMap<string, CustomPreset>,
): PresetPick {
  const presetRaw = args["preset_id"];
  if (typeof presetRaw !== "string" || presetRaw.length === 0) {
    return fail("MISSING_PRESET", "preset_id is required");
  }
  if (!PRESET_ID_RE.test(presetRaw) || containsCjk(presetRaw)) {
    return fail("BAD_PRESET_ID", "preset_id must be ASCII a-z0-9- 1..64");
  }
  const template = frozenPresetOf(presetRaw);
  const customPreset = template === undefined ? custom?.get(presetRaw) : undefined;
  if (template === undefined && customPreset === undefined) {
    return fail("UNKNOWN_PRESET", "unknown preset");
  }
  const isCustom = presetRaw === "custom" || customPreset !== undefined;
  return { ok: true, presetId: presetRaw, isCustom };
}

/** state 校验：text 非空串（中文正文合法），lang 无缺省——写错即 400。 */
function checkState(
  state: unknown,
): { readonly ok: true; readonly text: string; readonly lang: DecisionLang } | Invalid {
  if (!isRecord(state)) return fail("MISSING_STATE", "state is required");
  const text = state["text"];
  if (typeof text !== "string" || text.length === 0 || text.trim().length === 0) {
    return fail("EMPTY_TEXT", "state.text must be a non-blank string");
  }
  const langRaw = state["lang"];
  const lang: unknown = langRaw === undefined ? "unknown" : langRaw;
  if (lang !== "en" && lang !== "zh" && lang !== "unknown") {
    return fail("BAD_LANG", "state.lang must be en|zh|unknown");
  }
  return { ok: true, text, lang };
}

/** ws_request_verdict 参数校验（成功即 ValidDecide，失败即 400 类错误；custom 自建 id 经第二参传入）。 */
export function validateDecideArgs(
  args: unknown,
  custom?: ReadonlyMap<string, CustomPreset>,
): { readonly ok: true; readonly valid: ValidDecide } | Invalid {
  if (!isRecord(args)) return fail("BAD_ARGS", "args must be an object");
  const preset = pickPreset(args, custom);
  if (!preset.ok) return preset;
  const state = checkState(args["state"]);
  if (!state.ok) return state;
  const override = args["questions_override"];
  if (override === undefined) {
    return fail("MISSING_OVERRIDE", "questions_override is required (templates hold no questions)");
  }
  const checked = checkOverrideList(override);
  if (!checked.ok) return checked;
  return {
    ok: true,
    valid: {
      presetId: preset.presetId,
      text: state.text,
      lang: state.lang,
      questions: checked.questions,
      appliedSource: preset.isCustom ? "custom" : "override",
    },
  };
}
