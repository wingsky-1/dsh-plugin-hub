/** api 域 probe 块 dry-run 的形状与预算常量。 */
import type { NotifyRequest, RawSettingValue } from "../../../deps.ts";
import type { NotificationLocale } from "../../../../shared/interface.ts";

/** 测试通知的固定文案；每条请求按当前语言生成，dry-run 与普通测试共用。 */
export function testNotification(locale: NotificationLocale): NotifyRequest {
  return locale === "en"
    ? {
        kind: "test",
        title: "DSH: Test notification",
        body: "Notifications are working (sent using the test button)",
      }
    : {
        kind: "test",
        title: "DSH：测试通知",
        body: "通知链路工作正常（此通知来自测试按钮）",
      };
}

/** 中文固定文案，保留旧导出。 */
export const TEST_NOTIFICATION: NotifyRequest = testNotification("zh");

/** dry-run 结果状态：与 DeliverResult 同值（ok 无理由，failed/skipped 带理由）。 */
export type DryRunStatus = "ok" | "failed" | "skipped";

/** dry-run 结果里的理由：结构化理由的线形态（code + 标量 params + 宿主原文 detail）。 */
export interface DryRunReason {
  readonly code: string;
  readonly params?: Record<string, string | number>;
  readonly detail?: string;
}

/**
 * dry-run 结果（提案 B3 schema）：ok 恒 true（投递失败是结果里的 status，不是请求失败），
 * channelId 回显测的是谁，status 为此次实测结论，reason 只在非 ok 时出现（已截断+收编）。
 * ok 且提示音未出时带 soundWarning（总体仍 ok，随行警告）。
 * 同步返回，不写 history / status，不推进 revision。
 */
export interface DryRunResult {
  readonly ok: true;
  readonly channelId: string;
  readonly status: DryRunStatus;
  readonly reason?: DryRunReason;
  readonly soundWarning?: DryRunReason;
}

/** 服务端总预算（毫秒）：提案 B7，超时即 408，结果丢弃（在飞的投递无法撤回，见预算注释）。 */
export const DRY_RUN_BUDGET_MS = 15_000;

/** 并发帽：提案 B5，同时最多 2 个 dry-run，超限 429（不排队，面板提示手动重试）。 */
export const DRY_RUN_MAX_INFLIGHT = 2;

/** dry-run 请求里的 draft 形态：只认 channels（B1），其它顶层键与 revision 由调用方忽略。 */
export interface DryRunDraftShape {
  readonly channels?: RawSettingValue;
}

/** 输入错误（→ 400）：draft 非法、掩码无源、目标不在草稿里。永不经过路由收口（那会记 warn）。 */
export class DryRunInputError extends Error {}

/** 预算超时（→ 408）：15s 内未 settle，结果丢弃，槽位释放。 */
export class DryRunTimeoutError extends Error {}
