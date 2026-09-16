/**
 * dsh-notifier —— 投递理由的 code 闭集（纯数据，无 import）。
 *
 * 为什么两端共用一份：`reasonLegacy` 此前在客户端是一份**靠注释维系的同值字面量**
 * （`const LEGACY_CODE = "reasonLegacy"`，注释自述「与服务端 REASON_LEGACY 同值」），而没有任何
 * 断言锁住两者相等——改一边就是一个读不出来的历史行。收口后客户端只消费这里这个值。
 *
 * 值函数（reason / normalizeReason / reasonFromCause / clampReasonDetail / sameReasonShape）不在这里：
 * 它们依赖 src/server/shared/text.ts 的截断实现，属宿主端，进不了零 import 的共享面。
 *
 * 生产侧闭集在本地，读侧仍是开放 string（磁盘上的旧行与跨版本数据不受本版编译期约束）。
 * 客户端字典必须覆盖 REASON_CODES 的每一项，跨端一致性由 test/client-unit/reason-text.test.ts 的
 * 直连断言守（客户端只把 REASON_LEGACY 当值用，REASON_CODES 只作类型来源）。
 */

/**
 * 升级前的散文理由。这一条是唯一「code 不含文案」的取值：原文整句进 `detail`，客户端逐字渲染。
 * 它只在割接产物上出现（见 upgrade 域的 reason 形态迁移），但会随历史记录长期留在磁盘上。
 */
export const REASON_LEGACY = "reasonLegacy";

/**
 * 本版会生产的 code 清单。命名即字典 key：`t(code, params)` 直接取文案，不另建一张
 * code → key 的映射表，少一处能漂的地方。
 */
export const REASON_CODES = [
  REASON_LEGACY,
  // 空动作（skipped）：`config` 是用户意图，`environment` 是环境能力。两者必须分得开——
  // 前者不该被当成故障去查，后者不该被当成「用户自己关的」而放过。
  "reasonSkipConfig",
  "reasonSkipEnvironment",
  // system 出口
  "reasonSystemPopupFailed",
  "reasonSystemSoundFailed",
  // win32 的 toast 脚本缺失是**打包缺陷**，与「宿主没能力」是两回事：合成一个 code 会把
  // 插件自己的问题说成用户的桌面环境问题，用户会去 Windows 上找一个不存在的 notify-send
  "reasonSystemToastScriptMissing",
  // 合成音的临时文件写不进去（/tmp 只读挂载、拿不到写权限）：这是一个**空动作**（没有可执行的
  // 播放动作），终态因此是 skipped 而不是 failed——宿主原文（EROFS/EACCES）进 detail。
  "reasonSystemToneUnwritable",
  // bark 出口
  "reasonBarkRequestFailed",
  "reasonBarkHttp",
  "reasonBarkRejected",
  "reasonBarkBodyUnreadable",
  // webhook 出口
  "reasonWebhookTemplateInvalid",
  "reasonWebhookRequestFailed",
  "reasonWebhookHttp",
  // 投递编排
  "reasonUnknownTarget",
  "reasonChannelThrew",
  // 节流命中：本次**没有投递**。把它记成上一次的结论，等于让归档替一次没发生的投递背书——
  // 通知记录是用户唯一能逐条看的投递面，那一行必须是这一次的事实。
  "reasonThrottled",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** 理由参数：只收能被字典插值的标量——对象与数组进不来，文案层不必再判嵌套。 */
export type ReasonParams = Readonly<Record<string, string | number>>;
