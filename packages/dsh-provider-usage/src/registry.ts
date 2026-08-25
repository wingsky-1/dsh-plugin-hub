/**
 * dsh-provider-usage — 适配器注册表（候选 + 唯一启用，v2 契约）。
 *
 * 同 provider 允许多个候选适配器（内置 + 用户若干），任一时刻**一个启用**：
 * - 内置 opencode-go 默认启；用户适配器经设置页 add 登记后默认成为启用者
 * - `select(provider, name|null)` 运行时切换/清空启用
 * - `getEntry(provider)` 返回启用条目；无启用候选返回 undefined，
 *   区分 `no-adapter`（无候选）与 `no-enabled-adapter`（有候选但全禁用）
 */
import { basename } from "node:path";
import type { UsageStatsAdapter } from "./contracts.js";
import { isUsageStatsAdapter, describeUsageStatsAdapterShape } from "./contracts.js";

/** 适配器来源。 */
export type AdapterSource = "builtin" | "user-file";

/** 最近一次错误登记（kind=load：装载/契约校验失败；kind=exec：fetchData 执行抛错或超时）。 */
export interface AdapterErrorInfo {
  at: number;
  kind: "load" | "exec";
  message: string;
}

/** 快照条目（设置面板/health 展示用）。 */
export interface AdapterInfo {
  /** 适配器唯一名。 */
  name: string;
  /** 展示名。 */
  label: string;
  /** 认领的 provider 列表。 */
  providers: string[];
  /** 来源：builtin | user-file。 */
  source: AdapterSource;
  /** 用户文件路径（source=user-file 时有值）。 */
  file?: string;
  /** 是否当前启用（per provider；多 provider 认领时以对应用户为准）。 */
  enabled: boolean;
}

/** 内部候选条目。 */
interface AdapterEntry {
  adapter: UsageStatsAdapter;
  name: string;
  label: string;
  providers: string[];
  source: AdapterSource;
  file?: string;
}

/**
 * 热更新替换结果（#212）。
 * ok=false 时旧条目**原样保留**（冲突预检先行，不做先删后注册），detail 供 health/日志如实呈现。
 */
export type ReplaceFileResult =
  | { ok: true; name: string }
  | { ok: false; code: "invalid-adapter" | "duplicate-name"; detail: string };

/**
 * 适配器注册表（候选 + 唯一启用）。
 * @param opts.diag - 诊断收集器（缺省 console.warn）。
 * @param opts.sanitizePath - 错误消息路径脱敏（把绝对路径归约为 `~` 形态，信息面最小披露）。
 */
