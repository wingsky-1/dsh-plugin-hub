/**
 * dsh-provider-usage — 用户适配器持久化（设置页 add/select 承载，免手改配置）。
 *
 * 自 index.ts 抽离，导出面由 index.ts 转发 re-export
 * 保持不变（外部消费者仍从 lib/index.js 导入）。
 */

import { copyFile, link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { expandHomePath, pluginHome, resolvePath } from "./path-resolve.ts";
import { dshHome as dshHomeDefault } from "../../../../../shared/dsh-home.js";

/** 损坏启用状态的取证备份上限；新隔离的现场始终保留，其余按文件名时间戳轮转。 */
export const ADAPTER_STATE_BACKUP_LIMIT = 5;

/** 用户适配器登记条目（add 路由写入、启动时合并加载）。 */
export interface UserAdapterRecord {
  /** 适配器唯一名（= mjs 导出的 name）。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 认领的 provider 列表。 */
  providers: string[];
  /** 文件路径（绝对路径或可解析形态）。 */
  file: string;
}

/** 用户适配器清单文件路径（历史根目录下）。 */
export function userAdaptersFile(root: string): string {
  return join(root, "user-adapters.json");
}

/** 启用选择状态文件路径（历史根目录下）。 */
export function adapterStateFile(root: string): string {
  return join(root, "adapter-state.json");
}

/** plain object 判定（类型谓词，承担当前收窄）。 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 单条清单项归一（纯函数）：字段逐个容错取值，id/providers/file 三者齐备才成条目
 * （缺一即视为坏条目丢弃——清单损坏不得让半条记录进入注册面）。
 * label 缺省回落 id。
 */
export function toAdapterRecord(item: unknown): UserAdapterRecord | undefined {
  if (!isRecordLike(item)) return undefined;
  const id = typeof item.id === "string" ? item.id : "";
  const label = typeof item.label === "string" ? item.label : "";
  const providers = Array.isArray(item.providers)
    ? item.providers.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const file = typeof item.file === "string" ? item.file : "";
  if (id.length === 0 || providers.length === 0 || file.length === 0) return undefined;
  return { id, label: label || id, providers, file };
}

/** 清单外壳解析（纯函数）：adapters 数组或 undefined（坏文件/顶层形态无效皆视作无）。 */
export function adapterListOf(data: unknown): unknown[] | undefined {
  if (!isRecordLike(data)) return undefined;
  const list = data["adapters"];
  return Array.isArray(list) ? list : undefined;
}

/** 防御式解析用户适配器清单文本（坏文件返回 []）。 */
export function parseUserAdapters(raw: string | undefined): UserAdapterRecord[] {
  if (typeof raw !== "string" || raw === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = adapterListOf(data);
  if (list === undefined) return [];
  const out: UserAdapterRecord[] = [];
  for (const item of list) {
    const record = toAdapterRecord(item);
    if (record !== undefined) out.push(record);
  }
  return out;
}

/** 读取用户适配器清单（坏文件/不存在返回 []）。 */
export async function readUserAdapters(root: string): Promise<UserAdapterRecord[]> {
  try {
    if (!existsSync(userAdaptersFile(root))) return [];
    return parseUserAdapters(await readFile(userAdaptersFile(root), "utf8"));
  } catch {
    return [];
  }
}

type AdapterStateReadStatus = "missing" | "ok" | "invalid-shape" | "quarantined" | "unreadable";

interface AdapterStateReadResult {
  state: Record<string, string | null>;
  status: AdapterStateReadStatus;
  detail?: string;
  backupFile?: string;
}

interface AdapterStateReadOptions {
  diagnostic?: (message: string) => void;
  now?: () => number;
  moveToBackup?: (file: string, backupBase: string) => Promise<string>;
}

function thrownDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "不可显示的错误";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function defaultAdapterStateDiagnostic(message: string): void {
  console.warn(`[dsh-provider-usage] ${message}`);
}

/** 不支持 hard-link 的文件系统错误码（退化为 exclusive copy 的前提）。 */
const HARDLINK_UNSUPPORTED = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"];

/**
 * no-clobber 占位（true = candidate 已占位；false = 已被占，换名重试）。
 * 同目录 hard-link 创建具备原子 no-clobber 语义；不支持时退化为 exclusive copy
 * （原文件仅在完整复制后才由调用方移除）。其余错误上抛。
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

/** 占位成功后移除原路径即完成隔离；移除失败则证据与现场并存，上抛交调用方 fail-closed。 */
async function unlinkIsolatedOriginal(file: string, candidate: string): Promise<void> {
  try {
    await unlink(file);
  } catch (unlinkError: unknown) {
    // candidate 已完整保留证据；原文件也仍在，调用方会 fail-closed，禁止后续写入覆盖。
    throw new Error(
      `备份已留存在 ${basename(candidate)}，但移除原文件失败：${thrownDetail(unlinkError)}`,
    );
  }
}

async function moveToBackupNoClobber(file: string, backupBase: string): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? backupBase : `${backupBase}-${suffix}`;
    if (!(await reserveNoClobber(file, candidate))) continue;
    await unlinkIsolatedOriginal(file, candidate);
    return candidate;
  }
}

