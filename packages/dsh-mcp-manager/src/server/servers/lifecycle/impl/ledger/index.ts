/**
 * dsh-mcp-manager — servers/lifecycle/impl/ledger/index.ts：装载账本（确定性回收链，§1.5）。
 *
 * 装载实例不能交给 loader 的 entry 树持有：`EntryTree.create` 末行 `tree.write()` 会把运行期
 * command / args / env（含凭据模板展开后的明文）写回用户 profile。所以官方实例由我方账本持有、
 * 回收也由我方负责——这是两条回收链的主链，兜底链是 `bindHost` 里 `ctx.effect` 注册的 dispose。
 *
 * 已知缺口（照 §1.5 写进实现）：`DomainSpec.release(): void` 是同步签名，而官方 `dispose()` 会
 * await 首次连接尝试的在途 Promise（挂死的服务器可能等到 SDK 的 60s initialize 超时）。
 * 因此 `release()` 与单键的 `releaseOne()` 都只**发起** dispose 并把 Promise 收进 pendingDisposals，
 * 另开 `flushDisposals()` 供测试与真机验证显式等待；需要等结算的单键路径用 `dispose()`。
 *
 * 键由调用方给（id 生成与 `(scope,name)→id` 表归 workspace 域，§2.6 裁定 B）：本域不生成 id，
 * 也不把键写进 MountedPlugin——端口因此对配置与命名保持无感知。同一键未释放前重复 mount
 * 属编程错误，不等官方那句 `serverName is already in use`（那是第二道闸，不是第一道）。
 */
import type { MountedPlugin, OfficialPluginModule } from "../../../../shared/interface.ts";
import { lifecyclePorts } from "../service/index.ts";

/** 账本条目：一次装载留下的全部我方痕迹（模块与配置只为排查用，不参与回收裁决）。 */
export interface LedgerEntry {
  readonly key: string;
  readonly module: OfficialPluginModule;
  readonly config: unknown;
  readonly handle: MountedPlugin;
}

class MountLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  /** 释放后待结算的 dispose：只收不 await，见文件头「已知缺口」。 */
  private pending: Promise<void>[] = [];

  /** 记账并**发起**装载：先查键再装，撞键当场抛（早失败 + 判词点名键）。 */
  mount(key: string, module: OfficialPluginModule, config: unknown): LedgerEntry {
    if (this.entries.has(key)) {
      throw new Error(
        `dsh-mcp-manager: servers/lifecycle 账本已有键 ${key}——同一 serverName 未释放前不得重复 mount`,
      );
    }
    const handle = lifecyclePorts.get().loader.mount(module, config);
    const entry: LedgerEntry = { key, module, config, handle };
    this.entries.set(key, entry);
    return entry;
  }

  get(key: string): LedgerEntry | undefined {
    return this.entries.get(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** 该条目是否仍是账本当前代际：被替换或已移除都不算——晚到结算据此丢弃（代际守卫）。 */
  isCurrent(entry: LedgerEntry): boolean {
    return this.entries.get(entry.key) === entry;
  }

  /**
   * 单键释放，**只发起不等结算**：摘账同步生效（`isCurrent` 立刻为假），dispose 收进既有
   * pending。拆除路径用它——见文件头「已知缺口」；要等结算的重建路径用 `dispose()`。
   */
  releaseOne(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    const disposal = entry.handle.dispose();
    // 没有任何调用方 await 这个 promise，不吞掉拒绝就会变成 unhandled rejection 打崩进程；
    // pending 里仍放**原 promise**——上抛语义留给 flushDisposals（吞掉错因等于把泄漏变成静默）。
    void disposal.catch(() => {});
    this.pending.push(disposal);
  }

  /** 单键释放：先摘账（同步生效，isCurrent 立刻为假）再等句柄结算。 */
  async dispose(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    await entry.handle.dispose();
  }

  /** 域卸载：逐条摘账并发起 dispose，不等结算（见文件头「已知缺口」）。 */
  release(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.pending.push(entry.handle.dispose());
  }

  /**
   * 等待已发起的 dispose 全部落定。任一失败如实上抛：兜底链保证的是「卸载不卡住」，
   * 不是「dispose 永不失败」，吞掉错因会让泄漏变成静默。
   */
  async flushDisposals(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    const settled = await Promise.allSettled(pending);
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected !== undefined && rejected.status === "rejected") throw rejected.reason;
  }
}

/** 本域唯一的账本实例：类不外放，外部 new 不出第二份账。 */
export const mountLedger = new MountLedger();
