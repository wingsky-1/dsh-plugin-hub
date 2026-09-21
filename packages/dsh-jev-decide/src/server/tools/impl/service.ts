/**
 * tools 域实现：decide 编排（校验 → 开关 → 预检 → 截断 → 密钥 → 远端 → 落史）。
 *
 * - 校验 400 不落史（未进入任何预设）；开关关闭不落史；预检命中/远端成败落史；
 * - Noul 置空 tier：choice==="Noul" 时 tier 强制 none（弃权不分级）；
 * - tier/automation 受预设 automationCap 封顶（0=none,1=low,2=high）；
 * - 失败包络无概率字段（choice/score/confidence/tier 一律不出现）；
 * - 计费 codepoints 取远端回值，缺席回落原文长度；重试次数如实回传；
 * - R5：远端成功输出被截断时 automation 强制 suggest-only（local-precheck 的 manual 保持）；
 * - D4：recordEvent 经 safeRecord（try/catch + sessionId 落史前校验回落 unknown），落史失败不污染结果。
 */
import {
  FROZEN_PRESETS,
  SESSION_ID_RE,
  TEMPLATE_VERSION,
  truncateCodePoints,
} from "../../../shared/interface.ts";
import type {
  AutomationLevel,
  DecideOutput,
  ErrorEnvelope,
  JevTier,
} from "../../../shared/interface.ts";
import type { DecideDeps, DecideEvent } from "../deps.ts";
import { callWithRetry, defaultFetchImpl, toWireQuestions } from "./client.ts";
import { localPrecheckHit } from "./precheck.ts";
import { validateDecideArgs } from "./validate.ts";

/** 失败包络（必含 errorCode + category；message 不带任何原文/密钥）。 */
function envelope(errorCode: string, category: string, message: string): ErrorEnvelope {
  return { ok: false, error: { errorCode, category, message } };
}

/** 等级序号转分层（越界回落 none）。 */
function tierOf(index: number): JevTier {
  return index === 2 ? "high" : index === 1 ? "low" : "none";
}

/** 自动化等级（tier none 一律 manual；其余按封顶后序号）。 */
function automationOf(tier: JevTier, index: number): AutomationLevel {
  if (tier === "none") return "manual";
  return index >= 2 ? "auto" : index === 1 ? "assisted" : "manual";
}

/** 落史前 sessionId 校验（非法回落 unknown，保证文件名安全）。 */
function safeSessionId(sessionId: string): string {
  return SESSION_ID_RE.test(sessionId) ? sessionId : "unknown";
}

