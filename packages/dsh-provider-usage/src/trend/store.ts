/**
 * dsh-provider-usage/trend — 按天分片 JSONL 存储（#503 M1）。
 *
 * 目录（复用 HistoryStore 的「按天分片 + prune」模式，trend 以 day 为主键另建目录，
 * 不套 HistoryStore 的 provider/name 目录结构）：
 * - <root>/details/YYYY-MM-DD.jsonl  当日 per-step 明细/计数行（append-only，0600）
 * - <root>/agg/YYYY-MM-DD.jsonl      日切压实后的聚合行（整日原子重写：tmp+rename）
 *
 * 崩溃安全约定（重启重建无歧义的关键）：压实顺序 = 先原子写聚合分片、后删明细分片。
 * 同日两分片并存时 **聚合分片权威**（明细分片视为压实未完成的残留，重建时忽略并自愈删除）。
 *
 * 并发纪律：同日明细分片写入经 per-day Promise 链单飞串行（防 flush 与压实互吞）；
 * 聚合分片整日重写天然幂等（最后一写为准）。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TREND_ROW_VERSION,
  isValidShardRow,
  type TrendAggRow,
  type TrendCounterRow,
  type TrendDetailRow,
} from "./types.ts";

export type TrendShardRow = TrendDetailRow | TrendCounterRow | TrendAggRow;

export class TrendStore {
  private readonly root: string;
  private readonly warn: (msg: string) => void;
  /** per-day append 串行链（day key → promise）。 */
  private detailChains = new Map<string, Promise<void>>();

  constructor(opts: { root: string; warn?: (msg: string) => void }) {
    this.root = opts.root;
    this.warn = opts.warn ?? ((msg) => console.warn(`[dsh-provider-usage] trend: ${msg}`));
  }

  private detailsDir(): string {
    return join(this.root, "details");
  }

  private aggDir(): string {
    return join(this.root, "agg");
  }

  private detailsFile(day: string): string {
    return join(this.detailsDir(), `${day}.jsonl`);
  }

  private aggFile(day: string): string {
    return join(this.aggDir(), `${day}.jsonl`);
  }

  // ---------------------------------------------------------------- 明细追加

  /**
   * 追加未持久化行到各自日分片（per-day 单飞串行）。
   * 返回本次调用中**写入成功的 day 集合**：调用方据此精确标记 persisted——
   * 部分日失败时成功日不重复 append（防崩溃重建双算）、失败日行保留待下轮重试。
   * 注意：okDays 只反映本次调用各日写入段的成败（排队在前链的历史失败不影响本次结果）。
   */
  async appendRows(rows: Array<TrendDetailRow | TrendCounterRow>): Promise<Set<string>> {
    const byDay = new Map<string, Array<TrendDetailRow | TrendCounterRow>>();
    for (const row of rows) {
      const list = byDay.get(row.day);
      if (list === undefined) byDay.set(row.day, [row]);
      else list.push(row);
    }
    const okDays = new Set<string>();
    for (const [day, dayRows] of byDay) {
      const done = this.detailChains.get(day) ?? Promise.resolve();
      const next = done
        .then(async () => {
          await mkdir(this.detailsDir(), { recursive: true });
          const body = dayRows.map((r) => JSON.stringify(r)).join("\n");
          await appendFile(this.detailsFile(day), `${body}\n`, { encoding: "utf8", mode: 0o600 });
          okDays.add(day);
        })
        .catch((e: unknown) => {
          this.warn(`明细分片写入失败（${day}）：${e instanceof Error ? e.message : String(e)}`);
        });
      this.detailChains.set(day, next);
      await next;
      // 链已收敛且无后续写入时清理表项（防 Map 无界增长）
      if (this.detailChains.get(day) === next) this.detailChains.delete(day);
    }
    return okDays;
  }

  // ---------------------------------------------------------------- 聚合压实

  /**
   * 整日聚合行原子重写（tmp+rename，0600）。空行数组 = 删除该日聚合分片（防御）。
   * 这是「聚合分片权威」约定的写入侧：成功返回后该日聚合事实已完整落盘。
   */
  async writeAggDay(day: string, rows: TrendAggRow[]): Promise<void> {
    await mkdir(this.aggDir(), { recursive: true });
    if (rows.length === 0) {
      await rm(this.aggFile(day), { force: true });
      return;
    }
    // P2-7：写 tmp 前清理同日 rename 前崩溃残留的 tmp（文件名前缀 `${day}.jsonl.` 且
    // 后缀 `.tmp`）。尽力而为：清理失败不影响主流程（仅告警，下轮重写时再清）。
    try {
      for (const f of await readdir(this.aggDir())) {
        if (f.startsWith(`${day}.jsonl.`) && f.endsWith(".tmp")) {
          await rm(join(this.aggDir(), f), { force: true });
        }
      }
    } catch (e: unknown) {
      this.warn(`聚合分片 tmp 残留清理失败（${day}）：${e instanceof Error ? e.message : String(e)}`);
    }
    const tmp = `${this.aggFile(day)}.${Date.now()}.tmp`;
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(tmp, `${body}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.aggFile(day));
  }

  /** 删除明细分片（压实收尾；文件不存在视为成功）。 */
  async deleteDetailShard(day: string): Promise<void> {
    await rm(this.detailsFile(day), { force: true });
  }

  // ---------------------------------------------------------------- 读取与重建

  /** 读明细分片（坏行跳过并告警；文件不存在返回空）。 */
  async readDetailShard(day: string): Promise<Array<TrendDetailRow | TrendCounterRow>> {
    return this.readShard(this.detailsFile(day), (r): r is TrendDetailRow | TrendCounterRow => r.kind !== "agg");
  }

  /** 读聚合分片（同上）。 */
  async readAggShard(day: string): Promise<TrendAggRow[]> {
    return this.readShard(this.aggFile(day), (r): r is TrendAggRow => r.kind === "agg");
  }

  private async readShard<T extends TrendShardRow>(file: string, filter: (r: TrendShardRow) => r is T): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return []; // ENOENT / 竞态删除：返回空
    }
    const out: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.warn(`分片坏行跳过：${file}`);
        continue;
      }
      if (!isValidShardRow(parsed)) {
        this.warn(`分片行校验失败跳过（v=${(parsed as { v?: unknown }).v}）：${file}`);
        continue;
      }
      if (filter(parsed)) out.push(parsed);
    }
    return out;
  }

  /** 聚合分片是否存在且非空（「聚合权威」判定的读侧）。 */
  async hasAggShard(day: string): Promise<boolean> {
    try {
      const s = await stat(this.aggFile(day));
      return s.isFile() && s.size > 0;
    } catch {
      return false;
    }
  }

  /** 列出目录下全部日 key（升序；目录不存在返回空）。 */
  private async listDays(dir: string): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  }

  listDetailDays(): Promise<string[]> {
    return this.listDays(this.detailsDir());
  }

  listAggDays(): Promise<string[]> {
    return this.listDays(this.aggDir());
  }

  // ---------------------------------------------------------------- 留存清理

  /**
   * prune：删除 cutoff 日（不含）之前的聚合分片与明细分片（YYYY-MM-DD 字典序即时间序）。
   * 返回删除文件数。明细目录正常只含当日/未压实日，此处兜底清理残留。
   */
  async prune(beforeDay: string): Promise<number> {
    let removed = 0;
    for (const dir of [this.aggDir(), this.detailsDir()]) {
      for (const day of await this.listDays(dir)) {
        if (day < beforeDay) {
          try {
            await rm(join(dir, `${day}.jsonl`), { force: true });
            removed += 1;
          } catch (e: unknown) {
            this.warn(`留存清理失败（${day}）：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    return removed;
  }
}

/** 行 schema 版本透出（测试/契约断言用）。 */
export { TREND_ROW_VERSION };
