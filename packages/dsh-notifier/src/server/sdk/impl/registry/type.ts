/**
 * dsh-notifier sdk 域 —— 动态种类注册表自己的形状。
 *
 * 两个形状都只对注册表成立，另一块（服务面）用不上，因此留在本块而不是上移成公共语言。
 */
import type { ExternalKind } from "../../deps.ts";

/**
 * 动态种类注册（外部调用方提交的形状）。
 *
 * 只有 id 与展示名：注册是「我这里有一种通知」的声明，不是投递配置。想让某种通知发到
 * 哪儿，是用户在自己设置页上决定的事——插件能自己指定路由，就等于能绕过用户同意。
 *
 * id 的类型是**命名空间限定的模板字面量**而不是宽 `string`：冒号两侧缺一不可，而这两个
 * 位置恰好是「谁注册的」与「它叫什么的」的分界。写成 `string`，一次拼错的表现是注册表
 * 里多一个查不到归属的键，而它在设置页上与正常条目长得一模一样。
 */
export interface KindRegistration {
  /** 全局唯一 id：`<命名空间>:<id>`，命名空间取调用方包名的短形式。 */
  id: ExternalKind;
  /** 设置页展示名（展示层文本，不是推送内容）。 */
  label: string;
}

/** 清单项：注册表的条目与确认态合并后的形态（设置页据此渲染「允许 / 拒绝」）。 */
export interface RegisteredKind {
  id: string;
  label: string;
  /** 用户已经放行；未放行的种类在裁决层被压制（`unlisted`）。 */
  confirmed: boolean;
}
