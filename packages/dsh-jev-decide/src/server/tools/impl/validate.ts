/**
 * tools 域实现：ws_jev_decide 参数校验（纯函数）。
 *
 * 规则（任务契约）：
 * - 双缺省/空串/空数组 400：preset_id 缺省、state.text 缺省或空串、custom 缺 override、override 空数组；
 * - custom 可单独 present：preset_id=custom 时 questions_override 必填（1-20 题任意）；
 * - override 全量：非 custom 的 override 须与模板等长且同 id 集（不接受部分覆盖）；
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

/** 单题校验（kind/options 互斥 + 255 + ASCII id）。 */
function checkQuestion(
  item: unknown,
): { readonly ok: true; readonly question: ValidQuestion } | Invalid {
  if (!isRecord(item)) return fail("BAD_QUESTION", "question must be an object");
  const id: unknown = item["id"];
  const text: unknown = item["text"];
  const kind: unknown = item["kind"];
  if (typeof id !== "string" || id.length === 0 || !QUESTION_ID_RE.test(id) || containsCjk(id)) {
    return fail("BAD_QUESTION_ID", "question id must be ASCII a-z0-9- 1..64");
  }
  if (
    typeof text !== "string" ||
    Array.from(text).length === 0 ||
    Array.from(text).length > MAX_QUESTION_TEXT ||
    text.trim().length === 0
  ) {
    return fail("BAD_QUESTION_TEXT", "question text must be 1..255 codepoints and non-blank");
  }
  if (kind !== "choice" && kind !== "score") {
    return fail("BAD_QUESTION_KIND", "question kind must be choice|score");
  }
  const options: unknown = item["options"];
  if (kind === "choice") {
    if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
      return fail("BAD_OPTIONS", "choice question needs 2..10 options");
    }
    for (const opt of options as unknown[]) {
      if (
        typeof opt !== "string" ||
        opt.length === 0 ||
        Array.from(opt).length > 64 ||
        (opt as string).trim().length === 0
      ) {
        return fail("BAD_OPTIONS", "option must be non-empty string <=64 codepoints");
      }
    }
    const opts = (options as unknown[]).map((opt) => opt as string);
    return { ok: true, question: { id, text, kind, options: opts } };
  }
  if (options !== undefined) {
    return fail("BAD_OPTIONS", "score question must not carry options");
  }
  return { ok: true, question: { id, text, kind } };
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

/** ws_jev_decide 参数校验（成功即 ValidDecide，失败即 400 类错误）。 */
export function validateDecideArgs(
  args: unknown,
): { readonly ok: true; readonly valid: ValidDecide } | Invalid {
  if (!isRecord(args)) return fail("BAD_ARGS", "args must be an object");
  const presetRaw: unknown = args["preset_id"];
  if (typeof presetRaw !== "string" || presetRaw.length === 0) {
    return fail("MISSING_PRESET", "preset_id is required");
  }
  if (!PRESET_ID_RE.test(presetRaw) || containsCjk(presetRaw)) {
    return fail("BAD_PRESET_ID", "preset_id must be ASCII a-z0-9- 1..64");
  }
  const template = frozenPresetOf(presetRaw);
  if (template === undefined) return fail("UNKNOWN_PRESET", "unknown preset");
  const state: unknown = args["state"];
  if (!isRecord(state)) return fail("MISSING_STATE", "state is required");
  const text: unknown = state["text"];
  if (typeof text !== "string" || text.length === 0 || (text as string).trim().length === 0) {
    return fail("EMPTY_TEXT", "state.text must be a non-blank string");
  }
  const lang: unknown = state["lang"];
  if (lang !== "en" && lang !== "zh" && lang !== "unknown") {
    return fail("BAD_LANG", "state.lang must be en|zh|unknown");
  }
  const override: unknown = args["questions_override"];
  if (presetRaw === "custom") {
    if (override === undefined)
      return fail("MISSING_OVERRIDE", "custom preset requires questions_override");
    const checked = checkOverrideList(override);
    if (!checked.ok) return checked;
    return {
      ok: true,
      valid: {
        presetId: presetRaw,
        text,
        lang,
        questions: checked.questions,
        appliedSource: "custom",
      },
    };
  }
  if (override === undefined) {
    const fromTemplate: ValidQuestion[] = template.questions.map((q) => ({
      id: q.id,
      text: q.text,
      kind: q.kind,
      ...(q.options !== undefined ? { options: [...q.options] } : {}),
    }));
    return {
      ok: true,
      valid: {
        presetId: presetRaw,
        text,
        lang,
        questions: fromTemplate,
        appliedSource: "template",
      },
    };
  }
  const checked = checkOverrideList(override);
  if (!checked.ok) return checked;
  if (checked.questions.length !== template.questions.length) {
    return fail(
      "PARTIAL_OVERRIDE",
      "questions_override must replace the full template question set",
    );
  }
  const templateIds = new Set(template.questions.map((q) => q.id));
  for (const q of checked.questions) {
    if (!templateIds.has(q.id)) {
      return fail(
        "PARTIAL_OVERRIDE",
        "questions_override must replace the full template question set",
      );
    }
  }
  return {
    ok: true,
    valid: {
      presetId: presetRaw,
      text,
      lang,
      questions: checked.questions,
      appliedSource: "override",
    },
  };
}
