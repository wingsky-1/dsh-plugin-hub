/**
 * upgrade 域：存储布局归位——把散在 DSH home 根目录的用户数据收进包私有目录（§7.1/§7.2）。
 *
 * 两条判据在这里落地：**纯字节搬移**（不 `JSON.parse`：坏文件的格式知识属各域容错读面，迁移把它原样
 * 搬到新位置）、**归档一律执行**（目标已存在时也不覆盖目标，旧文件改成固定名留痕 = 幂等标记）。
 *
 * 可再生落点（目录摘要 / 调用统计 / 目录型缓存）不进迁移：缺了由各域按空形态重建，搬旧值
 * 反而可能把过期快照当成新数据。
 */
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import {
  LEGACY_LAYOUT,
  configFile,
  legacyFile,
  userStatePath,
  writeFileAtomic,
} from "../../../shared/interface.ts";
import type { UpgradeDeps } from "../../deps.ts";

/** 归档后缀：搬完留证据，也是「这一份处理过了」的标记（固定名 → 重跑不累积）。 */
const MIGRATED_SUFFIX = ".migrated.bak";

/**
 * 空落盘形态。初始形态一律是**空结构**而不是默认值快照——写全量默认值会把「用户覆盖过哪些键」这个
 * 语义冲掉（文件里每个键都会被读成用户显式提交的）。
 *
 * 配置与用户状态用**版本化**空形：裸 `{}` 会被各自的读面当成缺版本字段的历史文件，而这两份文件的
 * 形态契约里就有 `version`（`server/store` 与 `server/store/impl/middleware-state.ts` 都按它落盘）。
 */
const EMPTY_CONFIG = `${JSON.stringify({ version: 1, servers: [] }, null, 2)}\n`;
const EMPTY_USER_STATE = `${JSON.stringify({ version: 1, disabled: {} }, null, 2)}\n`;

/** 布局的一项。 */
interface LayoutEntry {
  /** 旧文件名（DSH_HOME 根目录下）。 */
  readonly legacy: string;
  /** 目标路径。是**取路径的函数**而不是路径：`DSH_HOME` 在装配期才定，模块加载期取值会落错根。 */
  readonly target: () => string;
  /** 目标与旧文件都不存在时的初始形态。 */
  readonly initial: string;
  /** 用户显式接管了这份落点时为真——整项不动（见 `migrateStorageLayout`）。 */
  readonly takenOver?: (deps: UpgradeDeps) => boolean;
}

/** 单文件布局项：只剩用户数据两项（可再生落点不进迁移，见模块头注释）。 */
const LAYOUT: readonly LayoutEntry[] = [
  {
    legacy: LEGACY_LAYOUT.config,
    target: configFile,
    initial: EMPTY_CONFIG,
    takenOver: (deps) => deps.storePath !== "",
  },
  { legacy: LEGACY_LAYOUT.userState, target: userStatePath, initial: EMPTY_USER_STATE },
];

/**
 * 旧存储 → 新存储布局。逐项独立（一项搬不动不影响其余），但**搬不动都抛出**：迁移没做完而启动照常，
 * 等于让各域按错误的形态去读数据。幂等：目标已存在即处理过，归档名固定、重跑不累积。
 *
 * 用户显式配置了 `storePath` 的那一项**整项不动**——不迁移、不改写、也不建初始形态：
 * 插件继续读用户那个文件，默认落点上的旧文件不是它的数据，搬走或归档都是替用户做主张。
 */
export async function migrateStorageLayout(deps: UpgradeDeps): Promise<void> {
  for (const entry of LAYOUT) {
    if (entry.takenOver !== undefined && entry.takenOver(deps)) continue;
    await settleOne(legacyFile(entry.legacy), entry.target(), entry.initial, deps);
  }
}

/**
 * 落定一项。目标已存在即视为「这一份处理过了」：不覆盖、只把源文件归档——用户可能已经在新位置改过
 * 东西，用旧文件盖回去等于用历史覆盖现在。`initial` 为 null 的落点（项目级配置：缺文件即空
 * store，没有各自的初始形态）不建文件。
 *
 * 项目级 just-in-time 迁移（`./project-layout.ts`）复用本函数：同文件内的 `settleOne` 即同一语义。
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
  if (!existsSync(source)) {
    if (initial !== null) await writeFileAtomic(target, initial);
    return;
  }
  await writeFileAtomic(target, readSource(source));
  archive(source);
}

/**
 * 目标比旧文件更新才出声：旧文件更新说明有更旧的版本在迁移之后又写过它（降级写入），
 * 该让人知道这次归档丢掉了什么。mtime 只影响**这条文案**，不改变动作。
 */
function warnIfDowngraded(source: string, target: string, deps: UpgradeDeps): void {
  if (!existsSync(source)) return;
  if (statSync(source).mtimeMs <= statSync(target).mtimeMs) return;
  deps.logger.warn(
    `dsh-mcp-manager: 旧存储文件 ${source} 比目标 ${target} 更新——检测到更旧的降级写入，将归档旧文件并保留目标`,
  );
}

/** 常规文件判定（归档多代只跳过常规文件：占位的是目录即改名失败照抛，旧报警保留）。 */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 读旧文件；读不出来即抛——那是「搬不动」，不该被当成「没有旧数据」。内容一律不解析。 */
function readSource(source: string): string {
  try {
    return readFileSync(source, "utf8");
  } catch (cause) {
    throw new Error(`dsh-mcp-manager: 旧存储文件不可读：${source}`, { cause });
  }
}

/**
 * 归档源文件；本来就没有就什么都不做。首选固定名（`${source}.migrated.bak` =
 * 「这一份处理过了」的标记，幂等语义不变）；该名已存在（降级写入让旧文件重现，
 * 见 warnIfDowngraded）时按 `.2`、`.3`……留多代，不覆盖第一代证据（#903 M-arch）。
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
    throw new Error(`dsh-mcp-manager: 旧存储文件改名失败：${source}`, { cause });
  }
}
