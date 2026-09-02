// dsh 插件家族共享层 — 宿主端「设置命名空间」注册（单一事实源）。
//
// 背景：
// DSH rc.7 起，设置 → 插件 的 `settings.plugin.item` 槽由 `list(id)` 改为
// `keyed(key)`，且只在「宿主 serve 的 settings 命名空间 ∩ 卡片声明的 key」交集
// 非空时才渲染。想让插件的设置卡片在 rc.7 显示，宿主端必须把该插件的命名空间
// 注册进 settings 服务（`settings.describe()` 才能返回它）。
//
// 为什么不用官方 `@deepseek-ai/dsh-settings`：
// 该包由宿主 dsh 运行时提供，不在插件仓库依赖中；插件运行时沿自身 lib/ 路径
// 向上解析不到（MODULE_NOT_FOUND），动态 import 会静默失败、命名空间从未注册，
// 导致 rc.7 下设置卡片空白。因此这里改用「服务面注入」：`ctx.inject(["settings"],…)`
// 由宿主 cordis 上下文按名注入 settings 服务，零包依赖、与官方语义等值。
//
// 本实现逐条等值复刻官方 `installSettingsSection`（dsh-settings@0.1.0-rc.7）：
//   1. 注入 settings 服务（不存在则不运行 → 卡片降级，功能不受影响）；
//   2. `settings.register(ns, schema, { base: entry, validate? })` 注册命名空间，
//      返回 owner scope，随 fiber 卸载自动注销、重复注册抛错；
//   3. `setSource` 指向 `scope.get()`；卸载/服务消失时回落到组合层 entry；
//   4. `onChange` 在来源切换与 `scope.watch` 变化时触发。
//
// #436 收敛：`onScope`（可选）在 register 返回 owner scope 后立即回调（先于
// setSource），供 notifier / lan-proxy 做存量配置迁移与写路径装配；warnLog 为
// 单一事实源（notifier / lan-proxy 曾各复刻一份，现统一引用本导出）。
//
// 约定：js + d.ts 双写（tsc rootDir 硬约束）；只 import Node 内置；零运行时依赖。

/**
 * 是否正处于插件自身 fiber 卸载中（区别于「仅丢失 settings 服务」）。
 * 官方判据：fiber.state ∈ { unloading, disposed }。
 * @param {unknown} ctx - cordis 插件上下文。
 * @returns {boolean} 是否在卸载。
 */
function isUnloading(ctx) {
  const fiber =
    ctx && typeof ctx === "object" && "fiber" in ctx
      ? /** @type {{ state?: unknown }} */ (/** @type {any} */ (ctx).fiber)
      : undefined;
  const state = fiber && typeof fiber === "object" ? fiber.state : undefined;
  return state === "unloading" || state === "unloaded" || state === "disposed";
}

/**
 * 日志兜底：logger 可能确实没有（极端降级），全部可选调用。
 * 单一事实源（#436）：notifier / lan-proxy 曾各复刻一份 warnLog，现统一引用本导出。
 * @param {unknown} ctx - cordis 插件上下文。
 * @param {string} message - 告警消息。
 */
export function warnLog(ctx, message) {
  const logger =
    ctx && typeof ctx === "object" && "logger" in ctx
      ? /** @type {{ warn?: (...a: unknown[]) => void }} */ (/** @type {any} */ (ctx).logger)
      : undefined;
  if (typeof logger?.warn === "function") logger.warn(message);
}

/**
 * 安装「可选 settings 消费者的标准接线」：settings 服务存在时，把 `ns` 以组合层
 * `entry` 作为 `base` 注册进 settings 服务，并让 `hooks.setSource` 指向解析后的
 * owner scope（hooks.onScope 可选：register 成功后先交 scope）；服务消失/插件
 * 卸载时回落到 entry。注册随 scoped fiber 生效——settings 服务从未挂载则本函数
 * 什么都不做（卡片降级，功能不受影响）。
 *
 * 等值语义参考官方 `installSettingsSection`
 * （@deepseek-ai/dsh-settings@0.1.0-rc.7，MIT）。这里不 import 该包，纯粹以
 * 服务面注入驱动，规避插件运行时解析不到该包导致的静默失败。
 *
 * @param {any} ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param {string} ns - 插件自有命名空间（小写 kebab，通常 `<plugin 名>`，须唯一）。
 * @param {unknown} schema - schemastery schema，解析该命名空间的值（通常为插件 Config）。
 * @param {unknown} entry - 组合层配置，作为命名空间的 `base` 层。
 * @param {{ setSource(source: () => unknown): void; onChange(): void; validate?: unknown; onScope?: (scope: unknown, settings: unknown) => void }} hooks
 *   - setSource：把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。
 *     rc.7 下 settings 服务存在时，卡片数据应经此 scope 读写。
 *   - onChange：来源切换或命名空间值变化时触发，插件据此刷新自身状态/落盘。
 *   - validate：可选的自定义校验（透传给 settings.register）。
 *   - onScope：可选；register 返回 owner scope 后立即回调（先于 setSource），
 *     notifier / lan-proxy 在此做存量配置迁移与写路径装配（#436）。
 * @returns {void}
 */
export function installSettingsNamespace(ctx, ns, schema, entry, hooks) {
  // 防御：ctx.inject 不可用（极简宿主/测试桩）与 settings 服务缺失同属降级场景，
  // 静默跳过（卡片降级，不影响插件主体）。
  if (typeof ctx?.inject !== "function") {
    warnLog(ctx, `${ns}: ctx.inject 不可用 — 设置命名空间未注册，卡片降级`);
    return;
  }
  ctx.inject(["settings"], (sctx) => {
    const settings = sctx && sctx.settings;
    if (!settings || typeof settings.register !== "function") {
      warnLog(ctx, `${ns}: settings 服务缺少 register 能力 — 设置命名空间未注册，卡片降级`);
      return;
    }
    let scope;
    try {
      scope = settings.register(ns, schema, {
        base: entry,
        ...(hooks && hooks.validate !== undefined ? { validate: hooks.validate } : {}),
      });
    } catch (err) {
      // 重复注册等硬错误：报日志但不中断插件主体（宿主导入时并行注册同名 ns 会走到这）。
      warnLog(ctx, `${ns}: settings.register 失败 — ${String(err && err.message ? err.message : err)}`);
      return;
    }
    if (hooks && typeof hooks.onScope === "function") {
      hooks.onScope(scope, settings);
    }
    hooks.setSource(() => scope.get());
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    scope.watch(() => {
      if (isUnloading(ctx)) return;
      hooks.onChange();
    });
  });
}
