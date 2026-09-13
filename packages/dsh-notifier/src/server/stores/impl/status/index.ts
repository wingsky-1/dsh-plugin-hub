/**
 * dsh-notifier stores 域 —— 频道投递状态落盘实现：内存镜像 + debounce 合并的整文件原子写。
 *
 * 与历史同源但多一层 debounce：通知风暴时避免每条通知一次整文件重写。
 */
import {
  readTextFileSync,
  writeTextAtomic,
  STATUS_FILE_NAME,
  clampReasonDetail,
  normalizeReason,
  notifierFile,
} from "../../../shared/interface.ts";
import type { ProducedReason } from "../../../shared/interface.ts";
import type { ChannelStatusEntry, StatusDeps } from "./type.ts";

/** 未装配时的占位：装配是必经路径，占位只是让字段不必每个使用点判空。 */
const UNINSTALLED: StatusDeps = { logger: { warn: () => {} } };

/** 状态条目上限（防已删频道残留键无限累积；超出时最旧先出）。 */
const STATUS_MAX_ENTRIES = 64;

/** 落盘 debounce 窗口（毫秒）：窗口内的多次 record 合并为一次整文件写。 */
const STATUS_DEBOUNCE_MS = 500;

/** 宿主原文（`detail`）上限（字符）：摘要会随 GET /status 出到设置页，够定位问题即可。
 * `code` / `params` 不受这条上限约束——它们是固定短标识，没有撑爆页面的风险。 */
const STATUS_ERROR_LIMIT = 300;
/** 待落盘状态：有改动尚未落盘时才持有定时器。 */
type PendingFlush = { pending: false } | { pending: true; timer: ReturnType<typeof setTimeout> };

/** 频道投递终态：内存镜像即时更新，落盘延后合并。 */
class StatusStore {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 落盘路径：DSH home 由环境决定、进程内不变，故随实例一次性定下。 */
  private readonly file = notifierFile(STATUS_FILE_NAME);
  private deps: StatusDeps = UNINSTALLED;
  /** 内存镜像：本类的单一事实源，冷启动从文件加载；空表即「尚未加载」。 */
  private mirror: Record<string, ChannelStatusEntry> = {};
  /** 落盘 debounce：窗口内多次 record 合并为一次整文件写。 */
  private flush: PendingFlush = { pending: false };
  /** 写队列串行化：整文件重写若并发交错，后写的会把先写的整份内容覆盖掉。 */
  private queue: Promise<void> = Promise.resolve();

  install(deps: StatusDeps): void {
    if (this.installed) throw new Error("dsh-notifier: 投递状态只能装配一次");
    this.installed = true;
    this.deps = deps;
  }

  /** 卸载：放开装配入参并丢掉内存镜像。镜像要一起丢——它是「磁盘状态」的记忆。 */
  release(): void {
    this.clearPendingFlush();
    this.installed = false;
    this.deps = UNINSTALLED;
    this.mirror = {};
  }

  /** 记录一次投递终态：内存立即更新，落盘延后合并（失败仅经日志出口告警）。 */
  record(channelId: string, status: "ok" | "failed", error?: ProducedReason): void {
    this.loadFromDisk();
    const prev = this.mirror[channelId];
    const entry: ChannelStatusEntry = {
      lastTs: Date.now(),
      lastStatus: status,
      // 连续失败计数跨重启延续：冷启动已把文件读进镜像，「上一次」因此就在 prev 里。
      failStreak: status === "ok" ? 0 : (prev === undefined ? 0 : prev.failStreak) + 1,
    };
    if (status === "failed" && error !== undefined) {
      entry.lastError = clampReasonDetail(error, STATUS_ERROR_LIMIT);
    }
    // 删了再插 = 移到表尾：镜像键序即最近使用序。频道 id 形如 `bark:<id>` 或内置通道名，
    // 不是整数样键——整数样键在对象里恒按数值升序枚举，回插改不动位置。
    delete this.mirror[channelId];
    this.mirror[channelId] = entry;
    this.evictOldest();
    this.scheduleFlush();
  }

