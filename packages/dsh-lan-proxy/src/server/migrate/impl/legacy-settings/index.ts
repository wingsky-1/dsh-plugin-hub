/**
 * dsh-lan-proxy — 旧官方 settings section 到 canonical settings 的窄 facade。
 *
 * 通用文档读取、imported < live、JSON clone/cycle 防护、currentUser 优先与 marker 时序统一走
 * shared/legacy-settings-migration；本域只保留 LAN 的 namespace、配置 sanitizer 与默认路径。
 */
import { dshHome } from "../../../../../../../shared/dsh-home.js";
import {
  migrateLegacySettings as migrateSharedLegacySettings,
  readLegacySettings as readSharedLegacySettings,
} from "../../../../../../../shared/legacy-settings-migration.js";
import type {
  LegacySettingsMigrationOutcome,
  LegacySettingsMigrationStatus,
  LegacySettingsReadResult,
} from "../../../../../../../shared/legacy-settings-migration.js";
import { sanitizeSettings } from "../../../config/interface.ts";
import type { OwnerScopeLike } from "../../../config/interface.ts";
import { pluginDir } from "../../../shared/interface.ts";

/** 旧官方 settings namespace（只在本迁移子域出现）。 */
export const LEGACY_SETTINGS_NS = "dsh-lan-proxy";

/** settings 迁移自己的完成 marker；刻意不叫 config.json.migrated.bak。 */
export const SETTINGS_MIGRATION_MARKER_NAME = "settings.migrated";

/** marker 内容版本；成功写入后未来实现可据此演进而不误读旧 marker。 */
export const SETTINGS_MIGRATION_MARKER_VERSION = "1";

export type {
  LegacySettingsMigrationOutcome,
  LegacySettingsMigrationStatus,
  LegacySettingsReadResult,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** LAN 特有校验：通用 validator 会把非数组对象形态的 wsDeflatePolicy 放行，迁移仍只收 plain record。 */
function sanitizeLegacySection(section: Record<string, unknown>): Record<string, unknown> | null {
  const sanitized = sanitizeSettings(section);
  if (sanitized === null) return null;
  const policy = (sanitized as Record<string, unknown>).wsDeflatePolicy;
  if (policy !== undefined && !isPlainRecord(policy)) return null;
  return sanitized as Record<string, unknown>;
}

/**
 * 读取两个 profile 文档并按 imported < settings.yaml 合并旧 section。
 * 任一存在文件读/解析失败即整体失败；不存在文件不算失败。
 */
export function readLegacySettings(
  options: { readonly home?: string } = {},
): LegacySettingsReadResult {
  return readSharedLegacySettings({
    legacyNamespace: LEGACY_SETTINGS_NS,
    home: options.home ?? dshHome(),
    sanitize: sanitizeLegacySection,
  });
}

export interface LegacySettingsMigrationOptions {
  /** profile home；默认取 dshHome()，测试/隔离 profile 可显式传入。 */
  readonly home?: string;
  /** 插件私有目录；marker 写在此处，默认取 pluginDir()。 */
  readonly configDir?: string;
  /** canonical settings 的 raw user section；字段存在即用户已决定。 */
  readonly currentUser?: unknown;
  /** canonical descriptor revision；用于 CAS 写入。 */
  readonly expectedRevision?: number;
  /** canonical owner scope；本 step 只使用 update，不触碰 config file state。 */
  readonly scope: Pick<OwnerScopeLike, "update">;
  readonly logger?: { warn?: (...args: unknown[]) => void };
}

/**
 * 执行一次旧 settings section 迁移。marker 命中后不读旧源、不写 scope。
 */
export async function migrateLegacySettings(
  options: LegacySettingsMigrationOptions,
): Promise<LegacySettingsMigrationOutcome> {
  return migrateSharedLegacySettings({
    legacyNamespace: LEGACY_SETTINGS_NS,
    home: options.home ?? dshHome(),
    configDir: options.configDir ?? pluginDir(),
    markerName: SETTINGS_MIGRATION_MARKER_NAME,
    markerVersion: SETTINGS_MIGRATION_MARKER_VERSION,
    sanitize: sanitizeLegacySection,
    currentUser: options.currentUser,
    expectedRevision: options.expectedRevision,
    scope: options.scope,
    logger: options.logger,
    label: "lan-proxy",
  });
}
