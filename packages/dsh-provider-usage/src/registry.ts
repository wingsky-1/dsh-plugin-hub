/**
 * dsh-provider-usage — 宿主端适配器注册表 v2（HostAdapterRegistry）。
 *
 * R1 升级：从「provider → 适配器一对一硬覆盖」改为「候选 + 唯一启用」（D6）。
 * - 同 provider 允许多个候选（内置 + 用户若干），任一时刻**一个启用**；
 * - 默认启用规则（3.1b）：内置 opencode-go 默认启；配置显式列出的用户适配器
 *   （未 `enabled:false`）默认启并成为该 provider 当前启用者（同 provider 后注册
 *   默认启用者替换前者）；`enabled:false` 仅作禁用候选；
 * - `select(provider, adapterId)` 运行时切换启用；
 * - `get(provider)` 只返回启用条目；无启用候选返回 undefined，区分 `no-adapter`
 *   （无候选）与 `no-enabled-adapter`（有候选但全禁用）。
 */
import { basename } from "node:path";
import type {
  HostFetchContext,
  HostProviderAdapter,
  ProviderUsage,
} from "./contracts.js";
import { describeAdapterShape, isHostProviderAdapter, usageError } from "./contracts.js";

/** 注册条目来源。 */
export type AdapterSource = "builtin" | "user-file";

/**
 * 候选条目状态（issue #29 收敛）：注册即结构校验通过，invalid/load-failed 从未
 * 赋值（加载失败在 apply 层直接不注册），故只保留 active。
 */
export type AdapterStatus = "active";

/**
 * 最近一次适配器错误登记（issue #38 注入容错：面板排障展示用）。
 * kind=load：文件装载/契约校验失败；kind=exec：fetchUsage/summarize 执行抛错或超时。
 * key：已注册候选用 adapter id；未注册成功的用户文件用 `file:<basename>`。
 */
export interface AdapterErrorInfo {
  at: number;
  kind: "load" | "exec";
  message: string;
}

/** 护栏超时哨兵（区别于适配器自身抛错）。 */
class AdapterGuardTimeout extends Error {}

/** 注册表诊断条目（health / 设置面板候选展示用）。 */
export interface AdapterRegistrationInfo {
  /** 适配器唯一名。 */
  id: string;
  /** 适配器展示名。 */
  label: string;
  /** 认领的 provider 名。 */
  providers: string[];
  /** 来源：builtin | user-file。 */
  source: AdapterSource;
  /** 用户文件路径（source=user-file 时有值）。 */
  file?: string;
  /** 加载/校验状态。 */
  status: AdapterStatus;
  /** 是否当前启用（per provider；多 provider 认领时以对应用户为准）。 */
  enabled: boolean;
}

/** 内部候选条目。 */
interface AdapterEntry {
  adapter: HostProviderAdapter;
  id: string;
  label: string;
  providers: string[];
  source: AdapterSource;
  file?: string;
  status: AdapterStatus;
}

/**
 * 宿主适配器注册表（候选 + 唯一启用）。
 * @param opts.diag - 诊断收集器（可选；缺省 console.warn）。
 * @param opts.sanitizePath - 错误消息路径脱敏函数（可选；登记前把绝对路径归约成
 *   `~` 形态，维持信息面最小披露）。
 */
