/** upgrade 域存量配置的形状：**旧版本长什么样**是升级的知识，业务域只该认识当前格式。 */
import type { SettingsDescribeOptions, SettingsDescriptor } from "@deepseek-ai/dsh-settings";
import type { RawSettingValue } from "../../deps.ts";

/** 旧版本留下的设置（键值都不受契约约束）：可能是用户手写的、更高版本留下的，或当年就没通过校验的脏值
 * ——割接只搬运它们，合法性判断仍旧只属于 config 域的归一化。 */
export type LegacyStoredSettings = { readonly [key: string]: RawSettingValue };

/** settings 服务给本域的最小读面：定位宿主文档的 `documentPath` + 兜底的 `describe`——本域不认识它的其余能力，
 * 也就不引它整个面，所以是自建窄面而不是把服务类整个引进来。
 *
 * 为什么不能 `Pick<SettingsProvider, …>`：0.1.7-rc.1 起那个类改名 `SettingsForms`，旧名不再导出——
 * Pick 写法在新基线下连名字都对不上。也不能 `Pick<SettingsForms, …>`：它把 `documentPath` 收窄成了
 * 非空 `string`，旧基线的非文件型 provider（`string | undefined`）反而接不上。自建可空面双基线都接得住：
 * 新基线的 `string` 可赋给 `string | undefined`，旧基线本来就是可空——读侧的缺省分支（拿不到路径就按
 * DSH home 下的缺省名找）两种基线都走得到。业务域内无版本分支。
 *
 * 为什么不能只要 `describe`：它只列**当前已注册**的命名空间，而本插件自 0.2.4 起不再注册 settings 命名空间
 * ——升级期那份存量在它眼里根本不存在，割接会读空（实测：`settings.yaml` 里那一节原样躺着，配置文件一个字节没写）。 */
export interface LegacySettingsFace {
  /** 宿主文档路径：文件型 provider 自报，非文件型没有本地文档所以可空。 */
  readonly documentPath: string | undefined;
  /** 已注册命名空间的描述（含 user 层）；读存量一律脱敏。 */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[];
}
