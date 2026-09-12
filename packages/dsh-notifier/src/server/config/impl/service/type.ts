/**
 * dsh-notifier config 域 —— 装配面与读写结果（本域形状）。
 */
import type { NotifyConfig, SettingInvalid } from "../model/type.ts";

/**
 * 设置页视图：四个事实同一刻取齐（分开取会让界面拿着旧修订号提交，凭空造出一次冲突）。
 * `user` 与 `effective` 都是**掩码后**的形态——明文凭据只走域内的 `readConfig()`。
 */
export interface SettingsView {
  /** 用户层：用户在设置页显式提交过的键（凭据字段已掩码）。 */
  user: Partial<NotifyConfig>;
  /** 修订号：用户层内容摘要——内容不变则号不变，手改文件与经接口写入得到同样的号。 */
  revision: number;
  /** 当前是否可写；本地文件恒为可写，真正的写失败由 `write` 的结果表达。 */
  writable: boolean;
  /** 生效设置：入口层与用户层合并、归一化后的完整形态（凭据字段已掩码）。 */
  effective: Partial<NotifyConfig>;
}

/**
 * 写入结果：失败分三类而不是一个布尔——界面要据此决定定位到字段、提示「已过期」，
 * 还是把表单整体置灰。
 */
export type WriteResult =
  | { ok: true; view: SettingsView }
  | { ok: false; reason: "invalid"; error: SettingInvalid }
  | { ok: false; reason: "conflict" }
  | { ok: false; reason: "unavailable" };
