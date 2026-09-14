/**
 * 落盘 IO 原语：原子写 + 容错读。
 *
 * 为什么自写而不引库：三个候选各自缺一项——`atomically` 在模块加载期就接管宿主退出路径、
 * `write-file-atomic` 没有写队列、`steno` 不收 mode 且合并写（§7.5 的比较表）。自写只比
 * 现状多一条串行链，换来「零依赖 + 不装进程级钩子 + 显式 mode」。
 *
 * 写函数恒定四件事：唯一临时名 → 显式 mode 写入 → `rename` 覆盖 → 失败清理临时名并上抛
 * **原错误**。同目标路径的写串行：`rename` 的先后在并发下没有保证，旧数据可能覆盖新数据（R11）。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { directoryMode, fileMode } from "./paths.ts";

/**
 * 同目标路径的写链。这是**模块级**的（I9 的例外）：串行必须跨调用点生效，收进实例反而各写各的。
 * 前一次 settle 之后才发起下一次；前一次失败不阻断下一次（链本身不能被一次失败毒化）。
 */
const writeChains = new Map<string, Promise<void>>();

/** 唯一临时名：pid + 时间戳 + 随机后缀——同名临时文件绝不会被两次写共用。 */
function temporaryNameFor(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
}

/** 建目录并落登记的 mode：插件自有目录 0o700，项目 `.dsh/` 随项目自身权限模型。 */
export async function ensureDir(dir: string): Promise<void> {
  const mode = directoryMode(dir);
  await mkdir(dir, mode === null ? { recursive: true } : { recursive: true, mode });
}

/** 单次写（不含串行）：失败清理临时名后上抛原错误，残留临时名不留给下一次写踩踏。 */
async function writeOnce(file: string, data: string): Promise<void> {
  // 落在任何落盘动作之前：未登记的路径不该先建目录、再抛错。
  const mode = fileMode(file);
  await ensureDir(dirname(file));
  const temporary = temporaryNameFor(file);
  try {
    await writeFile(
      temporary,
      data,
      mode === null ? { encoding: "utf8" } : { encoding: "utf8", mode },
    );
    await rename(temporary, file);
  } catch (cause) {
    // 清理失败不掩盖原错误：调用方要看到的是「为什么没写成」，不是「清理也没成」。
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** 原子写全文：mode 取自 `paths.ts` 的登记表，未登记即抛错（不写权限未登记的文件）。 */
export function writeFileAtomic(file: string, data: string): Promise<void> {
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(
    () => writeOnce(file, data),
    () => writeOnce(file, data),
  );
  writeChains.set(file, next);
  return next.finally(() => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  });
}

/** 容错读全文：不存在 / 不可读 / 是目录一律回落 null，由各域按既有语义回落空值。 */
export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** 容错读 JSON：解析失败同样回落 null——坏文件是各域读面的常态，不是进程失败。 */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  const text = await readTextFile(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
