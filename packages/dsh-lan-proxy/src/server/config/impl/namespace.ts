/**
 * dsh-lan-proxy — 官方 settings 条目接线（薄包装）。
 *
 * 只做三件事：注册条目、把 owner scope 交给调用方、依次透传 hooks；实现统一
 * 转发 shared/installSettingsNamespace（单一事实源）。
 *
 * 为什么不用官方 @deepseek-ai/dsh-settings 包：插件运行时沿自身 lib/ 向上解析不到
 * 该包（MODULE_NOT_FOUND），动态 import 会静默失败。
 *
 * 读面以 describe 的 descriptor 为准（user/revision），写面走 owner scope.update/replace，
 * 热更新订阅 settings/document-updated（见 apply）。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  installSettingsNamespace,
  type HostSettingsDescriptor,
  type HostSettingsService,
} from "../../../../../../shared/settings-namespace.js";
import { LAN_PROXY_IDENTITY } from "../../../shared/interface.ts";
import { Config } from "./model.ts";
import type { LanProxyConfig } from "./model.ts";

export { warnLog } from "../../../../../../shared/settings-namespace.js";

/** 本插件在官方 settings 服务中的 canonical 条目 id。 */
export const SETTINGS_NS = LAN_PROXY_IDENTITY.settingsNamespace;

/**
 * describe 返回的条目 descriptor 最小面。
 *
 * 字段类型引用 shared 的官方锚 `HostSettingsDescriptor`（#1164）：上游改字段类型
 * 即在本包 tsc 期判红，而不是运行时读到 undefined 才暴露。保留「只声明本包真读的
 * 三个字段」这一窄面（描述项还有很多字段，本包不使用）。
 */
export interface SettingsDescriptorLike {
  /** 条目 id。 */
  ns: HostSettingsDescriptor["ns"];
  /** 原始 user 节（存在即用户设过值）。 */
  user?: HostSettingsDescriptor["user"];
  /** 乐观并发版本。 */
  revision: HostSettingsDescriptor["revision"];
}

/**
 * owner scope 最小类型面（以 describe 投影读、以 update/replace 写）。
 *
 * 写面签名从官方 `SettingsForms` 派生：官方方法首参是命名空间 id，owner scope 的
 * 命名空间由闭包绑定，故只取第 2/3 个参数与返回类型（#1164）。上游改写面参数或
 * 返回类型时本包 tsc 判红。
 */
export interface OwnerScopeLike {
  /** 当前解析值（schema defaults → base → user 层）。 */
  get(): LanProxyConfig;
  /** 增量 merge patch 进 user 层并持久化。 */
  update(
    patch: Parameters<HostSettingsService["update"]>[1],
    expectedRevision?: Parameters<HostSettingsService["update"]>[2],
  ): ReturnType<HostSettingsService["update"]>;
  /** 整节替换 user 层，缺省键回落 base/schema 默认。 */
  replace(
    section: Parameters<HostSettingsService["replace"]>[1],
    expectedRevision?: Parameters<HostSettingsService["replace"]>[2],
  ): ReturnType<HostSettingsService["replace"]>;
}

/**
 * settings 服务最小类型面。
 *
 * `describe` 取官方 `SettingsForms` 的签名；两个写面保持可选（宿主/测试桩可能
 * 只暴露读面，缺方法时本包按「settings service unavailable」拒绝写），#1164。
 */
export interface SettingsServiceLike extends Pick<HostSettingsService, "describe"> {
  /** 服务级增量写。 */
  update?: HostSettingsService["update"];
  /** 服务级整节替换。 */
  replace?: HostSettingsService["replace"];
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
