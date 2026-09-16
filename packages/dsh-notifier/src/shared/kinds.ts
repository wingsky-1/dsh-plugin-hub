/**
 * dsh-notifier —— 通知类型表（纯数据 + 两个纯判定，无 import）。
 *
 * 为什么两端共用一份：内置 kind 的**事件开关键**与**展示强度**此前两端各写一份逐字相同的副本
 * （宿主端 judge 的 kind→开关键表、service 的 kind→强度表；客户端设置页的事件卡与历史行的
 * 开关键→kind、kind→强度）。漂移的症状是「事件色点 / 免打扰豁免与服务端裁决不是同一张表」：
 * 客户端认某个 kind 而宿主端不认，用户按下的开关就静默失效。
 *
 * 不搬进这里的是「开关键 → i18n 文案 key」那张表：文案属于客户端，宿主端没有翻译面。
 */
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

/** 展示强度（severity 仅展示；过滤语义归 kind）。 */
export type NotifySeverity = "info" | "success" | "warning" | "failure";

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

/** 事件开关在设置里的键名（宿主端设置模型的字段名）。 */
export type KindSwitchKey =
  | "notifyAsk"
  | "notifyQuestion"
  | "notifyTaskDone"
  | "notifySubagentDone"
  | "notifyTaskError"
  | "notifyTurnEnd";

/**
 * 内置 kind → 事件开关键；`test` 不在表里——它不对应任何宿主事件，也就没有开关。
 *
 * 客户端设置页的那张逆向表（开关键 → kind）由本表**反转**得到，故这里是它的唯一事实源。
 * 表里的每个值都必须是设置模型里真实存在的布尔键：改名漏改一处会让开关读到一个恒 undefined
 * 的字段，症状是该事件的通知永远发不出。
 */
export const KIND_SWITCHES: Record<Exclude<BuiltinKind, "test">, KindSwitchKey> = {
  ask: "notifyAsk",
  question: "notifyQuestion",
  done: "notifyTaskDone",
  "subagent-done": "notifySubagentDone",
  error: "notifyTaskError",
  "turn-end": "notifyTurnEnd",
};
