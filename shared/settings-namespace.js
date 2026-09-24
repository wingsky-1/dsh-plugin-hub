// dsh 插件家族共享层 — 宿主端「设置命名空间」注册（单一事实源）。
//
// 背景：
// DSH 0.1.7-rc.1 起，设置 → 插件 的 `settings.plugin.item` 槽由 `list(id)` 改为
// `keyed(key)`，且只在「宿主 serve 的 settings 命名空间 ∩ 卡片声明的 key」交集
// 非空时才渲染。想让插件的设置卡片在 0.1.7-rc.1 显示，宿主端必须把该插件的命名空间
// 注册进 settings 服务（`settings.describe()` 才能返回它）。
//
// 为什么不用官方 `@deepseek-ai/dsh-settings`：
// 该包由宿主 dsh 运行时提供，不在插件仓库依赖中；插件运行时沿自身 lib/ 路径
// 向上解析不到（MODULE_NOT_FOUND），动态 import 会静默失败、命名空间从未注册，
// 导致 0.1.7-rc.1 下设置卡片空白。因此这里改用「服务面注入」：`ctx.inject(["settings"],…)`
// 由宿主 cordis 上下文按名注入 settings 服务，零包依赖、与官方语义等值。
//
// 语义：读经 `settings.describe()` 按 `ns` 定位后取 `value`，写经
// `settings.update/replace/mutate(ns, …)`，热更新经 `settings/document-updated`
// 按 ns 过滤＋快照比对后触发 `onChange`。schema 由宿主侧持有，不经本函数注册
// （签名保留 schema 参数供调用方零改，本函数不使用）。
//
// #436 收敛：`onScope`（可选）只在 owning fiber ACTIVE 且 canonical namespace
// 被 Settings 服务描述后回调，供存量配置迁移与写路径装配；warnLog 为单一事实源
// （notifier / lan-proxy 曾各复刻一份，现统一引用本导出）。
//
// 约定：js + d.ts 双写（tsc rootDir 硬约束）；只 import Node 内置；零运行时依赖。
/**
 * 是否正处于插件自身 fiber 卸载中（区别于「仅丢失 settings 服务」）。
 * 官方判据：Cordis 4 的 FiberState 4/5（DISPOSED/UNLOADING）；字符串形态仅供
 * 极简测试宿主兼容。
 * @param {unknown} ctx - cordis 插件上下文。
 * @returns {boolean} 是否在卸载。
 */
