/**
 * 宿主端「设置命名空间」注册（单一事实源）。
 *
 * 背景与语义见 settings-namespace.js 顶部注释。要点：DSH rc.7 起设置卡槽
 * `settings.plugin.item` 为 keyed，只有在「宿主 serve 的命名空间 ∩ 卡片 key」
 * 非空时渲染；为让卡片显示，宿主端需用此函数把命名空间接进 settings 服务。
 * 零包依赖，服务面注入，等值语义参考官方 `SettingsProvider.installSection`
 * （@deepseek-ai/dsh-settings@0.1.5-rc.1；历史注释误写的
 * `installSettingsSection@0.1.0-rc.7` 并不存在，特此纠正）。
 *
 * 双路径（能力探测，无版本号分支）：settings 有 register 走旧 Provider 路径，
 * 否则走 rc.7 Forms 路径（describe 定位＋update/replace/mutate 写＋
 * document-updated 订阅）。各分支删除条件见 .js 内注释，关联 issue #1011。
 * 本文件只收窄能力面（全 unknown 结构面，无 rc.7 独有导入，双基线可编译）。
 */

/** `installSettingsNamespace` 的 hooks 面（双路径共用，三包零改）。 */
export interface SettingsNamespaceHooks {
  /** 把插件对该命名空间的读取来源指向返回的 scope（`scope.get()`）。 */
  setSource(source: () => unknown): void;
  /** 来源切换或命名空间值变化时触发，插件据此刷新/落盘。 */
  onChange(): void;
  /**
   * 可选自定义校验，仅旧 Provider 路径透传给 settings.register；
   * Forms 路径由宿主校验，传了也不生效但不报错。
   */
  validate?: unknown;
  /**
   * 可选；scope 就绪后立即回调（先于 setSource）。
   * 供存量配置迁移 / 写路径装配使用；settings 服务缺失时不触发。
   */
  onScope?(scope: unknown, service: unknown): void;
}

/**
 * 旧 Provider 路径的 owner scope 窄面（register 返回值；rc.1 SettingsScope 子集）。
 * 只含本函数实际使用的 get/watch/update/replace。
 */
export interface SettingsProviderScope {
  /** 当前解析值。 */
  get(): unknown;
  /** 提交后异步串行回调，返回 disposer。 */
  watch(cb: (next: unknown, prev: unknown) => void): () => void;
  /** 增量 merge patch 进 user 层并持久化。 */
  update(patch: object, expectedRevision?: number): Promise<unknown>;
  /** 整节替换 user 层。 */
  replace(section: object, expectedRevision?: number): Promise<unknown>;
}

/** 旧 Provider 路径的 settings 服务窄面（仅 register/describe 探测位）。 */
export interface SettingsProviderService {
  /** 注册命名空间并返回 owner scope。 */
  register(
    ns: string,
    schema: unknown,
    options?: { base?: unknown; validate?: unknown },
  ): SettingsProviderScope;
  /** 列出已注册命名空间（迁移/读面复用）。 */
  describe?(options?: { redactSecrets?: boolean }): unknown[];
}

/**
 * rc.7 Forms 路径的描述项窄面（entry id 定位：ns \u007c\u007c id \u007c\u007c key；
 * volatile 投影：volatile ?? value ?? user）。
 */
export interface SettingsFormsDescriptor {
  /** rc.1 风格命名空间键。 */
  ns?: unknown;
  /** rc.7 Forms 风格 entry id。 */
  id?: unknown;
  /** 兼容别名。 */
  key?: unknown;
  /** 已解析值。 */
  value?: unknown;
  /** Forms 易变投影（优先于 value 比对）。 */
  volatile?: unknown;
  /** 原始 user 层。 */
  user?: unknown;
  /** 乐观并发修订号。 */
  revision?: unknown;
}

/** rc.7 Forms 路径的 owner scope 窄面（describe 定位＋写委托＋事件订阅合成）。 */
export interface SettingsFormsScope {
  /** 当前解析值（describe volatile 投影，缺席回落 entry）。 */
  get(): unknown;
  /** 按 ns 过滤 document-updated、volatile 比对后回调，返回 disposer。 */
  watch(cb: (next: unknown, prev: unknown) => void): () => void;
  /** 委托 settings.update(ns, …)。 */
  update(patch: object, expectedRevision?: number): Promise<unknown>;
  /** 委托 settings.replace(ns, …)。 */
  replace(section: object, expectedRevision?: number): Promise<unknown>;
  /** 委托 settings.mutate(ns, …)；服务缺失时返回拒绝。 */
  mutate(ops: readonly unknown[], expectedRevision?: number): Promise<unknown>;
}

/** rc.7 Forms 路径的 settings 服务窄面（无 register，有 describe/写/事件）。 */
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
 * 双路径：有 register 走 Provider（等值官方 installSection），否则走 Forms。
 * 对外签名保持不变（三包零改）；能力探测禁版本号分支。
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param ns - 插件自有命名空间（小写 kebab，须唯一）。
 * @param schema - schemastery schema，解析该命名空间的值（通常为插件 Config；Forms 路径由宿主持有）。
 * @param entry - 组合层配置，作为命名空间的 `base` 层（Forms 路径为回落值）。
 * @param hooks - source 收藏与变更通知。
 */
export declare function installSettingsNamespace(
  ctx: unknown,
  ns: string,
  schema: unknown,
  entry: unknown,
  hooks: SettingsNamespaceHooks,
): void;
