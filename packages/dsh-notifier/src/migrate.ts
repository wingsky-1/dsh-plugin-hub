/**
 * dsh-notifier — 存量自建配置一次性迁移（issue #76，E1-E7/R1）。
 *
 * 旧版配置位于 `~/.dsh/dsh-notifier.json`（自建读写链路，现已废弃）；本模块
 * 在 settings 命名空间 attach 后（installNotifierSettings 的 onScope 内）把
 * 存量配置一次性迁入官方 settings user 层，rename-first marker 幂等。
 *
 * 分流（R1）：
 * - 合法 json：改名 `.migrated.bak`（即 `dsh-notifier.json.migrated.bak`）后
 *   sanitize 过滤经 owner scope.update 增量写入（只写文件里显式存在的键）；
 * - 损坏/非对象/无有效键：只改名 `.corrupted.bak` 标记，不写入（防把 schema
 *   默认值固化进 user 层、压制后续默认值演进）；
 * - 中断态：`.migrated.bak` 存在而 json 不存在 → 从 bak 重放
 *   （解析 → sanitize → update）——但若 settings user 层已有该命名空间的值
 *   （迁移已完成）则幂等跳过，避免重复写入（E2 断言「不重复写入」）；
 * - 写入失败：回滚改名（bak 还原为 json）并 warn，下次启动重试（E6）。
 */
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { errorMessage } from "../../../shared/host-utils.js";
import { sanitizeSettings } from "./config.ts";

/** 已迁移备份文件名后缀（幂等标记：存在且 user 层有值 = 已处理）。 */
export const MIGRATED_BAK_SUFFIX = ".migrated.bak";
/** 损坏备份文件名后缀（损坏/非对象/无有效键 → 只标记不写入）。 */
export const CORRUPTED_BAK_SUFFIX = ".corrupted.bak";

/** migrateLegacyConfig 的结果（导出供单测断言）。 */
export interface MigrationOutcome {
  /** 本次是否执行了改名标记（false = json 不存在且无处理动作）。 */
  performed: boolean;
  /** 是否有有效键写入了 owner scope（含中断态重放成功）。 */
  migrated: boolean;
  /** 写入失败后是否已回滚改名（json 已还原）。 */
  rolledBack: boolean;
  /** 损坏/空 JSON：仅改名 corrupted 标记、不写入。 */
  skippedCorrupt: boolean;
  /** 迁移已完成（user 层已有值）：幂等跳过（E2）。 */
  skippedIdempotent: boolean;
  /** 本次是否为中断态重放（.migrated.bak 存在且 json 不存在）。 */
  resumed: boolean;
}

/** migrateLegacyConfig 的依赖（scope.update 面 + user 层存在性判定）。 */
export interface MigrateDeps {
  /** 增量 merge patch 进 settings user 层。 */
  update(patch: object): Promise<void>;
  /** settings user 层该命名空间是否已有任何键（幂等跳过判定）。 */
  hasUserValues(): boolean;
}

/**
 * 检查文件上位标记：json 不存在、bak 存在。
 * @param legacyPath 旧 json 路径。
 * @param suffix 备份后缀（migrated / corrupted）。
 */
function hasBakOnly(legacyPath: string, suffix: string): boolean {
  return !existsSync(legacyPath) && existsSync(legacyPath + suffix);
}

/** rename，Windows 目标已存在先 unlink 旧目标（R1(c)）。 */
function renameOver(previous: string, next: string): void {
  if (existsSync(next)) unlinkSync(next);
  renameSync(previous, next);
}

/**
 * 存量 dsh-notifier.json 一次性迁移到官方 settings 命名空间。
 *
 * 时序（issue #76 R1）：
 * 0. 损坏标记态（只有 `.corrupted.bak`）→ 幂等跳过；
 * 1. json 不存在：
 *    - 无 migrated bak → 稳态，幂等返回；
 *    - migrated bak 存在 → 若 user 层已有值（迁移已完成，E2）跳过；
 *      否则视为迁移中断（E3），从 bak 重放「解析 → sanitize → update」；
 * 2. json 存在：读 + 解析；损坏/非对象/无有效键 → 改名 `.corrupted.bak`
 *    （只标记不写入，E4）；
 * 3. 合法 → 先改名 `.migrated.bak`（rename-first marker，改名成功即视为
 *    已处理）→ sanitize 过滤 → owner scope.update 增量写入；
 * 4. 写入失败 → 回滚改名（bak 还原为 json）并 warn，下次启动重试（E6）。
 *
 * 必须在 settings 服务 attach 后调用（onScope 内），且先于一切 enabled 判定
 * （禁用用户跨版本升级同样完成迁移，E7）。
 */
