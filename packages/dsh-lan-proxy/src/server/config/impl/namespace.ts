/**
 * dsh-lan-proxy — 官方 settings 条目接线（薄包装）。
 *
 * 只做三件事：注册条目、把 owner scope 交给调用方、依次透传 hooks；实现统一
 * 转发 shared/installSettingsNamespace（单一事实源）。
 *
 * 为什么不用官方 @deepseek-ai/dsh-settings 包：插件运行时沿自身 lib/ 向上解析不到
 * 该包（MODULE_NOT_FOUND），动态 import 会静默失败。
 *
 * dsh 0.1.7-rc.1 接缝（冻结计划 v1.1）：命名空间即 profile 条目 id（见下
 * SETTINGS_NS），读面以 describe 的 descriptor 为准（user/revision），写面走
 * owner scope.update/replace，热更新订阅 settings/document-updated（见 apply）。
 * 本文件只做薄包装对齐：类型面重定义为 Descriptor 面，签名与转发目标保持不变
 * （shared 接缝由另一 agent 重写，本包消费其不变签名）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { installSettingsNamespace } from "../../../../../../shared/settings-namespace.js";
import { Config } from "./model.ts";
import type { LanProxyConfig } from "./model.ts";

export { warnLog } from "../../../../../../shared/settings-namespace.js";

/**
 * 本插件在官方 settings 服务中的条目 id。
 * dsh 0.1.7-rc.1 起命名空间即 profile 条目 id，与 cordis.patch.yml 挂载行 id
 * 一致（ui-dsh-lan-proxy）；客户端 settings.plugin.item 的 key 与本常量配对
 * （见 src/client/index.ts，双写锁定，单测锁定）。
 */
export const SETTINGS_NS = "ui-dsh-lan-proxy";

/** describe 返回的条目 descriptor 最小面（rc.5/rc.7 双基线共有子集）。 */
export interface SettingsDescriptorLike {
  /** 条目 id（rc.7 即 profile 条目 id；rc.5 即命名空间名）。 */
  ns: string;
  /** 原始 user 节（存在即用户设过值）。 */
  user?: unknown;
  /** 乐观并发版本。 */
  revision: number;
}

/**
 * owner scope 最小类型面（Descriptor 面：以 describe 投影读、以 update/replace 写）。
 * get/update/replace 为双基线共有；watch 仅 rc.5 存在（rc.7 改 document-updated
 * 事件），保留为可选以保双基线可编译——删除条件：不再支持 rc.5 基线时删去本字段
 * （调用方不得新增对 watch 的依赖，热更新一律走 document-updated）。
 */
export interface OwnerScopeLike {
  /** 当前解析值（schema defaults → base → user 层）。 */
  get(): LanProxyConfig;
  /** 增量 merge patch 进 user 层并持久化。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
  /** 整节替换 user 层，缺省键回落 base/schema 默认。 */
  replace(section: object, expectedRevision?: number): Promise<void>;
  /**
   * 提交后异步串行回调，返回 disposer（rc.5 遗留面）。
   * rc.7 无此方法（改 document-updated 订阅）；可选仅为双基线 tsc 兼容。
   */
  watch?(cb: (next: LanProxyConfig, prev: LanProxyConfig) => void): () => void;
}

/**
 * settings 服务最小类型面（Descriptor 面）。
 * describe 为双基线共有读面；register 仅 rc.5（rc.7 由 profile 条目隐式注册），
 * update/replace(ns, …) 为 rc.7 服务级写面（rc.5 写走 scope）。
 * 三者皆可选——运行时以能力检测分支（非版本字符串分支，业务域无版本分支）；
 * 删除条件：不再支持 rc.5 基线时将 update/replace 改为必填并删去 register。
 */
export interface SettingsServiceLike {
  /** rc.5 注册面（rc.7 不存在）。 */
  register?(ns: string, schema: unknown, options?: { base?: unknown }): OwnerScopeLike;
  /** 条目描述（双基线共有；wire 面必传 redactSecrets）。 */
  describe(options?: { redactSecrets?: boolean }): Array<SettingsDescriptorLike>;
  /** rc.7 服务级增量写（rc.5 不存在，写走 scope）。 */
  update?(ns: string, patch: object, expectedRevision?: number): Promise<void>;
  /** rc.7 服务级整节替换（rc.5 不存在，写走 scope）。 */
  replace?(ns: string, section: object, expectedRevision?: number): Promise<void>;
}

/** installLanProxySettings 的 hooks 面（含 onScope：attach 后交出 owner scope）。 */
export interface LanProxySettingsHooks {
  /** 把插件对该条目的读取来源指向返回的 scope（见实现：scope.get）。 */
  setSource(source: () => LanProxyConfig): void;
  /** 来源切换或条目值变化时触发，插件据此刷新/重建转发器。 */
  onChange(): void;
  /** scope attach 后回调（迁移在此执行）；服务缺失时不触发。 */
  onScope(scope: OwnerScopeLike, service: SettingsServiceLike): void;
}

/**
 * 注册插件自有 settings 条目并把 owner scope 交给调用方。
 * 薄包装（#436）：转发 shared/installSettingsNamespace——setSource / onChange /
 * onScope 依次透传，降级与卸载回落语义统一由 shared 承担。对外签名与 #436 前
 * 保持一致：ctx / entry（组合层配置，作为条目的 base 层）/ hooks。
 *
 * @param ctx - 插件宿主端 apply 收到的 cordis 上下文。
 * @param entry - 组合层配置，作为条目的 base 层。
 * @param hooks - source 收藏、变更通知与 scope 移交。
 */
export function installLanProxySettings(
  ctx: Context,
  entry: LanProxyConfig,
  hooks: LanProxySettingsHooks,
): void {
  installSettingsNamespace(ctx, SETTINGS_NS, Config, entry, {
    setSource: hooks.setSource,
    onChange: hooks.onChange,
    onScope: hooks.onScope,
  });
}
