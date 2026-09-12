/**
 * dsh-notifier 包内 —— **落盘 IO 的单一实现**（原子写 + 容错读）。
 *
 * 三个存储（配置 / 历史 / 投递状态）共用同一套写入纪律：先写同目录临时文件、再
 * `rename` 覆盖目标。`rename` 在同一文件系统内是原子的，因此任何时刻读到的要么是
 * 旧内容、要么是新内容，不会是写了一半的半截 JSON——进程被杀、磁盘写满都落在这个
 * 保证里。直接 `writeFile` 到目标路径则不成立：截断与写入之间有窗口。
 *
 * 临时文件名固定为 `<目标>.tmp-<pid>`：同一进程内的写入由各域的写队列串行化，
 * 不会互相踩；跨进程同名覆盖也只是浪费一次写，不会产生半截的目标文件（目标文件
 * 由 `rename` 换成，永远完整）。
 *
 * 失败用返回值表达而不是抛出：三个域的调用点都在「通知主流程」的旁路上，
 * 它们要的是「记一条日志」，不是「在 catch 里分辨异常种类」。
 *
 * 依赖方向：只引用 Node 内置模块，不引用任何域。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 读取结果：文件不存在、不可读、是目录都归为「没有内容」。 */
type FileRead = { ok: true; text: string } | { ok: false };

/** 写入结果：失败带回原因文本（不含路径之外的敏感信息）。 */
export type FileWrite = { ok: true } | { ok: false; reason: string };

/**
 * 读全文。
 *
 * 只在装配路径上使用：设置必须在 `apply` 返回时就已是最终值，否则「读面第一次被
 * 调用」与「文件加载完成」之间会开一个窗口，窗口内的读者拿到的是尚未生效的默认值。
 * 单次几 KB 的读，代价一次性付清。
 *
 * 不区分「不存在」与「读失败」：两者的处置一致——调用方回落到空值，下一次写入把
 * 目录与文件一并补出来。区分它们只会让每个调用点多一个分支。
 */
export function readTextFileSync(file: string): FileRead {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false };
  }
}

/**
 * 原子写全文：补齐父目录 → 写临时文件 → `rename` 覆盖。
 *
 * 父目录在这里补齐而不是要求调用方先建：目录是路径的一部分，谁给出路径谁负责
 * 让它可写。
 */
export async function writeTextAtomic(file: string, text: string): Promise<FileWrite> {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, text, "utf8");
    await rename(temporary, file);
    return { ok: true };
  } catch (cause) {
    // 不做临时文件清理：同名临时文件会被下一次写入覆盖，不会累积。
    return { ok: false, reason: cause instanceof Error ? cause.message : "写入失败" };
  }
}

/**
 * 原子写全文（同步版）。
 *
 * 只给装配路径上的小文件用（升级链每次推进都要落一次版本号）：同步写换掉的是
 * 「装配还没返回，磁盘上却已是新版本」这类顺序问题，代价一次性付清。
 */
export function writeTextAtomicSync(file: string, text: string): FileWrite {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, file);
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "写入失败" };
  }
}
