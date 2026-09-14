/**
 * 围栏拒答的机器可读类别（#769）。宿主端写、客户端读，两侧必须是同一份取值：各写一份字面量，
 * 改一边就是一边静默退回文案兜底，而文案兜底认的是状态码——症状是「引导没了」而不是「报错了」。
 *
 * 为什么只放数据不放判定：判定（哪个 code 该给局域网引导、结构化与文案的优先级）在
 * src/client/api-error.ts，是客户端独有的读侧契约；这里只承载两端必须一致的那份**取值表**，
 * 于是本文件不产生可变异的分支（纯字面量由 sharedDefaults 的字面量变异排除承接）。
 *
 * 同级模块的构建硬约束（见 interface.ts）：本文件零 import。
 */

/**
 * 围栏拒答类别：键即值。
 *
 * 值携带完整语义（不靠键名，因为客户端拿到的是线上的字符串），读侧按值域判读——认不出的值
 * 一律交回状态码/文案兜底，而不是当成拒答。
 */
export const REFUSAL_CODES = {
  /** 非回环来源（含 Host 头不是回环）：回环围栏拒绝。 */
  FORBIDDEN_LOOPBACK: "FORBIDDEN_LOOPBACK",
  /** 方法不在端点的方法表里：方法围栏拒绝。 */
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
} as const;

/** 拒答类别联合。宿主端 `sendRefused` 只接受本联合，客户端按值域判读。 */
export type RefusalCode = (typeof REFUSAL_CODES)[keyof typeof REFUSAL_CODES];
