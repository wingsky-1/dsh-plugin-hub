/**
 * 共享层 —— 文本口径：跨域复用、无单一归属的语言。
 *
 * 放在这里而不是某个域里：定稿（pipeline）与各出口（channels）都要按码点截断，而
 * 「谁引用谁的实现」在域之间是禁忌。两份逐字相同的副本曾经各活一处，改一处必漏另一处。
 */

/** 按码点截断（超长才截）：按 UTF-16 code unit 切会把 emoji 的代理对腰斩，跨进程再编码显示成替换符。 */
export function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}
