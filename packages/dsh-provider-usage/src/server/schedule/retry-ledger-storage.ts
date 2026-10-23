/**
 * dsh-provider-usage — 报告重试状态账本：存储面（#1174 阶段 2）。
 *
 * 账本文件的落盘语义唯一物理定义处：0600 临时文件 → fsync → atomic rename →
 * 目录 fsync、损坏文件 no-clobber 取证隔离与 fail-closed 标记、备份轮转上限。
 * retryLedgerFile 是 retry-ledger.json 路径的唯一定义。
 *
 * per-root 串行锁与「读-改-写」的事务边界不在本模块：锁在 retry-ledger.ts，
 * 本模块只提供被它串起来的单步读（readDocumentUnlocked）与单步写（writeDocumentUnlocked）。
 *
 * 单向依赖 schema（错误类与文档类型）与 document（克隆/序列化/墓碑裁剪），不依赖工厂面。
 */

import { constants, existsSync } from "node:fs";
import { chmod, copyFile, link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { temporaryNameFor } from "../../shared/interface.ts";
import {
  RetryLedgerError,
  parseDocument,
  type RetryLedgerDocument,
} from "./retry-ledger-schema.ts";
import { emptyDocument, pruneTerminalEntries, serializeDocument } from "./retry-ledger-document.ts";

const CORRUPT_BACKUP_LIMIT = 5;
interface BackupEntry {
  name: string;
  timestamp: number;
  suffix: number;
}

export function retryLedgerFile(root: string): string {
  return join(root, "reports", "retry-ledger.json");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function storageError(): RetryLedgerError {
  return new RetryLedgerError("retry-ledger-storage", "retry ledger storage operation failed");
}

function corruptError(): RetryLedgerError {
  return new RetryLedgerError(
    "retry-ledger-corrupt",
    "retry ledger is quarantined; manual recovery is required",
  );
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EBADF", "EISDIR"].includes(
        errorCode(error) ?? "",
      )
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureReportsDirectory(root: string): Promise<string> {
  const reports = join(root, "reports");
  try {
    await mkdir(reports, { recursive: true, mode: 0o700 });
    await chmod(reports, 0o700);
    return reports;
  } catch {
    throw storageError();
  }
}

async function ensureCorruptMarker(reports: string): Promise<void> {
  const marker = join(reports, "retry-ledger.json.corrupt");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(marker, "wx", 0o600);
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") return;
    throw storageError();
  }
  try {
    await handle.writeFile("retry-ledger-corrupt\n", "utf8");
    await handle.sync();
  } catch {
    throw storageError();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await syncDirectory(reports);
  } catch {
    throw storageError();
  }
}

/** 不支持 hard-link 的文件系统错误码（退化为 exclusive copy 的前提）。 */
const HARDLINK_UNSUPPORTED = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"];

/**
 * no-clobber 占位（返回 true = candidate 已占位；false = 已被占，换名重试）。
 * 同目录 hard-link 创建具备原子 no-clobber 语义；不支持时退化为 exclusive copy。
 * 其余错误上抛（证据不完整，不得继续隔离流程）。
 */
async function reserveNoClobber(file: string, candidate: string): Promise<boolean> {
  try {
    await link(file, candidate);
    return true;
  } catch (linkError: unknown) {
    if (errorCode(linkError) === "EEXIST") return false;
    if (!HARDLINK_UNSUPPORTED.includes(errorCode(linkError) ?? "")) throw linkError;
    try {
      await copyFile(file, candidate, constants.COPYFILE_EXCL);
      return true;
    } catch (copyError: unknown) {
      if (errorCode(copyError) === "EEXIST") return false;
      throw copyError;
    }
  }
}

async function moveToBackupNoClobber(file: string, backupBase: string): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? backupBase : `${backupBase}-${suffix}`;
    if (!(await reserveNoClobber(file, candidate))) continue;
    await chmod(candidate, 0o600);
    await unlink(file);
    return candidate;
  }
}

function backupEntries(names: readonly string[], prefix: string): BackupEntry[] {
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(name.slice(prefix.length));
    if (match === null) continue;
    entries.push({
      name,
      timestamp: Number(match[1]),
      suffix: Number(match[2] ?? 0),
    });
  }
  return entries.sort(
    (left, right) => left.timestamp - right.timestamp || left.suffix - right.suffix,
  );
}

async function rotateBackups(
  reports: string,
  file: string,
  protectedBackup: string,
): Promise<void> {
  const prefix = "retry-ledger.json.bak-";
  const entries = backupEntries(await readdir(reports), prefix);
  const protectedPath = resolve(protectedBackup);
  const removable = entries.filter((entry) => resolve(join(reports, entry.name)) !== protectedPath);
  const removeCount = Math.max(0, removable.length - (CORRUPT_BACKUP_LIMIT - 1));
  for (const entry of removable.slice(0, removeCount)) {
    await unlink(join(reports, entry.name));
  }
  await syncDirectory(dirname(file));
}

async function quarantineCorrupt(root: string, file: string, now: number): Promise<never> {
  const reports = await ensureReportsDirectory(root);
  await ensureCorruptMarker(reports);
  try {
    const backup = await moveToBackupNoClobber(file, `${file}.bak-${now}`);
    await rotateBackups(reports, file, backup);
  } catch {
    throw storageError();
  }
  throw corruptError();
}

export async function readDocumentUnlocked(
  root: string,
  now: number,
): Promise<RetryLedgerDocument> {
  const file = retryLedgerFile(root);
  const reports = dirname(file);
  if (existsSafe(join(reports, "retry-ledger.json.corrupt"))) throw corruptError();

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return emptyDocument();
    throw storageError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorrupt(root, file, now);
  }
  try {
    return pruneTerminalEntries(parseDocument(parsed));
  } catch {
    await quarantineCorrupt(root, file, now);
    throw corruptError();
  }
}

function existsSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export async function writeDocumentUnlocked(
  root: string,
  document: RetryLedgerDocument,
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const file = retryLedgerFile(root);
  const reports = await ensureReportsDirectory(root);
  // 独占临时名走 shared 单一实现：同进程并发双写各落各的 tmp（open "wx" 的独占性才有意义）。
  const temporary = temporaryNameFor(file);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(serializeDocument(document), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameFile(temporary, file);
    temporaryExists = false;
    await chmod(file, 0o600);
    await syncDirectory(reports);
  } catch {
    if (temporaryExists) await unlink(temporary).catch(() => {});
    throw storageError();
  }
}
