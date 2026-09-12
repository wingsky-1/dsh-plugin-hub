/**
 * dsh-notifier api 域 —— 种类块自己的形状。
 */
import type { RawSettingValue } from "../../deps.ts";

/**
 * POST /kinds 的请求体。
 *
 * 两个字段都声明成**原始值**而不是各自的最终类型：请求体是外部输入，`as` 断言不校验
 * 任何东西，声明成 `string` / `boolean` 只会让「它已经是那个形状」这个假象一路传下去。
 * 形状把关因此落在读到它之后的第一个分支上。
 */
export interface KindPatchRequest {
  /** 动态种类 id。 */
  kind?: RawSettingValue;
  /** 确认（`true`）/ 撤销（`false`）。 */
  confirmed?: RawSettingValue;
}
