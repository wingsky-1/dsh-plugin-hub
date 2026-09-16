/**
 * dsh-notifier —— 内置音色白名单（纯数据，无 import）。
 *
 * 为什么两端共用一份：白名单此前两端各写一份**逐字相同**的字面量（宿主端 config 的写入口径、
 * 客户端设置页的音色选项与「有没有声」的三态判定），新增音色时漏改一边的症状是「设置页给得出
 * 选项、宿主把它当脏值静默回落」或反过来「宿主放行、选项里选不到」。
 *
 * 字面量数组是**唯一的物理事实源**，`SoundId` 由它派生——值与类型各写一份，会在新增音色时
 * 漏改一边。顺序即设置页展示顺序。导出面上只有类型与只读数组两项（与收口前的声明形态一致），
 * 免得下游为「元组 vs 数组」多写一次断言或收窄。
 *
 * 「跟随系统默认」不占白名单位：它在设置面是 `true`，在音色表一侧对应的键是 tones.ts 的
 * FOLLOW_SYSTEM_TONE（"default"）——后者是伪音色 id，不在用户可选的音色白名单里。
 */
const SOUND_ID_LIST = ["ding", "bell", "chime", "pop"] as const;

/** 内置音色 id：全平台语义一致的白名单。 */
export type SoundId = (typeof SOUND_ID_LIST)[number];

/** 白名单的运行时形态；顺序即设置页的展示顺序。 */
export const SOUND_IDS: readonly SoundId[] = SOUND_ID_LIST;

/**
 * 运行时白名单校验：类型联合只在编译期存在，磁盘内容与设置提交传来的值不受它约束。
 * 两端此前各自内联这份成员判定（宿主端 config 一次、客户端两次），收口到这里。
 */
export function isSoundId(value: unknown): value is SoundId {
  return typeof value === "string" && (SOUND_ID_LIST as readonly string[]).includes(value);
}
