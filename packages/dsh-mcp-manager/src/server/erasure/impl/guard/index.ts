/**
 * dsh-mcp-manager — erasure/impl/guard/index.ts：tools:sdk 段的 mcp__ 声明级擦除。
 *
 * 承重约束（三条，判据都在 test/unit/unit-erasure.test.ts）：
 *
 * 1. 只擦行首声明：SDK 生成的 TS 声明里 mcp__ 工具名恒在行首（去缩进后），
 *    散文里的 mcp__ 提及不在行首，故不受影响；段外文本本函数碰不到——
 *    调用方只把 tools:sdk 段的文本递进来。
 * 2. 注释连带：SDK 每条声明自带文档注释，擦声明时把紧贴其上的注释与空行
 *    一并带走，不留无主注释；非 mcp__ 条目的注释原样保留。
 * 3. 花括号深度跟踪：输出映射块按 brace 深度收口，渲染嵌套加深也不提前收口、
 *    更不误删块外行；未知形状宁可保留也不损坏文本（保留分支无计数：warn 只统计成功擦除数，未知形状覆盖靠单测形状断言，漂移即红）。
 */
import type { StartSdkErasureArgs } from "../../interface.ts";

/** 宿主 tools:sdk 分节名（dsh-tools sdkSection 的注册名，本包只读不拥有）。 */
const SDK_SECTION_NAME = "tools:sdk";

/** 注册名前缀（与 server/shared/tool-names.ts 的派生点同源，这里只读不造名）。 */
const MCP_PREFIX = "mcp__";

/** 累计计数（warn 里携带，根因修复前窗口统计不丢失）。 */
export interface ErasureStats {
  rounds: number;
  declarations: number;
}

/** 单次擦除结果。 */
export interface ErasureResult {
  text: string;
  erased: number;
}

/**
 * 可附着行：文档注释行或空行。暂存，见分晓后再决定去留——后面若紧跟 mcp__ 声明
 * 则连带擦掉，否则原样吐回（注释归属判定只看紧邻，不做跨行语义分析）。
 */
function isAttachableLine(line: string): boolean {
  const text = line.trimStart();
  return (
    text === "" ||
    text.startsWith("/**") ||
    text.startsWith("*/") ||
    text.startsWith("* ") ||
    text === "*"
  );
}

/**
 * 行首声明的 mcp__ 工具名；非声明行返回 undefined。
 * 散文提及（如指导文案里的 mcp__）不在行首，天然豁免。
 */
function mcpDeclName(line: string): string | undefined {
  const text = line.trimStart();
  if (!text.startsWith(MCP_PREFIX)) return undefined;
  const rest = text.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return undefined;
  const name = rest.slice(0, sep);
  if (name.length === 0) return undefined;
  for (const ch of name) {
    if (!isDeclIdent(ch)) return undefined;
  }
  return name;
}

/** 声明名是否恒为标识符字符：回答「这一段名字算不算 mcp__ 工具名？」——ASCII 字母/数字/下划线。
 *  擦除面只认这四类字符（SDK 生成的工具名恒满足）；放宽即扩大擦除范围，故单点收口。 */
function isDeclIdent(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_"
  );
}

/** 行内花括号净增量（输出映射块收口跟踪用；只数字面量比较）。 */
function braceDelta(line: string): number {
  return line.split("{").length - line.split("}").length;
}

/**
 * 擦掉 SDK 文本里全部行首 mcp__ 声明（值声明与输出映射块）及其附着注释。
 * 未知形状的行一律保留且不计数（warn 只覆盖成功擦除；未知形状由单测形状断言覆盖）：误删则直接损坏提示词。
 */
export function eraseMcpSdkDeclarations(text: string): ErasureResult {
  const lines = text.split("\n");
  const kept: string[] = [];
  let pending: string[] = [];
  let erased = 0;
  let depth = 0;
  const flushPending = (): void => {
    for (const line of pending) kept.push(line);
    pending = [];
  };
  for (const line of lines) {
    if (depth > 0) {
      depth += braceDelta(line);
      if (depth <= 0) depth = 0;
      continue;
    }
    if (isAttachableLine(line)) {
      pending.push(line);
      continue;
    }
    const name = mcpDeclName(line);
    if (name === undefined) {
      flushPending();
      kept.push(line);
      continue;
    }
    const after = line.slice(line.indexOf(":") + 1).trim();
    if (after === "unknown;") {
      pending = [];
      erased += 1;
      continue;
    }
    if (after === "{") {
      pending = [];
      erased += 1;
      depth = 1;
      continue;
    }
    flushPending();
    kept.push(line);
  }
  flushPending();
  return { text: kept.join("\n"), erased };
}

/**
 * 启动装配侧兜底擦除：订阅宿主组装 waterfall，对下游结果的 tools:sdk 段做声明级擦除。
 * 无泄漏时原样返回下游结果（同一引用，不制造装配抖动）；有泄漏时返回替换了该段文本
 * 的新装配，并 warn 一次（累计计数见 ErasureStats 语义，根因未修前统计不丢）。
 */
export function startSdkErasure(args: StartSdkErasureArgs): () => void {
  const { assemble, logger } = args;
  const stats: ErasureStats = { rounds: 0, declarations: 0 };
  return assemble.onAssemble(async (_assembly, _context, next) => {
    const downstream = await next();
    // 上游其他监听可能在运行时改写形状（宿主类型只约束编译期），先守形状再动手。
    if (!Array.isArray(downstream.sections)) return downstream;
    let roundErased = 0;
    const nextSections = downstream.sections.map((section) => {
      // 上游监听运行在类型之外：空段与异形段直接透传，绝不在此抛（抛即短路整条 waterfall）。
      if (typeof section !== "object" || section === null) return section;
      if (section.name !== SDK_SECTION_NAME || typeof section.text !== "string") return section;
      const result = eraseMcpSdkDeclarations(section.text);
      if (result.erased === 0) return section;
      roundErased += result.erased;
      return { ...section, text: result.text };
    });
    if (roundErased === 0) return downstream;
    stats.rounds += 1;
    stats.declarations += roundErased;
    logger.warn(
      "dsh-mcp-manager: erased " +
        roundErased +
        " leaked mcp__ declaration(s) from tools:sdk (round " +
        stats.rounds +
        ", total " +
        stats.declarations +
        "; transient registration race, see #922)",
    );
    return { ...downstream, sections: nextSections };
  });
}
