/**
 * dsh-notifier —— 宿主端组合根（唯一的装配层）。
 *
 * ## 只做三件事
 *
 * 1. **收窄宿主上下文**：把 `ctx` 变成各域要用的窄面。域不直接触达全局上下文。
 * 2. **按依赖顺序装配**：域只声明「我需要什么」，满足它是组合根的事。
 * 3. **注册生命周期**：宿主副作用经 `ctx.effect` 登记，卸载时按装配的逆序释放。
 *
 * 业务判断一律不在这里——凡是「什么时候该做什么」的问题，答案都属于某个域。
 * 组合根只把域接起来，不替它们做决定。
 *
 * ## 装配顺序（= 依赖顺序：下游先、上游后）
 *
 * | 序 | 域 | 职责 | 交给它什么 |
 * |---|---|---|---|
 * | 0 | `upgrade` | 存储形态的版本迁移 | 日志 |
 * | 1 | `config` | 通知配置的单一事实源 | 组合层入口层、日志 |
 * | 2 | `stores` | 历史与投递状态的持久化 | 保留天数读取器、日志 |
 * | 3 | `pipeline` | 一条通知的完整生命周期 | config / content / channels / stores 的能力 |
 * | 4 | `events` | 宿主事件 → 通知请求 | 宿主事件面、提交口、事件开关 |
 * | 5 | `sdk` | 对外 ABI（`ctx["wingsky.notifier"]`） | 提交口、内置 kind 列表 |
 * | 6 | `api` | 浏览器出口：HTTP 路由 + SSE | 配置读写、历史、提交口、帧入口 |
 *
 * `upgrade` 排在最前不是因为它是上游，而是因为它动的是**磁盘**：各域装配时会读
 * 文件，迁移必须在那些读之前落定。
 *
 * `content` 与 `channels` 无状态，**不参与装配**：它们是纯动作，谁用谁引契约。
 * 组合根不替它们持有实例，也不替调用方保管它们的入参。
 *
 * ## 纪律
 *
 * - 域之间不互相引用实现；跨域能力由本文件显式接上。
 * - 本文件是唯一允许引用全部域 `interface.ts` 的地方。
 * - 域的全部跨域依赖申报在各自的 `deps.ts`；本文件按该申报满足它。
 */
import type { Context } from "@deepseek-ai/cordis";
import { installConfig, readConfig } from "./server/config/interface.ts";
import type { NotifierEntryConfig } from "./server/config/interface.ts";
import type { LoggerPort } from "./server/shared/type.ts";
import { installStores } from "./server/stores/interface.ts";
import { installUpgrade } from "./server/upgrade/interface.ts";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 依赖的宿主服务。 */
export const inject = ["webServer"];

/**
 * 组合层入口配置（插件挂载点传入）。
 *
 * 两层合一：**设置项**作为用户层之下的默认层——组合层与启动参数给出厂默认之外的
 * 取值，用户在设置页里显式改过的键仍然压在它上面；**装配开关**只在这一层表达。
 */
export interface NotifierApplyConfig extends NotifierEntryConfig {
  /** 总开关；`false` 时一律不投递。归裁决层消费，不落盘、不进设置层。 */
  enabled?: boolean;
}

/** 挂载 dsh-notifier。 */
export function apply(ctx: Context, config: NotifierApplyConfig = {}): void {
  const host = bindHost(ctx);
  const disposers = assemble(host, config);
  ctx.effect(() => () => safeDisposeAll(disposers));
}

/** 组合根用到的宿主面：域拿到的是能力，不是上下文。 */
interface HostPort {
  readonly logger: LoggerPort;
}

function bindHost(ctx: Context): HostPort {
  return { logger: ctx.logger };
}

/**
 * 装配：按依赖顺序接上各域，返回它们的释放函数（逆序执行）。
 *
 * 每一步的入参都来自上一步的产出或 `host`——装配顺序即依赖顺序，顺序错了就是
 * 运行期空值。
 */
function assemble(host: HostPort, config: NotifierApplyConfig): Array<() => void> {
  const disposers: Array<() => void> = [];

  // 0. 存储形态迁移：动的是磁盘，必须早于任何读文件的域。
  installUpgrade({ logger: host.logger });

  // 1. 设置：读面在装配返回时即可用，后续各域不必等加载。
  installConfig({ entry: config, logger: host.logger });

  // 2. 存储：保留天数取 getter——设置可变，装配期快照会在用户改设置后失效。
  installStores({
    maxAgeDays: () => readConfig().historyMaxAgeDays,
    logger: host.logger,
  });

  return disposers;
}

/** 逐个释放；单个释放失败不阻断其余（否则一个域的清理会拖垮整条卸载链）。 */
function safeDisposeAll(disposers: Array<() => void>): void {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // 忽略：卸载阶段不做失败上报，避免掩盖首个异常
    }
  }
}
