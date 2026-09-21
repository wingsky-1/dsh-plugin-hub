/**
 * dsh-provider-usage — server/config 域提示词表旧址（#768 A波2 re-export 门面）。
 *
 * canonical 已下沉 server/shared/prompts.ts（冻结文本锁表，文本逐字一致）。
 * 本文件仅作兼容门面（旧址直引仍可达同一引用）；生产与测试一律经
 * server/shared/interface.ts 消费（同源纪律）。
 */
export {
  LEGACY_PROMPT_TEMPLATE,
  LEGACY_DAILY_PROMPT_V1,
  LEGACY_WEEKLY_PROMPT_V1,
  LEGACY_MONTHLY_PROMPT_V1,
  LEGACY_DAILY_PROMPT_V2,
  LEGACY_WEEKLY_PROMPT_V2,
  LEGACY_MONTHLY_PROMPT_V2,
  LEGACY_DAILY_PROMPT_V3,
  LEGACY_WEEKLY_PROMPT_V3,
  LEGACY_MONTHLY_PROMPT_V3,
  LEGACY_DAILY_PROMPT_V4,
  LEGACY_WEEKLY_PROMPT_V4,
  LEGACY_MONTHLY_PROMPT_V4,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_WEEKLY_PROMPT,
  DEFAULT_MONTHLY_PROMPT,
  DEFAULT_PROMPTS,
  DEFAULT_PROMPT_TEMPLATE,
} from "../shared/interface.ts";
