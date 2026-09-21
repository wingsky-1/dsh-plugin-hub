/** 落盘 IO 的单一实现（原子写 + 容错读）：先写同目录临时文件、再 `rename` 覆盖目标——同一文件系统内 `rename` 是原子的，读到的
 * 要么旧内容要么新内容、不会是写了一半的 JSON（直接 `writeFile` 到目标则在截断与写入之间有窗口）；失败用返回值表达而不是抛出。 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 读取结果：文件不存在、不可读、是目录都归为「没有内容」。 */
type FileRead = { ok: true; text: string } | { ok: false };

/** 写入结果：失败带回原因文本（不含路径之外的敏感信息）。 */
export type FileWrite = { ok: true } | { ok: false; reason: string };

/** 唯一临时名：pid+时间戳+随机后缀，同进程并发双写不再共用同一 tmp；rename 先后仍无保证 R11，但内容各自完整。 */
function temporaryNameFor(file: string): string {
  return `${file}.tmp-${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
}

/** 读全文。只在装配路径上使用：设置必须在 `apply` 返回时就已是最终值，否则「读面第一次被调用」与「文件加载完成」
 * 之间会开一个窗口。不区分「不存在」与「读失败」——两者处置一致（调用方回落空值），区分只会多一个分支。 */
export function readTextFileSync(file: string): FileRead {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false };
  }
}

/** 原子写全文：补齐父目录 → 写临时文件 → `rename` 覆盖。父目录在这里补齐而不是要求调用方先建：目录是路径的一部分，
 * 谁给出路径谁负责让它可写。 */
export async function writeTextAtomic(file: string, text: string): Promise<FileWrite> {
  const temporary = temporaryNameFor(file);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, text, "utf8");
    await rename(temporary, file);
    return { ok: true };
  } catch (cause) {
    // 不做临时文件清理（本补丁不动错误模型；随机后缀残留不再被覆盖）。
    return { ok: false, reason: cause instanceof Error ? cause.message : "写入失败" };
  }
}

/** 原子写全文（同步版）。只给装配路径上的小文件用（升级链每次推进都要落一次版本号）：同步写换掉的是「装配还没
 * 返回，磁盘上却已是新版本」这类顺序问题。 */
export function writeTextAtomicSync(file: string, text: string): FileWrite {
  const temporary = temporaryNameFor(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, file);
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "写入失败" };
  }
}
