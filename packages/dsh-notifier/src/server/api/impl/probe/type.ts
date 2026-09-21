/** api 域自检块自己的形状。 */
import type { RawSettingValue } from "../../deps.ts";

/** POST /test 的请求体。body 本身是**可选**的（缺席表达「全频道测试」）；字段声明成原始值而不是 `string`，因为读它
 * 用的 `as` 断言不校验任何东西——声明成终态只会让形状检查被跳过。
 *
 * `draft` 出现即草稿测试（dry-run，提案 PR-B）：只认其中的 `channels`（与 stored.channels 同形元素，
 * 须含目标频道的完整条目），顶层其它键与 `revision` 一律忽略；此时 `channelId` 必填（只测单个频道）。
 * 无 `draft` 时走老路（已保存配置的广播 / onlyChannel），语义一个字不改。 */
export interface TestRequest {
  /** 只测这一个频道实例；省略 = 全频道测试（dry-run 下必填）。 */
  channelId?: RawSettingValue;
  /** 草稿测试的频道草稿；出现即 dry-run，不落盘。 */
  draft?: RawSettingValue;
}
