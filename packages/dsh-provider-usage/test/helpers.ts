// @ts-nocheck
/**
 * dsh-provider-usage — 单元测试共享辅助（纯函数断言用，不创建临时目录）。
 */
import assert from "node:assert/strict";

export { assert };

// ---------------------------------------------------------------- sanitizeHtml 统一判定标准 v2（测试侧单一事实源）
//
// 本节是 sanitizeHtml 安全判据的唯一测试侧实现：smoke-pure / unit-v1 等一律
// 引用此处，禁止再复制解码器/危险模式/判定函数（P2③——round1 的 P1-1 穿透
// 正是「实现与判据镜像漂移、共盲放过 Tab/LF/CR 实体族」的后果）。
//
// 与 src/sanitize.ts 实现的关系：**有意保持独立**。实现是净化器本体（发布物），
// 判据是浏览器语义参照（qa 复核基准），二者互为对抗；判据内部单一事实源即可，
// 不得为「复用」而让 src 反向 import 测试文件或扩大 lib/index.js 导出面。

/** 具名实体表（qa 判据子集）：产出 ASCII 危险字符的 WHATWG 正式名小写。 */
const JUDGE_NAMED: Record<string, string> = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'",
  colon: ":", semi: ";", equals: "=", sol: "/", num: "#",
  lpar: "(", rpar: ")",
};

/** 恰好一轮 HTML 实体解码（具名 + 十进制 + 十六进制数字实体，有无分号均解）。 */
export function judgeDecodeOnce(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);?/g, (_m: string, h: string) =>
      String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m: string, d: string) =>
      String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);?/g, (_m: string, nm: string) =>
      JUDGE_NAMED[nm.toLowerCase()] ?? `&${nm}`);
}

/**
 * 浏览器语义视图：一轮解码后按 WHATWG URL basic parser 入口语义剥除全部
 * ASCII tab/newline/CR（jav&#9;ascript: 剥后 scheme 还原为 javascript:）。
 */
export function judgeBrowserView(s: string): string {
  return judgeDecodeOnce(s).replace(/[\t\n\r]/g, "");
}

/** 危险载体模式集合（统一判定标准同款）。 */
export const SANITIZE_DANGER_RE =
  /<script\b|<iframe\b|<frame\b|<object\b|<embed\b|<meta\b|<link\b|<base\b|\son\w+\s*=|javascript\s*:|data\s*:\s*text\/html|expression\s*\(/i;

/** 统一判定标准 v2：净化输出经浏览器语义视图后不匹配任何危险载体模式。 */
export function judgeContained(out: string): boolean {
  return !SANITIZE_DANGER_RE.test(judgeBrowserView(out));
}

/** pad(k)：每轮净化仅暴露一层 <meta> 的深嵌套构造（k 层需 k 轮收敛）。 */
export function judgePad(k: number): string {
  let s = "<meta>";
  for (let i = 1; i < k; i++) s = "<met" + s + "a>";
  return s;
}
