/** upgrade 域存量配置的形状：**旧版本长什么样**是升级的知识，业务域只该认识当前格式。 */
import type { SettingsDescribeOptions, SettingsDescriptor } from "@deepseek-ai/dsh-settings";
import type { RawSettingValue } from "../../deps.ts";

/** 旧版本留下的设置（键值都不受契约约束）：可能是用户手写的、更高版本留下的，或当年就没通过校验的脏值
 * ——割接只搬运它们，合法性判断仍旧只属于 config 域的归一化。 */
export type LegacyStoredSettings = { readonly [key: string]: RawSettingValue };

/** settings 服务给本域的最小读面：`describe` 是非文件 provider 的低优先级兜底；`documentPath` 只为保持
 * 宿主 provider 的结构兼容而保留，legacy reader 故意不读取它——它指向当前 profile 文档，不是历史 settings map。
 */
export interface LegacySettingsFace {
  /** 宿主当前文档路径；保留结构兼容，但 legacy reader 不把它作为历史 map。 */
  readonly documentPath: string;
  /** 已注册命名空间的描述（含 user 层）；读存量一律脱敏。 */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
}
