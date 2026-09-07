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
import { alignLastRun, deriveLastRun, LAST_RUN_SCHEMA, pendingReports, type DueReport, type LastRunRecord } from "./schedule.ts";
import { parseReportIndexLines } from "./runner.ts";

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

/** 原子写 lastRun（tmp+rename，0600；带 schema 版本）。#503 M3 接线：导出供手动生成路由读改写复用。 */
export async function writeLastRun(root: string, state: Partial<Record<ReportPeriod, string>>): Promise<void> {
  const file = lastRunFile(root);
  await mkdir(join(root, "reports"), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, schema: LAST_RUN_SCHEMA, updatedAt: Date.now() }), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * #629 P2 lastRun 单一临界区：读-改-写按 root 串行（per-root promise 链）+ 写前重读。
 *
 * lost-update 窗口（原问题）：保存配置路径（handleReportConfig 的 preset 写）与任务
 * 执行器写 lastRun（apply 层 executor）都是「readLastRun → 改 → writeLastRun」全量
 * 写，两个 async 交错时后写者以旧快照覆盖前写者的字段（如保存配置预置 weekly 键时
 * 抹掉任务刚推进的 daily 键）。修复形态：所有 lastRun 的 read-modify-write 统一收敛
 * 到本函数——patch 只在临界区内、基于**链上最新**的文件快照计算（写前重读），同一
 * root 的更新按提交序串行落盘，任何一方都不会拿过期快照覆盖他人字段。
 *
 * - 并发方仍可绕过本函数直写（writeLastRun 保留原语义），进程内已知写方已全部
 *   接线到 updateLastRun；跨进程（多实例）由 DSH_HOME/profile 隔离天然不共享文件；
 * - patch 抛错 → 该次更新不落盘且不阻塞链上后续更新（错误向调用方透传）；
 * - 测试钩子：__lastRunChainForTests 暴露 per-root 链尾，用例 await 之即可确定性
 *   收敛（替代 sleep 等待）。
 */
const lastRunChainByRoot = new Map<string, Promise<void>>();

export function updateLastRun(
  root: string,
  patch: (prev: Partial<Record<ReportPeriod, string>>) => Partial<Record<ReportPeriod, string>>,
): Promise<void> {
  const prev = lastRunChainByRoot.get(root) ?? Promise.resolve();
  const run = async (): Promise<void> => {
    const cur = await readLastRun(root); // 写前重读：链上最新快照，非调用时刻旧快照
    await writeLastRun(root, patch(cur));
  };
  const next = prev.then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  lastRunChainByRoot.set(root, tail);
  return next;
}

/** 测试隔离钩子：返回指定 root 的临界区链尾（await 确定收敛），无在途更新时 undefined。 */
export function __lastRunChainForTests(root: string): Promise<void> | undefined {
  return lastRunChainByRoot.get(root);
}

/**
 * 启动时 lastRun 一致性保证（#624）：
 * - schema 缺失/旧（<2）：全量重算（deriveLastRun）——一次性迁移，修复旧语义
 *   「当天」污染键（周一 06:00 吞日报的根因）；
 * - schema 已新（>=2）：温和对齐（alignLastRun）——仅该期 index 存在已闭环记录
 *   时对齐到最新闭环键（遮蔽事故自愈），preset 键（#531 首次启用预置，index 无
 *   对应记录）保留不动。
 * 与现文件不一致或 schema 变更时原子写回并 warn 前后对照；任何异常不抛（保持
 * 原状，下次启动再试）；无 index 时视作无事实，不动 lastRun。
 */
export async function ensureLastRunMigrated(
  root: string,
  warn?: (msg: string) => void,
): Promise<{ changed: boolean; before: Partial<Record<ReportPeriod, string>>; after: Partial<Record<ReportPeriod, string>> }> {
  const diag = warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] report: ${msg}`));
  try {
    const raw = await readFile(lastRunFile(root), "utf8").catch(() => null);
    if (raw === null) return { changed: false, before: {}, after: {} }; // 从未落盘
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const schema = typeof parsed.schema === "number" ? parsed.schema : 1;
    const before = await readLastRun(root);
    const indexRaw = await readFile(join(root, "reports", "index.jsonl"), "utf8").catch(() => null);
    if (indexRaw === null) return { changed: false, before, after: before }; // 无事实源，保持原状
    const records = parseReportIndexLines(indexRaw) as LastRunRecord[];
    const after = schema < LAST_RUN_SCHEMA ? deriveLastRun(records) : alignLastRun(before, records);
    const changed = schema < LAST_RUN_SCHEMA || JSON.stringify(before) !== JSON.stringify(after);
    if (changed) {
      await writeLastRun(root, after);
      diag(`lastRun 已按 index 事实校准（schema ${schema}→${LAST_RUN_SCHEMA}）：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
    return { changed, before, after };
  } catch (e: unknown) {
    diag(`lastRun 校准失败（保持原状）：${e instanceof Error ? e.message : String(e)}`);
    return { changed: false, before: {}, after: {} };
  }
}

export interface ReportSchedulerOptions {
  /** 存储根（historyRoot）。 */
  root: string;
  /** 当前配置（updateConfig 热更新）。 */
  config: ReportConfig;
  /** 到期回调（#625：提交到任务队列，非阻塞；队列负责执行、幂等与 lastRun 推进）。 */
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
   * 启动：先做 lastRun 一致性校准（#624，async，失败不影响调度），
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
   * 一轮检查：读 lastRun → 计算到期集合 → 逐个提交到任务队列（#625：提交非阻塞，
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
