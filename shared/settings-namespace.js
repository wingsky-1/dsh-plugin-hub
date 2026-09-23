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
// 双路径（能力探测，无版本号分支）：
//   - settings 有 register 即走旧 Provider 路径（见 installViaProvider）：
//     `settings.register(ns, schema, { base: entry, validate? })` 注册命名空间，
//     返回 owner scope，随 fiber 卸载自动注销、重复注册抛错；`setSource` 指向
//     `scope.get()`；卸载/服务消失时回落到组合层 entry；`onChange` 在来源切换与
//     `scope.watch` 变化时触发。等值语义参考官方
//     `SettingsProvider.installSection`（@deepseek-ai/dsh-settings@0.1.5-rc.1，MIT）。
//     注：历史注释误写为复刻 `installSettingsSection@0.1.0-rc.7`——该符号在官方包
//     中不存在，特此纠正（实际对标为 `installSection(owner, ns, schema, entry, hooks)`）。
//   - 否则走 rc.7 Forms 路径（见 installViaForms）：不再调用 register；读经
//     `settings.describe()` 按 entry id（`ns \u007c\u007c id \u007c\u007c key`）定位后取 volatile 投影
//     （`volatile ?? value ?? user`），写经 `settings.update/replace/mutate(ns, …)`，
//     热更新经 `settings/document-updated` 按 ns 过滤＋volatile 投影比对后触发
//     `onChange`。schema 在此路径下由宿主侧持有，不经本函数注册；validate 仅
//     Provider 路径透传（Forms 侧由宿主校验，见函数内注释）。
//
// 探测禁版本号分支：只看 `typeof settings.register === "function"` 与
// `typeof settings.describe === "function"` 等能力面，不读任何版本串。
//
// #436 收敛：`onScope`（可选）在 scope 就绪后立即回调（先于
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
 * Forms 描述项的 entry id：rc.1 为 `ns`，rc.7 Forms 为 `id`（兼容 `key` 别名）。
 * 能力探测而非版本分支：逐个试探字段，命中即用。
 * @param {unknown} descriptor - describe() 返回的单项。
 * @returns {string|undefined} 定位 id。
 */
