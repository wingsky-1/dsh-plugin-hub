/**
 * dsh-notifier upgrade 域 —— 存量配置的形状。
 *
 * 归本域而不是 config 域：**旧版本长什么样**是升级的知识，而业务域只该认识当前格式。
 * 把「0.2.3 的配置住在官方 settings 里」这类事实放进业务域，等于让它为每一次历史包袱
 * 永久背一份依赖。
 *
 * 本块只回答一个问题：新配置文件还空着时，用户的设置在旧版本里长什么样。它不写盘、
 * 不校验、不做合并——落盘与校验是 config 域写面的事。
 */
import type { RawSettingValue } from "../../deps.ts";

/**
 * 旧版本留下的设置（键值都不受契约约束）。
 *
 * 键是旧的，值也没被校验过：可能是用户手写的，可能是更高版本留下的，也可能是当年就没
 * 通过校验的脏值。它们要过一遍 config 域的写入口才谈得上「可用的设置」。
 */
export type LegacyStoredSettings = { readonly [key: string]: RawSettingValue };

/** settings 服务的一条命名空间记录；只取本域要用的两项。 */
export interface LegacySettingsEntry {
  ns: string;
  user?: RawSettingValue;
}

/**
 * settings 服务给本域的最小读面。
 *
 * 只声明 `describe`：本域要的只是「那个命名空间的 user 层是什么」。声明成窄接口而不是
 * 引官方包的类型面——后者要为一个方法付一次 peer 依赖，而它在插件里运行时解析不到。
 */
export interface LegacySettingsFace {
  describe(options: { redactSecrets: boolean }): ReadonlyArray<LegacySettingsEntry>;
}

/**
 * 宿主 settings 的接入面。
 *
 * 它是「就绪时回调」而不是「现在给我」：那个服务可能晚于本插件装配，宿主也可以根本
 * 不装它——而存量配置的读取只能发生在那之后，且这两种情况都不该拦住插件启动。
 */
export interface LegacySettingsPort {
  /** 服务就绪（或已就绪）时回调一次；始终不来则永不回调。@returns 退订器。 */
  whenReady(handler: (settings: LegacySettingsFace) => void): () => void;
}
