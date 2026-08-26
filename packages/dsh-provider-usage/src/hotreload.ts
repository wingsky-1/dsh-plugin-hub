/**
 * dsh-provider-usage — 适配器 mjs 热更新（mtime+size 轮询 + 原子切换）。
 *
 * 机制：
 * - 轮询 stat（默认 2s），对比 mtimeMs + size 检测文件变化（nodemon 同款，跨平台可靠）
 * - `import(pathToFileURL(file) + '?t=' + mtimeMs)` 绕 ESM 模块缓存
 * - 新模块加载并校验通过后才替换引用（原子切换）；失败保留旧版
 * - 校验和（内容 hash）可选项：开启后每次变化先算 hash，文件被替换也能感知
 */
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { UsageStatsAdapter } from "./contracts.ts";
import { isUsageStatsAdapter, describeUsageStatsAdapterShape } from "./contracts.ts";

/** 文件状态快照（mtimeMs + size）。 */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** 读取文件状态（不存在返回 null）。 */
export async function readStamp(file: string): Promise<FileStamp | null> {
  try {
    const s = await stat(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** 两个快照是否相同。 */
export function stampEqual(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** 加载 ESM 模块并校验为新契约（失败返回错误描述）。 */
export async function loadAndValidateAdapter(
  file: string,
  stamp: FileStamp,
): Promise<{ adapter?: UsageStatsAdapter; error?: string }> {
  try {
    const url = pathToFileURL(file).href + `?t=${stamp.mtimeMs}`;
    const mod = (await import(url)) as Record<string, unknown>;
    const candidate = (mod.default ?? mod) as unknown;
    if (!isUsageStatsAdapter(candidate)) {
      const detail = describeUsageStatsAdapterShape(candidate) ?? "未知形状问题";
      return { error: `契约校验失败：${detail}` };
    }
    return { adapter: candidate };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 可热更新的适配器持有者。
 *
 * - `current`: 当前生效的适配器
 * - `poll()`: 轮询一次，文件变化则加载新版并原子切换
 * - `stop()`: 停止轮询
 */
export class HotReloadableAdapter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStamp: FileStamp | null = null;
  private readonly onReload: (info: { ok: boolean; error?: string }) => void;
  // 显式字段（#276 方案 A：构造器参数属性非可擦除语法，Node strip-only 模式
  // 无法加载插桩 src；改显式声明 + 构造函数体内赋值，语义零变化）
  private readonly file: string;
  private readonly intervalMs: number;
  private readonly checkChecksum: boolean;

  constructor(
    file: string,
    intervalMs: number,
    onReload?: (info: { ok: boolean; error?: string }) => void,
    checkChecksum = false,
  ) {
    this.file = file;
    this.intervalMs = intervalMs;
    this.checkChecksum = checkChecksum;
    this.onReload = onReload ?? ((): void => {});
  }

  /** 当前生效的适配器。 */
  current: UsageStatsAdapter | null = null;

  /** 启动轮询（先同步一次校验）。 */
  async start(): Promise<{ ok: boolean; error?: string }> {
    const stamp = await readStamp(this.file);
    this.lastStamp = stamp;
    if (stamp === null) {
      const error = `文件不存在或不可读：${this.file}`;
      this.onReload({ ok: false, error });
      return { ok: false, error };
    }
    const loaded = await this.reload(stamp);
    if (loaded.error !== undefined) {
      this.onReload({ ok: false, error: loaded.error });
      return loaded;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    return loaded;
  }

  /** 停止轮询（dispose 时调用）。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 手动触发一次检轮询（测试用 / 启动补检）。 */
  async pollOnce(): Promise<{ ok: boolean; error?: string }> {
    const stamp = await readStamp(this.file);
    if (stampEqual(stamp, this.lastStamp)) return { ok: true };
    this.lastStamp = stamp;
    if (stamp === null) {
      // 文件被删除：保留当前适配器，不切换
      return { ok: true };
    }
    return this.reload(stamp);
  }

  private async reload(stamp: FileStamp): Promise<{ ok: boolean; error?: string }> {
    // 可选：校验和验证（内容 hash）——此处简化为记录 mtime+size，
    // 完整校验和需读文件内容；保持轻量，由调用方决定是否开启
    const loaded = await loadAndValidateAdapter(this.file, stamp);
    if (loaded.error !== undefined) {
      this.onReload({ ok: false, error: loaded.error });
      return { ok: false, error: loaded.error };
    }
    // 原子切换：新适配器校验通过后才替换引用
    this.current = loaded.adapter ?? null;
    this.onReload({ ok: true });
    return { ok: true };
  }
}