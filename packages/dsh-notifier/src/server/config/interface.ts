/**
 * config 域对外契约：通知设置的**唯一存取点**（读与写，归一化、校验、掩码往返、原子落盘都在域内）。本域不认识
 * 通知业务——免打扰是否命中、某频道是否参与投递属于裁决层与投递层，塞进来就把「用户说什么」变成「系统认为该怎样」。
 */
import type { ConfigDeps } from "./deps.ts";
import type { NotifyConfig, SettingsPatch } from "./impl/model/type.ts";
import { configStore } from "./impl/service/index.ts";
import type { SettingsView, WriteResult } from "./impl/service/type.ts";

// ---------------------------------------------------------------- 入参类型
// 只多这一个出口名字：多一个出口就是多一份要同步的事实源。

export type { RawSettingValue, SettingsPatch, StoredSettings } from "./impl/model/type.ts";

/**
 * 草稿测试（dry-run）的输入闸门与内存归一化：api 域经这两样把 draft 变成可投递的
 * 生效条目，全程不碰写面（不掩码落盘、不推进 revision）。纯函数 + 只读，还原要的原值
 * 由调用方显式传入，不在域内另读一份。
 */
export { normalizeConfig } from "./impl/input/index.ts";
export { resolveDraftChannels } from "./impl/draft/index.ts";
export type { ResolvedDraft } from "./impl/draft/index.ts";

// ---------------------------------------------------------------- 装配

/** 装配设置存取（组合根在 `apply` 期调用一次）。装配返回时读面已可用：文件在装配期同步读完，不存在即回落默认设置。
 * @param deps 组合层入口层与失败出口。 */
export function installConfig(deps: ConfigDeps): void {
  configStore.install(deps);
}

/** 卸载设置存取，与 `installConfig` 配对：放开装配入参、丢掉用户层快照，此后读面回落默认设置。重复调用无害。 */
export function releaseConfig(): void {
  configStore.release();
}

// ---------------------------------------------------------------- 读面

/** 读当前生效设置：归一化在域内完成，调用方拿到的一定是可直接用的完整形态。**含明文凭据**，只服务域内投递、不外发。 */
export function readConfig(): NotifyConfig {
  return configStore.current();
}

/** 读设置页视图：掩码后的用户层与生效值 + 修订号 + 可写性。四个事实同一刻取齐——分开取会让界面拿着旧修订号提交。 */
export function readSettingsView(): SettingsView {
  return configStore.view();
}

// ---------------------------------------------------------------- 写面

/** 写用户设置：掩码还原 + 校验 + 合并 + 落盘一次完成；提交掩码占位即表达「保留原值」，契约不认识的键**原样保留**。
 * @param expectedRevision 期望的用户层修订号（乐观并发；缺省 = 不做版本校验）。 */
export async function writeConfig(
  patch: SettingsPatch,
  expectedRevision?: number,
): Promise<WriteResult> {
  return configStore.write(patch, expectedRevision);
}
