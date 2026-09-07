/**
 * dsh-web-file-preview — 文本/二进制内容嗅探（宿主端专属，issue #630 改动 B）。
 *
 * 白名单（grouping.ts）未命中的 other 组不再一律 415：按业界共识（git
 * buffer_is_binary、VS Code encoding.ts、GitHub blob 渲染同款思路）做内容嗅探，
 * 文本按 text 组直出、二进制维持 415 占位 + ?dl=1 下载出口。
 *
 * 模块边界（红线）：本模块是 Node fs 能力封装，**禁止**被双端共用的
 * grouping.ts 引用——否则浏览器端 esbuild 打包破坏、违反客户端干净模块约定。
 *
 * 实现：引入成熟开源库 isbinaryfile（零依赖、MIT、jest 同款；pin 5.0.4——
 * 6.0.0 engines 要求 node>=24，与本包 node>=20 冲突）。算法优于手写 NUL 嗅探：
 * 覆盖无 BOM 的 UTF-16（奇偶位 NUL 统计）、非法 UTF-8 比例阈值、%PDF- 头等
 * 误判源；传 Buffer 时内部只看样本窗口，无读放大。
 * BOM 判定：带 BOM 一律视为文本（BOM 是明确的编码自述，NUL 语义不适用）；
 * 转码覆盖 TextDecoder 原生标签（UTF-8/UTF-16LE/BE）+ 手写 UTF-32 解码；
 * GB18030 等外来 BOM 判文本但不转码（与白名单内同类文件的现状行为一致）。
 */

import { isBinaryFileSync } from "isbinaryfile";
import { open } from "node:fs/promises";

/** 嗅探样本窗口（与 isbinaryfile 内部 512B 窗口一致；单次 open+read 复用）。 */
export const SNIFF_SAMPLE_BYTES = 512;

/** 嗅探结论：text（附可选 BOM 转码标签）按文本直出；binary 走 415 占位。 */
export type SniffVerdict =
  | { kind: "text"; bom?: string }
  | { kind: "binary" };

/** BOM 前缀 → 转码标签（UTF-32 项在前，避免 FF FE 00 00 被 UTF-16LE 前缀吞掉）。 */
const BOM_DESCRIPTORS: Array<{ prefix: number[]; label: string }> = [
  { prefix: [0xff, 0xfe, 0x00, 0x00], label: "utf-32le" },
  { prefix: [0x00, 0x00, 0xfe, 0xff], label: "utf-32be" },
  { prefix: [0xef, 0xbb, 0xbf], label: "utf-8" },
  { prefix: [0xff, 0xfe], label: "utf-16le" },
  { prefix: [0xfe, 0xff], label: "utf-16be" },
];

/** 头部 BOM → 转码标签（无 BOM → undefined）。纯函数，可单测。 */
export function bomLabelOf(head: Buffer): string | undefined {
  for (const { prefix, label } of BOM_DESCRIPTORS) {
    if (head.length >= prefix.length && prefix.every((byte, i) => head[i] === byte)) {
      return label;
    }
  }
  return undefined;
}

/**
 * other 组文件 → 文本直出 or 二进制占位。
 * 先看样本 BOM（带 BOM 一律文本），再交 isbinaryfile 嗅探（无 BOM 的启发式
 * UTF-16 由库判 binary → 保守按二进制占位——占位卡有下载出口，不做启发式
 * endianness 转码赌博）。空文件按文本（200 空 body）。
 * 抛出的 IO 错误（EACCES、stat 后竞态删除等）由调用方并入 readErrorCode 语义。
 */
export async function sniffKind(resolved: string): Promise<SniffVerdict> {
  const handle = await open(resolved, "r");
  let sample: Buffer;
  try {
    const buf = Buffer.alloc(SNIFF_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_SAMPLE_BYTES, 0);
    sample = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const bom = sample.length > 0 ? bomLabelOf(sample) : undefined;
  if (bom !== undefined) return { kind: "text", bom };
  return isBinaryFileSync(sample) ? { kind: "binary" } : { kind: "text" };
}

/** UTF-32 手写解码（Node TextDecoder 无 UTF-32 标签；非法/代理区码点跳过）。 */
function decodeUtf32(data: Buffer, little: boolean): string {
  let out = "";
  for (let i = 0; i + 4 <= data.length; i += 4) {
    const cp = little ? data.readUInt32LE(i) : data.readUInt32BE(i);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * 按 sniffKind 回传的 BOM 标签转码整份文件（含 BOM 的完整 Buffer；BOM 剥除）。
 * 标签不认识时返回 undefined（调用方回退 UTF-8 直出，行为等同现状）。
 */
export function decodeWithBom(data: Buffer, bom: string): string | undefined {
  if (bom === "utf-32le" || bom === "utf-32be") {
    return decodeUtf32(data.subarray(4), bom === "utf-32le");
  }
  if (bom === "utf-16le" || bom === "utf-16be") {
    return new TextDecoder(bom).decode(data.subarray(2));
  }
  if (bom === "utf-8") return new TextDecoder("utf-8").decode(data.subarray(3));
  return undefined;
}
