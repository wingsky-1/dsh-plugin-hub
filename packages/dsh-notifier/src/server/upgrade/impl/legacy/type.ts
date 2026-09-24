/** upgrade 域存量配置的形状：**旧版本长什么样**是升级的知识，业务域只该认识当前格式。 */
import type { SettingsDescribeOptions, SettingsDescriptor } from "@deepseek-ai/dsh-settings";
import type { RawSettingValue } from "../../deps.ts";

/** 旧版本留下的设置（键值都不受契约约束）：可能是用户手写的、更高版本留下的，或当年就没通过校验的脏值
 * ——割接只搬运它们，合法性判断仍旧只属于 config 域的归一化。 */
export type LegacyStoredSettings = { readonly [key: string]: RawSettingValue };

/** settings 服务给本域的最小读面：定位宿主文档的 `documentPath` + 兜底的 `describe`——本域不认识它的其余能力，
 * 也就不引它整个面，所以是自建窄面而不是把服务类整个引进来。
 *
 * `documentPath` 按官方 SettingsForms 实形收紧为非空 `string`（宿主自报当前文档路径）。
 *
 * 为什么不能只要 `describe`：它只列**当前已注册**的命名空间，而本插件自 0.2.4 起不再注册 settings 命名空间
 * ——升级期那份存量在它眼里根本不存在，割接会读空（实测：`settings.yaml` 里那一节原样躺着，配置文件一个字节没写）。 */
export interface LegacySettingsFace {
  /** 宿主文档路径（宿主自报当前文档）。 */
  readonly documentPath: string;
  /** 已注册命名空间的描述（含 user 层）；读存量一律脱敏。 */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
}
