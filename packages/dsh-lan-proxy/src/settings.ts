/**
 * dsh-lan-proxy — 官方 settings 命名空间接线（#276 方案 A 阶段 3 拆出）。
 *
 * 职责：插件在官方 settings 服务中的命名空间（SETTINGS_NS）、minimal 类型面
 * （OwnerScopeLike / SettingsServiceLike / LanProxySettingsHooks）与挂载函数
 * installLanProxySettings。非导出辅助 isUnloading / warnLog 亦归此模块
 * （apply.ts 经 module 导出复用 warnLog，不重复实现）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../../../shared/host-utils.js";
import { Config } from "./config.ts";
import type { LanProxyConfig } from "./config.ts";

/** 本插件在官方 settings 服务中的命名空间。 */
export const SETTINGS_NS = "dsh-lan-proxy";

/**
 * 是否正处于插件自身 fiber 卸载中（区别于「仅丢失 settings 服务」）。
 * 与 shared/settings-namespace.js 同款判据：fiber.state ∈ { unloading, unloaded,
 * disposed }。（包内复刻：coder 规程禁止改 shared/，而 owner scope 写能力需要
 * 拿到 register 返回值，shared 版 hooks 不外露 scope。）
 */
function isUnloading(ctx: unknown): boolean {
  const fiber =
    ctx && typeof ctx === "object" && "fiber" in ctx
      ? (ctx as { fiber?: { state?: unknown } }).fiber
      : undefined;
  const state = fiber && typeof fiber === "object" ? fiber.state : undefined;
  return state === "unloading" || state === "unloaded" || state === "disposed";
}

/** 日志兜底：logger 可能确实没有（极端降级），全部可选调用。 */
export function warnLog(ctx: unknown, message: string): void {
  const logger =
    ctx && typeof ctx === "object" && "logger" in ctx
      ? (ctx as { logger?: { warn?: (...a: unknown[]) => void } }).logger
      : undefined;
  if (typeof logger?.warn === "function") logger.warn(message);
}

/**
 * owner scope 最小类型面（官方 SettingsScope<T> 的子集；仅 import type 无法
 * 从运行时拿到该包，这里按 @deepseek-ai/dsh-settings@0.1.1-rc.2 类型层收窄）。
 */
export interface OwnerScopeLike {
  /** 当前解析值（schema defaults → base → user 层）。 */
  get(): LanProxyConfig;
  /** 提交后异步串行回调，返回 disposer。 */
  watch(cb: (next: LanProxyConfig, prev: LanProxyConfig) => void): () => void;
  /** 增量 merge patch 进 user 层并持久化。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
  /** 整节替换 user 层，缺省键回落 base/schema 默认。 */
  replace(section: object, expectedRevision?: number): Promise<void>;
}

/** settings 服务最小类型面（register/describe）。 */
export interface SettingsServiceLike {
  register(ns: string, schema: unknown, options?: { base?: unknown }): OwnerScopeLike;
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown; revision: number }>;
}

/** installLanProxySettings 的 hooks 面（含 onScope：attach 后交出 owner scope）。 */
export interface LanProxySettingsHooks {
  /** 把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。 */
  setSource(source: () => LanProxyConfig): void;
  /** 来源切换或命名空间值变化时触发，插件据此刷新/重建转发器。 */
  onChange(): void;
  /** scope attach 后回调（迁移在此执行）；服务缺失时不触发。 */
  onScope(scope: OwnerScopeLike, service: SettingsServiceLike): void;
}

/**
 * 注册插件自有 settings 命名空间并把 owner scope 交给调用方
 * （服务面注入，零包依赖；语义等值复刻官方 installSettingsSection 与
 * shared/installSettingsNamespace——差异仅在把 register 返回的 owner scope
 * 经 onScope 外露，供存量配置迁移写入）。
 *
 * 为什么不用官方 @deepseek-ai/dsh-settings 包：插件运行时沿自身 lib/ 向上
 * 解析不到该包（MODULE_NOT_FOUND），动态 import 会静默失败——与
 * shared/settings-namespace.js 相同的服务面注入方案。
 *
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param entry - 组合层配置，作为命名空间的 base 层。
 * @param hooks - source 收藏、变更通知与 scope 移交。
 */
export function installLanProxySettings(ctx: Context, entry: LanProxyConfig, hooks: LanProxySettingsHooks): void {
  type InjectFn = (services: string[], fn: (c: any) => void) => void;
  if (typeof (ctx as unknown as { inject?: InjectFn })?.inject !== "function") {
    warnLog(ctx, `${SETTINGS_NS}: ctx.inject 不可用 — 设置命名空间未注册，设置卡降级`);
    return;
  }
  (ctx.inject as unknown as InjectFn)(["settings"], (sctx) => {
    const settings = sctx && (sctx.settings as SettingsServiceLike | undefined);
    if (!settings || typeof settings.register !== "function") {
      warnLog(ctx, `${SETTINGS_NS}: settings 服务缺少 register 能力 — 设置命名空间未注册，设置卡降级`);
      return;
    }
    let scope: OwnerScopeLike;
    try {
      scope = settings.register(SETTINGS_NS, Config, { base: entry });
    } catch (err) {
      warnLog(ctx, `${SETTINGS_NS}: settings.register 失败 — ${errorMessage(err)}`);
      return;
    }
    hooks.onScope(scope, settings);
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    // 热更新统一走官方 scope.watch（提交后异步串行回调）。
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
  });
}