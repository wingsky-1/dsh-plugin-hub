/**
 * dsh-provider-usage — upgrade 域存储归位（historyRoot 内扁平旧形态 → reports/ 子目录）。
 *
 * 两条判据在这里落地：**纯字节搬移**（不 JSON.parse：坏文件的格式知识属各域容错读面，
 * 迁移把它原样搬到新位置）、**归档一律执行**（目标已存在时也不覆盖目标，
 * 旧文件改成固定名留痕 = 幂等标记）。
 *
 * 可再生落点不进迁移：trend/（会话用量趋势明细/聚合分片，缺了由 TrendTracker 按空形态重建，
 * 搬旧值反而可能把过期快照当成新数据）、history/ 下按天分片 JSONL（HistoryStore append
 * 热路径自建，迁移只保证 reports/ 一族；history/ 旧 v3 桶迁移由 HistoryStore.migrateLegacyV3
 * 在装配后处理，不属本链）——缺了由各域按空形态重建。
 *
 * 读经注入（deps.readOldFile 读旧文件字节，不直连 fs 读旧文件）、写经同域原语
 * （writeFileAtomic 0600 原子写）、归档经直接 fs（renameSync 固定名留痕）。
 * 禁新建 file-io 叶（S2 约束）：本文件即存储原语的唯一落点，不另起 shared/file-io。
 */
import { existsSync, renameSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { UpgradeDeps } from "./deps.ts";
import { LAST_RUN_SCHEMA } from "../shared/interface.ts";

/** 归档后缀：搬完留证据，也是「这一份处理过了」的标记（固定名 → 重跑不累积）。 */
export const MIGRATED_SUFFIX = ".migrated.bak";

/**
 * 空落盘形态。初始形态一律是**版本化空形**而不是全量默认值快照——写全量默认值会把
 * 「用户覆盖过哪些键」这个语义冲掉（文件里每个键都会被读成用户显式提交的）。
 * 读面均容忍 version/schema 附加字段（normalizeReportConfig/readLastRun 白名单投影），
 * 故附加版本字段不改变归一化结果，只起「已落定初始形态」的标记作用。
 */
const EMPTY_CONFIG = `${JSON.stringify({ version: 1 }, null, 2)}\n`;
const EMPTY_LAST_RUN = `${JSON.stringify({ schema: LAST_RUN_SCHEMA }, null, 2)}\n`;

/** 同目标路径的写链：rename 先后在并发下无保证，串行防旧数据盖新数据。 */
const writeChains = new Map<string, Promise<void>>();

function temporaryNameFor(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

async function writeOnce(file: string, data: string): Promise<void> {
  await ensureDir(dirname(file));
  const temporary = temporaryNameFor(file);
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/**
 * 原子写全文（0600，tmp+rename，失败清理临时名后上抛原错误）。
 * version.ts 的刻度回写与三步迁移的落盘统一经此原语（同一目录内相对引用）。
 */
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

/** 旧扁平形态（historyRoot 根下，reports/ 子目录化之前的落点；迁移读面，新代码不得回写）。 */
export function legacyConfigFile(root: string): string {
  return join(root, "config.json");
}

/** 旧扁平形态（同上）。 */
export function legacyLastRunFile(root: string): string {
  return join(root, "last-run.json");
}

/** 新形态：报告配置（运行时读面见 server/config/store.ts 的 reportConfigFile，同字面量）。 */
export function targetConfigFile(root: string): string {
  return join(root, "reports", "config.json");
}

/** 新形态：lastRun 投影（运行时读面见 server/schedule/store.ts，同字面量；D2 前在 domain2/common/last-run.ts）。 */
export function targetLastRunFile(root: string): string {
  return join(root, "reports", "last-run.json");
}

interface LayoutEntry {
  readonly legacy: (root: string) => string;
  readonly target: (root: string) => string;
  readonly initial: string;
}

const LAYOUT: readonly LayoutEntry[] = [
  { legacy: legacyConfigFile, target: targetConfigFile, initial: EMPTY_CONFIG },
  { legacy: legacyLastRunFile, target: targetLastRunFile, initial: EMPTY_LAST_RUN },
];

/**
 * 旧存储 → 新存储布局。逐项独立（一项搬不动不影响其余），但**搬不动都抛出**：
 * 迁移没做完而启动照常，等于让各域按错误的形态去读数据。
 * 幂等：目标已存在即处理过，归档名固定、重跑不累积。
 */
export async function migrateStorageLayout(deps: UpgradeDeps): Promise<void> {
  const root = deps.resolveRoot();
  for (const entry of LAYOUT) {
    await settleOne(entry.legacy(root), entry.target(root), entry.initial, deps);
  }
}

/**
 * 落定一项。目标已存在即视为「这一份处理过了」：不覆盖、只把源文件归档——用户可能已经在新位置改过
 * 东西，用旧文件盖回去等于用历史覆盖现在。initial 为 null 的落点不建文件（本表暂无此形态，保留签名
 * 与 mcp 同构以备 just-in-time 复用）。
 */
export async function settleOne(
  source: string,
  target: string,
  initial: string | null,
  deps: UpgradeDeps,
): Promise<void> {
  if (existsSync(target)) {
    warnIfDowngraded(source, target, deps);
    archive(source);
    return;
  }
  if (existsSync(source)) {
    const old = await deps.readOldFile(source);
    if (old.ok === false) {
      throw new Error(`dsh-provider-usage: 旧存储文件不可读：${basename(source)}`);
    }
    await writeFileAtomic(target, old.text);
    archive(source);
    return;
  }
  const old = await deps.readOldFile(source);
  if (old.ok === true) {
    // 竞态：existsSync 与读之间文件出现（旧文件重现）→ 按有源处理（字节搬移 + 归档）
    await writeFileAtomic(target, old.text);
    archive(source);
    return;
  }
  if (initial !== null) await writeFileAtomic(target, initial);
}

function warnIfDowngraded(source: string, target: string, deps: UpgradeDeps): void {
  if (!existsSync(source)) return;
  let sourceMtime = 0;
  let targetMtime = 0;
  try {
    sourceMtime = statSync(source).mtimeMs;
    targetMtime = statSync(target).mtimeMs;
  } catch {
    return;
  }
  if (sourceMtime <= targetMtime) return;
  deps.logger.warn(
    `dsh-provider-usage: 旧存储文件 ${basename(source)} 比目标更新——检测到更旧的降级写入，将归档旧文件并保留目标`,
  );
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 归档源文件；本来就没有就什么都不做。首选固定名（`${source}.migrated.bak` =
 * 「这一份处理过了」的标记，幂等语义不变）；该名已存在（降级写入让旧文件重现）时按
 * `.2`、`.3`……留多代，不覆盖第一代证据。
 */
function archive(source: string): void {
  if (!existsSync(source)) return;
  let target = `${source}${MIGRATED_SUFFIX}`;
  for (let generation = 2; isRegularFile(target); generation += 1) {
    target = `${source}${MIGRATED_SUFFIX}.${generation}`;
  }
  try {
    renameSync(source, target);
  } catch (cause) {
    throw new Error(`dsh-provider-usage: 旧存储文件改名失败：${basename(source)}`, {
      cause,
    });
  }
}
