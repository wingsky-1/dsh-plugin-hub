/** api 域 probe 块 dry-run 的形状与预算常量。 */
import type { NotifyRequest, RawSettingValue } from "../../../deps.ts";

/** 测试通知的固定文案。不引入自由文本面：它验证的是链路本身而不是文案；取值沿用重写前的文案，
 * 用户看到的那两句不该因为一次内部重构而变（原先住在 probe/index.ts，dry-run 与老路共用，收到此处只留一份）。 */
export const TEST_NOTIFICATION: NotifyRequest = {
  kind: "test",
  title: "DSH：测试通知",
  body: "通知链路工作正常（此通知来自测试按钮）",
};

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
 * 同步返回，不写 history / status，不推进 revision。
 */
export interface DryRunResult {
  readonly ok: true;
  readonly channelId: string;
  readonly status: DryRunStatus;
  readonly reason?: DryRunReason;
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
