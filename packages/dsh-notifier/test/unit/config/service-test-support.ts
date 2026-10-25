/**
 * dsh-notifier config service 测试的专属共享事实。
 *
 * 本模块不持有 home、产品单例、定时器或测试生命周期。每个入口仍须先建立自己的
 * `DSH_HOME`，再动态导入产品门面；这里只导出无状态夹具与产品门面的类型。
 */
import type {
  NotifyConfig,
  RawSettingValue,
  SettingInvalid,
  SettingsPatch,
} from "../../../src/server/config/impl/model/type.ts";
import type { SettingsView, WriteResult } from "../../../src/server/config/impl/service/type.ts";

export type ServiceApi = {
  readonly installConfig: (deps: { readonly logger: { warn: (message: string) => void } }) => void;
  readonly releaseConfig: () => void;
  readonly readConfig: () => NotifyConfig;
  readonly readSettingsView: () => SettingsView;
  readonly writeConfig: (patch: SettingsPatch, expectedRevision?: number) => Promise<WriteResult>;
};

/** 掩码占位：设置页把用户没改动的凭据原样提交回来，两侧字面量必须一致。 */
export const MASK = "********";

/** 合法 bark 频道：写面要求 id / baseUrl / deviceKey 非空且 level 合法。 */
export const BARK = {
  type: "bark",
  id: "bark:phone",
  name: "A",
  baseUrl: "https://api.day.app",
  deviceKey: "key-1",
  level: "active",
};

/** 两条内置条目：显式提交 `channels` 时必须带着它们（内置渠道不能删除）。 */
export const BUILTINS = [
  { type: "browser", id: "browser", enabled: true, popup: true, sound: false, whenVisible: false },
  { type: "system", id: "system", enabled: false, popup: false, sound: false },
] as const;

/** 磁盘上的一条 webhook：url + auth，credential 键按用例再加。 */
export const HOOK = {
  type: "webhook",
  id: "webhook:hook",
  url: "https://example.test/hook",
  auth: "none",
  enabled: true,
} as const;

/** 取「非法」失败的载荷；不是 invalid（或竟然成功）即当场失败。 */
export function invalidOf(result: WriteResult): SettingInvalid {
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`期望 invalid，实际 ${JSON.stringify(result)}`);
  }
  return result.error;
}

/** 按类型取条目：内置两条恒在最前，按下标取到的就不再是出站频道。 */
export function channelOfType(
  list: Array<Record<string, RawSettingValue>>,
  type: string,
): Record<string, RawSettingValue> {
  const channel = list.find((item) => item.type === type);
  if (channel === undefined) throw new Error(`期望配置里有一个 ${type} 频道`);
  return channel;
}

/** 频道数组里按 id 取那一条（两条同类型时不能按类型取——那只会拿到第一条）。 */
export function channelById(
  list: readonly RawSettingValue[],
  id: string,
): Record<string, RawSettingValue> {
  const found = (list as ReadonlyArray<Record<string, RawSettingValue>>).find(
    (item) => item.id === id,
  );
  if (found === undefined) throw new Error(`数组里没有 id=${id} 的频道`);
  return found;
}

/** 取一份配置里的频道数组；存储层形状不受契约约束，故按原始值看。 */
export function channelsOf(config: Partial<NotifyConfig>): Array<Record<string, RawSettingValue>> {
  return (config.channels ?? []) as unknown as Array<Record<string, RawSettingValue>>;
}

/** 造一份磁盘：给 channels 的每条补上两条内置条目（真实文件里也有）。 */
export function diskOf(...channels: ReadonlyArray<Record<string, RawSettingValue>>): string {
  return JSON.stringify({ channels: [...BUILTINS, ...channels] });
}
