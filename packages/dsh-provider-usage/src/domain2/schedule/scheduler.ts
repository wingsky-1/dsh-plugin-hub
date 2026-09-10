/**
 * dsh-provider-usage/report — 极简调度器（官方无 cron 的先行版）。
 *
 * 形态（不引入 croner）：60s tick + 候选窗口对齐 + lastRun 幂等标记 +
 * 启动补跑（首轮 tick 即检查）。单飞互斥：生成超过 tick 间隔时后续 tick 跳过
 * （busy 标志），生成失败不推进 lastRun（下轮重试同一窗口，幂等不重复扣期）。
 * lastRun 持久化原语（读/写/临界区/迁移校准）见 last-run.ts——调度与执行
 * 共同依赖该公共原语。
 */
import type { ReportConfig } from "./config.ts";
import { pendingReports, type DueReport } from "./schedule.ts";
import { readLastRun, ensureLastRunMigrated } from "../common/interface.ts";

export interface ReportSchedulerOptions {
  /** 存储根（historyRoot）。 */
  root: string;
  /** 当前配置（updateConfig 热更新）。 */
  config: ReportConfig;
  /** 到期回调（提交到任务队列，非阻塞；队列负责执行、幂等与 lastRun 推进）。 */
  onDue: (due: DueReport) => Promise<void>;
  /** 注入时钟（测试）。 */
  now?: () => number;
  /** tick 间隔（默认 60000；测试可缩短）。 */
  tickMs?: number;
  /** 诊断出口。 */
  warn?: (msg: string) => void;
}

export class ReportScheduler {
  private config: ReportConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly root: string;
  private readonly onDue: (due: DueReport) => Promise<void>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly warn: (msg: string) => void;

  private constructor(opts: ReportSchedulerOptions) {
    this.root = opts.root;
    this.config = opts.config;
    this.onDue = opts.onDue;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 60_000;
    this.warn = opts.warn ?? ((msg) => console.warn(`[dsh-provider-usage] report: ${msg}`));
  }

  /**
   * 启动：先做 lastRun 一致性校准（async，失败不影响调度），
   * 完成后立即跑首轮（启动补跑语义），随后固定间隔 tick。
   */
  static start(opts: ReportSchedulerOptions): ReportScheduler {
    const s = new ReportScheduler(opts);
    s.timer = setInterval(() => void s.tick(), s.tickMs);
    (s.timer as { unref?: () => void }).unref?.();
    void ensureLastRunMigrated(s.root, s.warn).finally(() => void s.tick());
    return s;
  }

  /** 热更新配置（下轮 tick 生效）。 */
  updateConfig(config: ReportConfig): void {
    this.config = config;
  }

  /**
   * 一轮检查：读 lastRun → 计算到期集合 → 逐个提交到任务队列（提交非阻塞，
   * 队列负责串行执行、幂等下沉与 lastRun 推进；同窗口已在队列中由队列去重吸收）。
   */
  async tick(): Promise<void> {
    if (this.disposed) return;
    try {
      const lastRun = await readLastRun(this.root);
      const due = pendingReports(this.config, this.now(), lastRun);
      for (const d of due) {
        try {
          await this.onDue(d);
        } catch (e: unknown) {
          this.warn(`${d.period} ${d.key} 提交失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e: unknown) {
      this.warn(`tick 异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 停止 tick（挂载清理；进行中的一轮自然完成——onDue 由宿主侧 await 语义决定）。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}