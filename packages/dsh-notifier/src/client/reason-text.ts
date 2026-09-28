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
  reasonDispatchCanceled: "reasonDispatchCanceled",
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
  status: DeliveryStatus;
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
  const row = deliveryRowOf(value);
  return row === undefined ? undefined : projectDelivery(row, t);
}

/** 明细行的状态闭集：`status` 是这一行的判据，值域外一律读不出。 */
type DeliveryStatus = "ok" | "failed" | "skipped";

/** 值域守卫：认不出容器、channelId 或 status 就读不出（认不出的代价是界面去猜）。 */
function deliveryRowOf(
  value: unknown,
):
  | { readonly channelId: string; readonly status: DeliveryStatus; readonly reason: unknown }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.channelId !== "string" || source.channelId === "") return undefined;
  const status = source.status;
  if (status !== "ok" && status !== "failed" && status !== "skipped") return undefined;
  return { channelId: source.channelId, status, reason: source.reason };
}

/** 认得之后只剩机械投影：`ok` 那一支没有理由可说，与 DeliveryView 同口径。 */
function projectDelivery(
  row: { readonly channelId: string; readonly status: DeliveryStatus; readonly reason: unknown },
  t: ReasonTranslator,
): DeliveryView {
  if (row.status === "ok") {
    return {
      channelId: row.channelId,
      status: row.status,
      statusText: t("chStatusOk"),
      reason: "",
      detail: "",
    };
  }
  return {
    channelId: row.channelId,
    status: row.status,
    statusText: row.status === "failed" ? t("chStatusFailed") : t("chStatusSkipped"),
    reason: reasonText(row.reason, t),
    detail: reasonDetail(row.reason),
  };
}

/** 主文案与宿主原文之间的分隔：主文案自带括号（"（网络或超时）"），用竖线而不是冒号才读得开。 */
const DETAIL_SEPARATOR = "｜";

/**
 * dry-run 结果行的理由文案（#912 F1 回归 pin）：`ok` 那一支为空串——成功没有理由可说，
 * 与 DeliveryView 同口径；非 ok 走 reasonText。调用方（index.tsx sendTest）不得直调
 * reasonText，否则 ok 行必挂“原因未知”。
 *
 * 失败行逐字追加宿主原文（#1016 P0）。此前只给主文案，而这一行只有一个字符串可展示（不像历史
 * 里的 DeliveryView 有独立的 detail 区域），于是被出站 URL 硬闸拒绝的投递显示成
 * 「Bark 请求失败（网络或超时）」——真实原因（URL 含凭据 / 协议不支持）被丢在 detail 里，
 * 用户看到的是一条与自己配置无关的结论。
 *
 * **逐字投影，不分类也不改写**：客户端无从判断一段 detail 是不是安全拒绝，一旦开始按内容
 * 归类加提示，「连接超时」也会被说成安全问题——那比不显示更坏。是否「已拒绝投递」由服务端在
 * 原因里自己说明。
 */
export function dryRunReasonText(status: string, reason: unknown, t: ReasonTranslator): string {
  if (status === "ok") return "";
  const text = reasonText(reason, t);
  const detail = reasonDetail(reason);
  // 主文案已经就是 detail 的两种情形：认不出的 code（回落成原文）与 reasonLegacy。再拼一次
  // 等于同一条信息说两遍。
  return detail === "" || detail === text ? text : text + DETAIL_SEPARATOR + detail;
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