export async function migrateLegacyConfig(legacyPath: string, deps: MigrateDeps, logger?: { warn?: (...a: unknown[]) => void }): Promise<MigrationOutcome> {
  const migratedBak = legacyPath + MIGRATED_BAK_SUFFIX;
  const corruptedBak = legacyPath + CORRUPTED_BAK_SUFFIX;

  // 0. 损坏标记态幂等（user 层不该有值；有则跳过——损坏只标记不写入）
  if (hasBakOnly(legacyPath, CORRUPTED_BAK_SUFFIX)) {
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: true, resumed: false };
  }

  // 1. json 不存在
  if (!existsSync(legacyPath)) {
    if (!existsSync(migratedBak)) {
      return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false };
    }
    // 中断态/已迁移：user 层已有值 → 幂等跳过（E2，不重复写入）；
    // 否则视为中断，从 bak 重放（E3）。
    if (deps.hasUserValues()) {
      return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: true, resumed: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(migratedBak, "utf8"));
    } catch {
      logger?.warn?.(`dsh-notifier: 检测到未完成的迁移残留 ${MIGRATED_BAK_SUFFIX}，但内容不是合法 JSON — 无法自动恢复，请手动检查该备份（原始配置应在其内）或将其改名 ${CORRUPTED_BAK_SUFFIX}`);
      return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: true };
    }
    const sanitized = sanitizeSettings(parsed);
    if (sanitized === null || Object.keys(sanitized).length === 0) {
      logger?.warn?.(`dsh-notifier: 未完成的迁移残留 ${MIGRATED_BAK_SUFFIX} 无可迁移的有效键 — 已跳过，确认无误后可手动删除该备份`);
      return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: true };
    }
    try {
      await deps.update(sanitized as Record<string, unknown>);
      logger?.warn?.(`dsh-notifier: 检测到上次未完成的迁移 — 已从 ${MIGRATED_BAK_SUFFIX} 重放写入设置；确认运行正常后可手动删除该备份`);
      return { performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: true };
    } catch (err) {
      logger?.warn?.(`dsh-notifier: 未完成迁移从 ${MIGRATED_BAK_SUFFIX} 重放写入失败（${errorMessage(err)}）— 配置仍保留在该备份中，排查后重启重试或手动恢复`);
      return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: true };
    }
  }

  // 2. json 存在：读 + 解析
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    // 损坏：只改名 corrupted 标记，不写入（E4）
    try {
      renameOver(legacyPath, corruptedBak);
      logger?.warn?.(`dsh-notifier: 存量 ${legacyPath.split(/[\\/]/).pop()} 不是合法 JSON — 改名 ${CORRUPTED_BAK_SUFFIX} 标记，不写入设置`);
    } catch (err) {
      logger?.warn?.(`dsh-notifier: 损坏配置改名失败（${errorMessage(err)}）— 原文件保留原位，请手动处理`);
    }
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    try {
      renameOver(legacyPath, corruptedBak);
      logger?.warn?.(`dsh-notifier: 存量配置不是对象 — 改名 ${CORRUPTED_BAK_SUFFIX} 标记，不写入设置`);
    } catch (err) {
      logger?.warn?.(`dsh-notifier: 非对象配置改名失败（${errorMessage(err)}）— 原文件保留原位，请手动处理`);
    }
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: false };
  }
  const sanitized = sanitizeSettings(parsed);
  if (sanitized === null || Object.keys(sanitized).length === 0) {
    try {
      renameOver(legacyPath, corruptedBak);
      logger?.warn?.(`dsh-notifier: 存量配置无有效键 — 改名 ${CORRUPTED_BAK_SUFFIX} 标记，不写入设置`);
    } catch (err) {
      logger?.warn?.(`dsh-notifier: 无有效键配置改名失败（${errorMessage(err)}）— 原文件保留原位，请手动处理`);
    }
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, skippedIdempotent: false, resumed: false };
  }

  // 3. 合法：rename-first marker 后再写入
  try {
    renameOver(legacyPath, migratedBak);
  } catch (err) {
    logger?.warn?.(`dsh-notifier: 存量配置改名失败（${errorMessage(err)}）— 本次跳过，下次启动重试`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: false };
  }
  try {
    await deps.update(sanitized as Record<string, unknown>);
    return { performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, skippedIdempotent: false, resumed: false };
  } catch (err) {
    // 4. 写入失败：回滚改名（bak 还原为 json），下次启动重试
    try {
      if (!existsSync(legacyPath)) renameSync(migratedBak, legacyPath);
    } catch (rollbackErr) {
      logger?.warn?.(`dsh-notifier: 迁移回滚失败（${errorMessage(rollbackErr)}）— 数据保留在 ${MIGRATED_BAK_SUFFIX}，请手动恢复`);
    }
    logger?.warn?.(`dsh-notifier: 存量配置迁移写入设置失败（${errorMessage(err)}）— 已回滚，下次启动重试`);
    return { performed: true, migrated: false, rolledBack: true, skippedCorrupt: false, skippedIdempotent: false, resumed: false };
  }
}