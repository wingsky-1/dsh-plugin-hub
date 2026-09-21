/**
 * store 域实现：原子落盘原语（目录 0700 / 文件 0600 / 临时文件+rename）。
 *
 * 只做字节进出，不懂任何业务形状；调用方传完整路径，本模块按需建目录。
 * 同步形态：配置加载发生在装配期，调用栈短、可预测，无需异步。
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** 确保目录存在且为 0700（chmod best-effort，非 POSIX 平台不抛）。 */
export function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 非 POSIX 平台忽略。
  }
}

/** 原子写文件并置 0600（同目录临时文件 + rename；崩溃不留半截文件）。 */
export function atomicWrite0600Sync(file: string, text: string): void {
  ensureDir0700(dirname(file));
  const nonce = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  const tmp = file + ".tmp-" + String(process.pid) + "-" + nonce;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // 非 POSIX 平台忽略。
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 非 POSIX 平台忽略。
  }
}

/** 读文本文件（缺席即 ok:false，由调用方回落默认值）。 */
export function readTextSync(
  file: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false } {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false };
  }
}

/** 读 JSON 文件（缺席/解析失败即 ok:false，不抛）。 */
export function readJsonSync(
  file: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const raw = readTextSync(file);
  if (!raw.ok) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw.text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 文件 mtime 毫秒（取不到即 -1，排序时沉底）。 */
export function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/** 列目录下全部文件名（非目录/不可读即空数组，不抛）。 */
export function listFilesSync(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 删文件（缺席不抛）。 */
export function removeFileSync(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // 缺席或删不掉都不阻断主流程。
  }
}
