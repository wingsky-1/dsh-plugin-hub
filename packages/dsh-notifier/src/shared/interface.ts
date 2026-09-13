/**
 * dsh-notifier —— 两端共享面（门禁要求：跨模块引用只能落到本文件）。
 *
 * 本目录的位置是临时形态（维护者裁定后续可能改成单独的 shard 目录），所以这里只做转出、
 * 不放任何实现：届时迁移成本 = 本文件与 ./tones.ts 两个文件。
 */
export { FOLLOW_SYSTEM_TONE, TONES } from "./tones.ts";
export type { ToneNote, ToneSpec } from "./tones.ts";