/** 记录事件（落史失败只记日志，不污染决议结果；sessionId 随事件同行并校验）。 */
function safeRecord(
  deps: DecideDeps,
  event: Omit<DecideEvent, "sessionId"> & { readonly sessionId: string },
): void {
  try {
    deps.recordEvent?.({ ...event, sessionId: safeSessionId(event.sessionId) });
  } catch (cause) {
    deps.logger.warn(
      "dsh-jev-decide: 历史记录失败 —— " + (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

/** 执行一次决议（纯编排；副作用仅经注入 deps 发生）。 */
export async function decide(
  args: unknown,
  deps: DecideDeps,
): Promise<DecideOutput | ErrorEnvelope> {
  const checked = validateDecideArgs(args);
  if (!checked.ok)
    return envelope(checked.failure.errorCode, "bad-request", checked.failure.message);
  const valid = checked.valid;
  if (!deps.isEnabled(valid.presetId)) {
    return envelope("PRESET_DISABLED", "preset-disabled", "preset disabled");
  }
  const trunc = truncateCodePoints(valid.text, deps.connection.truncBudget);
  const now = deps.now ?? Date.now;
  const cap = deps.capOf(valid.presetId);
  const started = now();
  const hit = localPrecheckHit(valid.text);
  if (hit) {
    safeRecord(deps, {
      sessionId: deps.sessionId,
      precheckHit: true,
      presetId: valid.presetId,
      text: valid.text,
      lang: valid.lang,
      truncated: trunc.truncated,
      originalLength: trunc.originalLength,
      resultKind: "local-precheck",
      choice: "human",
      confidence: 1,
      tier: "none",
      automation: "manual",
      latencyMs: 0,
    });
    return {
      ok: true,
      provider: "official",
      appliedSource: "local-precheck",
      truncated: trunc.truncated,
      originalLength: trunc.originalLength,
      tier: "none",
      automation: "manual",
      codepoints: 0,
      retries: 0,
      latencyMs: 0,
      resultKind: "local-precheck",
      choice: "human",
      confidence: 1,
    };
  }
  const resolved = deps.resolveKey();
  if (resolved.key === undefined) {
    safeRecord(deps, {
      sessionId: deps.sessionId,
      presetId: valid.presetId,
      text: valid.text,
      lang: valid.lang,
      truncated: trunc.truncated,
      originalLength: trunc.originalLength,
      resultKind: "not-executed",
      precheckHit: hit,
      confidence: 0,
      tier: "none",
      automation: "manual",
      latencyMs: 0,
      errorCode: "NO_KEY",
    });
    return envelope("NO_KEY", "no-key", "no api key (set apiKeyRef or confirmed plaintext)");
  }
  const fetchImpl = deps.fetchImpl ?? defaultFetchImpl();
  const limit = deps.limit ?? (<T>(task: () => Promise<T>): Promise<T> => task());
  const body = {
    preset: valid.presetId,
    templateVersion: TEMPLATE_VERSION as 1,
    state: { text: trunc.text, lang: valid.lang },
    questions: toWireQuestions(valid.questions),
  };
  const outcome = await limit(() =>
    callWithRetry(body, resolved.key as string, deps.connection.timeoutMs, fetchImpl),
  );
  const latencyMs = now() - started;
  if (outcome.failure !== undefined || outcome.verdict === undefined) {
    const failure = outcome.failure ?? {
      code: "UPSTREAM",
      category: "upstream",
      message: "unknown",
    };
    safeRecord(deps, {
      sessionId: deps.sessionId,
      presetId: valid.presetId,
      text: valid.text,
      lang: valid.lang,
      truncated: trunc.truncated,
      originalLength: trunc.originalLength,
      resultKind: "upstream-error",
      precheckHit: hit,
      confidence: 0,
      tier: "none",
      automation: "manual",
      latencyMs,
      errorCode: failure.code,
    });
    return envelope(failure.code, failure.category, failure.message);
  }
  const verdict = outcome.verdict;
  const tierIndex =
    verdict.resultKind === "choice" && verdict.choice === "Noul" ? 0 : Math.min(verdict.tier, cap);
  const autoIndex = Math.min(verdict.automation, cap);
  const tier = tierOf(tierIndex);
  const automation: AutomationLevel = trunc.truncated
    ? "suggest-only"
    : automationOf(tier, autoIndex);
  const codepoints = verdict.codepoints > 0 ? verdict.codepoints : trunc.originalLength;
  safeRecord(deps, {
    sessionId: deps.sessionId,
    presetId: valid.presetId,
    text: valid.text,
    lang: valid.lang,
    truncated: trunc.truncated,
    originalLength: trunc.originalLength,
    resultKind: verdict.resultKind,
    precheckHit: hit,
    ...(verdict.choice !== undefined ? { choice: verdict.choice } : {}),
    ...(verdict.score !== undefined ? { score: verdict.score } : {}),
    confidence: verdict.confidence,
    tier,
    automation,
    latencyMs,
  });
  return {
    ok: true,
    provider: "official",
    appliedSource: valid.appliedSource,
    truncated: trunc.truncated,
    originalLength: trunc.originalLength,
    tier,
    automation,
    codepoints,
    retries: outcome.retries,
    latencyMs,
    resultKind: verdict.resultKind,
    ...(verdict.choice !== undefined ? { choice: verdict.choice } : {}),
    ...(verdict.score !== undefined ? { score: verdict.score } : {}),
    confidence: verdict.confidence,
  };
}

/** 预设清单（只读；模板 frozen，开关/上限取配置快照）。 */
export function listPresets(deps: {
  readonly isEnabled: (presetId: string) => boolean;
  readonly capOf: (presetId: string) => number;
}): readonly {
  readonly id: string;
  readonly enabled: boolean;
  readonly templateVersion: 1;
  readonly automationCap: number;
  readonly questionCount: number;
}[] {
  return FROZEN_PRESETS.map((preset) => ({
    id: preset.id,
    enabled: deps.isEnabled(preset.id),
    templateVersion: TEMPLATE_VERSION as 1,
    automationCap: deps.capOf(preset.id),
    questionCount: preset.questions.length,
  }));
}
