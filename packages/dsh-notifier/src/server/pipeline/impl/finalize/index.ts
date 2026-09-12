/**
 * dsh-notifier pipeline 域 —— 定稿：把请求加工成待投递消息。强度按 kind 补缺省（外部
 * kind 没有缺省），标题按展示上限截断；正文不截断——它的长度权威在各出口自己那里。
 */
import type { NotifyMessage } from "../../deps.ts";
import { KIND_SEVERITY, isBuiltinKind, isNotifySeverity } from "../service/kinds.ts";
import type { NotifyRequest } from "../service/type.ts";
import type { SeverityChoice } from "./type.ts";

/** 标题展示上限（码点）：四个出口的标题上限都是 64，故在这里截断一次即可。 */
const TITLE_MAX_CODE_POINTS = 64;

/**
 * 按码点截断：按 UTF-16 code unit 切会把 emoji 的代理对腰斩，跨进程再编码显示成替换符。
 */
function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/**
 * 这次通知的展示强度：请求里合法就用它，否则按 kind 查缺省；非法值一律视同「未提供」
 * ——跨宿主边界传来的值不受编译期联合约束，而下游各出口的缺省路径已经定义了「未提供」
 * 的语义，不在这里新造第二套默认值。
 */
export function resolveSeverity(request: NotifyRequest): SeverityChoice {
  const declared = request.severity;
  if (declared !== undefined && isNotifySeverity(declared)) {
    return { provided: true, severity: declared };
  }
  return isBuiltinKind(request.kind)
    ? { provided: true, severity: KIND_SEVERITY[request.kind] }
    : { provided: false };
}

/**
 * 定稿：组装待投递消息；强度缺席就不写这个键。
 * `ts` 由编排层取一次并同时喂给归档——投递载荷与历史记录必须是同一个时刻。
 */
export function finalizeRequest(request: NotifyRequest, ts: number): NotifyMessage {
  const base = {
    kind: request.kind,
    ts,
    title: truncateCodePoints(request.title, TITLE_MAX_CODE_POINTS),
    body: request.body,
  };
  const severity = resolveSeverity(request);
  return severity.provided ? { ...base, severity: severity.severity } : base;
}