function formsEntryId(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return undefined;
  const record = /** @type {Record<string, unknown>} */ (descriptor);
  for (const key of ["ns", "id", "key"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
/**
 * Forms 描述项的 volatile 投影：优先 `volatile`，回落 `value`，再回落 `user`。
 * 与 `settings/document-updated` 的比对口径一致：只在该投影变化时触发 onChange。
 * @param {unknown} descriptor - describe() 返回的单项。
 * @returns {unknown} 投影值。
 */
function projectFormsVolatile(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return descriptor;
  const record = /** @type {Record<string, unknown>} */ (descriptor);
  if ("volatile" in record) return record["volatile"];
  if ("value" in record) return record["value"];
  if ("user" in record) return record["user"];
  return descriptor;
}
/**
 * JSON 语义深比较（settings 值均为 JSON 兼容；不可序列化时回落引用比较）。
 * @param {unknown} a - 比较左值。
 * @param {unknown} b - 比较右值。
 * @returns {boolean} 是否深相等。
 */
function isDeepEqualForms(a, b) {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
/**
 * 快照一份 JSON 兼容值，避免 scope.get() 返回活引用导致比对基线被外部改写。
 * @param {unknown} value - 待快照值。
 * @returns {unknown} 快照。
 */
function snapshotFormsValue(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // structuredClone 不可用或遇到不可克隆值时走 JSON 回落。
  }
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}
/**
 * 经 describe() 定位本命名空间并取 volatile 投影；缺席/异常时回落到组合层 entry。
 * @param {unknown} settings - settings 服务。
 * @param {string} ns - 插件自有命名空间。
 * @param {unknown} entry - 组合层配置（回落值）。
 * @returns {unknown} 当前解析值。
 */
function readFormsValue(settings, ns, entry) {
  try {
    const describe = /** @type {{ describe?: unknown }} */ (settings).describe;
    if (typeof describe !== "function") return entry;
    const entries = /** @type {unknown} */ (
      /** @type {(opts?: unknown) => unknown} */ (describe).call(settings)
    );
    if (!Array.isArray(entries)) return entry;
    for (const item of entries) {
      if (formsEntryId(item) === ns) return projectFormsVolatile(item);
    }
    return entry;
  } catch {
    return entry;
  }
}
/**
 * 订阅 `settings/document-updated` 并按 ns 过滤。事件面经 sctx.on 优先、ctx.on
 * 兜底探测（均为 cordis 标准面，无版本分支）；事件名固定为官方声明的
 * `settings/document-updated`（@deepseek-ai/dsh-settings types 面）。
 * @param {unknown} ctx - 插件上下文（兜底订阅面）。
 * @param {unknown} sctx - 注入后的 scoped 上下文（优先订阅面）。
 * @param {string} ns - 插件自有命名空间。
 * @param {(evNs: unknown, revision: unknown) => void} listener - 过滤后的监听器。
 * @returns {() => void} 退订函数。
 */
function subscribeFormsDocumentUpdated(ctx, sctx, ns, listener) {
  const candidates = [];
  const sctxOn =
    sctx && typeof sctx === "object" && "on" in sctx
      ? /** @type {unknown} */ (/** @type {any} */ (sctx).on)
      : undefined;
  const ctxOn =
    ctx && typeof ctx === "object" && "on" in ctx
      ? /** @type {unknown} */ (/** @type {any} */ (ctx).on)
      : undefined;
  if (typeof sctxOn === "function") candidates.push(sctxOn);
  if (typeof ctxOn === "function" && ctxOn !== sctxOn) candidates.push(ctxOn);
  for (const on of candidates) {
    try {
      const disposer = /** @type {(event: string, cb: (...args: any[]) => void) => unknown} */ (
        on
      ).call(sctxOn === on ? sctx : ctx, "settings/document-updated", (...args) => {
        const evNs = args.length > 0 ? args[0] : undefined;
        if (String(evNs) !== String(ns)) return;
        listener(evNs, args.length > 1 ? args[1] : undefined);
      });
      if (typeof disposer === "function") return /** @type {() => void} */ (disposer);
      return () => {};
    } catch {
      continue;
    }
  }
  return () => {};
}
/**
 * 旧 Provider 路径（rc.1 运行时行为逐字保留）。
 * 删除条件：当 catalog 基线升到 rc.7 且线上宿主均无 register 能力（全员 Forms）
 * 时可删本分支，只留 Forms 路径；关联 issue #1011。删除时同步更新 .d.ts 窄面与
 * shared/ 版本矩阵测试的 Provider fixture。
 * @param {any} ctx - 插件上下文。
 * @param {any} sctx - 注入后的 scoped 上下文。
 * @param {any} settings - 含 register 的 settings 服务。
 * @param {string} ns - 命名空间。
 * @param {unknown} schema - schemastery schema。
 * @param {unknown} entry - 组合层配置。
 * @param {{ setSource(source: () => unknown): void; onChange(): void; validate?: unknown; onScope?: (scope: unknown, settings: unknown) => void }} hooks - 回调面。
 * @returns {void}
 */
function installViaProvider(ctx, sctx, settings, ns, schema, entry, hooks) {
  let scope;
  try {
    scope = settings.register(ns, schema, {
      base: entry,
      ...(hooks && hooks.validate !== undefined ? { validate: hooks.validate } : {}),
    });
  } catch (err) {
    // 重复注册等硬错误：报日志但不中断插件主体（宿主导入时并行注册同名 ns 会走到这）。
    warnLog(
      ctx,
      `${ns}: settings.register 失败 — ${String(err && err.message ? err.message : err)}`,
    );
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
}
/**
 * rc.7 Forms 路径（无 register 时）：entry id 定位 describe、update/replace/mutate
 * 写、document-updated 按 ns 过滤＋volatile 投影比对后 onChange。
 * 删除条件：当不再需要兼容 rc.1 Provider（线上宿主全员含 register 之前绝不删；
 * 反之若回退到只支持 Provider 则删本分支）；关联 issue #1011。删除时同步更新
 * .d.ts 窄面与 shared/ 版本矩阵测试的 Forms fixture。
 * @param {any} ctx - 插件上下文。
 * @param {any} sctx - 注入后的 scoped 上下文。
 * @param {any} settings - 无 register、有 describe 的 Forms settings 服务。
 * @param {string} ns - 命名空间。
 * @param {unknown} _schema - 占位：Forms 侧 schema 由宿主持有，本函数不注册
 *   （签名为三包零改而保留；validate 亦只在 Provider 路径透传，Forms 写校验由
 *   宿主承担）。
 * @param {unknown} entry - 组合层配置（describe 缺席时的回落值）。
 * @param {{ setSource(source: () => unknown): void; onChange(): void; validate?: unknown; onScope?: (scope: unknown, settings: unknown) => void }} hooks - 回调面。
 * @returns {void}
 */
function installViaForms(ctx, sctx, settings, ns, _schema, entry, hooks) {
  if (typeof settings.describe !== "function") {
    warnLog(ctx, `${ns}: settings 服务缺少 register 能力 — 设置命名空间未注册，卡片降级`);
    return;
  }
  const readCurrent = () => readFormsValue(settings, ns, entry);
  const writeVia = (method, payload, expectedRevision) => {
    const fn = settings[method];
    if (typeof fn !== "function") {
      return Promise.reject(new Error(`settings service unavailable: ${String(method)} 缺失`));
    }
    try {
      if (expectedRevision === undefined) {
        return fn.call(settings, ns, payload);
      }
      return fn.call(settings, ns, payload, expectedRevision);
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const scope = {
    get: () => readCurrent(),
    watch: (cb) => {
      let last = snapshotFormsValue(readCurrent());
      const disposer = subscribeFormsDocumentUpdated(ctx, sctx, ns, () => {
        let next;
        try {
          next = readCurrent();
        } catch {
          return;
        }
        if (isDeepEqualForms(next, last)) return;
        const prev = last;
        last = snapshotFormsValue(next);
        try {
          cb(next, prev);
        } catch {
          // 观察者异常不扩散（与 Provider 的 contained watcher 同语义）。
        }
      });
      return () => {
        try {
          disposer();
        } catch {
          // 退订幂等：重复调用不抛。
        }
      };
    },
    update: (patch, expectedRevision) => writeVia("update", patch, expectedRevision),
    replace: (section, expectedRevision) => writeVia("replace", section, expectedRevision),
    mutate: (ops, expectedRevision) => writeVia("mutate", ops, expectedRevision),
  };
  if (hooks && typeof hooks.onScope === "function") {
    hooks.onScope(scope, settings);
  }
  hooks.setSource(() => scope.get());
  let unwatchForms = () => {};
  if (typeof sctx?.effect === "function") {
    sctx.effect(() => () => {
      try {
        unwatchForms();
      } catch {
        // 退订幂等。
      }
      if (isUnloading(ctx)) return;
      hooks.setSource(() => entry);
      hooks.onChange();
    });
  }
  hooks.onChange();
  unwatchForms = scope.watch(() => {
    if (isUnloading(ctx)) return;
    hooks.onChange();
  });
}
/**
 * 安装「可选 settings 消费者的标准接线」：settings 服务存在时，把 `ns` 以组合层
 * `entry` 作为 `base` 注册进 settings 服务，并让 `hooks.setSource` 指向解析后的
 * owner scope（hooks.onScope 可选：scope 就绪后先交 scope）；仅服务消失
 * （scoped fiber 注销而插件仍存活）时回落到 entry；插件自身卸载时不回落
 * （disposer 短路，随 fiber 注销）。注册随 scoped fiber 生效——settings 服务
 * 从未挂载则本函数什么都不做（卡片降级，功能不受影响）。
 *
 * 双路径：有 register 走 Provider 路径（等值语义参考官方
 * `SettingsProvider.installSection`，@deepseek-ai/dsh-settings@0.1.5-rc.1，MIT；
 * 历史注释误写的 `installSettingsSection@0.1.0-rc.7` 并不存在），无 register 则走
 * Forms 路径（describe 定位＋update/replace/mutate 写＋document-updated 订阅）。
 * 这里不 import 该包，纯粹以服务面注入驱动，规避插件运行时解析不到该包导致的静默失败。
 *
 * @param {any} ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param {string} ns - 插件自有命名空间（小写 kebab，通常 `<plugin 名>`，须唯一）。
 * @param {unknown} schema - schemastery schema，解析该命名空间的值（通常为插件 Config）。
 * @param {unknown} entry - 组合层配置，作为命名空间的 `base` 层（Forms 路径下为回落值）。
 * @param {{ setSource(source: () => unknown): void; onChange(): void; validate?: unknown; onScope?: (scope: unknown, settings: unknown) => void }} hooks
 *   - setSource：把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。
 *     settings 服务存在时，卡片数据应经此 scope 读写。
 *   - onChange：来源切换或命名空间值变化时触发，插件据此刷新自身状态/落盘。
 *   - validate：可选的自定义校验（仅 Provider 路径透传给 settings.register；
 *     Forms 路径由宿主校验，传了也不生效但不报错）。
 *   - onScope：可选；scope 就绪后立即回调（先于 setSource），
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
    if (!settings || typeof settings !== "object") {
      warnLog(ctx, `${ns}: settings 服务缺少 register 能力 — 设置命名空间未注册，卡片降级`);
      return;
    }
    // 能力探测（禁版本号分支）：有 register 即旧 Provider 路径，否则 Forms 路径。
    if (typeof settings.register === "function") {
      installViaProvider(ctx, sctx, settings, ns, schema, entry, hooks);
      return;
    }
    installViaForms(ctx, sctx, settings, ns, schema, entry, hooks);
  });
}
