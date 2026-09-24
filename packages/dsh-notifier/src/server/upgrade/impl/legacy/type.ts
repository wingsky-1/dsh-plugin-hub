/** upgrade 域存量配置的形状：**旧版本长什么样**是升级的知识，业务域只该认识当前格式。 */
import type { SettingsDescribeOptions, SettingsDescriptor } from "@deepseek-ai/dsh-settings";
import type { RawSettingValue } from "../../deps.ts";

/** 旧版本留下的设置（键值都不受契约约束）：可能是用户手写的、更高版本留下的，或当年就没通过校验的脏值
 * ——割接只搬运它们，合法性判断仍旧只属于 config 域的归一化。 */
export type LegacyStoredSettings = { readonly [key: string]: RawSettingValue };

/** settings 服务给本域的低优先级读面；正式历史来源由 upgrade 域直接读取 DSH_HOME 双文件。 */
export interface LegacySettingsFace {
  /** 已注册命名空间的描述（含 user 层）；读存量一律脱敏。 */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
}
