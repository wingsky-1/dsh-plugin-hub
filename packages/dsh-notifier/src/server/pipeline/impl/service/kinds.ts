/**
 * dsh-notifier pipeline 域 —— 通知种类的词汇表。
 *
 * 数组是**唯一的物理事实源**，`BuiltinKind` 由它派生。值与类型各写一份，就会在新增
 * 一种通知时漏改一边，而症状是「新种类的开关永远是关的」——没人会去查一个看起来只是
 * 类型的东西。
 *
 * 词汇表归本域：事件开关、频道路由、动态 kind 白名单、bark 的按 kind 紧急度全按它查。
 * 谁命名坐标系，谁就定义了什么算「一类通知」。
 *
 * 依赖方向：只引用本目录，不引用 `interface.ts`。
 */

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
 *
 * 内置 kind 一律不含冒号，两个集合因此天然不相交——「这是内置的还是外部注册的」是一次
 * 字符串判断，而不是一次白名单查询。查询会在注册之前把没登记的种类误判成内置，而误判
 * 的方向恰好是「放行」。
 */
export type ExternalKind = `${string}:${string}`;

/** 通知种类：内置的，或外部注册的。 */
export type NotifyKind = BuiltinKind | ExternalKind;

/** 是不是内置种类。 */
export function isBuiltinKind(kind: string): kind is BuiltinKind {
  return (BUILTIN_KINDS as readonly string[]).includes(kind);
}
