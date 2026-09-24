/**
 * dsh-lan-proxy — 旧官方 settings section 到 canonical settings 的窄迁移。
 *
 * 旧版本把插件配置写在 settings 文档的 `dsh-lan-proxy` section；0.1.7-rc.1 importer
 * 不会把这个别名自动映射到 `ui-dsh-lan-proxy`。本文件只在 upgrade 边界读取
 * `$DSH_HOME/settings.yaml` 与 `settings.yaml.imported`，不读 config.json，也
 * 不替业务层提供旧格式兼容。
 *
 * 合并契约是递归覆盖：imported < settings.yaml < 当前 canonical user。
 * plain object 逐层合并，数组、标量、null 与 undefined 由高优先级来源替换；
 * 当前 user 中即使值是 null/空数组/空对象，该字段也算用户已经决定过，旧源
 * 不得复活。完成状态是本目录内独立的 settings marker，只有 canonical scope
 * 写入成功后才创建。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { dshHome } from "../../../../../../../shared/dsh-home.js";
import { errorMessage } from "../../../../../../../shared/host-utils.js";
import { sanitizeSettings } from "../../../config/interface.ts";
import type { OwnerScopeLike } from "../../../config/interface.ts";
import { pluginDir } from "../../../shared/interface.ts";

/** 旧官方 settings namespace（只在本迁移子域出现）。 */
export const LEGACY_SETTINGS_NS = "dsh-lan-proxy";

/** settings 迁移自己的完成 marker；刻意不叫 config.json.migrated.bak。 */
export const SETTINGS_MIGRATION_MARKER_NAME = "settings.migrated";

/** marker 内容版本；成功写入后未来实现可据此演进而不误读旧 marker。 */
export const SETTINGS_MIGRATION_MARKER_VERSION = "1";

const SETTINGS_DOCUMENT_NAMES = ["settings.yaml", "settings.yaml.imported"] as const;

type JsonRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createRecord(): JsonRecord {
  // null prototype 让 __proto__ 等键只能成为无副作用的自有数据键。
  return Object.create(null) as JsonRecord;
}

function isJsonCloneable(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isJsonCloneable(item, seen));
    if (!isPlainRecord(value)) return false;
    return Object.values(value).every((item) => isJsonCloneable(item, seen));
  } finally {
    seen.delete(value);
  }
}

function cloneValue<T>(value: T, ancestors = new WeakSet<object>()): T {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("配置值不能包含循环引用");
    ancestors.add(value);
    try {
      return value.map((item) => cloneValue(item, ancestors)) as T;
    } finally {
      ancestors.delete(value);
    }
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) throw new TypeError("配置值不能包含循环引用");
    ancestors.add(value);
    try {
      const out = createRecord();
      for (const [key, child] of Object.entries(value)) {
        out[key] = cloneValue(child, ancestors);
      }
      return out as T;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    throw new TypeError("配置值不能包含非 plain object");
  }
  return value;
}

/** imported < high；high 中显式出现的值永远优先。 */
function mergeRecords(
  low: JsonRecord,
  high: JsonRecord,
  ancestors = new WeakSet<object>(),
): JsonRecord {
  if (ancestors.has(low) || ancestors.has(high)) {
    throw new TypeError("配置值不能包含循环引用");
  }
  ancestors.add(low);
  ancestors.add(high);
  try {
    const merged = createRecord();
    for (const [key, value] of Object.entries(low)) {
      merged[key] = cloneValue(value, ancestors);
    }
    for (const [key, highValue] of Object.entries(high)) {
      if (!hasOwn(low, key)) {
        merged[key] = cloneValue(highValue, ancestors);
        continue;
      }
      const lowValue = low[key];
      if (isPlainRecord(lowValue) && isPlainRecord(highValue)) {
        merged[key] = mergeRecords(lowValue, highValue, ancestors);
      } else {
        merged[key] = cloneValue(highValue, ancestors);
      }
    }
    return merged;
  } finally {
    ancestors.delete(low);
    ancestors.delete(high);
  }
}

interface DocumentRead {
  readonly name: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly hasSection: boolean;
  readonly values: JsonRecord;
  readonly error?: string;
}

