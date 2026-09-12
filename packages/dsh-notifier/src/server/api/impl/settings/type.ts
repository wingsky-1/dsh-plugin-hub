/**
 * dsh-notifier api 域 —— 设置块自己的形状。
 */
import type { RawSettingValue } from "../../deps.ts";

/**
 * PUT /config 的请求体。
 *
 * 两个字段都声明成**原始值**而不是它们各自的最终类型：请求体是外部输入，`as` 断言
 * 不校验任何东西，声明成 `SettingsPatch` 只会让「它已经是那个形状」这个假象一路传
 * 下去——而它可能是个字符串。形状把关因此落在读到它之后的第一个分支上。
 */
export interface PatchRequest {
  /** 设置补丁：键名与键值都不受信，可能带契约不认识的键。 */
  patch?: RawSettingValue;
  /** 提交所基于的修订号；省略 = 不做乐观并发校验。 */
  expectedRevision?: RawSettingValue;
}
