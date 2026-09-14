/**
 * 共享层 —— 投递理由的结构化形态（跨端线格式）。
 *
 * 为什么是结构而不是散文：同一句「没送到」要在状态页、通知记录、日志三处出现。散文只能原样
 * 搬运——双语做不到，参数化做不到，客户端也无从判断「这句是宿主原文还是插件文案」。拆成
 * `code`（文案）+ `params`（插值）+ `detail`（宿主原文）之后，三处各自取自己需要的那一段。
 *
 * `code` 在生产侧是闭集（拼错即编译错误），在读侧是**开放的 string**：磁盘上的旧行与跨版本
 * 数据不受本版编译期约束，拿闭集去读只会把不认识的记录整条丢掉——那比渲染一句中性文案糟得多。
 */
import { truncateCodePoints } from "./text.ts";

/**
 * 升级前的散文理由。这一条是唯一「code 不含文案」的取值：原文整句进 `detail`，客户端逐字渲染。
 * 它只在割接产物上出现（见 upgrade 域的 reason 形态迁移），但会随历史记录长期留在磁盘上。
 */
export const REASON_LEGACY = "reasonLegacy";

/**
 * 本版会生产的 code 清单。客户端字典必须覆盖这里每一项，跨端一致性由测试断言（客户端不 import
 * 本模块——浏览器包里没有服务端）。
 *
 * 命名即字典 key：`t(code, params)` 直接取文案，不另建一张 code → key 的映射表，少一处能漂的地方。
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

/** 一条投递理由；`detail` 是宿主原文，**不作主文案**（界面折叠展示，并标注它的来源）。 */
export interface DeliverReason {
  code: string;
  params?: ReasonParams;
  detail?: string;
}

/**
 * 生产侧的理由：`code` 受本版闭集约束。它与读侧共用同一个开放形态，但**在边界上把差别表达出来**
 * ——`recordStatus(id, "failed", { code: "打错字" })` 现在是编译错误，而不是一条永远走中性回退的记录。
 */
export type ProducedReason = DeliverReason & { code: ReasonCode };

/** 生产侧构造：`code` 受闭集约束，拼错在编译期就红。 */
export function reason(
  code: ReasonCode,
  extra?: { readonly params?: ReasonParams; readonly detail?: string },
): ProducedReason {
  const built: ProducedReason = { code };
  const params = normalizeParams(extra?.params);
  if (params !== undefined) built.params = params;
  if (extra?.detail !== undefined && extra.detail !== "") built.detail = extra.detail;
  return built;
}

/**
 * 按「不认识的输入」造一条理由：全仓只有一种把未知抛出物变成 `detail` 的写法（出口违约与
 * 未知目标各需要一次），两处各写一遍就等于把 `instanceof Error` 这条口径复制两份。
 */
export function reasonFromCause(code: ReasonCode, cause: unknown): ProducedReason {
  return reason(code, { detail: cause instanceof Error ? cause.message : String(cause) });
}

/**
 * 归一化任意来源的 reason：结构化对象只取认识的那几个字段；字符串按「升级前的散文」收编进
 * `detail`；其余（null、数组、没有 code 的对象）判为读不出——调用点各自决定丢还是留。
 *
 * 归一化收在一处而不是让每个调用方各判一次：`status.json` 与 `history.jsonl` 都是磁盘数据，
 * 用户手改、半截写入、旧版本写下的行都会到这里，判断散开就必然有一处漏。
 */
export function normalizeReason(value: unknown): DeliverReason | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : { code: REASON_LEGACY, detail: value };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.code !== "string" || source.code === "") return undefined;
  const normalized: DeliverReason = { code: source.code };
  const params = normalizeParams(source.params);
  if (params !== undefined) normalized.params = params;
  if (typeof source.detail === "string" && source.detail !== "") normalized.detail = source.detail;
  return normalized;
}

/**
 * 两条理由是否**已经是同一个形态**（含 `params`）：割接据此判断「这条已经改过形了」，重跑不再写盘。
 *
 * 刻意**不做语义归一化**：`"旧散文"` 与 `{ code: REASON_LEGACY, detail: "旧散文" }` 语义等价，
 * 但前者恰恰是**还没割接**的那个形态——用语义判等会让割接变成空操作，旧数据永远留在散文形态。
 * 这里要判的是「字节形态已经对了」，不是「意思一样」。
 */
export function sameReasonShape(left: unknown, right: unknown): boolean {
  if (!isReasonObject(left) || !isReasonObject(right)) return false;
  if (left.code !== right.code || left.detail !== right.detail) return false;
  return paramsEqual(left.params, right.params);
}

/** 是不是结构化的理由对象：字符串、数组、null 都不是（它们正是待割接的旧形态）。 */
function isReasonObject(value: unknown): value is DeliverReason {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as DeliverReason).code === "string"
  );
}

/** 参数逐键比较（缺省视同空表）：`params` 是展示插值，不做深比较。 */
function paramsEqual(a: ReasonParams | undefined, b: ReasonParams | undefined): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((k) => left[k] === right[k]);
}

/**
 * `detail` 按展示上限截断（截断是展示语义，不是脱敏）；无 detail 或未超限时原样返回同一个对象。
 *
 * 泛型只为**保住生产侧的封闭 code**：调用方交进来 `ProducedReason`，拿回去还得是它，否则一次
 * 截断就把「code 受本版闭集约束」这条边界悄悄拓宽成开放 string。展开泛型对象无法被 TS 证明
 * 仍是 `T`（已知限制），故这里有一次局部断言。
 */
export function clampReasonDetail<T extends DeliverReason>(value: T, max: number): T {
  if (value.detail === undefined) return value;
  const detail = truncateCodePoints(value.detail, max);
  return detail === value.detail ? value : ({ ...value, detail } as T);
}

/** 参数只收标量：跨边界与磁盘数据里的嵌套值渲染不出来，收进来只会让文案层多一层判空。 */
function normalizeParams(value: unknown): ReasonParams | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" || typeof item === "number") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
