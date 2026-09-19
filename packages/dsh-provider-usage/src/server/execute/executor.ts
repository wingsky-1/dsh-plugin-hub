/**
 * dsh-provider-usage — server/execute 域：报告生成执行器工厂
 * （#768 D3，由 domain2/execute/executor.ts 搬入，零行为变更）。
 *
 * 执行接线器：幂等下沉（执行前重查 index，已有成功记录且非 force → 复用）、
 * LLM 生成、lastRun 推进——全部在 ReportTaskQueue 临界区内串行执行。
 * 失败不推进 lastRun（下轮按幂等重试/补跑）；错误经 sanitizeDiagnostic 脱敏后
 * 再抛（status 路由回客户端，防本地路径泄露——脱敏为工厂契约字段）。
 * schedule/config 双门面消费：updateLastRun 单一临界区与任务类型经
 * server/schedule 门面，配置形态经 server/config 门面（D2 起即此口径）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ReportConfig } from "../config/interface.ts";
import { readReportIndex, runDueReport } from "./runner.ts";
import { updateLastRun } from "../schedule/interface.ts";
import type { ReportTaskInput, ReportTaskResult } from "../schedule/interface.ts";
import type { TrendTracker } from "../aggregate/interface.ts";

export interface DueExecutorDeps {
  trend: TrendTracker;
  ctx: Context;
  getReportCfg: () => ReportConfig;
  historyRoot: string;
  sanitizeDiagnostic: (s: string) => string;
}

/** 构造串行执行器（幂等/推进/脱敏行为在此固化）。 */
export function makeDueReportExecutor(
  deps: DueExecutorDeps,
): (input: ReportTaskInput) => Promise<ReportTaskResult> {
  return async (input) => {
    try {
      if (input.force !== true) {
        const existing = (await readReportIndex(deps.historyRoot)).find(
          (m) => m.period === input.period && m.key === input.key && m.ok === true,
        );
        if (existing !== undefined) return { meta: existing, reused: true };
      }
      const meta = await runDueReport({
        due: input,
        trend: deps.trend,
        ctx: deps.ctx,
        reportCfg: deps.getReportCfg(),
        historyRoot: deps.historyRoot,
        sanitizeDiagnostic: deps.sanitizeDiagnostic,
      });
      // lastRun 推进走单一临界区（写前重读），不与保存配置路径互踩字段
      await updateLastRun(deps.historyRoot, (cur) => ({ ...cur, [meta.period]: meta.key }));
      return { meta };
    } catch (e: unknown) {
      throw new Error(deps.sanitizeDiagnostic(e instanceof Error ? e.message : String(e)));
    }
  };
}
