/**
 * dsh-lan-proxy — 旧扁平目录一次性迁出（issue #911）。
 *
 * 把 lan-proxy/（#911 前自签证书缓存所在）收进包私有目录
 * @wingsky-1/dsh-lan-proxy/，对标 notifier upgrade/storage-layout 那一步
 * （旧文件搬运 + 目标已存在不覆盖 + 旧文件归档留证据）。
 *
 * 语义：
 * - 目标已存在即视为处理过：不覆盖（用户可能已在新位置换过证书），只把
 *   旧文件归档为 .migrated.bak（与 migrateFileConfig 的 marker 同族）；
 * - 目标缺失且旧文件存在：原子改名搬运；
 * - 两边都没有：全新安装（ensureSelfSignedTls 随后在新目录建出），零操作；
 * - 幂等：搬完/归档完重跑不累积。
 *
 * 失败口径：单文件搬不动记 warn；若出现搬运失败则把已搬的回滚（改名回去，
 * best effort），并回落旧目录——调用方本轮全程只用一个目录（不双源），下次
 * 启动重跑本次迁移（参考 migrateFileConfig 的 rolledBack 语义）。
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { legacyPluginDir, pluginDir } from "../../../shared/interface.ts";

/** 旧文件归档后缀（与 MIGRATED_BAK_NAME 同族的处理过标记）。 */
export const LEGACY_BAK_SUFFIX = ".migrated.bak";

/** resolvePluginDir 入参（文件名由调用方传入：自签 key/cert 名归 tls 域，config.json 名归本域）。 */
export interface LayoutMigrateOptions {
  /** 随目录迁移的文件名（含分隔符的一律跳过，防路径穿越）。 */
  files: readonly string[];
  /** 服务端日志兜底（失败只记日志，由返回值告知调用方降级）。 */
  logger?: { warn?: (...args: unknown[]) => void };
}

/** resolvePluginDir 结果。 */
export interface LayoutMigrateOutcome {
  /** 本轮生效目录（新旧二选一；调用方全程只用它）。 */
  dir: string;
  /** 本次实际搬运的文件名。 */
  moved: string[];
  /** 是否回落旧目录（搬运失败且已回滚）。 */
  fallback: boolean;
}

/** 反斜杠码点（写成码点比较，避免转义层吞反斜杠字面量）。 */
const BACKSLASH = 92;

/** 文件名合法性（防路径穿越：调用方传的应是常量，此处为最后一道防线）。 */
function isSafeName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  for (const ch of name) {
    if (ch === "/" || ch.charCodeAt(0) === BACKSLASH) return false;
  }
  return true;
}

/** 取错误消息（日志用，不进响应）。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 旧目录迁出并抉择本轮生效目录（同步；装配期最先跑，先于 prepareTls 与
 * migrateFileConfig——两者都读写本返回值目录）。
 */
export function resolvePluginDir(options: LayoutMigrateOptions): LayoutMigrateOutcome {
  const from = legacyPluginDir();
  const to = pluginDir();
  mkdirSync(to, { recursive: true });
  if (!existsSync(from)) return { dir: to, moved: [], fallback: false };
  const moved: string[] = [];
  const rollback: string[] = [];
  const warn = (message: string) => options.logger?.warn?.(message);
  for (const name of options.files) {
    if (!isSafeName(name)) continue;
    const step = migrateFileOnce(name, from, to, warn);
    if (step.outcome === "moved") {
      moved.push(name);
      rollback.push(name);
      continue;
    }
    if (step.outcome !== "failed") continue;
    warn("lan-proxy: 旧目录迁移 " + name + " 失败 — " + errMsg(step.err) + "，回滚并回落旧目录");
    rollbackMoved(rollback, from, to);
    return { dir: from, moved: [], fallback: true };
  }
  return { dir: to, moved, fallback: false };
}

/**
 * 单个文件的迁出判定。四种结局各自独立成一支，故收成一个函数：
 * 原来四种结局（含两层 try/catch 与一层回滚循环）挤在 resolvePluginDir 的 for 体里，
 * 「搬不动就回落旧目录」这条主路径要穿过三层缩进才看得见。
 *
 * 纯判定 + 单次 rename：archived（目标已在位，源改名为 .bak）与 failed 不改 moved/rollback。
 */
function migrateFileOnce(
  name: string,
  from: string,
  to: string,
  warn: (message: string) => void,
): { readonly outcome: "skipped" | "archived" | "moved" | "failed"; readonly err?: unknown } {
  const src = join(from, name);
  const dst = join(to, name);
  if (!existsSync(src)) return { outcome: "skipped" };
  if (existsSync(dst)) {
    try {
      renameSync(src, src + LEGACY_BAK_SUFFIX);
    } catch (err) {
      warn("lan-proxy: 旧目录文件 " + name + " 归档失败（保留原位）— " + errMsg(err));
    }
    return { outcome: "archived" };
  }
  try {
    renameSync(src, dst);
    return { outcome: "moved" };
  } catch (err) {
    return { outcome: "failed", err };
  }
}

/** 回滚：把本轮已搬走的文件逆序搬回旧目录（best effort）。 */
function rollbackMoved(rollback: readonly string[], from: string, to: string): void {
  for (const done of [...rollback].reverse()) {
    try {
      renameSync(join(to, done), join(from, done));
    } catch {
      // 回滚 best effort：残留即下次重跑，本轮仍回落旧目录（单目录抉择）。
    }
  }
}