function isUnloading(ctx) {
  const fiber =
    ctx && typeof ctx === "object" && "fiber" in ctx
      ? /** @type {{ state?: unknown }} */ (/** @type {any} */ (ctx).fiber)
      : undefined;
  const state = fiber && typeof fiber === "object" ? fiber.state : undefined;
  return (
    state === "unloading" ||
    state === "unloaded" ||
    state === "disposed" ||
    state === 4 ||
    state === 5
  );
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
 * 键序无关的稳定序列化（settings 值均为 JSON 兼容）：对象键排序后再序列化，
 * 使「同值异序」的描述项不误触发 onChange。不可序列化时回落 String()。
 * @param {unknown} value - 待序列化值。
 * @returns {string} 可比较的字符串。
 */
function stableStringifyForms(value) {
  try {
    return JSON.stringify(sortKeysForms(value));
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}
/**
 * 递归排序对象键（数组保持顺序）：stableStringifyForms 的预处理。
 * @param {unknown} value - 待排序值。
 * @returns {unknown} 排序后的结构。
 */
function sortKeysForms(value) {
  if (Array.isArray(value)) return value.map(sortKeysForms);
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    const next = {};
    for (const key of Object.keys(record).sort()) next[key] = sortKeysForms(record[key]);
    return next;
  }
  return value;
}
/**
 * JSON 语义深比较（键序无关）。
 * @param {unknown} a - 比较左值。
 * @param {unknown} b - 比较右值。
 * @returns {boolean} 是否深相等。
 */
function isDeepEqualForms(a, b) {
  if (Object.is(a, b)) return true;
  return stableStringifyForms(a) === stableStringifyForms(b);
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
 * 经 describe() 定位本命名空间的描述项；缺席、畸形或读取异常时返回 undefined。
 * @param {unknown} settings - settings 服务。
 * @param {string} ns - 插件自有命名空间。
 * @returns {Record<string, unknown> | undefined} 当前描述项。
 */
function findFormsDescriptor(settings, ns) {
  try {
    const describe = /** @type {{ describe?: unknown }} */ (settings).describe;
    if (typeof describe !== "function") return undefined;
    const entries = /** @type {unknown} */ (
      /** @type {(opts?: unknown) => unknown} */ (describe).call(settings)
    );
    if (!Array.isArray(entries)) return undefined;
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const record = /** @type {Record<string, unknown>} */ (item);
      if (record.ns === ns) return record;
    }
  } catch {
    // 读取失败时由调用方按“尚未服务”处理。
  }
  return undefined;
}

/**
 * 经 describe() 按 ns 定位本命名空间并取 value；缺席/异常时回落到组合层 entry。
 * @param {unknown} settings - settings 服务。
 * @param {string} ns - 插件自有命名空间。
 * @param {unknown} entry - 组合层配置（回落值）。
 * @returns {unknown} 当前解析值。
 */
function readFormsValue(settings, ns, entry) {
  const record = findFormsDescriptor(settings, ns);
  return record !== undefined && "value" in record ? record.value : entry;
}

/**
 * Settings 服务是否已经能按 canonical id 服务本命名空间。
 * @param {unknown} settings - settings 服务。
 * @param {string} ns - 插件自有命名空间。
 * @returns {boolean} 是否已服务。
 */
function isFormsNamespaceServed(settings, ns) {
  return findFormsDescriptor(settings, ns) !== undefined;
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
 * Forms 安装：describe 按 ns 定位读、update/replace/mutate 写、document-updated
 * 按 ns 过滤＋快照比对后 onChange。onScope 只在 owning fiber ACTIVE 且
 * canonical namespace 首次被 settings 服务描述后交付一次；订阅由本函数内部直连，
 * 不对外暴露 watch 面。
 * @param {any} ctx - 插件上下文。
 * @param {any} sctx - 注入后的 scoped 上下文。
 * @param {any} settings - 有 describe 的 Forms settings 服务。
 * @param {string} ns - 命名空间。
 * @param {unknown} entry - 组合层配置（describe 缺席时的回落值）。
 * @param {{ setSource(source: () => unknown): void; onChange(): void; onScope?: (scope: unknown, settings: unknown) => void }} hooks - 回调面。
 * @returns {void}
 */
function installViaForms(ctx, sctx, settings, ns, entry, hooks) {
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
    update: (patch, expectedRevision) => writeVia("update", patch, expectedRevision),
    replace: (section, expectedRevision) => writeVia("replace", section, expectedRevision),
    mutate: (ops, expectedRevision) => writeVia("mutate", ops, expectedRevision),
  };
  const ownerFiber = ctx && typeof ctx === "object" ? ctx.fiber : undefined;
  const ownerState = ownerFiber && typeof ownerFiber === "object" ? ownerFiber.state : undefined;
  let ownerReady =
    typeof ownerFiber?.await !== "function" ||
    ownerState === undefined ||
    ownerState === 2 ||
    ownerState === "active";
  let scopeDelivered = false;
  let deliveringScope = false;
  let disposed = false;
  const deliverScope = () => {
    if (
      scopeDelivered ||
      deliveringScope ||
      !ownerReady ||
      disposed ||
      typeof hooks?.onScope !== "function" ||
      isUnloading(ctx)
    ) {
      return;
    }
    deliveringScope = true;
    try {
      if (!isFormsNamespaceServed(settings, ns)) return;
      if (disposed || isUnloading(ctx)) return;
      scopeDelivered = true;
      hooks.onScope(scope, settings);
    } finally {
      deliveringScope = false;
    }
  };

  let unwatchForms = () => {};
  if (typeof sctx?.effect === "function") {
    sctx.effect(() => () => {
      disposed = true;
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

  let last = snapshotFormsValue(readCurrent());
  unwatchForms = subscribeFormsDocumentUpdated(ctx, sctx, ns, () => {
    if (isUnloading(ctx)) return;
    deliverScope();
    let next;
    try {
      next = readCurrent();
    } catch {
      return;
    }
    if (isDeepEqualForms(next, last)) return;
    last = snapshotFormsValue(next);
    try {
      hooks.onChange();
    } catch {
      // 观察者异常不扩散。
    }
  });

  // owning fiber 真正 ACTIVE 后主动探测一次；document-updated 只覆盖之后的重载/替换。
  // 就绪判据是 fiber.await()，不是微任务、定时器或时序猜测。
  if (typeof ownerFiber?.await === "function" && !ownerReady) {
    void ownerFiber.await().then(
      () => {
        const state = ownerFiber.state;
        if (
          disposed ||
          isUnloading(ctx) ||
          (state !== undefined && state !== 2 && state !== "active")
        ) {
          return;
        }
        ownerReady = true;
        deliverScope();
      },
      () => {},
    );
  }

  // 订阅先于首次交付，避免 settings 服务已注入但 canonical row 尚未 active 的启动窗口漏事件。
  deliverScope();
  hooks.setSource(() => scope.get());
  hooks.onChange();
}
/**
 * 安装「可选 settings 消费者的标准接线」：settings 服务存在时，把 `ns` 以组合层
 * `entry` 作为回落接进 settings 服务，并让 `hooks.setSource` 指向 describe 投影
 * （hooks.onScope 可选：owning fiber ACTIVE 且 canonical namespace 被服务后交 scope）；仅服务消失
 * （scoped fiber 注销而插件仍存活）时回落到 entry；插件自身卸载时不回落
 * （disposer 短路，随 fiber 注销）。接线随 scoped fiber 生效——settings 服务
 * 从未挂载则本函数什么都不做（卡片降级，功能不受影响）。
 *
 * 这里不 import 官方包，纯粹以服务面注入驱动，规避插件运行时解析不到该包导致的静默失败。
 *
 * @param {any} ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param {string} ns - 插件自有命名空间（小写 kebab，通常 `<plugin 名>`，须唯一）。
 * @param {unknown} schema - 占位：schema 由宿主持有，本函数不注册（签名为调用方零改而保留）。
 * @param {unknown} entry - 组合层配置（describe 缺席时的回落值）。
 * @param {{ setSource(source: () => unknown): void; onChange(): void; onScope?: (scope: unknown, settings: unknown) => void }} hooks
 *   - setSource：把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。
 *     settings 服务存在时，卡片数据应经此 scope 读写。
 *   - onChange：来源切换或命名空间值变化时触发，插件据此刷新自身状态/落盘。
 *   - onScope：可选；owning fiber ACTIVE 且 canonical namespace 被服务时回调一次。
 *     启动时已服务则仍先于 setSource；晚就绪时由 fiber.await 或 document-updated 唤醒。
 * @returns {void}
 */
export function installSettingsNamespace(ctx, ns, schema, entry, hooks) {
  void schema;
  // 防御：ctx.inject 不可用（极简宿主/测试桩）与 settings 服务缺失同属降级场景，
  // 静默跳过（卡片降级，不影响插件主体）。
  if (typeof ctx?.inject !== "function") {
    warnLog(ctx, `${ns}: ctx.inject 不可用 — 设置命名空间未注册，卡片降级`);
    return;
  }
  ctx.inject(["settings"], (sctx) => {
    const settings = sctx && sctx.settings;
    if (!settings || typeof settings !== "object" || typeof settings.describe !== "function") {
      warnLog(ctx, `${ns}: settings 服务缺席 — 设置命名空间未注册，卡片降级`);
      return;
    }
    installViaForms(ctx, sctx, settings, ns, entry, hooks);
  });
}
