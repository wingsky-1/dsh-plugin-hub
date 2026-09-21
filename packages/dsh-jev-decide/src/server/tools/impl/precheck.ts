/**
 * tools 域实现：本地密形预检（命中即不离境、直转人工；纯函数）。
 *
 * secret-leak 预设默认关闭是第一道闸；本预检是第二道——对全部预设生效：
 * 正文命中密钥密形时，本次决议不发任何出境请求，直接返回人工接管。
 */

/** 密钥密形（命中即敏感，宁可误报人工，不可漏报出境）。 */
const SECRET_HIT_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{8,}/,
  /xox[bpas]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
];

/** 是否命中密形（命中即不离境）。 */
export function localPrecheckHit(text: string): boolean {
  for (const pattern of SECRET_HIT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
