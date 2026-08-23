/**
 * dsh-provider-usage — 按天分片 JSONL 历史存储（v2）。
 *
 * 取代旧 v3 多文件 JSON 桶格式。优点：
 * - append 为 O(1)（appendFile），无读-改-写竞态
 * - 留存清理 = 删除过期日文件，非全量重写
 * - 进程崩溃只损失当次未写完的一行
 *
 * 目录结构：historyDir/<safe(provider)>/<safe(name)>/YYYY-MM-DD.jsonl
 */
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeSegment } from "../contracts.js";

/** 历史条目（JSONL 行）。 */
export interface HistoryEntry {
  time: number;
  data: Record<string, unknown>;
}

/** 按天分片 JSONL 历史存储。 */
export class HistoryStore {
  private readonly root: string;
  private readonly maxAgeMs: number;
  private readonly maxSizeBytes: number;

  constructor(opts: { root: string; maxAgeMs?: number; maxSizeBytes?: number }) {
    this.root = opts.root;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000; // 30 天
    this.maxSizeBytes = opts.maxSizeBytes ?? 20 * 1024 * 1024; // 20MB
  }

  /** 适配器目录（provider/name 均安全化）。 */
  private dirOf(provider: string, name: string): string {
    return join(this.root, safeSegment(provider), safeSegment(name));
  }

  /** 当日文件名。 */
  private fileOf(provider: string, name: string, time: number): string {
    const d = new Date(time);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return join(this.dirOf(provider, name), `${day}.jsonl`);
  }

  /** 追加一条（O(1) appendFile）。 */
  async append(provider: string, name: string, entry: HistoryEntry): Promise<void> {
    const file = this.fileOf(provider, name, entry.time);
    await mkdir(this.dirOf(provider, name), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.maybePrune(provider, name);
  }

  /** 读取某日的条目（文件不存在返回空）。 */
  async readDay(provider: string, name: string, time: number): Promise<HistoryEntry[]> {
    const file = this.fileOf(provider, name, time);
    if (!existsSync(file)) return [];
    const raw = await readFile(file, "utf8");
    return parseJsonl(raw);
  }

  /** 按时间范围查询（只扫 range 覆盖的天数文件）。 */
  async query(
    provider: string,
    name: string,
    range: { start: number; end: number },
    limit = 5000,
  ): Promise<{ entries: HistoryEntry[]; truncated: boolean }> {
    const entries: HistoryEntry[] = [];
    // 从 start 所在日到 end 所在日逐日读取
    let day = startOfDay(range.start);
    const endDay = startOfDay(range.end);
    while (day <= endDay) {
      const dayEntries = await this.readDay(provider, name, day);
      for (const e of dayEntries) {
        if (e.time >= range.start && e.time <= range.end) entries.push(e);
        if (entries.length >= limit) return { entries, truncated: true };
      }
      day += 86400000;
    }
    return { entries, truncated: false };
  }

  /** 获取最后一条（读最后一天文件的尾行 try-parse，失败返回 null）。 */
  async last(provider: string, name: string): Promise<HistoryEntry | null> {
    const dir = this.dirOf(provider, name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return null;
    }
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();
    for (let i = jsonlFiles.length - 1; i >= 0; i--) {
      const file = join(dir, jsonlFiles[i]);
      try {
        const raw = await readFile(file, "utf8");
        const lines = raw.trimEnd().split("\n");
        for (let j = lines.length - 1; j >= 0; j--) {
          try {
            const entry = JSON.parse(lines[j]) as HistoryEntry;
            if (typeof entry?.time === "number" && typeof entry.data === "object" && entry.data !== null) {
              return entry;
            }
          } catch {
            continue; // 坏行跳过
          }
        }
      } catch {
        continue; // 文件读取失败跳过
      }
    }
    return null;
  }

  /** 留存清理：删过期日文件 + 总大小超限时从最旧文件逐个删。 */
  async maybePrune(provider: string, name: string): Promise<void> {
    const dir = this.dirOf(provider, name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - this.maxAgeMs;
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();
    // 1. 删过期文件（按文件名日期）
    for (const f of jsonlFiles) {
      const dayMs = Date.parse(f.slice(0, 10));
      if (Number.isFinite(dayMs) && dayMs < cutoff) {
        try { await rm(join(dir, f), { force: true }); } catch { /* 忽略 */ }
      }
    }
    // 2. 总大小超限：从最旧文件逐个删（保留最后 1 个文件，防清零）
    let remaining = jsonlFiles.filter((f) => {
      const dayMs = Date.parse(f.slice(0, 10));
      return !(Number.isFinite(dayMs) && dayMs < cutoff);
    });
    let total = 0;
    for (const f of remaining) {
      try {
        const stat = await import("node:fs/promises").then((m) => m.stat(join(dir, f)));
        total += stat.size;
      } catch { /* 忽略 */ }
    }
    while (total > this.maxSizeBytes && remaining.length > 1) {
      const oldest = remaining.shift();
      if (oldest === undefined) break;
      try {
        const stat = await import("node:fs/promises").then((m) => m.stat(join(dir, oldest)));
        total -= stat.size;
        await rm(join(dir, oldest), { force: true });
      } catch { /* 忽略 */ }
    }
  }

  /** 导出全部数据（调试/割接用）。 */
  async exportAll(provider: string, name: string): Promise<HistoryEntry[]> {
    const dir = this.dirOf(provider, name);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const out: HistoryEntry[] = [];
    for (const f of files.filter((x) => x.endsWith(".jsonl")).sort()) {
      try {
        out.push(...parseJsonl(await readFile(join(dir, f), "utf8")));
      } catch { /* 忽略 */ }
    }
    return out;
  }

  /**
   * 割接：原子写一份文件（写 tmp + rename）。
   * 供迁移工具把旧 v3 数据拷入新格式时使用。
   */
  async writeDirect(provider: string, name: string, day: number, entries: HistoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const file = this.fileOf(provider, name, day);
    await mkdir(this.dirOf(provider, name), { recursive: true });
    const tmp = `${file}.${Date.now()}.tmp`;
    const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmp, file);
    } catch (e) {
      try { await rm(tmp, { force: true }); } catch { /* 忽略 */ }
      throw e;
    }
  }
}

/** 解析 JSONL 文本为条目数组（跳过坏行）。 */
export function parseJsonl(raw: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (typeof entry?.time === "number" && typeof entry.data === "object" && entry.data !== null) {
        out.push(entry);
      }
    } catch {
      continue; // 坏行跳过
    }
  }
  return out;
}

/** 某天 00:00:00 的时间戳。 */
export function startOfDay(time: number): number {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 目录结构推导（探测用：返回已有 provider/name 列表）。 */
export async function listAdapters(root: string): Promise<Array<{ provider: string; name: string }>> {
  let providers: string[];
  try {
    providers = await readdir(root);
  } catch {
    return [];
  }
  const out: Array<{ provider: string; name: string }> = [];
  for (const p of providers) {
    try {
      const names = await readdir(join(root, p));
      for (const n of names) out.push({ provider: p, name: n });
    } catch { /* 忽略 */ }
  }
  return out;
}