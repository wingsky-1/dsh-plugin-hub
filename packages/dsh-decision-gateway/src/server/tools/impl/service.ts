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
  JEV_MODEL,
  SESSION_ID_RE,
  TEMPLATE_VERSION,
  truncateCodePoints,
} from "../../../shared/interface.ts";
import type {
  AutomationLevel,
  CustomPreset,
  DecideOutput,
  DecisionLang,
  ErrorEnvelope,
  DecisionTier,
} from "../../../shared/interface.ts";
import type { DecideDeps, DecideEvent, ValidDecide, ValidQuestion } from "../deps.ts";
import { callWithRetry, defaultFetchImpl, toWireQuestions } from "./client.ts";
import type { DecisionFailure, RemoteVerdict } from "./client.ts";
import { localPrecheckHit } from "./precheck.ts";
import { validateDecideArgs } from "./validate.ts";

/** 失败包络（必含 errorCode + category；message 不带任何原文/密钥）。 */
function envelope(errorCode: string, category: string, message: string): ErrorEnvelope {
  return { ok: false, error: { errorCode, category, message } };
}

/** 等级序号转分层（越界回落 none）。 */
function tierOf(index: number): DecisionTier {
  return index === 2 ? "high" : index === 1 ? "low" : "none";
}

/** 自动化等级（tier none 一律 manual；其余按封顶后序号）。 */
function automationOf(tier: DecisionTier, index: number): AutomationLevel {
  if (tier === "none") return "manual";
  return index >= 2 ? "auto" : index === 1 ? "assisted" : "manual";
}

/** 内部 AbortError 判定（排队取消在 task 启动前由并发门拒绝）。 */
function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    (cause as { readonly name?: unknown }).name === "AbortError"
  );
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
      "dsh-decision-gateway: 历史记录失败 —— " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

/** 执行一次决议（纯编排；副作用仅经注入 deps 发生）。 */
/** 截断结果（truncateCodePoints 的返回面，本文件多处共用故取其 ReturnType）。 */
type TruncResult = ReturnType<typeof truncateCodePoints>;

/**
 * 落史事件的公共面。
 *
 * 会话/预设/正文/截断/题面/预检命中这八个字段在预检命中、缺密钥、远端失败、
 * 远端成功四条落史路径上完全一致，抽成一处免得逐条改漏；各路径只在此之上
 * 追加自己的 resultKind 与概率/时延面。
 */
interface EventBase {
  readonly sessionId: string;
  readonly presetId: string;
  readonly text: string;
  readonly lang: DecisionLang;
  readonly truncated: boolean;
  readonly originalLength: number;
  readonly questions: readonly ValidQuestion[];
  readonly precheckHit: boolean;
}

/** 事件公共面构造（已校验入参 + 截断结果 + 预检命中位）。 */
function eventBase(
  deps: DecideDeps,
  valid: ValidDecide,
  trunc: TruncResult,
  hit: boolean,
): EventBase {
  return {
    sessionId: deps.sessionId,
    presetId: valid.presetId,
    text: valid.text,
    lang: valid.lang,
    truncated: trunc.truncated,
    originalLength: trunc.originalLength,
    questions: valid.questions,
    precheckHit: hit,
  };
}

/**
 * 本地预检命中：不出境直转人工。
 *
 * choice=human / tier=none / automation=manual 在此钉死，不受 automationCap
 * 与截断影响——R5 的 suggest-only 只作用于远端成功面，本路径恒 manual。
 */