interface AdapterStateBackupEntry {
  file: string;
  timestamp: number;
  suffix: number;
}

/**
 * 目录内取证备份名归集（纯函数）：只认 `<prefix><ts>[-<n>]` 形态且时间戳/序号
 * 落在安全整数域的条目，按 (ts, n) 升序返回。
 */
export function collectBackupEntries(
  names: readonly string[],
  directory: string,
  prefix: string,
): AdapterStateBackupEntry[] {
  const entries: AdapterStateBackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(name.slice(prefix.length));
    if (match === null) continue;
    const timestamp = Number(match[1]);
    const suffix = Number(match[2] ?? 0);
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(suffix)) continue;
    entries.push({ file: join(directory, name), timestamp, suffix });
  }
  return entries.sort(
    (left, right) => left.timestamp - right.timestamp || left.suffix - right.suffix,
  );
}

/** 轮转删除名单（纯函数）：剔除受保护的新备份，按老→新取超出上限的部分。 */
export function removableBackupFiles(
  entries: readonly AdapterStateBackupEntry[],
  protectedBackup: string,
): string[] {
  const protectedPath = resolve(protectedBackup);
  const removable = entries.filter((entry) => resolve(entry.file) !== protectedPath);
  const removeCount = Math.max(0, removable.length - (ADAPTER_STATE_BACKUP_LIMIT - 1));
  return removable.slice(0, removeCount).map((entry) => entry.file);
}

async function rotateAdapterStateBackups(
  file: string,
  protectedBackup: string,
  diagnostic: (message: string) => void,
): Promise<void> {
  const directory = dirname(file);
  const prefix = `${basename(file)}.bak-`;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    diagnostic(
      `adapter-state.json 取证备份轮转扫描失败（${thrownDetail(error)}）；现有备份保持不变`,
    );
    return;
  }
  const entries = collectBackupEntries(names, directory, prefix);
  for (const target of removableBackupFiles(entries, protectedBackup)) {
    try {
      await unlink(target);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") continue;
      diagnostic(
        `adapter-state.json 旧取证备份 ${basename(target)} 轮转失败（${thrownDetail(error)}）；现有备份保持不变`,
      );
    }
  }
}

async function quarantineAdapterState(
  file: string,
  reason: string,
  detail: string,
  status: "quarantined" | "invalid-shape",
  diagnostic: (message: string) => void,
  now: () => number,
  moveToBackup: (file: string, backupBase: string) => Promise<string>,
): Promise<AdapterStateReadResult> {
  const backupBase = `${file}.bak-${now()}`;
  try {
    const backupFile = await moveToBackup(file, backupBase);
    await rotateAdapterStateBackups(file, backupFile, diagnostic);
    diagnostic(
      `adapter-state.json ${reason}，已隔离留证为 ${basename(backupFile)}；备份仅供取证、不会自动恢复，最多保留 ${ADAPTER_STATE_BACKUP_LIMIT} 份；本次按默认启用关系继续`,
    );
    return { state: {}, status, detail, backupFile };
  } catch (quarantineError: unknown) {
    const quarantineDetail = `${reason}且隔离失败：${thrownDetail(quarantineError)}`;
    diagnostic(`adapter-state.json ${quarantineDetail}；为保留现场，本次按默认启用关系继续`);
    return { state: {}, status: "unreadable", detail: quarantineDetail };
  }
}

