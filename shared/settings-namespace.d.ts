/**
 * 宿主端「设置命名空间」注册（单一事实源）。
 *
 * 背景与语义见 settings-namespace.js 顶部注释。要点：宿主 settings 服务按 `ns`
 * 定位描述项并取 `value`；写经 update/replace/mutate；热更新经
 * document-updated 订阅（内部直连，不对外暴露 watch 面）。
 * 本文件只收窄能力面（全 unknown 结构面，无官方包导入）。
 */

/** `installSettingsNamespace` 的 hooks 面。 */
export interface SettingsNamespaceHooks {
  /** 把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。 */
  setSource(source: () => unknown): void;
  /** 来源切换或命名空间值变化时触发，插件据此刷新/落盘。 */
  onChange(): void;
  /**
   * 可选；scope 就绪后立即回调（先于 setSource）。
   * 供存量配置迁移 / 写路径装配使用；settings 服务缺失时不触发。
   */
  onScope?(scope: unknown, service: unknown): void;
}

/** 描述项窄面（按 ns 定位，取 value）。 */
export interface SettingsFormsDescriptor {
  /** 命名空间键。 */
  ns?: unknown;
  /** 已解析值。 */
  value?: unknown;
  /** 原始 user 层。 */
  user?: unknown;
  /** 乐观并发修订号。 */
  revision?: unknown;
}

/** owner scope 窄面（describe 定位读＋写委托；订阅由接缝内部直连）。 */
export interface SettingsFormsScope {
  /** 当前解析值（describe value，缺席回落 entry）。 */
  get(): unknown;
  /** 委托 settings.update(ns, …)。 */
  update(patch: object, expectedRevision?: number): Promise<unknown>;
  /** 委托 settings.replace(ns, …)。 */
  replace(section: object, expectedRevision?: number): Promise<unknown>;
  /** 委托 settings.mutate(ns, …)；服务缺失时返回拒绝。 */
  mutate(ops: readonly unknown[], expectedRevision?: number): Promise<unknown>;
}

/** settings 服务窄面（describe/写）。 */
export interface SettingsFormsService {
  /** 按 entry id 定位描述项。 */
  describe(options?: { redactSecrets?: boolean }): SettingsFormsDescriptor[];
  /** 合并写。 */
  update?(ns: string, patch: object, expectedRevision?: number): Promise<unknown>;
  /** 整节写。 */
  replace?(ns: string, section: object, expectedRevision?: number): Promise<unknown>;
  /** 路径写（可选）。 */
  mutate?(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<unknown>;
}

/**
 * 日志兜底：logger 可能确实没有（极端降级），全部可选调用。
 * 单一事实源（#436）：notifier / lan-proxy 曾各复刻一份，现统一引用本导出。
 */
export declare function warnLog(ctx: unknown, message: string): void;

/**
 * 注册插件自有 settings 命名空间（服务面注入，无包依赖）。
 * 对外签名保持不变（调用方零改）。
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param ns - 插件自有命名空间（小写 kebab，须唯一）。
 * @param schema - 占位：schema 由宿主持有，本函数不注册。
 * @param entry - 组合层配置（describe 缺席时的回落值）。
 * @param hooks - source 收藏与变更通知。
 */
export declare function installSettingsNamespace(
  ctx: unknown,
  ns: string,
  schema: unknown,
  entry: unknown,
  hooks: SettingsNamespaceHooks,
): void;
