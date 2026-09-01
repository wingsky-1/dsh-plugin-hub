/**
 * dsh-lan-proxy — 存量 config.json 一次性迁移（#276 方案 A 阶段 3 拆出）。
 *
 * rename-first marker，幂等：先把 config.json 原子改名为
 * config.json.migrated.bak（存在即「已处理过」），再 sanitize 过滤后经 owner
 * scope.update 增量写入官方 settings 存储；中断态（.bak 存在且 config.json
 * 不存在）从 bak 重放。设置接线在 settings.ts，净化规则在 config.ts。
 */
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../../shared/host-utils.js";
import { sanitizeSettings, normalizeLegacyWsCompressPaths } from "./config.ts";
import type { OwnerScopeLike } from "./settings.ts";

/** 迁移备份文件名（同时是幂等标记：存在即「已处理过」）。 */
export const MIGRATED_BAK_NAME = "config.json.migrated.bak";

/**
 * 迁移写入前的最后一收口（issue #395 M2）：sanitize 后再对 wsCompressPaths 应用
 * 旧白名单归一化——显式保存过旧默认 ["/api/events.mux", "/api/events.host"] 的
 * 存量 config.json 迁移后同样写入新默认 ["/api/remote.mux"]；自定义白名单原样保留。
 */
function normalizeMigratedWsCompressPaths(sanitized: ReturnType<typeof sanitizeSettings>): ReturnType<typeof sanitizeSettings> {
  if (sanitized === null || sanitized.wsCompressPaths === undefined) return sanitized;
  const normalized = normalizeLegacyWsCompressPaths(sanitized.wsCompressPaths);
  if (normalized === undefined) return sanitized;
  return { ...sanitized, wsCompressPaths: [...normalized] };
}

/** migrateFileConfig 的结果（导出供单测断言）。 */
export interface MigrationOutcome {
  /** 本次是否执行了改名标记（false = config.json 不存在，或仅从中断态重放）。 */
  performed: boolean;
  /** 是否有有效键写入了 owner scope（含中断态重放成功）。 */
  migrated: boolean;
  /** 写入失败后是否已回滚改名（config.json 已还原）。 */
  rolledBack: boolean;
  /** 损坏/空 JSON：仅改名标记、不写入（防固化 schema 默认值）。 */
  skippedCorrupt: boolean;
  /** 本次是否为中断态重放（.bak 存在且 config.json 不存在）。 */
  resumed: boolean;
}

/**
 * 中断态重放：上次「改名成功 → scope.update 完成前」进程被杀的现场是
 * `.bak` 存在且 `config.json` 不存在——此时不能按幂等跳过（否则配置永滞
 * .bak 且无提示），视为未完成迁移，从 bak 重放「解析→sanitize→scope.update」。
 * 成功后保留 bak（update 同值 merge 幂等，后续启动重放无害）；损坏/无效/
 * 写入失败则 warn 明示手动恢复路径。
 */
async function resumeMigrateFromBak(
  bakPath: string,
  scope: Pick<OwnerScopeLike, "update">,
  logger?: { warn?: (...a: unknown[]) => void },
): Promise<MigrationOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bakPath, "utf8"));
  } catch {
    logger?.warn?.(`lan-proxy: 检测到上次未完成的迁移残留 ${MIGRATED_BAK_NAME}，但文件不是合法 JSON — 无法自动恢复，请手动检查该文件（原始 config.json 内容应在其内）或删除它`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: true };
  }
  const sanitized0 =
    typeof parsed === "object" && parsed !== null ? sanitizeSettings(parsed) : null;
  if (sanitized0 === null || Object.keys(sanitized0).length === 0) {
    logger?.warn?.(`lan-proxy: 上次未完成的迁移残留 ${MIGRATED_BAK_NAME} 无可迁移的有效键 — 已跳过，确认无误后可手动删除该文件`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: true };
  }
  const sanitized = normalizeMigratedWsCompressPaths(sanitized0);
  try {
    await scope.update(sanitized as Record<string, unknown>);
    logger?.warn?.(`lan-proxy: 检测到上次未完成的迁移 — 已从 ${MIGRATED_BAK_NAME} 重放写入设置；确认运行正常后可手动删除该备份`);
    return { performed: false, migrated: true, rolledBack: false, skippedCorrupt: false, resumed: true };
  } catch (err) {
    logger?.warn?.(`lan-proxy: 未完成的迁移从 ${MIGRATED_BAK_NAME} 重放写入设置失败（${errorMessage(err)}）— 配置仍保留在该备份中，请排查后重启重试，或手动将其内容恢复到设置`);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: true };
  }
}