function localPrecheckOutput(deps: DecideDeps, base: EventBase, trunc: TruncResult): DecideOutput {
  safeRecord(deps, {
    ...base,
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

/** 缺密钥：不发起远端调用，落史标 not-executed（不静默成功也不静默失败）。 */
function noKeyEnvelope(deps: DecideDeps, base: EventBase): ErrorEnvelope {
  safeRecord(deps, {
    ...base,
    resultKind: "not-executed",
    confidence: 0,
    tier: "none",
    automation: "manual",
    latencyMs: 0,
    errorCode: "NO_KEY",
  });
  return envelope("NO_KEY", "no-key", "no api key (set apiKeyRef or plaintext)");
}

/** 远端失败：回无概率字段的失败包络（choice/score/confidence/tier 一律不出现）。 */
function upstreamFailureEnvelope(
  deps: DecideDeps,
  base: EventBase,
  latencyMs: number,
  failure: DecisionFailure | undefined,
): ErrorEnvelope {
  const reason = failure ?? { code: "UPSTREAM", category: "upstream", message: "unknown" };
  safeRecord(deps, {
    ...base,
    resultKind: "upstream-error",
    confidence: 0,
    tier: "none",
    automation: "manual",
    latencyMs,
    errorCode: reason.code,
  });
  return envelope(reason.code, reason.category, reason.message);
}

/** tier/automation 投影：Noul 置空 tier（弃权不分级）→ cap 封顶 → 截断强制 suggest-only（R5）。 */
export function projectLevels(
  verdict: RemoteVerdict,
  cap: number,
  truncated: boolean,
): { readonly tier: DecisionTier; readonly automation: AutomationLevel } {
  const tierIndex =
    verdict.resultKind === "choice" && verdict.choice === "Noul" ? 0 : Math.min(verdict.tier, cap);
  const autoIndex = Math.min(verdict.automation, cap);
  const tier = tierOf(tierIndex);
  return { tier, automation: truncated ? "suggest-only" : automationOf(tier, autoIndex) };
}

/** 远端成功投影的输入（把 outcome 之外的面收成一束，母体调用处一眼可读）。 */
interface RemoteProjection {
  readonly appliedSource: ValidDecide["appliedSource"];
  readonly cap: number;
  readonly trunc: TruncResult;
  readonly latencyMs: number;
  readonly retries: number;
}

/** 远端成功：落史 + 回 DecideOutput（计费 codepoints 取远端回值，缺席回落原文长度）。 */
function projectVerdict(
  deps: DecideDeps,
  base: EventBase,
  verdict: RemoteVerdict,
  proj: RemoteProjection,
): DecideOutput {
  const { tier, automation } = projectLevels(verdict, proj.cap, proj.trunc.truncated);
  const codepoints = verdict.codepoints > 0 ? verdict.codepoints : proj.trunc.originalLength;
  safeRecord(deps, {
    ...base,
    resultKind: verdict.resultKind,
    ...(verdict.choice !== undefined ? { choice: verdict.choice } : {}),
    ...(verdict.score !== undefined ? { score: verdict.score } : {}),
    confidence: verdict.confidence,
    tier,
    automation,
    latencyMs: proj.latencyMs,
  });
  return {
    ok: true,
    provider: "official",
    appliedSource: proj.appliedSource,
    truncated: proj.trunc.truncated,
    originalLength: proj.trunc.originalLength,
    tier,
    automation,
    codepoints,
    retries: proj.retries,
    latencyMs: proj.latencyMs,
    resultKind: verdict.resultKind,
    ...(verdict.choice !== undefined ? { choice: verdict.choice } : {}),
    ...(verdict.score !== undefined ? { score: verdict.score } : {}),
    confidence: verdict.confidence,
  };
}

export async function decide(
  args: unknown,
  deps: DecideDeps,
): Promise<DecideOutput | ErrorEnvelope> {
  const customMap = deps.customPresets;
  const checked = validateDecideArgs(args, customMap);
  if (!checked.ok)
    return envelope(checked.failure.errorCode, "bad-request", checked.failure.message);
  const valid = checked.valid;
  if (!deps.isEnabled(valid.presetId)) {
    return envelope("PRESET_DISABLED", "preset-disabled", "preset disabled");
  }
  if (deps.signal.aborted) {
    return envelope("ABORTED", "aborted", "caller aborted");
  }

  const direct = <T>(task: () => Promise<T>): Promise<T> => task();
  const limit = deps.limit ?? direct;
  const execute = async (runRemote: typeof direct): Promise<DecideOutput | ErrorEnvelope> => {
    const trunc = truncateCodePoints(valid.text, deps.connection.truncBudget);
    const now = deps.now ?? Date.now;
    const cap = deps.capOf(valid.presetId);
    const started = now();
    const hit = localPrecheckHit(valid.text);
    const base = eventBase(deps, valid, trunc, hit);
    if (hit) return localPrecheckOutput(deps, base, trunc);
    const resolved = deps.resolveKey();
    if (resolved.key === undefined) return noKeyEnvelope(deps, base);
    const outcome = await runRemote(() =>
      callWithRetry(
        {
          model: JEV_MODEL,
          state: trunc.text,
          questions: toWireQuestions(valid.questions),
        },
        resolved.key as string,
        deps.connection.timeoutMs,
        deps.fetchImpl ?? defaultFetchImpl(),
        deps.signal,
      ),
    );
    const latencyMs = now() - started;
    if (outcome.failure !== undefined || outcome.verdict === undefined) {
      return upstreamFailureEnvelope(deps, base, latencyMs, outcome.failure);
    }
    return projectVerdict(deps, base, outcome.verdict, {
      appliedSource: valid.appliedSource,
      cap,
      trunc,
      latencyMs,
      retries: outcome.retries,
    });
  };

  try {
    return await limit(() => execute(direct), deps.signal);
  } catch (cause) {
    if (isAbortError(cause)) {
      return envelope("ABORTED", "aborted", "caller aborted");
    }
    throw cause;
  }
}

/** 预设清单（只读；frozen 规范 + 自建 customs，开关/上限取配置快照）。 */
export function listPresets(deps: {
  readonly isEnabled: (presetId: string) => boolean;
  readonly capOf: (presetId: string) => number;
  readonly customs?: readonly CustomPreset[];
}): readonly {
  readonly id: string;
  readonly enabled: boolean;
  readonly templateVersion: 1;
  readonly automationCap: number;
  readonly label: string;
  readonly description: string;
  readonly custom: boolean;
}[] {
  const frozen = FROZEN_PRESETS.map((preset) => ({
    id: preset.id,
    enabled: deps.isEnabled(preset.id),
    templateVersion: TEMPLATE_VERSION as 1,
    automationCap: deps.capOf(preset.id),
    label: preset.label,
    description: preset.description,
    custom: false as const,
  }));
  const customs = (deps.customs ?? []).map((preset) => ({
    id: preset.id,
    enabled: deps.isEnabled(preset.id),
    templateVersion: TEMPLATE_VERSION as 1,
    automationCap: deps.capOf(preset.id),
    label: preset.label,
    description: preset.description,
    custom: true as const,
  }));
  return [...frozen, ...customs];
}
