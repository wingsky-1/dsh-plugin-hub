/** upgrade 域存量配置的形状：**旧版本长什么样**是升级的知识，业务域只该认识当前格式。 */
import type { RawSettingValue } from "../../deps.ts";

/** 旧版本留下的设置（键值都不受契约约束）：可能是用户手写的、更高版本留下的，或当年就没通过校验的脏值——要过
 * 一遍 config 域的写入口才谈得上「可用的设置」。 */
export type LegacyStoredSettings = { readonly [key: string]: RawSettingValue };

/** settings 服务的一条命名空间记录；只取本域要用的两项。 */
export interface LegacySettingsEntry {
  ns: string;
  user?: RawSettingValue;
}

/** settings 服务给本域的最小读面：只声明 `describe`，不引官方包的类型面——后者要为一个方法付一次 peer 依赖，
 * 而它在插件里运行时解析不到。 */
export interface LegacySettingsFace {
  describe(options: { redactSecrets: boolean }): ReadonlyArray<LegacySettingsEntry>;
}

/** 宿主 settings 的接入面：它是「就绪时回调」而不是「现在给我」——那个服务可能晚到或根本不来，而存量配置的读取
 * 只能发生在那之后，两种情况都不该拦住插件启动。 */
export interface LegacySettingsPort {
  /** 服务就绪（或已就绪）时回调一次；始终不来则永不回调。@returns 退订器。 */
  whenReady(handler: (settings: LegacySettingsFace) => void): () => void;
}