/**
 * 读取持久化的启用映射并返回内部诊断状态。
 *
 * JSON 语法损坏或顶层形态无效时，以 no-clobber hard-link（不支持时 exclusive copy）
 * + unlink 隔离为 `.bak-<ts>[-n]` 留证，再按空状态继续。备份不会自动回灌，
 * 仅保留最近 ADAPTER_STATE_BACKUP_LIMIT 份（始终保护本次新备份）；
 * 普通 I/O 失败则标为 unreadable，供写路径 fail-closed，避免把无法读取的旧状态覆盖掉。
 * 本函数仅供包内 apply 与源码级测试使用；公开兼容面仍为 readAdapterState(root)。
 */
/**
 * 启用映射归一（纯函数，两条读路径共用同一容错口径）：
 * - key 必须是非空串；
 * - 值为 null 表示「显式清空」，保留；
 * - 值为非空串表示启用者，保留；
 * - 其余（空串、数字、对象、数组、undefined）一律丢弃。
 */
export function adapterStateMap(data: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [provider, id] of Object.entries(data)) {
    if (provider.length === 0) continue;
    if (id === null) out[provider] = null;
    else if (typeof id === "string" && id.length > 0) out[provider] = id;
  }
  return out;
}

/** 顶层非 plain object 时的形态标签（隔离文案用，须与判词一致）。 */
export function describeTopLevelShape(parsed: unknown): string {
  if (parsed === null) return "null";
  if (Array.isArray(parsed)) return "array";
  return typeof parsed;
}

/** 读盘结果：原文，或已定稿的失败结果（键集合与历史逐字一致，缺失即缺失）。 */
type AdapterStateFileRead =
  { ok: true; raw: string } | { ok: false; result: AdapterStateReadResult };

/** 启用状态文件读盘（ENOENT → missing；其他 I/O 失败 → 已诊断的 unreadable）。 */
async function readAdapterStateFile(
  file: string,
  diagnostic: (message: string) => void,
): Promise<AdapterStateFileRead> {
  try {
    return { ok: true, raw: await readFile(file, "utf8") };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT")
      return { ok: false, result: { state: {}, status: "missing" } };
    const detail = thrownDetail(error);
    diagnostic(`adapter-state.json 读取失败（${detail}），本次按默认启用关系继续`);
    return { ok: false, result: { state: {}, status: "unreadable", detail } };
  }
}

/** 隔离所需的注入参数（now / moveToBackup 的缺省兜底集中在此）。 */
function quarantineHooks(
  options: AdapterStateReadOptions,
  diagnostic: (message: string) => void,
): {
  diagnostic: (message: string) => void;
  now: () => number;
  moveToBackup: (file: string, backupBase: string) => Promise<string>;
} {
  return {
    diagnostic,
    now: options.now ?? Date.now,
    moveToBackup: options.moveToBackup ?? moveToBackupNoClobber,
  };
}

export async function readAdapterStateResult(
  root: string,
  options: AdapterStateReadOptions = {},
): Promise<AdapterStateReadResult> {
  const diagnostic = options.diagnostic ?? defaultAdapterStateDiagnostic;
  const file = adapterStateFile(root);
  const read = await readAdapterStateFile(file, diagnostic);
  if (!read.ok) return read.result;
  const hooks = quarantineHooks(options, diagnostic);

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch (parseError: unknown) {
    return quarantineAdapterState(
      file,
      "JSON 损坏",
      thrownDetail(parseError),
      "quarantined",
      hooks.diagnostic,
      hooks.now,
      hooks.moveToBackup,
    );
  }

  // 顶层必须是 plain object——null / 数组 / 字符串等类数组输入一律拒绝，
  // 并隔离原文留证，避免后续状态写把现场直接覆盖掉。
  if (!isRecordLike(parsed)) {
    const actual = describeTopLevelShape(parsed);
    return quarantineAdapterState(
      file,
      `顶层结构无效（必须为对象，实际为 ${actual}）`,
      `invalid top-level type: ${actual}`,
      "invalid-shape",
      hooks.diagnostic,
      hooks.now,
      hooks.moveToBackup,
    );
  }
  return { state: adapterStateMap(parsed), status: "ok" };
}