/**
 * 存量 config.json 一次性迁移到官方 settings 命名空间（rename-first marker）。
 *
 * 时序（issue #110 修订路线）：
 * 0. 中断态（`.bak` 存在且 `config.json` 不存在，即上次改名后写入未完成）→
 *    从 bak 重放写入（见 resumeMigrateFromBak），不静默跳过；
 * 1. `config.json` 不存在（且无中断态残留）→ 直接返回（幂等：二次启动跳过）；
 * 2. 先原子改名 `config.json` → `config.json.migrated.bak`（POSIX rename 原子；
 *    Windows 目标已存在会抛错，故先 unlink 旧 bak——bak 仅是保险副本，被新的
 *    用户手动恢复内容取代可接受）；改名成功即视为「已处理」，无论后续成败；
 * 3. 解析 bak：损坏/非对象/无有效键 → 到此为止（只标记不写入，避免把 schema
 *    默认值固化进用户层、压制后续默认值演进）；
 * 4. sanitizeSettings 过滤后经 owner scope.update 增量写入（只写文件里显式
 *    存在的键，schema 默认保持动态兜底——spike 结论优先 update，replace 仅当
 *    需要整节割接时使用）；
 * 5. 写入失败 → 回滚改名（bak 还原为 config.json）并 warn，下次启动重试。
 *
 * 必须在 settings 服务 attach 后调用（installLanProxySettings 的 onScope 内），
 * 且先于任何 enabled 早退——禁用用户跨版本升级同样要完成迁移。
 */
export async function migrateFileConfig(
  configDir: string,
  scope: Pick<OwnerScopeLike, "update">,
  logger?: { warn?: (...a: unknown[]) => void },
): Promise<MigrationOutcome> {
  const cfgPath = join(configDir, "config.json");
  const bakPath = join(configDir, MIGRATED_BAK_NAME);
  // 中断态优先于幂等判定：config.json 与 .bak 同时不存在才是真正的已迁移稳态。
  if (!existsSync(cfgPath)) {
    if (existsSync(bakPath)) return resumeMigrateFromBak(bakPath, scope, logger);
    return { performed: false, migrated: false, rolledBack: false, skippedCorrupt: false, resumed: false };
  }
  // Windows 上 rename 到已存在目标会抛错；先移除历史 bak（见函数注释）。
  if (existsSync(bakPath)) unlinkSync(bakPath);
  renameSync(cfgPath, bakPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bakPath, "utf8"));
  } catch {
    logger?.warn?.(`lan-proxy: 存量 config.json 不是合法 JSON — 仅标记为已迁移（${MIGRATED_BAK_NAME}），不写入设置`);
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    logger?.warn?.(`lan-proxy: 存量 config.json 不是配置对象 — 仅标记为已迁移（${MIGRATED_BAK_NAME}），不写入设置`);
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  const sanitized0 = sanitizeSettings(parsed);
  if (sanitized0 === null) {
    // 含类型非法值：整体不写入（与保存通道同口径，宁可不迁也不迁一半）。
    logger?.warn?.(`lan-proxy: 存量 config.json 含非法配置值 — 仅标记为已迁移（${MIGRATED_BAK_NAME}），不写入设置`);
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  if (Object.keys(sanitized0).length === 0) {
    return { performed: true, migrated: false, rolledBack: false, skippedCorrupt: true, resumed: false };
  }
  const sanitized = normalizeMigratedWsCompressPaths(sanitized0);
  try {
    await scope.update(sanitized as Record<string, unknown>);
    return { performed: true, migrated: true, rolledBack: false, skippedCorrupt: false, resumed: false };
  } catch (err) {
    // 写入失败：回滚改名，让下次启动重试（数据始终存在于 config.json 或 bak 之一）。
    try {
      if (!existsSync(cfgPath)) renameSync(bakPath, cfgPath);
    } catch (rollbackErr) {
      logger?.warn?.(`lan-proxy: 迁移回滚失败（${errorMessage(rollbackErr)}）— 数据保留在 ${MIGRATED_BAK_NAME}，请手动恢复`);
    }
    logger?.warn?.(`lan-proxy: 存量 config.json 迁移写入设置失败（${errorMessage(err)}）— 已回滚，下次启动重试`);
    return { performed: true, migrated: false, rolledBack: true, skippedCorrupt: false, resumed: false };
  }
}