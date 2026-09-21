/**
 * history 域实现：snippet 脱敏与截断（纯函数）。
 *
 * 顺序先脱敏后截断：截断在前会把掩码切半，泄露半截密钥。
 * 密钥原文永不入库是红线，本模块是最后一道闸（调用方不得绕过直接拼条目）。
 */
import { SNIPPET_MAX } from "../../../shared/interface.ts";

/** 密钥密形（与 tools 预检同源不同用：此处做掩码，前者做命中判定）。 */
const REDACT_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /xox[bpas]-[A-Za-z0-9-]+/g,
  // S2：头到尾非贪婪不限长——200 字窗口会把长 PEM 切成“掩码半截+密钥体残留”，截断后再存约 170 字原文。
  /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
  /api[_-]?key\s*[:=]\s*[^\s,}]+/gi,
  /password\s*[:=]\s*[^\s,}]+/gi,
  /secret\s*[:=]\s*[^\s,}]+/gi,
];

/** 脱敏并截断（≤200 字，按 codepoints 不断字）。 */
export function redactSnippet(text: string): string {
  let out = text;
  for (const pattern of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "***");
  }
  const points = Array.from(out);
  if (points.length <= SNIPPET_MAX) return out;
  return points.slice(0, SNIPPET_MAX).join("");
}
