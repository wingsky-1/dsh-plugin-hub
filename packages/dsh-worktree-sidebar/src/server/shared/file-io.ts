/**
 * 落盘 IO 的单一实现：先写同目录临时文件、再 `rename` 覆盖。
 *
 * 同一文件系统内 `rename` 是原子的，读到的要么是旧内容要么是新内容；
 * 直接 `writeFile` 到目标则在截断与写入之间留了窗口，而绑定表被读的时刻
 * 恰好是文件树的每次刷新。失败用返回值表达而不是抛出——调用方的处置一律是
 * 「保持上次成功态 + 出声」，异常在类型上就不该是控制流。
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 读取结果：「不存在」「不可读」「是目录」归为同一类——调用方对三者的处置都是回落空值。 */
type FileRead = { readonly ok: true; readonly text: string } | { readonly ok: false };

/** 写入结果。 `reason` 是给日志用的原因文本，不含路径之外的额外事实。 */
export type FileWrite = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** 同步读全文。只给装配路径用：装配返回时必须已拿到最终值，否则会开一个「读面已可用、文件还没加载」的窗口。 */
export function readTextFileSync(file: string): FileRead {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false };
  }
}

/** 原子写全文：补齐父目录 → 写临时文件 → `rename` 覆盖。父目录在这里补齐，谁给出路径谁负责让它可写。 */
export async function writeTextAtomic(file: string, text: string): Promise<FileWrite> {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, text, "utf8");
    await rename(temporary, file);
    return { ok: true };
  } catch (cause) {
    // 不清临时文件：同名临时文件会被下一次写入覆盖，不会累积。
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
