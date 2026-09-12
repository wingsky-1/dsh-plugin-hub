/**
 * dsh-notifier pipeline 域 —— 通知种类与展示强度的词汇表。
 * 数组是**唯一的物理事实源**，`BuiltinKind` 由它派生；值与类型各写一份，会在新增一种
 * 通知时漏改一边。
 */
import type { NotifySeverity } from "../../deps.ts";

/** 内置通知种类（顺序即设置页的展示顺序）。 */
export const BUILTIN_KINDS = [
  "ask",
  "question",
  "done",
  "subagent-done",
  "error",
  "turn-end",
  "test",
] as const;

/** 内置通知种类。 */
export type BuiltinKind = (typeof BUILTIN_KINDS)[number];

/**
 * 外部注册的通知种类：`<命名空间>:<id>`。
 * 内置 kind 一律不含冒号，两个集合因此天然不相交；而白名单查询会在注册之前把没登记的
 * 种类误判成内置，误判方向恰好是放行。
 */
export type ExternalKind = `${string}:${string}`;

/** 通知种类：内置的，或外部注册的。 */
export type NotifyKind = BuiltinKind | ExternalKind;

/** 是不是内置种类。 */
export function isBuiltinKind(kind: string): kind is BuiltinKind {
  return (BUILTIN_KINDS as readonly string[]).includes(kind);
}

/**
 * 内置 kind → 缺省展示强度；外部 kind 没有缺省（强度由调用方自己说）。
 * 写成 `Record<BuiltinKind, …>`：新增一种内置通知时，漏配强度是编译错误。
 */
export const KIND_SEVERITY: Record<BuiltinKind, NotifySeverity> = {
  ask: "warning",
  question: "info",
  done: "success",
  "subagent-done": "info",
  error: "failure",
  "turn-end": "info",
  test: "info",
};

/** 合法强度全集的**运行时**形态（与 `NotifySeverity` 联合一一对应）。 */
export const NOTIFY_SEVERITIES = [
  "info",
  "success",
  "warning",
  "failure",
] as const satisfies readonly NotifySeverity[];

/** 运行时枚举校验：类型联合只在编译期存在，跨宿主边界传来的值不受它约束。 */
export function isNotifySeverity(value: string): value is NotifySeverity {
  return (NOTIFY_SEVERITIES as readonly string[]).includes(value);
}
