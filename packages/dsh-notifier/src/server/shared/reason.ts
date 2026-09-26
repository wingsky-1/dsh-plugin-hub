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
import { REASON_CODES, REASON_LEGACY } from "../../shared/interface.ts";
import type { ReasonCode, ReasonParams } from "../../shared/interface.ts";
import { truncateCodePoints } from "./text.ts";

/**
 * code 闭集的事实源在 src/shared/reason-codes.ts（两端共享面，零 import）：客户端此前自己抄了一份
 * 同值字面量、两边靠注释维系相等，收口后由构造保证同值。
 *
 * 留在本文件的是**值函数**（reason / normalizeReason / reasonFromCause / clampReasonDetail /
 * sameReasonShape）：它们依赖 ./text.ts 的截断实现，属宿主端，进不了零 import 的共享面。
 */
export { REASON_CODES, REASON_LEGACY };
export type { ReasonCode, ReasonParams };

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
  if (typeof value === "string") return legacyFrom(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.code !== "string" || source.code === "") return undefined;
  return projectReason(source.code, source);
}

/** 升级前的散文：空串读不出，非空收编成 legacy + detail（散文即宿主原文）。 */
function legacyFrom(value: string): DeliverReason | undefined {
  return value === "" ? undefined : { code: REASON_LEGACY, detail: value };
}

/** 结构化投影：只取认识的那几个字段——code 必填，params / detail 有值才带上。 */
function projectReason(code: string, source: Record<string, unknown>): DeliverReason {
  const normalized: DeliverReason = { code };
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
