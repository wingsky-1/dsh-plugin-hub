#!/usr/bin/env node
"use strict";

/**
 * ts-lex — TS/TSX 源码的**词法**扫描（acorn tokenizer，零新增依赖）。
 *
 * 为什么需要它（本仓工具链的实测硬事实，判据设计上必须知道）：
 *   1. esbuild 剥类型会**擦除** `import type … from` 与 `declare module "X" {}`——连
 *      `verbatimModuleSyntax: true` 也一样（实测：`import type {A} from "X"` 在输出里完全
 *      不存在，`import {type B} from "X"` 只剩 `import {} from "X"`）。而本仓对官方包的
 *      引用**几乎全是类型导入**（运行时值导入另由 contract-check 的「仅类型导入」闸判红），
 *      于是「剥类型 + acorn.parse」的 AST 里恒不存在这两类构造：**只跑 AST 的判据恒零命中**
 *      （静默假绿，且看不出是判据失效还是真的干净）。
 *   2. `node:module.stripTypeScriptTypes` 同款擦除（实测同形态）。
 *   3. `typescript@7`（本仓 devDep）只导出 version；`typescript/unstable/ast` 的
 *      `createScanner` 是空实现（实测 `scan()` 恒返 FirstToken、`SyntaxKind.EndOfFileToken`
 *      为 undefined），JS 编译器 API 不可用。
 *   4. acorn 的 **tokenizer 只认 token 不认文法**：TS 特有的 `type`/`interface`/`as`/`?`/
 *      `!` 在 token 层与 ES 同形，故「类型侧」事实可以从词法流取到，且带精确偏移与解码后的
 *      字符串值——这比文本扫描结构性地强（注释、字符串字面量、模板串里的同形文本都进不来）。
 *
 * 因此判据侧的事实分工：**运行时侧**（`import` / `export … from` / 动态 `import()`）走
 * 「esbuild 剥类型 + acorn AST」，**类型侧**（`import type` / `declare module`）走本模块的
 * 词法流；两者取并集才是「这个文件依赖了哪些官方包」的完整事实。
 *
 * JSX 与词法化（分段扫描，重要）：.tsx 的 JSX 区段不是合法 JS（JSX 文本里的 `/` 被当正则
 * 起点、文本里的非 ASCII 字符直接报错），acorn tokenizer 会抛。处理方式是**分段**：抛错时保留
 * 已取到的 token，跳到「失败位置之前最近的行首」另开一个 tokenizer 续扫（不从段首重来，故
 * 整体仍是一次线性扫描）。被跳过的区段原样记进 `skipped`，判据据此对「跳过区里恰好有
 * import / declare module」fail-closed——盲区必须是响亮的，不能是静默的假绿。
 *
 * 本模块只提供**机制**（词法化 + 行号 + 分段），不认任何门禁语义：什么算命中由各门禁自己判断
 * （与 `lib/exemption-gate.ts` 的分工同形）。
 *
 * 已知边界（不为此加复杂度，本仓无此形态）：TS 的 `import x = require("X")` 等价式里模块
 * 说明符落在括号内（深度 > 0），本模块不计——它是运行时导入，调用方若在意可自行用 AST 腿补。
 */

import { tokenizer } from "acorn";

/** acorn token 的最小结构视图（acorn 未导出 Token 类型，故自声明；避免 any 逃逸）。 */
interface RawToken {
  type: { label: string };
  value?: unknown;
  start: number;
  end: number;
}

/** tokenizer 的最小结构视图：acorn 的类型声明未含 getTokenStart，故自声明。 */
interface RawStream {
  getToken(): RawToken;
  getTokenStart?(): number;
}

export interface SourceToken {
  /** acorn 词法类别（name / keyword / string / num / regexp / punct…）。 */
  label: string;
  /** token 原文（字符串字面量含引号；其余是记号本身）。 */
  text: string;
  /** 字符串字面量的**解码值**（非字符串 token 为 null）。 */
  value: string | null;
  /** 在整份源码中的绝对偏移。 */
  start: number;
  end: number;
  /** 1-based 行号。 */
  line: number;
  /** 本 token 之前是否有换行（ASI 判定用；跨分段也如实反映）。 */
  lineStart: boolean;
}

/** 被跳过的区段：词法化失败后到续扫点之间的原文。 */
export interface SkippedSpan {
  start: number;
  end: number;
  text: string;
}

