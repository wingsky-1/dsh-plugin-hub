/**
 * 旧官方 settings section 到 canonical scope 的通用迁移协议。
 * 插件差异由调用方参数化；本模块不解释任何插件配置键。
 */
export type LegacySettingsRecord = Record<string, unknown>;

export interface LegacySettingsDocumentRead {
  readonly name: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly hasSection: boolean;
  readonly values: LegacySettingsRecord;
  readonly error?: string;
}

export interface LegacySettingsReadResult {
  readonly ok: boolean;
  readonly hasSection: boolean;
  readonly values: LegacySettingsRecord;
  readonly documents: readonly LegacySettingsDocumentRead[];
  readonly error?: string;
}

export type LegacySettingsSanitizer = (section: LegacySettingsRecord) => unknown;

export interface LegacySettingsReadOptions {
  readonly legacyNamespace: string;
  readonly home: string;
  readonly sanitize: LegacySettingsSanitizer;
}

export type LegacySettingsMigrationStatus = "migrated" | "already-complete" | "skipped" | "failed";

export interface LegacySettingsMigrationOutcome {
  readonly status: LegacySettingsMigrationStatus;
  readonly migrated: boolean;
  readonly completed: boolean;
  readonly error?: string;
}

export interface LegacySettingsMigrationOptions {
  readonly legacyNamespace: string;
  readonly home: string;
  readonly configDir: string;
  readonly markerName: string;
  readonly markerVersion: string;
  readonly sanitize: LegacySettingsSanitizer;
  readonly currentUser?: unknown;
  readonly expectedRevision?: number;
  readonly scope: { update(patch: object, expectedRevision?: number): Promise<unknown> };
  readonly prepareConfigDir?: () => void | Promise<void>;
  readonly logger?: { warn?: (...args: unknown[]) => void };
  readonly label: string;
}

export declare function readLegacySettings(
  options: LegacySettingsReadOptions,
): LegacySettingsReadResult;

export declare function migrateLegacySettings(
  options: LegacySettingsMigrationOptions,
): Promise<LegacySettingsMigrationOutcome>;
