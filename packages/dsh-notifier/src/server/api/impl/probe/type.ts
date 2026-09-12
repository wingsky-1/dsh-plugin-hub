/** api 域自检块自己的形状。 */
import type { RawSettingValue } from "../../deps.ts";

/** POST /test 的请求体。body 本身是**可选**的（缺席表达「全频道测试」）；字段声明成原始值而不是 `string`，因为读它
 * 用的 `as` 断言不校验任何东西——声明成终态只会让形状检查被跳过。 */
export interface TestRequest {
  /** 只测这一个频道实例；省略 = 全频道测试。 */
  channelId?: RawSettingValue;
}
