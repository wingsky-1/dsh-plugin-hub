/**
 * dsh-opencode-usage — 宿主端适配器注册表（HostAdapterRegistry）。
 *
 * 按 provider 名分派取数（M1 核心）：
 * - 内置 OpenCode Go 先注册；
 * - 用户宿主适配器后注册，同 provider **用户覆盖内置**（D4）；
 * - get(provider) 未命中 → 返回归一化的 no-adapter 错误结果。
 *
 * 多 provider 并存时按 provider 名独立查表，互不干扰；注册顺序决定覆盖优先级。
 */
import type {
  HostFetchContext,
  HostProviderAdapter,
  ProviderUsage,
} from "./contracts.js";
import { isHostProviderAdapter, usageError } from "./contracts.js";

/** 注册表诊断条目（health / 设置面板展示用）。 */
export interface AdapterRegistrationInfo {
  /** 认领的 provider 名。 */
  providers: string[];
  /** 来源：builtin | user-file。 */
  source: "builtin" | "user-file";
  /** 用户文件路径（source=user-file 时有值）。 */
  file?: string;
  /** 加载/校验状态。 */
  status: "active" | "invalid" | "load-failed";
  /** 失败诊断（status != active 时有值）。 */
  error?: string;
}

/**
 * 宿主适配器注册表。
 * @param opts.diag - 诊断收集器（可选；缺省 console.warn）。
 */
export function makeHostAdapterRegistry(opts: { diag?: (m: string) => void } = {}) {
  const diag = opts.diag ?? ((m: string): void => console.warn("[dsh-opencode-usage]", m));
  /** provider → 适配器（后注册覆盖先注册）。 */
  const byProvider = new Map<string, HostProviderAdapter>();
  /** 注册条目（含来源/状态，供 health/设置面板快照）。 */
  const infos: AdapterRegistrationInfo[] = [];

  /**
   * 注册一个适配器（结构校验失败只告警，不注册）。
   * @param adapter - 契约对象。
   * @param source - builtin | user-file。
   * @param file - 用户文件路径（可选）。
   * @returns 是否注册成功。
   */
  function register(adapter: unknown, source: AdapterRegistrationInfo["source"], file?: string): boolean {
    if (!isHostProviderAdapter(adapter)) {
      const at = file === undefined ? "内置适配器" : `用户适配器 ${file}`;
      diag(`${at} 契约校验失败（version/providers/fetchUsage），不注册`);
      infos.push({
        providers: [],
        source,
        file,
        status: "invalid",
        error: "契约校验失败",
      });
      return false;
    }
    for (const provider of adapter.providers) {
      byProvider.set(provider, adapter);
    }
    infos.push({ providers: [...adapter.providers], source, file, status: "active" });
    return true;
  }

  /** 按 provider 查适配器；未命中返回 undefined。 */
  function get(provider: string): HostProviderAdapter | undefined {
    return byProvider.get(provider);
  }

  /** 取某 provider 的归一化结果（未命中 → no-adapter 错误态）。 */
  async function fetchUsage(provider: string, ctx: HostFetchContext): Promise<ProviderUsage> {
    const adapter = byProvider.get(provider);
    if (adapter === undefined) {
      return usageError(provider, "no-adapter", provider, Date.now());
    }
    try {
      return await adapter.fetchUsage(ctx);
    } catch (error) {
      diag(`适配器 ${provider} 运行抛错：${error instanceof Error ? error.message : String(error)}`);
      return usageError(provider, "adapter-crash", provider, Date.now());
    }
  }

  /** 撤销某 provider 的分派（用户覆盖内置时，卸载用户适配器后回落内置）。 */
  function unregisterProvider(provider: string, removed: HostProviderAdapter): void {
    if (byProvider.get(provider) === removed) byProvider.delete(provider);
  }

  /** 注册表快照（health / 设置面板适配器管理区）。 */
  function snapshot(): { providers: string[]; infos: AdapterRegistrationInfo[] } {
    return { providers: [...byProvider.keys()], infos: [...infos] };
  }

  return { register, get, fetchUsage, unregisterProvider, snapshot };
}

export type HostAdapterRegistry = ReturnType<typeof makeHostAdapterRegistry>;