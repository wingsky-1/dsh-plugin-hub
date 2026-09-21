/**
 * dsh-provider-usage — upgrade 域配置形态割接（旧单模板/旧三周期默认 → 新三周期默认）。
 *
 * 只做形态割接，不做归一化：归一化单答案仍归 server/config/normalize.ts 的 normalizeReportConfig
 *（运行时读面），本步只把「用户从未自定义的旧默认文本」升级为三份新默认，把「自定义旧单模板」
 *展开为三周期同文本（用户文本不丢）。其它字段原样保留，promptTemplate 回填为 prompts.monthly
 *镜像（旧消费方兼容）。
 *
 * LEGACY 锁表经 server/shared/interface.ts 以纯数据复用（#768 A波2 由 config 下沉 shared；
 * S2 允许的 type-only/纯面复用——常量无副作用，非业务实例；normalizeReportConfig 本体不调用，
 * 避免把业务读面的归一化语义搬进迁移域）。
 * 读经注入（deps.readOldFile），写经同域原语（storage-layout.ts 的 writeFileAtomic 0600），
 * 坏文件容错（保持原状 + 诊断，不抛；启动期读盘数据不可信，抛即崩）。
 */
import { basename } from "node:path";
import type { ReportPrompts } from "../config/interface.ts";
import {
  DEFAULT_PROMPTS,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V4,
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V4,
} from "../shared/interface.ts";
import type { UpgradeDeps } from "./deps.ts";
import { targetConfigFile, writeFileAtomic } from "./storage-layout.ts";

const LEGACY_DAILY: readonly string[] = [
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
];

const LEGACY_WEEKLY: readonly string[] = [
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V4,
];

const LEGACY_MONTHLY: readonly string[] = [
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V4,
];

/** 旧单模板默认（用户从未自定义）：统一升级为三份新默认 = 单答案。 */
function isLegacySingleDefault(text: string): boolean {
  return (
    text === LEGACY_PROMPT_TEMPLATE ||
    text === LEGACY_MONTHLY_PROMPT_V1 ||
    text === LEGACY_MONTHLY_PROMPT_V2
  );
}

function normalizeOnePrompt(raw: unknown, dflt: string, legacy: readonly string[]): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 20000) return dflt;
  if (legacy.includes(raw)) return dflt;
  return raw;
}

/**
 * 配置形态割接。幂等：已是新形态即无改写；坏文件保持原状 + 诊断（不抛）。
 * 写失败即抛（调用方中止升级，下次从同一步重跑）。
 */
export async function migrateReportConfig(deps: UpgradeDeps): Promise<void> {
  const file = targetConfigFile(deps.resolveRoot());
  const old = await deps.readOldFile(file);
  if (old.ok === false) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(old.text) as unknown;
  } catch {
    deps.logger.warn(
      `dsh-provider-usage: 配置文件 ${basename(file)} 损坏，保持原状（下次启动仍按默认归一化读）`,
    );
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    deps.logger.warn(`dsh-provider-usage: 配置文件 ${basename(file)} 顶层非对象，保持原状`);
    return;
  }
  const src = parsed as Record<string, unknown>;
  const promptsSrc =
    typeof src.prompts === "object" && src.prompts !== null
      ? (src.prompts as Record<string, unknown>)
      : null;
  let next: ReportPrompts | null = null;
  if (promptsSrc !== null) {
    const d = DEFAULT_PROMPTS;
    const morphed: ReportPrompts = {
      daily: normalizeOnePrompt(promptsSrc.daily, d.daily, LEGACY_DAILY),
      weekly: normalizeOnePrompt(promptsSrc.weekly, d.weekly, LEGACY_WEEKLY),
      monthly: normalizeOnePrompt(promptsSrc.monthly, d.monthly, LEGACY_MONTHLY),
    };
    const cur = promptsSrc as Partial<Record<keyof ReportPrompts, unknown>>;
    if (
      cur.daily !== morphed.daily ||
      cur.weekly !== morphed.weekly ||
      cur.monthly !== morphed.monthly
    ) {
      next = morphed;
    } else {
      return;
    }
  } else {
    const legacy = typeof src.promptTemplate === "string" ? src.promptTemplate : null;
    if (legacy === null || legacy.trim().length === 0 || legacy.length > 20000) return;
    if (isLegacySingleDefault(legacy)) {
      next = { ...DEFAULT_PROMPTS };
    } else {
      next = { daily: legacy, weekly: legacy, monthly: legacy };
      const cur = src as { prompts?: unknown };
      if (cur.prompts !== undefined) {
        // 已有 prompts 非对象形态（如字符串污染）→ 仍以展开为准（与归一化同向）
      }
    }
  }
  if (next === null) return;
  const out: Record<string, unknown> = { ...(src as Record<string, unknown>) };
  out.prompts = next;
  out.promptTemplate = next.monthly;
  await writeFileAtomic(file, `${JSON.stringify(out, null, 2)}\n`);
  deps.logger.warn(
    `dsh-provider-usage: 配置形态已割接（${basename(file)} 旧默认模板升级为三周期新默认）`,
  );
}