function absentDocument(name: string): DocumentRead {
  return { name, present: false, valid: true, hasSection: false, values: {} };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function readDocument(home: string, name: string): DocumentRead {
  const path = join(home, name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // ENOENT 是“该候选源不存在”；其它错误（权限、目录、竞态等）都必须
    // fail-closed，不能因为 existsSync 的一次性观测而误当空文档。
    if (isMissingFileError(error)) return absentDocument(name);
    return {
      name,
      present: true,
      valid: false,
      hasSection: false,
      values: {},
      error: `读取 ${name} 失败：${errorMessage(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: false,
      values: {},
      error: `解析 ${name} 失败：${errorMessage(error)}`,
    };
  }

  // 空文档是合法的“无旧 section”；非对象根则不是 settings 文档，失败闭锁。
  if (parsed === null || parsed === undefined) {
    return { name, present: true, valid: true, hasSection: false, values: {} };
  }
  if (!isPlainRecord(parsed)) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: false,
      values: {},
      error: `${name} 根节点不是对象`,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, LEGACY_SETTINGS_NS)) {
    return { name, present: true, valid: true, hasSection: false, values: {} };
  }

  const section = parsed[LEGACY_SETTINGS_NS];
  if (!isPlainRecord(section)) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: true,
      values: {},
      error: `${name} 的 ${LEGACY_SETTINGS_NS} section 不是对象`,
    };
  }
  const sanitized = sanitizeSettings(section);
  const validDeflatePolicy =
    sanitized?.wsDeflatePolicy === undefined || isPlainRecord(sanitized.wsDeflatePolicy);
  if (sanitized === null || !validDeflatePolicy || !isJsonCloneable(sanitized)) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: true,
      values: {},
      error: `${name} 的 ${LEGACY_SETTINGS_NS} section 含非法配置值`,
    };
  }
  return {
    name,
    present: true,
    valid: true,
    hasSection: true,
    values: cloneValue(sanitized),
  };
}

/** reader 的可观测结果；失败时仍保留各文档状态，但不提供可写 values。 */
export interface LegacySettingsReadResult {
  readonly ok: boolean;
  readonly hasSection: boolean;
  readonly values: JsonRecord;
  readonly documents: readonly DocumentRead[];
  readonly error?: string;
}

/**
 * 读取两个 profile 文档并按 imported < settings.yaml 合并旧 section。
 * 任一存在文件读/解析失败即整体失败；不存在文件不算失败。
 */
export function readLegacySettings(
  options: { readonly home?: string } = {},
): LegacySettingsReadResult {
  const home = options.home ?? dshHome();
  const documents = SETTINGS_DOCUMENT_NAMES.map((name) => readDocument(home, name));
  const invalid = documents.find((document) => !document.valid);
  if (invalid !== undefined) {
    return {
      ok: false,
      hasSection: documents.some((document) => document.hasSection),
      values: {},
      documents,
      error: invalid.error,
    };
  }

  const imported = documents.find((document) => document.name === "settings.yaml.imported");
  const settings = documents.find((document) => document.name === "settings.yaml");
  const values = mergeRecords(
    imported?.values ?? createRecord(),
    settings?.values ?? createRecord(),
  );
  return {
    ok: true,
    hasSection: documents.some((document) => document.hasSection),
    values,
    documents,
  };
}

export type LegacySettingsMigrationStatus = "migrated" | "already-complete" | "skipped" | "failed";

/** 独立 settings step 的结果；不借用 config.json MigrationOutcome。 */
export interface LegacySettingsMigrationOutcome {
  readonly status: LegacySettingsMigrationStatus;
  /** 本轮是否实际提交了至少一个有效旧字段。 */
  readonly migrated: boolean;
  /** 本轮结束时完成 marker 是否存在。 */
  readonly completed: boolean;
  /** 失败原因（不含文档正文）。 */
  readonly error?: string;
}

export interface LegacySettingsMigrationOptions {
  /** profile home；默认取 dshHome()，测试/隔离 profile 可显式传入。 */
  readonly home?: string;
  /** 插件私有目录；marker 写在此处，默认取 pluginDir()。 */
  readonly configDir?: string;
  /** canonical settings 的 raw user section；字段存在即用户已决定。 */
  readonly currentUser?: unknown;
  /** canonical owner scope；本 step 只使用 update，不触碰 config file state。 */
  readonly scope: Pick<OwnerScopeLike, "update">;
  readonly logger?: { warn?: (...args: unknown[]) => void };
}

function markerPath(configDir: string): string {
  return join(configDir, SETTINGS_MIGRATION_MARKER_NAME);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * 只生成旧值中 current 未拥有的字段；同层 plain object 递归补缺。
 * current 的空对象与非 plain 值均是显式决定，不从 old 展开子键。
 */
function diffOverlay(
  lowOld: JsonRecord,
  current: JsonRecord,
  ancestors = new WeakSet<object>(),
): JsonRecord {
  const patch = createRecord();
  if (ancestors.has(current)) return patch;
  ancestors.add(current);
  try {
    for (const [key, oldValue] of Object.entries(lowOld)) {
      if (!hasOwn(current, key)) {
        patch[key] = cloneValue(oldValue);
        continue;
      }
      const currentValue = current[key];
      if (
        isPlainRecord(oldValue) &&
        isPlainRecord(currentValue) &&
        Object.keys(currentValue).length > 0
      ) {
        const nested = diffOverlay(oldValue, currentValue, ancestors);
        if (Object.keys(nested).length > 0) patch[key] = nested;
      }
    }
    return patch;
  } finally {
    ancestors.delete(current);
  }
}

function writeCompletionMarker(configDir: string): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(configDir, { recursive: true });
    const target = markerPath(configDir);
    const temporary = join(configDir, `.${SETTINGS_MIGRATION_MARKER_NAME}.${process.pid}.tmp`);
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件不存在是正常路径。
    }
    writeFileSync(temporary, `${SETTINGS_MIGRATION_MARKER_VERSION}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `写入 settings 迁移完成 marker 失败：${errorMessage(error)}` };
  }
}

function failure(
  error: string,
  logger?: LegacySettingsMigrationOptions["logger"],
): LegacySettingsMigrationOutcome {
  logger?.warn?.(`lan-proxy: ${error}`);
  return { status: "failed", migrated: false, completed: false, error };
}

/**
 * 执行一次旧 settings section 迁移。
 *
 * marker 命中时完全不读旧源、不写 scope，直接返回 already-complete；这使
 * 用户在迁移后清除可选字段再重启也不会被旧文档复活。没有 marker 时，只有
 * reader 成功且 scope.update 成功才写 marker。两份文档都没有旧 section 时
 * 返回 skipped 且不写 marker，给未来出现的 imported 来源留下消费机会；旧
 * section 存在但字段为空时才提交空 patch，让“已检查并完成”成为可观察的
 * 独立状态。
 */
export async function migrateLegacySettings(
  options: LegacySettingsMigrationOptions,
): Promise<LegacySettingsMigrationOutcome> {
  const configDir = options.configDir ?? pluginDir();
  const target = markerPath(configDir);
  if (existsSync(target)) {
    return { status: "already-complete", migrated: false, completed: true };
  }

  const read = readLegacySettings({ home: options.home });
  if (!read.ok) return failure(read.error ?? "旧 settings 读取失败", options.logger);
  if (!read.hasSection) {
    return { status: "skipped", migrated: false, completed: false };
  }

  let currentUser: JsonRecord = {};
  if (options.currentUser !== undefined && options.currentUser !== null) {
    if (!isPlainRecord(options.currentUser)) {
      return failure("当前 canonical user section 不是对象", options.logger);
    }
    currentUser = options.currentUser;
  }

  // currentUser 是 raw user 层：只补它缺失的路径，不清洗、不改写，
  // 也不把显式的 null/[]/{} 展开成可由旧源回填的对象。
  const patch = diffOverlay(read.values, currentUser);

  try {
    await options.scope.update(patch);
  } catch (error) {
    return failure(`旧 settings 写入 canonical scope 失败：${errorMessage(error)}`, options.logger);
  }

  const marker = writeCompletionMarker(configDir);
  if (!marker.ok) return failure(marker.error, options.logger);
  return {
    status: "migrated",
    migrated: Object.keys(patch).length > 0,
    completed: true,
  };
}
