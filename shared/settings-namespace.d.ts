/**
 * 宿主端「设置命名空间」注册（单一事实源）。
 *
 * 背景与语义见 settings-namespace.js 顶部注释。要点：DSH rc.7 起设置卡槽
 * `settings.plugin.item` 为 keyed，只有在「宿主 serve 的命名空间 ∩ 卡片 key」
 * 非空时渲染；为让卡片显示，宿主端需用此函数把命名空间注册进 settings 服务。
 * 零包依赖，服务面注入，等值复刻官方 `installSettingsSection`（dsh-settings）。
 */

/** `installSettingsNamespace` 的 hooks 面。 */
export interface SettingsNamespaceHooks {
  /** 把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。 */
  setSource(source: () => unknown): void;
  /** 来源切换或命名空间值变化时触发，插件据此刷新/落盘。 */
  onChange(): void;
  /** 可选自定义校验，透传给 settings.register。 */
  validate?: unknown;
  /**
   * 可选；register 返回 owner scope 后立即回调（先于 setSource）。
   * 供存量配置迁移 / 写路径装配使用；settings 服务缺失时不触发。
   */
  onScope?(scope: unknown, service: unknown): void;
}

/**
 * 日志兜底：logger 可能确实没有（极端降级），全部可选调用。
 * 单一事实源（#436）：notifier / lan-proxy 曾各复刻一份，现统一引用本导出。
 */
export declare function warnLog(ctx: unknown, message: string): void;

/**
 * 注册插件自有 settings 命名空间（服务面注入，无包依赖）。
 * 等值语义参考官方 `installSettingsSection`（@deepseek-ai/dsh-settings@0.1.0-rc.7）。
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param ns - 插件自有命名空间（小写 kebab，须唯一）。
 * @param schema - schemastery schema，解析该命名空间的值（通常为插件 Config）。
 * @param entry - 组合层配置，作为命名空间的 `base` 层。
 * @param hooks - source 收藏与变更通知。
 */
export declare function installSettingsNamespace(
  ctx: unknown,
  ns: string,
  schema: unknown,
  entry: unknown,
  hooks: SettingsNamespaceHooks,
): void;
