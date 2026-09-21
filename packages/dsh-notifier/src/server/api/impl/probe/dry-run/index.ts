/**
 * dsh-notifier api 域 —— 草稿测试（dry-run）的编排：解析 draft → 内存归一化 → 直构单目标 → 实测。
 *
 * 禁写面（提案 B3，判据逐项钉）：本模块可触达的只有「纯函数 + 单目标出站」，结构上拿不到
 * appendHistory / recordStatus / revision 落盘 / FrameBus emit——ProbeEndpoints 的构造入参里
 * 根本没有 stores 与 frames；logger 入参存在但 dry-run 全程不调用（含路由收口的 500 兜底，
 * 见 probe/index.ts 的 testDraft）。browser 的 emitFrame 由目标直构时接空函数，零真通知。
 *
 * bypass（提案 B6）：直构目标跳过 enabled 门（新频道默认 false，否则恒 suppressed）；
 * 不走 judge / kindRoutes；bypass 节奏与重试（单次尝试）；禁 settle / archive / emitFrame；
 * 能力探测复用共享缓存只读（channels 侧）；读面只用 config.readConfig（含明文凭据，不外发）。
 */
import { channelIdOf } from "../../../../../shared/interface.ts";
import type { ChannelPort, ConfigPort, PipelinePort } from "../../../deps.ts";
import type { EffectiveConfig } from "../../../../pipeline/deps.ts";
import type { ProducedReason } from "../../../../shared/interface.ts";
import {
  DRY_RUN_BUDGET_MS,
  DRY_RUN_MAX_INFLIGHT,
  DryRunInputError,
  DryRunTimeoutError,
  TEST_NOTIFICATION,
} from "./type.ts";
import type { DryRunReason, DryRunResult } from "./type.ts";

/** dry-run 的域能力：只有组合根够得着的三个端口（与 ProbeEndpoints 的入参同源）。 */
export interface DryRunDeps {
  readonly config: ConfigPort;
  readonly pipeline: PipelinePort;
  readonly channels: ChannelPort;
}

/**
 * 并发门：同时在飞的 dry-run 上限（提案 B5）。实例字段而非模块级计数——模块级 let 是门禁红线，
 * 状态必须收进实例（ProbeEndpoints 每挂载一份门，计数器与真实投递的节奏表相互独立）。
 */
export class DryRunGate {
  private active = 0;

  constructor(private readonly max: number = DRY_RUN_MAX_INFLIGHT) {}

  /** 尝试占一个槽位：满了即 false（调用方回 429，不排队）。 */
  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  /** 释放一个槽位：settle 与超时都要走这里（finally），不按子进程退出——否则泄漏（B7）。 */
  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  /** 在飞计数：只给单测读，生产路径不按它做判断（判断只认 tryAcquire 的原子结果）。 */
  get inflight(): number {
    return this.active;
  }
}

/**
 * 执行一次 dry-run：抛 DryRunInputError（调用方转 400），其余异常一律冒给预算层
 * （调用方按 500 收口，不记日志——禁写面）。成功即 B3 schema 的同步结果。
 */
export async function executeDryRun(
  deps: DryRunDeps,
  channelId: string,
  draft: unknown,
): Promise<DryRunResult> {
  const secrets = deps.config.readConfig().channels;
  const resolved = deps.config.resolveDraftChannels(draft, secrets);
  if (!resolved.ok) throw new DryRunInputError(resolved.hint);
  const effective = deps.config.normalizeConfig({ channels: [...resolved.channels] });
  const channel = effective.channels.find((item) => channelIdOf(item) === channelId);
  if (channel === undefined) {
    throw new DryRunInputError("draft.channels 里没有 channelId 对应的完整条目：" + channelId);
  }
  const message = deps.pipeline.finalizeRequest({ ...TEST_NOTIFICATION }, Date.now());
  const target = buildTarget(deps.pipeline, channel);
  const delivery = await deps.channels.dryRunTarget(target, message);
  if (delivery.status === "ok") return { ok: true, channelId, status: "ok" };
  return { ok: true, channelId, status: delivery.status, reason: toReason(delivery.reason) };
}

/**
 * 目标直构：映射复用路由的四个 builder（同一份，不漂移），门全部 bypass——
 * enabled 不看（直构），kind 取固定的 test（路由收窄不参与），frames / logger 接空实现
 * （browser 不 emit 真通知，system 的失败细节只进 reason.detail 不进日志）。
 */
function buildTarget(pipeline: PipelinePort, channel: EffectiveConfig["channels"][number]) {
  const quiet = { frames: { emit: () => {} }, logger: { warn: (_message: string): void => {} } };
  switch (channel.type) {
    case "bark":
      return pipeline.barkTarget(channel, "test");
    case "webhook":
      return pipeline.webhookTarget(channel);
    case "browser":
      // 内置 builder 回的是带身份的 RoutedTarget：dry-run 的身份即入参 channelId，只取其中的 target。
      return pipeline.browserTarget(channel, quiet, "test").target;
    case "system":
      return pipeline.systemTarget(channel, quiet).target;
    default:
      throw new DryRunInputError("未知的频道类型：" + String((channel as { type?: unknown }).type));
  }
}

/**
 * 投递理由 → 结果线形态：只做形状收窄。截断与收编是 dryRunTarget 的出站契约
 * （见 channels/interface.ts 的 dryRunTarget 注释），这里不再截第二遍——多截一次
 * 就多一条 api→channels 的跨模块值边（目录门面判红，见 verify-dir-imports）。
 */
function toReason(reason: ProducedReason): DryRunReason {
  const out: { code: string; params?: Record<string, string | number>; detail?: string } = {
    code: reason.code,
  };
  if (reason.params !== undefined) out.params = { ...reason.params };
  if (reason.detail !== undefined) out.detail = reason.detail;
  return out;
}

/**
 * 总预算：15s 内未 settle 即按超时拒绝（调用方回 408）。超时不取消在飞的投递——
 * bark / webhook 的单跳各有自己的 fetch 超时，system 的 spawn 靠出口的 KILL 8s 回收，
 * 它们结算后写不进任何地方（无 stores 引用），结果自然丢弃（B7「abort 残留声明」）。
 */
export function withDryRunBudget<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DryRunTimeoutError("dry-run 超过 15s 总预算")),
      DRY_RUN_BUDGET_MS,
    );
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}
