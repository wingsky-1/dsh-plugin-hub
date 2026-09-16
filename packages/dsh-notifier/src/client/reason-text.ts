/**
 * dsh-notifier — 投递理由的渲染（客户端唯一的理由文案来源）。
 *
 * 为什么 code → 字典 key 写成一张**显式完整表**：服务端新增一个 code 而这里忘了配文案，必须在
 * 编译期就红，而不是等用户看到一行英文标识符。`satisfies Record<ReasonCode, …>` 是穷尽约束，
 * 所以那边加一项、这边漏一项就是构建失败。
 *
 * 类型只 `import type`（编译期擦除，浏览器包里没有服务端实现）。理由的清单在 src/shared/
 * reason-codes.ts 一处维护（两端共享面），客户端不抄第二份——收口前 `reasonLegacy` 是本文件里
 * 一份靠注释维系同值的字面量，改一边就是一个读不出来的历史行。
 */
import { REASON_LEGACY } from "../shared/interface.ts";
import type { ReasonCode } from "../shared/interface.ts";
import type { NotifierLocaleKey } from "./locales.ts";

/** 翻译函数：宿主 locale 服务产物，或未装配时回落 key 本体的那个。 */
export type ReasonTranslator = (
  key: NotifierLocaleKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/** code → 字典 key（本包两者同名，仍逐项列出：改名的成本要落在表上，而不是悄悄跟着 key 漂）。 */
const REASON_KEYS = {
  reasonLegacy: "reasonLegacy",
  reasonSkipConfig: "reasonSkipConfig",
  reasonSkipEnvironment: "reasonSkipEnvironment",
  reasonSystemPopupFailed: "reasonSystemPopupFailed",
  reasonSystemSoundFailed: "reasonSystemSoundFailed",
  reasonSystemToastScriptMissing: "reasonSystemToastScriptMissing",
  reasonSystemToneUnwritable: "reasonSystemToneUnwritable",
  reasonBarkRequestFailed: "reasonBarkRequestFailed",
  reasonBarkHttp: "reasonBarkHttp",
  reasonBarkRejected: "reasonBarkRejected",
  reasonBarkBodyUnreadable: "reasonBarkBodyUnreadable",
  reasonWebhookTemplateInvalid: "reasonWebhookTemplateInvalid",
  reasonWebhookRequestFailed: "reasonWebhookRequestFailed",
  reasonWebhookHttp: "reasonWebhookHttp",
  reasonUnknownTarget: "reasonUnknownTarget",
  reasonChannelThrew: "reasonChannelThrew",
  reasonThrottled: "reasonThrottled",
} satisfies Record<ReasonCode, NotifierLocaleKey>;

/**
 * 理由的主文案。读侧对形态是**宽容**的：磁盘上的旧行（散文）、手改过的值、更新版本写下的
 * 陌生 code 都会到这里。宽容不等于含糊——认不出来时宁可给一句中性文案或宿主原文，也不猜。
 */
export function reasonText(value: unknown, t: ReasonTranslator): string {
  // 升级前的散文（或手改值）：原样显示。把一句能读懂的中文换成「原因未知」是自伤。
  if (typeof value === "string") return value;
  const view = reasonViewOf(value);
  if (view === undefined) return t("reasonUnknown");
  const detail = view.detail === undefined ? "" : view.detail;
  // 升级前誊下来的整句原文：它不是文案，逐字显示才是诚实的
  if (view.code === REASON_LEGACY) return detail === "" ? t("reasonLegacy") : detail;
  const key = knownKeyOf(view.code);
  // 认不出的 code（更新版本的插件写下的）：中性回退，先给宿主原文再给中性文案
  if (key === undefined) return detail === "" ? t("reasonUnknown") : detail;
  return t(key, view.params);
}

/** 宿主原文（没有就空串）：界面把它放进可折叠区并标注「来自宿主原文」，不作主文案。 */
export function reasonDetail(value: unknown): string {
  const view = reasonViewOf(value);
  if (view === undefined || view.detail === undefined) return "";
  // 升级前的原文已经是主文案，再折叠展示一次是同一条信息说两遍
  return view.code === REASON_LEGACY ? "" : view.detail;
}

/** 一条逐出口明细的视图：界面只消费它，于是「渲染成什么」在 node 环境里就能断言。 */
export interface DeliveryView {
  channelId: string;
  status: "ok" | "failed" | "skipped";
  /** 状态标签文案。 */
  statusText: string;
  /** 主理由文案；`ok` 那一支为空串（成功没有理由可说）。 */
  reason: string;
  /** 宿主原文（折叠展示）；没有、或与主文案重复时为空串。 */
  detail: string;
}

/**
 * 归一化一条投递明细（`/history` 里 `channels` 的一项）。
 *
 * 值域外的一律判读不出：`status` 是这一行的判据，认不出来就不能交给界面去猜（猜错的代价是
 * 把一次真实的失败画成成功）。判据与渲染分开，界面那侧才只剩一层机械投影。
 */
export function deliveryViewOf(value: unknown, t: ReasonTranslator): DeliveryView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.channelId !== "string" || source.channelId === "") return undefined;
  if (source.status !== "ok" && source.status !== "failed" && source.status !== "skipped") {
    return undefined;
  }
  const status = source.status;
  if (status === "ok") {
    return {
      channelId: source.channelId,
      status,
      statusText: t("chStatusOk"),
      reason: "",
      detail: "",
    };
  }
  return {
    channelId: source.channelId,
    status,
    statusText: status === "failed" ? t("chStatusFailed") : t("chStatusSkipped"),
    reason: reasonText(source.reason, t),
    detail: reasonDetail(source.reason),
  };
}

/** 读侧视图：只取渲染用得上的三个字段，其余（半截值、陌生键）不进界面。 */
interface ReasonView {
  code: string;
  params?: Readonly<Record<string, string | number>>;
  detail?: string;
}

function reasonViewOf(value: unknown): ReasonView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.code !== "string" || source.code === "") return undefined;
  const view: ReasonView = { code: source.code };
  const params = paramsOf(source.params);
  if (params !== undefined) view.params = params;
  if (typeof source.detail === "string" && source.detail !== "") view.detail = source.detail;
  return view;
}

function knownKeyOf(code: string): NotifierLocaleKey | undefined {
  return Object.prototype.hasOwnProperty.call(REASON_KEYS, code)
    ? REASON_KEYS[code as ReasonCode]
    : undefined;
}

/**
 * 参数按原样交给翻译函数：服务端写盘前已把非标量过滤掉，这里再逐字段过一遍属于第二份实现。
 * 手改文件带进来的嵌套值最坏也只是插值出一个 `[object Object]`，不值得为它复制一份过滤逻辑。
 */
function paramsOf(value: unknown): Readonly<Record<string, string | number>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.keys(value).length > 0
    ? (value as Readonly<Record<string, string | number>>)
    : undefined;
}