export function makeAdapterRegistry(opts: { diag?: (m: string) => void; sanitizePath?: (s: string) => string } = {}) {
  const diag = opts.diag ?? ((m: string): void => console.warn("[dsh-provider-usage]", m));
  const sanitizePath = opts.sanitizePath ?? ((s: string): string => s);
  /** provider → 有序候选条目。 */
  const candidatesByProvider = new Map<string, AdapterEntry[]>();
  /** provider → 当前启用 name。 */
  const enabledNames = new Map<string, string>();
  /** 已注册 name 集合（同 name 重复拒绝）。 */
  const registeredNames = new Set<string>();
  /** 最近一次错误登记（key = name 或 file:<basename>）。 */
  const lastErrors = new Map<string, AdapterErrorInfo>();

  /** 登记一次适配器错误（warn + 记录最近一次；同 key 覆盖）。 */
  function recordError(key: string, kind: "load" | "exec", message: string): void {
    lastErrors.set(key, { at: Date.now(), kind, message: sanitizePath(message) });
    diag(`适配器 ${key} ${kind === "load" ? "加载" : "执行"}错误：${sanitizePath(message)}`);
  }

  /** 获取某 provider 的候选列表（不存在则建空）。 */
  function candidates(provider: string): AdapterEntry[] {
    let list = candidatesByProvider.get(provider);
    if (list === undefined) {
      list = [];
      candidatesByProvider.set(provider, list);
    }
    return list;
  }

  /** 按 name 查某 provider 的候选条目。 */
  function findEntry(provider: string, name: string): AdapterEntry | undefined {
    return candidates(provider).find((e) => e.name === name);
  }

  /**
   * 注册一个适配器候选（v2 契约校验；失败登记错误并返回 false）。
   * @param adapter - 契约对象。
   * @param source - builtin | user-file。
   * @param file - 用户文件路径（可选）。
   * @param enabledHint - 配置显式给出的启停（undefined = 默认启用；false = 禁用候选）。
   * @returns 是否注册成功。
   */
  function register(adapter: unknown, source: AdapterSource, file?: string, enabledHint?: boolean): boolean {
    if (!isUsageStatsAdapter(adapter)) {
      const detail = describeUsageStatsAdapterShape(adapter) ?? "未知形状问题";
      if (file === undefined) {
        diag(`内置适配器契约校验失败（${detail}），不注册`);
      } else {
        recordError(`file:${basename(file)}`, "load", `契约校验失败（${detail}），已拒收`);
      }
      return false;
    }
    const a = adapter as UsageStatsAdapter;
    if (registeredNames.has(a.name)) {
      recordError(`file:${file ? basename(file) : a.name}`, "load", `适配器 name 重复：${a.name}，忽略重复注册`);
      return false;
    }
    registeredNames.add(a.name);

    const entry: AdapterEntry = {
      adapter: a,
      name: a.name,
      label: a.label ?? a.name,
      providers: [...a.providers],
      source,
      ...(file !== undefined ? { file } : {}),
    };
    for (const provider of a.providers) {
      candidates(provider).push(entry);
      // 默认启用：enabledHint !== false → 成为该 provider 当前启用者
      if (enabledHint !== false) {
        enabledNames.set(provider, a.name);
      }
    }
    return true;
  }

  /** 按 provider 返回当前启用条目；无启用返回 undefined。 */
  function getEntry(provider: string): AdapterEntry | undefined {
    const name = enabledNames.get(provider);
    if (name === undefined) return undefined;
    return findEntry(provider, name);
  }

  /** 按 provider 查当前启用适配器；无启用返回 undefined。 */
  function get(provider: string): UsageStatsAdapter | undefined {
    return getEntry(provider)?.adapter;
  }

  /** 某 provider 是否有任何候选。 */
  function hasCandidates(provider: string): boolean {
    return (candidates(provider).length ?? 0) > 0;
  }

  /**
   * 运行时切换某 provider 的启用适配器；name = null 清空该 provider 启用项（幂等）。
   * @returns 是否成功（切换要求 provider 与 name 均存在；清空恒成功）。
   */
  function select(provider: string, name: string | null): boolean {
    if (name === null) {
      enabledNames.delete(provider);
      return true;
    }
    const entry = findEntry(provider, name);
    if (entry === undefined) return false;
    enabledNames.set(provider, name);
    return true;
  }

  /** 当前启用适配器的 provider 列表（后台采样遍历用）。 */
  function enabledProviders(): string[] {
    return [...enabledNames.keys()];
  }

  /** 某 provider 是否启用某适配器。 */
  function isEnabled(provider: string, name: string): boolean {
    return enabledNames.get(provider) === name;
  }

  /**
   * 注册表快照（health / 设置面板适配器候选管理）。
   * - infos：全部候选条目（含 enabled 标记）；
   * - enabled：provider → enabledName 映射；
   * - errors：最近一次适配器错误登记。
   */
  function snapshot(): {
    infos: AdapterInfo[];
    enabled: Record<string, string>;
    enabledProviders: string[];
    errors: Array<AdapterErrorInfo & { key: string }>;
  } {
    const infos: AdapterInfo[] = [];
    const seen = new Set<string>();
    for (const [provider, list] of candidatesByProvider) {
      for (const entry of list) {
        const key = `${entry.name}/${provider}`;
        if (seen.has(key)) continue;
        seen.add(key);
        infos.push({
          name: entry.name,
          label: entry.label,
          providers: [...entry.providers],
          source: entry.source,
          ...(entry.file !== undefined ? { file: entry.file } : {}),
          enabled: enabledNames.get(provider) === entry.name,
        });
      }
    }
    const enabled: Record<string, string> = {};
    for (const [provider, name] of enabledNames) enabled[provider] = name;
    const errors = [...lastErrors.entries()].map(([key, e]) => ({ key, ...e }));
    return { infos, enabled, enabledProviders: [...enabledNames.keys()], errors };
  }

  /** 按 name 全局查找候选（跨 provider；add 重复检查用）。 */
  function hasName(name: string): boolean {
    return registeredNames.has(name);
  }

  /**
   * 移除某文件注册的全部候选（热更替换用）：同一文件的新版本改名后，
   * 旧条目先清掉再重新注册，避免 name 重复误报。
   * @returns 被移除的条目数。
   */
  function removeByFile(file: string): number {
    let removed = 0;
    for (const [provider, list] of candidatesByProvider) {
      const kept = list.filter((e) => e.file !== file);
      removed += list.length - kept.length;
      if (kept.length > 0) candidatesByProvider.set(provider, kept);
      else candidatesByProvider.delete(provider);
    }
    // 清掉已移除条目对应的 registeredNames 与 enabled 引用
    const activeNames = new Set<string>();
    for (const list of candidatesByProvider.values()) {
      for (const e of list) activeNames.add(e.name);
    }
    for (const n of [...registeredNames]) {
      if (!activeNames.has(n)) registeredNames.delete(n);
    }
    for (const [provider, name] of [...enabledNames]) {
      if (!activeNames.has(name)) enabledNames.delete(provider);
    }
    return removed;
  }

  /**
   * 热更新原子替换某文件注册的全部候选（#212）：
   * - 冲突预检：新版 name 与**其他来源**已注册名重复 → 拒绝且不动旧条目（修复改名撞名静默丢失）；
   * - enabled 保持：替换只更新代码不改写启用关系——本文件旧条目在其认领 provider 上
   *   原本是启用者的，替换后新条目沿用；原本停用的不得变回启用；新增认领的 provider 不自动启用。
   * @param file - 用户文件路径（定位被替换的旧条目）。
   * @param next - 新版适配器（契约校验失败同样拒绝且保留旧条目）。
   */
  function replaceByFile(file: string, next: unknown): ReplaceFileResult {
    if (!isUsageStatsAdapter(next)) {
      const detail = describeUsageStatsAdapterShape(next) ?? "未知形状问题";
      return { ok: false, code: "invalid-adapter", detail: `契约校验失败（${detail}），已保留旧条目` };
    }
    const a = next;
    // 收集本文件旧条目（同一条目可出现在多个 provider 桶，按 name 去重）
    const oldEntries = new Map<string, AdapterEntry>();
    for (const list of candidatesByProvider.values()) {
      for (const e of list) {
        if (e.file === file) oldEntries.set(e.name, e);
      }
    }
    // 冲突预检：新 name 不属于本文件旧名、却已被其他来源占用 → 拒绝，旧条目原样保留
    if (!oldEntries.has(a.name) && registeredNames.has(a.name)) {
      return { ok: false, code: "duplicate-name", detail: `适配器 name 冲突：${a.name}（已被其他适配器占用，旧条目保留）` };
    }
    // 记录旧启用状态：本文件旧条目在其认领的每个 provider 上是否是当前启用者
    const wasEnabledProviders = new Set<string>();
    for (const entry of oldEntries.values()) {
      for (const provider of entry.providers) {
        if (enabledNames.get(provider) === entry.name) wasEnabledProviders.add(provider);
      }
    }
    // 原子替换：移除旧条目后以「不默认启用」注册新版，再逐 provider 精确恢复原启用关系
    // （同步执行无 await 间隙，中间态外部不可观察）
    removeByFile(file);
    if (!register(a, "user-file", file, false)) {
      // 防御分支：契约与重名均已在上方排除，理论不可达
      return { ok: false, code: "invalid-adapter", detail: "替换注册失败，已保留语义上的空缺" };
    }
    for (const provider of a.providers) {
      if (wasEnabledProviders.has(provider)) select(provider, a.name);
    }
    return { ok: true, name: a.name };
  }

  return {
    register,
    recordError,
    get,
    getEntry,
    select,
    enabledProviders,
    isEnabled,
    hasCandidates,
    hasName,
    removeByFile,
    replaceByFile,
    snapshot,
  };
}

export type AdapterRegistry = ReturnType<typeof makeAdapterRegistry>;