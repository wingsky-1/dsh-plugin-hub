/**
 * dsh-notifier channels 域 —— 草稿测试（dry-run）的单目标出站（提案 B6）。
 *
 * bypass 清单（与正常管线逐项对照）：
 * - 跳过 enabled 门：直构目标，不读 channel.enabled——新频道默认 false，否则恒 suppressed，
 *   测新频道就永远测不了；
 * - 不走 judge / kindRoutes：只测这一个目标，裁决与路由没有输入；
 * - bypass 节奏（rhythm / withGate）与重试：单次尝试——bark 重试最坏约 33s（2 次退避），
 *   远超服务端 15s 总预算，写死单次，retryable 只如实带回，不执行；
 * - 禁 settle / archive / emitFrame 所涉的一切写面：不调 stores、不 emit 帧；browser 的
 *   emitFrame 接空函数——返回 ok 但不 emit 真通知（面板写明以面板结果为准）；
 * - 能力探测复用共享缓存只读：sendSystem 内部经 platformCapabilities.get 读缓存，
 *   这里不 reset、不替换；读面只传空 logger（B3 禁写面含全部 logger warn）；
 * - system spawn 没有 abort 线：15s 总预算到点后在飞的投递由出口自己的 KILL 8s 回收，
 *   结果丢弃（见 api 域的预算注释与 README 安全模型）。
 *
 * bark / webhook 走 SSRF 安全 fetch（见 secure-fetch.ts），单跳超时复用各出口自己的
 * clamp 再压 15s 上限（dryRunFetchTimeoutMs，表驱动钉住）；system / browser 不走网络，
 * 直接调出口原函数。结果理由在这里统一收口：FAILURE_REASON_MAX 截 detail
 * （RESPONSE_DETAIL_MAX 已在出口内截响应体，STATUS_ERROR_LIMIT 与前者同值 300，
 * 一次截断即同时满足三上限），normalizeReason 收编形态。
 */
import { clampReasonDetail, normalizeReason } from "../../../shared/interface.ts";
import type { ProducedReason } from "../../../shared/interface.ts";
import { sendBark, timeoutMsOf } from "../bark/index.ts";
import { sendBrowser } from "../browser/index.ts";
import { sendSystem } from "../system/index.ts";
import { clampTimeoutSec, sendWebhook } from "../webhook/index.ts";
import { FAILURE_REASON_MAX } from "../deliver/caps.ts";
import type { DeliveryTarget } from "../deliver/index.ts";
import type { DeliverResult, HttpFetch, NotifyMessage } from "../deliver/type.ts";
import { secureFetch } from "./secure-fetch.ts";
import type { SecureFetchPorts } from "./secure-fetch.ts";

/** dry-run 单跳出站超时上限（毫秒）：提案 B4「fetch 强制≤15s」。 */
export const DRY_RUN_FETCH_CAP_MS = 15_000;

/**
 * 单跳超时：复用各出口自己的 clamp（与已保存路径同源），再压 15s 上限。
 * 导出是为了让这条口径可表驱动：超时只落在请求的 deadline 上，从外面读不出来——
 * 「上限被改宽」在行为用例里是绿的（与 clampTimeoutSec 的导出理由同族）。
 */
export function dryRunFetchTimeoutMs(
  target: Extract<DeliveryTarget, { type: "bark" } | { type: "webhook" }>,
): number {
  const base =
    target.type === "bark" ? timeoutMsOf(target) : clampTimeoutSec(target.timeoutSec) * 1000;
  return Math.min(base, DRY_RUN_FETCH_CAP_MS);
}

/**
 * 单目标出站：按目标类型分派，bark / webhook 经安全 fetch，browser / system 直调原函数。
 *
 * @param ports 安全 fetch 的注入面（缺省即真实 DNS + 真实建连；单测注入桩，全程离线）。
 */
export async function dryRunTarget(
  target: DeliveryTarget,
  message: NotifyMessage,
  ports?: SecureFetchPorts,
): Promise<DeliverResult> {
  switch (target.type) {
    case "bark":
      return settled(await sendBark(target, message, dryRunFetch(target, ports)));
    case "webhook":
      return settled(await sendWebhook(target, message, dryRunFetch(target, ports)));
    case "browser":
      // emitFrame 接空函数：返回 ok 但不 emit 真通知（面板写明以面板结果为准，见 B6）。
      return settled(sendBrowser({ ...target, emitFrame: () => {} }, message));
    case "system":
      return settled(await sendSystem(target, message));
  }
}

/** 安全 fetch → 出口要的 HttpFetch 形状：失败抛错（出口收成 request-failed），成功按状态映射。 */
function dryRunFetch(
  target: Extract<DeliveryTarget, { type: "bark" } | { type: "webhook" }>,
  ports?: SecureFetchPorts,
): HttpFetch {
  return (url, init) =>
    secureFetch(
      url,
      {
        method: init.method,
        headers: init.headers,
        body: init.body,
        timeoutMs: dryRunFetchTimeoutMs(target),
      },
      ports ?? {},
    ).then((outcome) => {
      if (!outcome.ok) throw new Error(outcome.cause);
      return {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        text: () => Promise.resolve(outcome.body),
        json: () => {
          try {
            return Promise.resolve(JSON.parse(outcome.body) as unknown);
          } catch {
            return Promise.reject(new SyntaxError("响应体不是合法 JSON"));
          }
        },
      };
    });
}

/** 结果理由收口：ok 无理由；失败与空动作的理由截断 + 收编（见模块头三上限说明）。 */
function settled(result: DeliverResult): DeliverResult {
  if (result.status === "ok") return result;
  const normalized = normalizeReason(clampReasonDetail(result.reason, FAILURE_REASON_MAX));
  if (normalized === undefined) return result;
  return { ...result, reason: normalized as ProducedReason };
}
