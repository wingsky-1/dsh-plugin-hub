/**
 * dsh-notifier config 域 —— 装配面与读写结果（本域形状）。
 */
import type { NotifyConfig, SettingInvalid } from "../model/type.ts";

/**
 * 设置页视图。
 *
 * 四个事实必须同一刻取齐：分开取会让界面拿着旧修订号提交，凭空造出一次冲突。
 * `user` 与 `effective` 都是**掩码后**的形态——视图会经 HTTP 出到浏览器，凭据
 * 只以明文存在于 `readConfig()` 那条域内通道上。
 */
export interface SettingsView {
  /** 用户层：用户在设置页显式提交过的键（凭据字段已掩码）。 */
  user: Partial<NotifyConfig>;
  /**
   * 修订号：用户层的当前版本。
   *
   * 本地文件没有宿主服务的单调计数器，用**内容摘要**充当——它同样满足乐观并发
   * 唯一关心的性质：内容不变则号不变，内容一变号就变。副作用是手改文件与经接口
   * 写入得到同样的号，而这恰恰是对的：界面该拒绝的是「基于旧内容提交」，不是
   * 「不是通过我改的」。
   */
  revision: number;
  /** 当前是否可写。本地文件恒为可写；真正的写失败由 `write` 的结果表达。 */
  writable: boolean;
  /** 生效设置：入口层与用户层合并、归一化后的完整形态（凭据字段已掩码）。 */
  effective: Partial<NotifyConfig>;
}

/**
 * 写入结果。
 *
 * 失败分成三类而不是一个布尔：界面要据此决定是定位到字段、提示「已过期」，
 * 还是把表单整体置灰——三者的处置完全不同。
 */
export type WriteResult =
  | { ok: true; view: SettingsView }
  | { ok: false; reason: "invalid"; error: SettingInvalid }
  | { ok: false; reason: "conflict" }
  | { ok: false; reason: "unavailable" };
