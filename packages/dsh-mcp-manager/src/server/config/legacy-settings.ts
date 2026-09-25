/**
 * dsh-mcp-manager — 旧官方 settings section 到 canonical settings 的窄迁移。
 *
 * DSH 0.1.7-rc.1 引入的 importer（rc.2 沿用）会把旧 settings.yaml 改名为 settings.yaml.imported，但不会把插件别名
 * dsh-mcp-manager 自动映射到 canonical ui-dsh-mcp-manager。本域只在 settings scope 已
 * attach 后读取两份旧文档；当前设置卡片只支持 ui 子树，因此 middleware、middlewarePolicy
 * 及其它非 volatile 顶层键明确丢弃，不写入 canonical patch。
 */
import { dshHome } from "../../../../../shared/dsh-home.js";
import {
  migrateLegacySettings as migrateSharedLegacySettings,
  readLegacySettings as readSharedLegacySettings,
} from "../../../../../shared/legacy-settings-migration.js";
import type {
  LegacySettingsMigrationOutcome,
  LegacySettingsReadResult,
  LegacySettingsRecord,
} from "../../../../../shared/legacy-settings-migration.js";
import { ensureDir, mcpManagerHome } from "../shared/interface.ts";
import { MCP_MANAGER_IDENTITY } from "../../shared/interface.ts";
import type {
  SettingsFormsDescriptor,
  SettingsFormsScope,
  SettingsFormsService,
} from "../../../../../shared/settings-namespace.js";

/** 旧插件 settings namespace；只在本迁移实现出现。 */
export const LEGACY_SETTINGS_NS = "dsh-mcp-manager";

/** 私有目录内的一次性完成 marker。 */
export const SETTINGS_MIGRATION_MARKER_NAME = "settings.migrated";

/** marker 内容版本。 */
export const SETTINGS_MIGRATION_MARKER_VERSION = "1";

/** MCP 迁移所需的 canonical scope 最小面。 */
export type McpSettingsScope = Pick<SettingsFormsScope, "update">;

/** MCP 迁移所需的 settings service 最小面。 */
export type McpSettingsService = Pick<SettingsFormsService, "describe">;

export interface McpLegacySettingsMigrationOptions {
  /** profile home；默认取 DSH_HOME-aware dshHome()。 */
  readonly home?: string;
  /** 插件私有目录；默认取 mcpManagerHome()，生产路径为 <DSH_HOME>/@wingsky-1/dsh-mcp-manager。 */
  readonly configDir?: string;
  /** 已 attach 的 canonical owner scope；由本 facade 在运行时收窄。 */
  readonly scope: unknown;
  /** canonical settings service；由本 facade 在运行时收窄。 */
  readonly service: unknown;
  readonly logger?: { warn?: (...args: unknown[]) => void };
}

export interface McpLegacySettingsReadOptions {
  readonly home?: string;
}

type UiRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const UI_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
const UI_OFFSET_KEYS = ["x", "y", "blankY"] as const;
const LEGACY_FLAT_UI_KEYS = [
  "position",
  "offset",
  "offsetX",
  "offsetY",
  "blankY",
  "zIndexBase",
] as const;