/** 读取持久化的启用映射（provider → name；null 表示显式清空）。 */
export async function readAdapterState(root: string): Promise<Record<string, string | null>> {
  // 保持既有公开 API 语义：所有失败静默返回空对象，且不改动调用方文件。
  // 带诊断/隔离的恢复路径仅由包内 apply 调用 readAdapterStateResult。
  try {
    if (!existsSync(adapterStateFile(root))) return {};
    const parsed: unknown = JSON.parse(await readFile(adapterStateFile(root), "utf8"));
    return isRecordLike(parsed) ? adapterStateMap(parsed) : {};
  } catch {
    return {};
  }
}

async function syncParentDirectory(root: string): Promise<void> {
  // Windows 不支持以可 fsync 的方式打开目录；rename 仍保持原子替换语义。
  if (process.platform === "win32") return;
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(root, "r");
    await directory.sync();
  } catch (error: unknown) {
    // 部分文件系统明确不支持目录 fsync；这类平台保留文件 fsync + 原子 rename。
    if (["EINVAL", "ENOTSUP", "ENOSYS", "EBADF", "EISDIR"].includes(errorCode(error) ?? "")) return;
    throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
}

/**
 * 原子、耐久写入启用映射：独占临时文件（POSIX 0600；Windows 依赖用户 ACL）
 * → fsync → rename → 目录 fsync。
 * rename 前失败会清理临时文件并向调用方抛错，旧目标文件保持不变；rename 成功后
 * 目录 fsync 失败只表示崩溃耐久性未完全确认，已提交的新状态保持生效并经独立诊断上报。
 */
export async function writeAdapterState(
  root: string,
  state: Record<string, string | null>,
  durabilityDiagnostic: (message: string) => void,
): Promise<void> {
  const file = adapterStateFile(root);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(state);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let temporaryExists = false;
  try {
    const handle = await open(tmp, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    temporaryExists = false;
    try {
      await syncParentDirectory(root);
    } catch (error: unknown) {
      const detail = thrownDetail(error);
      try {
        durabilityDiagnostic(
          `adapter-state.json 已原子替换，但父目录 fsync 失败（${detail}）；新状态已提交，崩溃后的耐久性未完全确认`,
        );
      } catch {
        // 诊断通道自身失败也不能把已经完成的 rename 反向误报为写入失败。
      }
    }
  } catch (error: unknown) {
    if (temporaryExists) await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** 入参规整（纯函数）：非串、空串、含 NUL 一律拒。 */
export function normalizeAdapterFileInput(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.includes("\0")) return undefined;
  return trimmed;
}

/**
 * 拒绝 a/../b、./x 未规整形态（禁穿越）。比对前做分隔符归一：Windows 下
 * `~` 展开会产混合分隔符（home 段是反斜杠、用户写的余段保留 /），resolve 归一 / → \
 * 属平台语义而非未规整——按字面比对会把 ~/x 与全部正斜杠绝对路径误拒；
 * POSIX 分隔符归一为恒等变换，行为与历史实现完全一致，穿越段仍被拒。
 */
export function isUntraversedPath(expanded: string): boolean {
  const sepCanonical = (s: string) => (process.platform === "win32" ? s.replace(/\\/g, "/") : s);
  return sepCanonical(resolve(expanded)) === sepCanonical(expanded);
}

/** 相对路径：解析结果必须位于 DSH_HOME 或插件 home 之内 */
export function containedInHomes(dshHome: string, resolved: string): string | undefined {
  for (const base of [dshHome, pluginHome(dshHome)]) {
    const rel = relative(base, resolved);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return resolved;
  }
  return undefined;
}

/** 校验 add 入参 file 字段：文件存在可读 + 路径规整禁穿越。 */
export function resolveAddAdapterFile(
  input: unknown,
  dshHome = dshHomeDefault(),
): string | undefined {
  const trimmed = normalizeAdapterFileInput(input);
  if (trimmed === undefined) return undefined;
  const expandedForCheck = expandHomePath(trimmed);
  if (!isUntraversedPath(expandedForCheck)) return undefined;
  const resolved = resolvePath(expandedForCheck);
  if (resolved === undefined) return undefined;
  return isAbsolute(trimmed) ? resolved : containedInHomes(dshHome, resolved);
}