export function makeHostAdapterRegistry(opts: { diag?: (m: string) => void; sanitizePath?: (s: string) => string } = {}) {
  const diag = opts.diag ?? ((m: string): void => console.warn("[dsh-provider-usage]", m));
  const sanitizePath = opts.sanitizePath ?? ((s: string): string => s);
  /** provider → 有序候选条目（注册顺序）。 */
  const candidatesByProvider = new Map<string, AdapterEntry[]>();
  /** provider → 当前启用 adapterId。 */
  const enabledIds = new Map<string, string>();
  /** 已注册 adapter id 集合（同 id 重复拒绝）。 */
  const registeredIds = new Set<string>();
  /** 最近一次错误登记表（key = adapterId 或 file:<basename>）。 */
  const lastErrors = new Map<string, AdapterErrorInfo>();

  /**
   * 登记一次适配器错误（warn + 记录最近一次；同 key 覆盖）。
   * 加载失败（文件不存在/import 抛错/契约拒收）走 kind=load；执行抛错或护栏
   * 超时走 kind=exec。调用方无需再自行 warn。
   */
  function recordError(key: string, kind: "load" | "exec", message: string): void {
    lastErrors.set(key, { at: Date.now(), kind, message: sanitizePath(message) });
    diag(`适配器 ${key} ${kind === "load" ? "加载" : "执行"}错误：${sanitizePath(message)}`);
  }

  /**
   * 执行护栏：限时竞速。适配器 promise 在时限内 settle 则透传；超时则拒绝
   * AdapterGuardTimeout（底层 promise 无法强杀，其结果被丢弃，采样循环不再被
   * 挂起阻塞——同步死循环仍会阻塞事件循环，那需要 worker 隔离，超出本期）。
   */
  function withGuard<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AdapterGuardTimeout()), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /** 护栏时长：跟随 ctx.timeoutMs（下限 50ms 防误配），与网络超时同源同量级。 */
  function guardMs(ctx: HostFetchContext): number {
    return Math.max(50, typeof ctx.timeoutMs === "number" && Number.isFinite(ctx.timeoutMs) ? ctx.timeoutMs : 15000);
  }

  /** 执行期异常归类：护栏超时 → adapter-timeout；其余 → adapter-crash。 */
  function execFailure(provider: string, entryId: string, error: unknown): ProviderUsage {
    if (error instanceof AdapterGuardTimeout) {
      recordError(entryId, "exec", "执行超时（疑似死循环/长挂起，已被护栏拦截）");
      return usageError(provider, "adapter-timeout", provider, Date.now());
    }
    recordError(entryId, "exec", error instanceof Error ? error.message : String(error));
    return usageError(provider, "adapter-crash", provider, Date.now());
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

  /** 按 id 查某 provider 的候选条目。 */
  function findEntry(provider: string, adapterId: string): AdapterEntry | undefined {
    return candidates(provider).find((e) => e.id === adapterId);
  }

  /**
   * 注册一个适配器候选（结构校验失败只告警，不注册）。
   * @param adapter - 契约对象。
   * @param source - builtin | user-file。
   * @param file - 用户文件路径（可选）。
   * @param enabledHint - 配置显式给出的启停（undefined = 默认启用；false = 禁用候选）。
   * @returns 是否注册成功。
   */
  function register(
    adapter: unknown,
    source: AdapterSource,
    file?: string,
    enabledHint?: boolean,
  ): boolean {
    if (!isHostProviderAdapter(adapter)) {
      // issue #38：拒收时输出缺失成员明细（可排障），用户文件场景登记加载错误
      const detail = describeAdapterShape(adapter) ?? "未知形状问题";
      if (file === undefined) {
        diag(`内置适配器 契约校验失败（${detail}），不注册`);
      } else {
        recordError(`file:${basename(file)}`, "load", `契约校验失败（${detail}），已拒收`);
      }
      return false;
    }
    if (registeredIds.has(adapter.id)) {
      diag(`适配器 id 重复：${adapter.id}，忽略重复注册`);
      return false;
    }
    registeredIds.add(adapter.id);

    const entry: AdapterEntry = {
      adapter,
      id: adapter.id,
      label: adapter.label,
      providers: [...adapter.providers],
      source,
      ...(file !== undefined ? { file } : {}),
      status: "active",
    };
    for (const provider of adapter.providers) {
      candidates(provider).push(entry);
      // 默认启用：enabledHint !== false → 成为该 provider 当前启用者
      // （启用态由快照按 enabledIds 判定，无需回改旧候选）
      if (enabledHint !== false) {
        enabledIds.set(provider, adapter.id);
      }
    }
    return true;
  }

  /** 按 provider 返回当前启用条目；无启用返回 undefined。 */
  function getEntry(provider: string): AdapterEntry | undefined {
    const id = enabledIds.get(provider);
    if (id === undefined) return undefined;
    return findEntry(provider, id);
  }

  /** 按 provider 查当前启用适配器；无启用返回 undefined。 */
  function get(provider: string): HostProviderAdapter | undefined {
    return getEntry(provider)?.adapter;
  }

  /** 某 provider 是否有任何候选。 */
  function hasCandidates(provider: string): boolean {
    return (candidates(provider).length ?? 0) > 0;
  }

  /**
   * 运行时切换某 provider 的启用适配器；adapterId = null 清空该 provider 启用项
   * （issue #38：「禁用该提供商」，幂等，无候选也返回 true）。
   * @returns 是否成功（切换要求 provider 与 adapterId 均存在；清空恒成功）。
   */
  function select(provider: string, adapterId: string | null): boolean {
    if (adapterId === null) {
      enabledIds.delete(provider);
      return true;
    }
    const entry = findEntry(provider, adapterId);
    if (entry === undefined) return false;
    enabledIds.set(provider, adapterId);
    return true;
  }

  /**
   * 取某 provider 的归一化结果（启用适配器；区分 no-adapter / no-enabled-adapter）。
   * issue #38：执行受超时护栏约束——适配器挂起/死循环不再阻塞采样循环，
   * 超时返回 adapter-timeout 错误态。
   */
  async function fetchUsage(provider: string, ctx: HostFetchContext): Promise<ProviderUsage> {
    const entry = getEntry(provider);
    if (entry === undefined) {
      // 无候选（no-adapter）或有候选但全禁用（no-enabled-adapter）
      const code = hasCandidates(provider) ? "no-enabled-adapter" : "no-adapter";
      return usageError(provider, code, provider, Date.now());
    }
    try {
      return await withGuard(entry.adapter.fetchUsage(ctx), guardMs(ctx));
    } catch (error) {
      return execFailure(provider, entry.id, error);
    }
  }

  /**
   * 取某 provider 的轻量摘要（当前启用适配器 summarize，或通用推导占位）。
   * @returns bundle：适配器存在 + summarize 结果（或未实现摘要时 null）。
   */
  async function summarize(
    provider: string,
    ctx: HostFetchContext,
  ): Promise<{ entry: AdapterEntry | undefined; summary: import("./contracts.js").ProviderSummary | null }> {
    const entry = getEntry(provider);
    if (entry === undefined) return { entry: undefined, summary: null };
    if (typeof entry.adapter.summarize !== "function") return { entry, summary: null };
    try {
      const summary = await withGuard(entry.adapter.summarize(ctx), guardMs(ctx));
      return { entry, summary: summary ?? null };
    } catch (error) {
      execFailure(provider, entry.id, error);
      return { entry, summary: null };
    }
  }

  /** 当前启用适配器的 provider 列表（后台采样遍历用）。 */
  function enabledProviders(): string[] {
    return [...enabledIds.keys()];
  }

  /** 某 provider 是否启用某适配器。 */
  function isEnabled(provider: string, adapterId: string): boolean {
    return enabledIds.get(provider) === adapterId;
  }

  /**
   * 注册表快照（health / 设置面板适配器候选管理）。
   * - infos：全部候选条目（含 enabled 标记）；
   * - enabled：provider → enabledAdapterId 映射；
   * - errors：最近一次适配器错误登记（issue #38，面板排障展示；含未注册成功的
   *   用户文件条目，key = `file:<basename>`）。
   */
  function snapshot(): {
    infos: AdapterRegistrationInfo[];
    enabled: Record<string, string>;
    enabledProviders: string[];
    errors: Array<AdapterErrorInfo & { key: string }>;
  } {
    const infos: AdapterRegistrationInfo[] = [];
    const seen = new Set<string>();
    // 每个候选条目按 (id, provider) 记一条；多 provider 认领时按 provider 判定 enabled
    for (const [provider, list] of candidatesByProvider) {
      for (const entry of list) {
        const key = `${entry.id}/${provider}`;
        if (seen.has(key)) continue;
        seen.add(key);
        infos.push({
          id: entry.id,
          label: entry.label,
          providers: [...entry.providers],
          source: entry.source,
          ...(entry.file !== undefined ? { file: entry.file } : {}),
          status: entry.status,
          enabled: enabledIds.get(provider) === entry.id,
        });
      }
    }
    const enabled: Record<string, string> = {};
    for (const [provider, id] of enabledIds) enabled[provider] = id;
    const errors = [...lastErrors.entries()].map(([key, e]) => ({ key, ...e }));
    return { infos, enabled, enabledProviders: [...enabledIds.keys()], errors };
  }

  return {
    register,
    recordError,
    get,
    getEntry,
    select,
    fetchUsage,
    summarize,
    enabledProviders,
    isEnabled,
    hasCandidates,
    snapshot,
  };
}

export type HostAdapterRegistry = ReturnType<typeof makeHostAdapterRegistry>;