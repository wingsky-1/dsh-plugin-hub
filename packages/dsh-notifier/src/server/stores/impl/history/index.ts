/**
 * dsh-notifier stores 域 —— 通知历史实现（jsonl）：写队列串行化 + 原子写 + 滚动上限与按时效过滤。
 *
 * 保留天数每次读时现取：装配期取快照会在用户改设置后失效。
 */
import { readFile } from "node:fs/promises";
import {
  writeTextAtomic,
  HISTORY_FILE_NAME,
  normalizeReason,
  notifierFile,
} from "../../../shared/interface.ts";
import type { ChannelDelivery, HistoryDeps, HistoryEntry, ParsedHistoryLine } from "./type.ts";

/** 通知历史滚动上限（行数；超出后从尾部截断重写）。 */
const HISTORY_LIMIT = 200;

/** 一天的毫秒数：按天清理与按天过滤是同一个刻度。 */
const DAY_MS = 86_400_000;

/** 未装配时的占位：装配是必经路径，能力写成抛错，真被读到应当场暴露而不是静默按默认设置清理。 */
const UNINSTALLED: HistoryDeps = {
  logger: { warn: () => {} },
  config: {
    readConfig: () => {
      throw new Error("dsh-notifier: 历史存储尚未装配");
    },
  },
};

/** 通知历史：jsonl 追加写，读时滚动截断与按天过滤。 */
class HistoryStore {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。 */
  private readonly file = notifierFile(HISTORY_FILE_NAME);
  /** 装配入参（失败出口）。 */
  private deps: HistoryDeps = UNINSTALLED;
  /** 写队列串行化：并发「读-改-写」会互相覆盖丢记录。 */
  private queue: Promise<void> = Promise.resolve();

  /** 装配：单次生效。 */
  install(deps: HistoryDeps): void {
    if (this.installed) throw new Error("dsh-notifier: 历史存储只能装配一次");
    this.installed = true;
    this.deps = deps;
  }

  /** 卸载：放开装配入参。在飞的写入不等待——它们各有自己的失败出口。 */
  release(): void {
    this.installed = false;
    this.deps = UNINSTALLED;
  }

  /** 追加一条记录：入队即返回（不阻塞通知主流程），失败仅经日志出口告警。 */
  append(entry: HistoryEntry): void {
    // 装配入参在调用点取一次：写发生在稍后，卸载会把 deps 换回占位，取晚一步就连失败日志都落不下来。
    const deps = this.deps;
    this.queue = this.queue.then(async () => {
      try {
        const lines = await this.currentLines();
        lines.push(JSON.stringify(entry));
        // 写入是唯一能减少行数的时机，读侧的过滤只是兜底。
        const keepDays = deps.config.readConfig().historyMaxAgeDays;
        const kept =
          keepDays > 0
            ? lines.filter((line) => withinRetention(line, entry.ts - keepDays * DAY_MS))
            : lines;
        const trimmed = kept.length > HISTORY_LIMIT * 2 ? kept.slice(-HISTORY_LIMIT) : kept;
        const written = await writeTextAtomic(this.file, `${trimmed.join("\n")}\n`);
        if (!written.ok) {
          deps.logger.warn(`dsh-notifier: 历史记录写入失败: ${written.reason}`);
        }
      } catch (cause) {
        deps.logger.warn(
          `dsh-notifier: 历史记录写入失败: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
  }

  /** 最近记录（尾部最多 `HISTORY_LIMIT` 条；保留期 > 0 时先按天过滤）。 */
  async read(): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      // 没有历史文件与历史为空是同一件事：都回答「没有记录」，不是错误。
      return [];
    }
    const keepDays = this.deps.config.readConfig().historyMaxAgeDays;
    // 截止点用「现在」：调小保留天数后应立刻看不到旧记录，不必等下一次写入顺手清理。
    const cutoff = keepDays > 0 ? Date.now() - keepDays * DAY_MS : 0;
    const records: HistoryEntry[] = [];
    for (const line of text
      .split("\n")
      .filter(Boolean)
      .slice(-HISTORY_LIMIT * 2)) {
      const parsed = parseLine(line);
      if (!parsed.ok) continue;
      if (cutoff > 0 && typeof parsed.entry.ts === "number" && parsed.entry.ts < cutoff) continue;
      records.push(parsed.entry);
    }
    // 上限是读语义：手改文件绕过写侧时，读面仍只交出最近 HISTORY_LIMIT 条。
    records.splice(0, Math.max(0, records.length - HISTORY_LIMIT));
    return records;
  }

  /** 清空全部记录，返回被清空条数。 */
  async clear(): Promise<number> {
    // 已知边界：清空不进写队列，与在飞 append 竞争时，那一次 append 可能把刚清掉的行写回。
    let removed = 0;
    try {
      removed = (await readFile(this.file, "utf8")).split("\n").filter(Boolean).length;
    } catch {
      // 文件不存在：没有记录可清，清空动作本身照做（把文件补出来）。
    }
    const written = await writeTextAtomic(this.file, "");
    if (!written.ok) {
      this.deps.logger.warn(`dsh-notifier: 清空历史失败: ${written.reason}`);
    }
    return removed;
  }

  /** 现有行：读不到文件即空列表（首次写入从零开始，与读语义一致）。 */
  private async currentLines(): Promise<string[]> {
    try {
      return (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** 按天清理时一行的去留：坏行保守保留——「读不出来」不等于「过期」，删掉等于毁掉还有救的内容。 */
function withinRetention(line: string, cutoff: number): boolean {
  const parsed = parseLine(line);
  if (!parsed.ok) return true;
  return typeof parsed.entry.ts === "number" && parsed.entry.ts >= cutoff;
}

/** 解析一行 jsonl：只把 JSON 对象算作读到一行——非对象的合法 JSON 取字段会抛，当坏行处理。 */
function parseLine(line: string): ParsedHistoryLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { ok: false };
    return { ok: true, entry: normalizeEntry(parsed as HistoryEntry) };
  } catch {
    return { ok: false };
  }
}

/**
 * 归一化一条历史记录：只重写 `channels` 里的理由——升级前的行存的是散文，之后存结构化对象，
 * 客户端不该为「同一字段两种形态」各写一遍渲染。其余字段原样透传：历史是持久格式，可能躺着
 * 早已退役的种类，本域不认识不等于该丢。
 */
function normalizeEntry(entry: HistoryEntry): HistoryEntry {
  if (!Array.isArray(entry.channels)) return entry;
  const channels: ChannelDelivery[] = [];
  for (const delivery of entry.channels) {
    const normalized = normalizeDelivery(delivery);
    if (normalized !== undefined) channels.push(normalized);
  }
  return { ...entry, channels };
}

/** 逐出口明细的值域校验：陌生状态与读不出的理由都不该透传到设置页（那里直接渲染它们）。 */
function normalizeDelivery(value: unknown): ChannelDelivery | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.channelId !== "string") return undefined;
  if (source.status !== "ok" && source.status !== "failed" && source.status !== "skipped") {
    return undefined;
  }
  const delivery: ChannelDelivery = { channelId: source.channelId, status: source.status };
  const reason = normalizeReason(source.reason);
  if (reason !== undefined) delivery.reason = reason;
  return delivery;
}

/** 本域唯一的存储实例：类不外放，外面 `new` 不出第二份写队列。 */
export const historyStore = new HistoryStore();