export interface SourceScan {
  tokens: SourceToken[];
  skipped: SkippedSpan[];
}

const SCAN_OPTIONS = {
  ecmaVersion: "latest" as const,
  sourceType: "module" as const,
  allowHashBang: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
};

const LABEL_STRING = "string";
const LABEL_EOF = "eof";

/** 逐行起始偏移表（1-based 行号换算的查表底座）。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 偏移 → 1-based 行号（二分；token 递增，底座线性递增）。 */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** 失败偏移：acorn 的 SyntaxError 带 pos；缺失时退回当前 token 起点。 */
function failureOffset(error: unknown, stream: RawStream, sliceLength: number): number {
  const pos = (error as { pos?: unknown } | null)?.pos;
  if (typeof pos === "number" && pos >= 0) return Math.min(pos, sliceLength);
  const started = stream.getTokenStart?.();
  return typeof started === "number" ? started : 0;
}

/** 偏移 at 之前最近的行首（含 at 本身恰为行首的情形）；没有则返回 at。 */
function resumeOffset(text: string, at: number): number {
  for (let i = Math.min(at, text.length); i > 0; i -= 1) {
    if (text.charCodeAt(i - 1) === 10) return i;
  }
  return at;
}

/** 偏移 at 之后的第一个行首；没有则返回文末。 */
function nextLineStart(text: string, at: number): number {
  for (let i = Math.max(at, 0); i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) return i + 1;
  }
  return text.length;
}

/**
 * 续扫点：优先「失败位置之前最近的行首」；段首就失败时（续扫点落在不可词法化的行上，
 * 实测 .tsx 的 JSX 文本行即如此）退化为「整行跳过」，即下一行首；两者都不可得才前进一格。
 * 必须严格前进，否则分段失效即抛。
 */
function skipTo(text: string, from: number, at: number, acc: SourceScan): number {
  const back = resumeOffset(text, at);
  const cut = back > from ? back : nextLineStart(text, at);
  if (cut <= from) {
    throw new Error(
      `ts-lex: 偏移 ${from} 处即词法化失败且无法切出续扫点（分段失效）——本文件不可判`,
    );
  }
  acc.skipped.push({ start: at, end: cut, text: text.slice(at, cut) });
  return cut;
}

/** 词法化一个区段；返回 -1 表示已到文件尾，否则返回下一段的起始偏移。 */
function scanSegment(text: string, from: number, starts: number[], acc: SourceScan): number {
  const slice = text.slice(from);
  const stream = tokenizer(slice, SCAN_OPTIONS) as unknown as RawStream;
  for (;;) {
    let raw: RawToken;
    try {
      raw = stream.getToken();
    } catch (error) {
      return skipTo(text, from, from + failureOffset(error, stream, slice.length), acc);
    }
    if (raw.type.label === LABEL_EOF) return -1;
    const start = from + raw.start;
    const end = from + raw.end;
    // 逐 token 取「上一个 token 的结束」：段首那一次取值不能复用到整段——否则每个 token 的
    // lineStart 都会拿段首偏移去比，同一行里后续 token 全被标成行首，ASI 判定随之全错。
    const prevEnd = acc.tokens.length === 0 ? from : acc.tokens[acc.tokens.length - 1].end;
    acc.tokens.push({
      label: raw.type.label,
      text: text.slice(start, end),
      value: raw.type.label === LABEL_STRING ? String(raw.value) : null,
      start,
      end,
      line: lineOf(starts, start),
      lineStart: text.slice(prevEnd, start).includes("\n"),
    });
  }
}

/**
 * 全文词法化（分段续扫）。
 *
 * 抛错 = 本文件不可判（调用方须 fail-closed，不得当作「零命中」）。
 */
export function scanSource(text: string): SourceScan {
  const acc: SourceScan = { tokens: [], skipped: [] };
  const starts = lineStarts(text);
  let pos = 0;
  for (;;) {
    const next = scanSegment(text, pos, starts, acc);
    if (next < 0) return acc;
    pos = next;
  }
}

/** 跳过区段里是否藏着 import / declare module——藏得住就说明判据有盲区，调用方据此 fail-closed。 */
export function skippedImportRisks(scan: SourceScan): SkippedSpan[] {
  return scan.skipped.filter((span) => /^[ \t]*(?:import\b|declare\b)/m.test(span.text));
}
