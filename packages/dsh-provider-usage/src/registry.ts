/**
 * dsh-provider-usage — 简化适配器注册表（v2 新契约）。
 *
 * 只负责三件事：
 * 1. 按 provider 管理启用的适配器（每个 provider 最多一个启用）
 * 2. 运行时切换启用适配器
 * 3. 提供快照供设置面板展示
 */
import { basename } from "node:path";
import type { UsageStatsAdapter } from "./contracts.js";

/** 适配器来源。 */
export type AdapterSource = "builtin" | "user-file";

/** 最近一次错误登记。 */
export interface AdapterErrorInfo {
  at: number;
  kind: "load" | "exec";
  message: string;
}

/** 快照条目（供设置面板/health 展示）。 */
export interface AdapterInfo {
  name: string;
  label: string;
  providers: string[];
  source: AdapterSource;
  file?: string;
  enabled: boolean;
}

/** 简化适配器注册表。 */
export function makeV2Registry(opts: { diag?: (m: string) => void } = {}) {
  const diag = opts.diag ?? ((m: string): void => console.warn("[dsh-provider-usage]", m));
  /** provider → 适配器映射。 */
  const adapters = new Map<string, UsageStatsAdapter>();
  /** provider → 来源。 */
  const sources = new Map<string, AdapterSource>();
  /** provider → 文件路径。 */
  const files = new Map<string, string>();
  /** 最近一次错误。 */
  const lastErrors = new Map<string, AdapterErrorInfo>();

  /** 登记错误。 */
  function recordError(key: string, kind: "load" | "exec", message: string): void {
    lastErrors.set(key, { at: Date.now(), kind, message });
    diag(`适配器 ${key} ${kind === "load" ? "加载" : "执行"}错误：${message}`);
  }

  /** 注册一个适配器（按 provider 关联）。 */
  function register(adapter: UsageStatsAdapter, source: AdapterSource, file?: string): void {
    const name = adapter.name;
    for (const provider of adapter.providers) {
      adapters.set(provider, adapter);
      sources.set(provider, source);
      if (file !== undefined) files.set(provider, file);
      diag(`适配器 ${name} 已注册（provider=${provider}, source=${source})`);
    }
  }

  /** 获取某 provider 的适配器（无则返回 undefined）。 */
  function get(provider: string): UsageStatsAdapter | undefined {
    return adapters.get(provider);
  }

  /** 运行时切换某 provider 的适配器；adapterId = null 清空启用。 */
  function select(provider: string, adapterName: string | null): boolean {
    if (adapterName === null) {
      adapters.delete(provider);
      sources.delete(provider);
      files.delete(provider);
      return true;
    }
    // 查找已注册的适配器（按 name 匹配）
    for (const [p, a] of adapters) {
      if (p === provider && a.name === adapterName) return true;
    }
    return false;
  }

  /** 当前有启用适配器的 provider 列表。 */
  function enabledProviders(): string[] {
    return [...adapters.keys()];
  }

  /** 快照。 */
  function snapshot(): {
    infos: AdapterInfo[];
    enabled: Record<string, string>;
    enabledProviders: string[];
    errors: Array<AdapterErrorInfo & { key: string }>;
  } {
    const infos: AdapterInfo[] = [];
    const enabled: Record<string, string> = {};
    for (const [provider, a] of adapters) {
      infos.push({
        name: a.name,
        label: a.label ?? a.name,
        providers: a.providers,
        source: sources.get(provider) ?? "builtin",
        file: files.get(provider),
        enabled: true,
      });
      enabled[provider] = a.name;
    }
    const errors = [...lastErrors.entries()].map(([key, e]) => ({ key, ...e }));
    return { infos, enabled, enabledProviders: [...adapters.keys()], errors };
  }

  return { register, recordError, get, select, enabledProviders, snapshot };
}

export type V2Registry = ReturnType<typeof makeV2Registry>;