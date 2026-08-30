/**
 * dsh-notifier — 官方 settings 命名空间接线（issue #76，包内复刻）。
 *
 * 职责：插件在官方 settings 服务中的命名空间（SETTINGS_NS）、minimal 类型面
 * （OwnerScopeLike / SettingsServiceLike / NotifierSettingsHooks）与挂载函数
 * installNotifierSettings。形态等值复刻同仓 dsh-lan-proxy 的
 * installLanProxySettings（PR #267）：服务面注入零包依赖、register 返回的
 * owner scope 经 onScope 外露供写（存量迁移）、热更新统一走 scope.watch。
 *
 * 为什么不用官方 @deepseek-ai/dsh-settings 包：插件运行时沿自身 lib/ 向上
 * 解析不到该包（MODULE_NOT_FOUND），动态 import 会静默失败——与
 * shared/settings-namespace.js 相同的服务面注入方案。
 * 为什么不用 schemastery 构造 schema：notifier 无该依赖且 coder 禁改
 * package.json；官方 register 对 schema 的最小调用面是「callable（resolve
 * 时直接调用）+ toJSON（describe 序列化）+ 无 secret 的平铺形态（redact
 * walk 走 default 原样返回）」，包内以零依赖函数形态等值覆盖。
 */
import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../../../shared/host-utils.js";
import { normalizeConfig } from "./config.ts";
import type { NotifyConfig } from "./config.ts";

/** 本插件在官方 settings 服务中的命名空间。 */
export const SETTINGS_NS = "dsh-notifier";

/**
 * 是否正处于插件自身 fiber 卸载中（区别于「仅丢失 settings 服务」）。
 * 官方判据：fiber.state ∈ { unloading, unloaded, disposed }。
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
 * owner scope 最小类型面（官方 SettingsScope<T> 的子集）。注意官方 scope 的
 * update/replace 不接收 expectedRevision——乐观并发须经 SettingsServiceLike
 * 的 update(ns, ...)（SettingsProvider 公开方法，write 内做 revision 校验）。
 */
export interface OwnerScopeLike {
  /** 当前解析值（schema defaults → base → user 层）。 */
  get(): NotifyConfig;
  /** 提交后异步串行回调，返回 disposer。 */
  watch(cb: (next: NotifyConfig, prev: NotifyConfig) => void): () => void;
  /** 增量 merge patch 进 user 层并持久化（无 revision 校验的便捷面）。 */
  update(patch: object): Promise<void>;
}

/**
 * settings 服务最小类型面。update(ns, ...) 是乐观并发（expectedRevision）的
 * 唯一可达路径——官方 register 返回的 scope.update 会丢弃该参数。
 */
export interface SettingsServiceLike {
  register(ns: string, schema: unknown, options?: { base?: unknown }): OwnerScopeLike;
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown; revision: number }>;
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}

/** installNotifierSettings 的 hooks 面（含 onScope：attach 后交出 owner scope）。 */
export interface NotifierSettingsHooks {
  /** 把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。 */
  setSource(source: () => NotifyConfig): void;
  /** 来源切换或命名空间值变化时触发，插件据此刷新运行时状态。 */
  onChange(): void;
  /** scope attach 后回调（迁移在此执行）；服务缺失时不触发。 */
  onScope(scope: OwnerScopeLike, service: SettingsServiceLike): void;
}

/**
 * 零依赖最小 schema：官方 register 的 schema 参数在 resolve 时被当作函数
 * 直接调用（输入 = mergeLayers(base, user section)），describe 时调用
 * toJSON()，redactSecrets walk 对无 secret 字段的平铺 schema 走 default 分支
 * 原样返回值。这里以「可调用函数 + toJSON」等值覆盖——函数体即 normalizeConfig
 * （默认值兜底 + 白名单净化 + 未知键透传，与解析语义一致）。
 */
function createNotifierSchema(): unknown {
  const schema = (input: unknown) => normalizeConfig(input);
  // describe() 会调用 schema.toJSON()：返回可序列化的平铺描述（配置 UI 不解释
  // schema 结构——插件自绘卡片，官方 tab 只按命名空间派发）。
  (schema as { toJSON?: () => unknown }).toJSON = () => ({ type: "object" });
  return schema;
}

/**
 * 注册插件自有 settings 命名空间并把 owner scope 交给调用方。
 * 语义等值复刻官方 installSettingsSection / shared installSettingsNamespace，
 * 差异仅在把 register 返回的 owner scope 经 onScope 外露，供存量配置迁移写入
 * 与乐观并发（经 service.update(ns, patch, expectedRevision)）。
 *
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param entry - 组合层配置的通知字段（经 sanitizeSettings 白名单过滤后传入，
 *   作为命名空间的 base 层；无有效键则为空 base）。
 * @param hooks - source 收藏、变更通知与 scope 移交。
 */
export function installNotifierSettings(ctx: Context, entry: Record<string, unknown>, hooks: NotifierSettingsHooks): void {
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
      scope = settings.register(SETTINGS_NS, createNotifierSchema(), { base: entry });
    } catch (err) {
      warnLog(ctx, `${SETTINGS_NS}: settings.register 失败 — ${errorMessage(err)}`);
      return;
    }
    hooks.onScope(scope, settings);
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
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