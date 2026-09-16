/**
 * dsh-notifier 客户端 —— 凭据掩码字段的编辑语义。
 *
 * 服务端把已配置的凭据掩码后送进设置视图（config/impl/redact），写回时**只把恰好等于掩码的
 * 值**判为「未修改」并按 id 还原。因此掩码不是可以出现在输入框里的字面量：它一旦被用户改写
 * （在圆点后追加一个字符），提交值就不再等于掩码，服务端会把它当成新凭据落盘——真 key 丢失、
 * 该通道此后每次投递必败，而界面显示「已保存」。
 *
 * 本模块把这条语义收成一个可判据的纯函数：未编辑时渲染空值（占位符给出「已配置」提示），
 * 只有用户真的输入过才把字段写进草稿；未编辑的字段保持服务端掩码原样提交，由服务端还原。
 */

/** 已配置凭据在输入框里的占位提示（与后缀同一形态，不承载真实值）。 */
export const CREDENTIAL_MASK_PLACEHOLDER = "••••••••";

/** 服务端视图里该字段是否代表「已配置」：空串与缺失都是未配置（读面把空串剥掉了）。 */
export function isCredentialConfigured(raw: unknown): boolean {
  return typeof raw === "string" && raw !== "";
}

/** 凭据字段的瞬态键（<频道 id>:<字段>）：显隐与「已被用户编辑」两个瞬态集合共用同一形态。 */
export function credentialFieldKey(channelId: string, field: string): string {
  return `${channelId}:${field}`;
}

/** 输入框的渲染值：未编辑时为空——掩码不可作为可编辑字面量出现。 */
export function maskedFieldValue(raw: unknown, edited: boolean): string {
  if (!edited) return "";
  return typeof raw === "string" ? raw : "";
}

/** 一个凭据输入框要渲染的三件事：值、占位提示、是否已配置（后者驱动调用方的提示文案）。 */
export interface CredentialFieldView {
  value: string;
  placeholder: string;
  configured: boolean;
}

/** 凭据输入框的唯一投影：两张卡片（bark / webhook）都只消费它，掩码语义不出现第二份。 */
export function credentialFieldView(
  raw: unknown,
  edited: boolean,
  fallbackPlaceholder: string,
): CredentialFieldView {
  const configured = isCredentialConfigured(raw);
  return {
    value: maskedFieldValue(raw, edited),
    placeholder: configured ? CREDENTIAL_MASK_PLACEHOLDER : fallbackPlaceholder,
    configured,
  };
}
