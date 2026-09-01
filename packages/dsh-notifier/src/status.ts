/**
 * dsh-notifier — 频道投递状态落盘（M2，issue #366）。
 *
 * 职责：per-channel 最近一次投递终态（ok/failed + 错误摘要 + 连续失败计数）
 * 的内存镜像与持久化。与历史 jsonl 互补——事件流的实时性由 wingsky-notify/sent
 * 事件与 SSE 承担，本文件是「持久事实」：重启后设置页仍能看到各频道最近投递。
 *
 * 写入范式复用 history.ts（写队列串行化 + tmp+rename 原子写），另加 debounce
 * 合并（通知风暴时避免每条通知一次整文件重写的写放大）。
 * 注意：错误文本须由调用方先脱敏（service 层统一 scrub 后才传入），本模块
 * 只做存储，不再解释内容。
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { errorMessage } from "../../../shared/host-utils.js";

/** 单频道投递状态条目。 */
export interface ChannelStatusEntry {
  /** 最近一次投递的时间戳（毫秒）。 */
  lastTs: number;
  /** 最近一次投递终态。 */
  lastStatus: "ok" | "failed";
  /** 最近一次失败的错误摘要（已脱敏；ok 时缺省）。 */
  lastError?: string;
  /** 连续失败计数（成功即清零）。 */
  failStreak: number;
}

/** 频道投递状态存储：record 记录终态 / read 供 GET /status。 */
export interface StatusStore {
  /** 记录一次投递终态（内存立即更新；落盘 debounce 合并，fire-and-forget）。 */
  record(channelId: string, status: "ok" | "failed", error?: string): void;
  /** 读取全部频道状态（内存镜像优先，冷启动回落文件）。 */
  read(): Promise<Record<string, ChannelStatusEntry>>;
}

/** 状态条目上限（防已删频道残留键无限累积；超出时最旧先出）。 */
const STATUS_MAX_ENTRIES = 64;

/** 落盘 debounce 窗口（毫秒）：窗口内的多次 record 合并为一次整文件写。 */
const STATUS_DEBOUNCE_MS = 500;

/**
 * 创建频道投递状态存储。
 * @param options.file 状态文件路径（~/.dsh/dsh-notifier-status.json）。
 * @param options.warn 日志出口（ctx.logger.warn）。
 */
export function createStatusStore(options: { file: string; warn: (message: string) => void }): StatusStore {
  const { file, warn } = options;

  /** 内存镜像（单一事实源；冷启动时从文件懒加载一次）。 */
  const entries = new Map<string, ChannelStatusEntry>();
  let loaded = false;

  /** 写队列串行化（与 history.ts 同范式：防并发「读-改-写」互相覆盖）。 */
  let writeChain: Promise<void> = Promise.resolve();
  /** debounce 定时器与待写标记。 */
  let debounceTimer: NodeJS.Timeout | null = null;

  function loadSyncOnce(): void {
    // 冷启动同步懒加载：record/read 前先把文件读进内存（fire-and-forget 语义下
    // 用同步读避免 record 先于 read 完成的竞态；文件极小（≤64 条）可接受）。
    if (loaded) return;
    loaded = true;
    try {
      const text = readFileSync(file, "utf8");
      const obj = JSON.parse(text) as Record<string, ChannelStatusEntry>;
      for (const [id, entry] of Object.entries(obj)) {
        if (entry && typeof entry === "object" && typeof entry.lastTs === "number") entries.set(id, entry);
      }
    } catch {
      // 文件不存在/损坏：从空表开始
    }
  }

  function scheduleFlush(): void {
    if (debounceTimer !== null) return; // 已有待写定时器
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flush();
    }, STATUS_DEBOUNCE_MS);
    debounceTimer.unref?.();
  }

  function flush(): void {
    writeChain = writeChain.then(async () => {
      try {
        const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
        await writeFile(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
        await rename(tmp, file);
      } catch (error) {
        warn(`dsh-notifier: 投递状态写入失败: ${errorMessage(error)}`);
      }
    });
  }

  function record(channelId: string, status: "ok" | "failed", error?: string): void {
    loadSyncOnce();
    const prev = entries.get(channelId);
    const entry: ChannelStatusEntry = {
      lastTs: Date.now(),
      lastStatus: status,
      failStreak: status === "ok" ? 0 : (prev?.failStreak ?? 0) + 1,
    };
    if (status === "failed" && error) entry.lastError = error.slice(0, 300);
    entries.delete(channelId);
    entries.set(channelId, entry); // 重新插入保持最近使用在尾部
    while (entries.size > STATUS_MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    scheduleFlush();
  }

  async function read(): Promise<Record<string, ChannelStatusEntry>> {
    loadSyncOnce();
    return { ...Object.fromEntries(entries) };
  }

  return { record, read };
}
