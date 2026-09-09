/**
 * dsh-provider-usage/report — 报告生成执行器工厂（阶段二 D8：自 apply.ts 闭包移出）。
 *
 * E4 执行接线器：幂等下沉（执行前重查 index，已有成功记录且非 force → 复用）、
 * LLM 生成、lastRun 推进——全部在 ReportTaskQueue 临界区内串行执行（#625/#626）。
 * 失败不推进 lastRun（下轮按幂等重试/补跑）；错误经 sanitizeDiagnostic 脱敏后
 * 再抛（status 路由回客户端，防本地路径泄露——脱敏为工厂契约字段）。
 * 阶段四目录化后归 domain2/execute/；依赖域2公共层（last-run/report-index）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ReportConfig } from "./config.ts";
import { readReportIndex, runDueReport } from "./runner.ts";
import { updateLastRun } from "./last-run.ts";
import type { ReportTaskInput, ReportTaskResult } from "./tasks.ts";
import type { TrendTracker } from "../trend/index.ts";

export interface DueExecutorDeps {
  trend: TrendTracker;
  ctx: Context;
  getReportCfg: () => ReportConfig;
  historyRoot: string;
  sanitizeDiagnostic: (s: string) => string;
}

/** 构造串行执行器（E4 契约面：幂等/推进/脱敏行为在此固化）。 */
export function makeDueReportExecutor(deps: DueExecutorDeps): (input: ReportTaskInput) => Promise<ReportTaskResult> {
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
      // #629 P2：lastRun 推进走单一临界区（写前重读），不与保存配置路径互踩字段
      await updateLastRun(deps.historyRoot, (cur) => ({ ...cur, [meta.period]: meta.key }));
      return { meta };
    } catch (e: unknown) {
      throw new Error(deps.sanitizeDiagnostic(e instanceof Error ? e.message : String(e)));
    }
  };
}