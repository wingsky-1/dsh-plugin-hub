/**
 * dsh-provider-usage/report — 极简调度器（#503 M3，方案 §2.3：官方无 cron 的先行版）。
 *
 * 形态（方案定稿，不引入 croner）：60s tick + 候选窗口对齐 + lastRun 幂等标记 +
 * 启动补跑（首轮 tick 即检查）。单飞互斥：生成超过 tick 间隔时后续 tick 跳过
 * （busy 标志），生成失败不推进 lastRun（下轮重试同一窗口，幂等不重复扣期）。
 * lastRun 落盘 historyRoot/reports/last-run.json（0600）——historyRoot 随
 * DSH_HOME/profile 走，多实例（web / verify_*）天然隔离。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReportConfig, ReportPeriod } from "./config.ts";
import { pendingReports, type DueReport } from "./schedule.ts";

/** lastRun 持久化文件。 */
function lastRunFile(root: string): string {
  return join(root, "reports", "last-run.json");
}

/** 读 lastRun（缺失/损坏返回空表）。#503 M3 接线：导出供手动生成路由读改写复用。 */
export async function readLastRun(root: string): Promise<Partial<Record<ReportPeriod, string>>> {
  try {
    const raw = await readFile(lastRunFile(root), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<ReportPeriod, string>> = {};
    for (const p of ["daily", "weekly", "monthly"] as const) {
      if (typeof parsed[p] === "string") out[p] = parsed[p];
    }
    return out;
  } catch {
    return {};
  }
}

/** 原子写 lastRun（tmp+rename，0600）。#503 M3 接线：导出供手动生成路由读改写复用。 */
export async function writeLastRun(root: string, state: Partial<Record<ReportPeriod, string>>): Promise<void> {
  const file = lastRunFile(root);
  await mkdir(join(root, "reports"), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }), { mode: 0o600 });
  await rename(tmp, file);
}

export interface ReportSchedulerOptions {
  /** 存储根（historyRoot）。 */
  root: string;
  /** 当前配置（updateConfig 热更新）。 */
  config: ReportConfig;
  /** 到期回调（执行生成；抛错 = 失败，不推进 lastRun，下轮重试）。 */
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
  private busy = false;
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

  /** 启动：立即跑一轮（启动补跑语义），随后固定间隔 tick。 */
  static start(opts: ReportSchedulerOptions): ReportScheduler {
    const s = new ReportScheduler(opts);
    s.timer = setInterval(() => void s.tick(), s.tickMs);
    (s.timer as { unref?: () => void }).unref?.();
    void s.tick(); // 启动补跑：首轮立即检查
    return s;
  }

  /** 热更新配置（下轮 tick 生效）。 */
  updateConfig(config: ReportConfig): void {
    this.config = config;
  }

  /**
   * 一轮检查：读 lastRun → 计算到期集合 → 逐个生成 → 成功才推进 lastRun。
   * 单飞：busy 时本轮直接跳过（生成超过 tick 间隔的用例覆盖）。
   */
  async tick(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const lastRun = await readLastRun(this.root);
      const due = pendingReports(this.config, this.now(), lastRun);
      for (const d of due) {
        try {
          await this.onDue(d);
        } catch (e: unknown) {
          // 失败不推进 lastRun：下轮重试同一窗口（幂等不重复扣期）
          this.warn(`${d.period} ${d.key} 生成失败：${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        lastRun[d.period] = d.key;
        await writeLastRun(this.root, lastRun);
      }
    } catch (e: unknown) {
      this.warn(`tick 异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy = false;
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