  /** 读取全部频道状态（内存镜像优先，冷启动回落文件）。 */
  async read(): Promise<Record<string, ChannelStatusEntry>> {
    this.loadFromDisk();
    // 浅拷贝：镜像会被下一次 record 改写，调用方拿到的必须是「读到的那一刻」。
    return { ...this.mirror };
  }

  /**
   * 冷启动懒加载：把文件读进镜像。
   *
   * 必须同步读：`record` 是 fire-and-forget，异步加载会与它抢跑，让磁盘上的旧值把刚记下的
   * 投递盖回去。空表即「尚未加载」，读不出内容时下一次再读一遍。
   */
  private loadFromDisk(): void {
    if (Object.keys(this.mirror).length > 0) return;
    const read = readTextFileSync(this.file);
    if (!read.ok) return;
    try {
      const stored = JSON.parse(read.text) as Record<string, unknown>;
      for (const [channelId, entry] of Object.entries(stored)) {
        const normalized = normalizeEntry(entry);
        if (normalized !== undefined) this.mirror[channelId] = normalized;
      }
    } catch {
      // 半截 JSON：从空表开始，下一次落盘会用完整内容覆盖它。
    }
  }

  private scheduleFlush(): void {
    if (this.flush.pending) return;
    const timer = setTimeout(() => {
      this.flush = { pending: false };
      this.flushToDisk();
    }, STATUS_DEBOUNCE_MS);
    // 不把进程钉在事件循环上：丢掉的是「最近一次投递」的记录，下一次投递会重新记。
    timer.unref();
    this.flush = { pending: true, timer };
  }

  /** 丢掉待写定时器：卸载后这次落盘已没有要表达的事实。 */
  private clearPendingFlush(): void {
    if (this.flush.pending) clearTimeout(this.flush.timer);
    this.flush = { pending: false };
  }

  private flushToDisk(): void {
    // 快照先取：任务真正执行时镜像可能已被 release 丢掉，那时序列化出来的是一张空
    // 表——这次写本来要表达一次投递终态，却会把状态文件整份清掉。
    const snapshot = JSON.stringify(this.mirror, null, 2);
    const deps = this.deps;
    this.queue = this.queue.then(async () => {
      const written = await writeTextAtomic(this.file, snapshot);
      if (!written.ok) {
        deps.logger.warn(`dsh-notifier: 投递状态写入失败: ${written.reason}`);
      }
    });
  }

  private evictOldest(): void {
    const ids = Object.keys(this.mirror);
    const excess = ids.length - STATUS_MAX_ENTRIES;
    for (const channelId of ids.slice(0, Math.max(0, excess))) {
      delete this.mirror[channelId];
    }
  }
}

/**
 * 磁盘内容不受契约约束：只收「看起来是状态条目」的项，其余（陌生形态、半截值）丢掉。
 *
 * 值域也要校验，不能只看字段类型：`lastStatus` 是客户端直接画红绿的判据，把不认识的值透传出去
 * 之后，旧客户端会把任何 ≠ `"ok"` 的值渲染成「最近投递失败 + 红点」——一次降级就凭空多出一条
 * 故障。`lastError` 的旧形态（升级前写下的散文）在这里收编成结构化理由，读面因此不必再判两态。
 */
function normalizeEntry(entry: unknown): ChannelStatusEntry | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const source = entry as Record<string, unknown>;
  if (typeof source.lastTs !== "number") return undefined;
  if (source.lastStatus !== "ok" && source.lastStatus !== "failed") return undefined;
  const normalized: ChannelStatusEntry = {
    lastTs: source.lastTs,
    lastStatus: source.lastStatus,
    // 计数缺失（早于本字段的形态）按 0 起算：它只用于展示连续失败次数，不是判据。
    failStreak: typeof source.failStreak === "number" ? source.failStreak : 0,
  };
  const lastError = normalizeReason(source.lastError);
  if (lastError !== undefined) normalized.lastError = lastError;
  return normalized;
}

/** 本域唯一的存储实例：类不外放，外面 `new` 不出第二份内存镜像。 */
export const statusStore = new StatusStore();