function projectUi(ui: Record<string, unknown>): UiRecord | null {
  const projected: UiRecord = {};
  if (ui.position !== undefined) {
    if (!UI_POSITIONS.includes(ui.position as (typeof UI_POSITIONS)[number])) return null;
    projected.position = ui.position;
  }
  if (ui.offset !== undefined) {
    if (!isPlainRecord(ui.offset)) return null;
    const offset: UiRecord = {};
    for (const key of UI_OFFSET_KEYS) {
      const value = ui.offset[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      offset[key] = value;
    }
    projected.offset = offset;
  }
  if (ui.zIndexBase !== undefined) {
    if (typeof ui.zIndexBase !== "number" || !Number.isFinite(ui.zIndexBase)) return null;
    projected.zIndexBase = ui.zIndexBase;
  }
  return projected;
}

/**
 * 只投影当前设置卡片支持的 ui 子树（兼容历史隐藏 namespace 的扁平 ui 键）；
 * 废弃/非 volatile 顶层键不进入返回值。缺省字段保持缺省，让 shared 的
 * imported < live 合并仍按字段生效。
 */
function sanitizeLegacySection(section: LegacySettingsRecord): LegacySettingsRecord | null {
  const hasNestedUi = Object.prototype.hasOwnProperty.call(section, "ui");
  const hasFlatUi = LEGACY_FLAT_UI_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(section, key),
  );
  if (!hasNestedUi && !hasFlatUi) return {};

  const rawUi = hasNestedUi ? section.ui : section;
  if (rawUi === null || rawUi === undefined) return {};
  if (!isPlainRecord(rawUi)) return null;

  // 早期隐藏 namespace 直接存 position/offset；统一折算成当前 Config.ui 形状。
  const ui = { ...rawUi };
  if (ui.offset === undefined) {
    const offset: UiRecord = {};
    if (ui.offsetX !== undefined) offset.x = ui.offsetX;
    if (ui.offsetY !== undefined) offset.y = ui.offsetY;
    if (ui.blankY !== undefined) offset.blankY = ui.blankY;
    if (Object.keys(offset).length > 0) ui.offset = offset;
  }
  delete ui.offsetX;
  delete ui.offsetY;
  delete ui.blankY;

  const projected = projectUi(ui);
  return projected === null ? null : { ui: projected };
}

function failed(
  error: string,
  logger: McpLegacySettingsMigrationOptions["logger"],
): LegacySettingsMigrationOutcome {
  logger?.warn?.(`dsh-mcp-manager: ${error}`);
  return { status: "failed", migrated: false, completed: false, error };
}

function isMcpSettingsScope(value: unknown): value is McpSettingsScope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { update?: unknown }).update === "function"
  );
}

function isMcpSettingsService(value: unknown): value is McpSettingsService {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { describe?: unknown }).describe === "function"
  );
}

function currentUserResult(service: McpSettingsService):
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly revision: number | undefined;
    }
  | { readonly ok: false; readonly error: string } {
  try {
    const entries = service.describe({ redactSecrets: true });
    if (!Array.isArray(entries))
      return { ok: false, error: "canonical settings describe 未返回数组" };
    const descriptor = entries.find(
      (entry): entry is SettingsFormsDescriptor =>
        entry?.ns === MCP_MANAGER_IDENTITY.settingsNamespace,
    );
    return {
      ok: true,
      value: descriptor?.user,
      revision: typeof descriptor?.revision === "number" ? descriptor.revision : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: `读取 canonical settings user 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 读取旧 MCP section；公开此薄入口便于包内边界测试与诊断，合并/优先级语义由 shared 承担。
 */
export function readLegacySettings(
  options: McpLegacySettingsReadOptions = {},
): LegacySettingsReadResult {
  return readSharedLegacySettings({
    legacyNamespace: LEGACY_SETTINGS_NS,
    home: options.home ?? dshHome(),
    sanitize: sanitizeLegacySection,
  });
}

/**
 * 在 canonical settings scope attach 后执行一次旧 section 迁移。
 * canonical 写入前创建 pending receipt，成功后 promote 完成 marker；未知失败不重放，
 * 明确 revision 冲突才清理 receipt 重试。
 */
export async function migrateLegacySettingsFromSettings(
  options: McpLegacySettingsMigrationOptions,
): Promise<LegacySettingsMigrationOutcome> {
  const scope = options.scope;
  if (!isMcpSettingsScope(scope)) {
    return failed("canonical settings scope 不可用", options.logger);
  }
  const service = options.service;
  if (!isMcpSettingsService(service)) {
    return failed("canonical settings service 不可用", options.logger);
  }

  const current = currentUserResult(service);
  if (!current.ok) return failed(current.error, options.logger);

  const configDir = options.configDir ?? mcpManagerHome();
  return migrateSharedLegacySettings({
    legacyNamespace: LEGACY_SETTINGS_NS,
    home: options.home ?? dshHome(),
    configDir,
    markerName: SETTINGS_MIGRATION_MARKER_NAME,
    markerVersion: SETTINGS_MIGRATION_MARKER_VERSION,
    sanitize: sanitizeLegacySection,
    currentUser: current.value,
    expectedRevision: current.revision,
    scope,
    prepareConfigDir: () => ensureDir(configDir),
    logger: options.logger,
    label: "dsh-mcp-manager",
  });
}
