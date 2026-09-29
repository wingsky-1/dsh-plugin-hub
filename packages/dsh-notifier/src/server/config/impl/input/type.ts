/**
 * dsh-notifier config 域 —— 输入闸门的形状。
 */
import type { SettingInvalid } from "../model/type.ts";

/**
 * 校验结果。
 *
 * 用具名判别联合而不是空值哨兵：调用方不必猜「空」是「通过了」还是「没东西可
 * 校验」，而失败载荷是结构化的，界面能直接定位到字段。
 */
export type ValidationResult = { ok: true } | { ok: false; error: SettingInvalid };
