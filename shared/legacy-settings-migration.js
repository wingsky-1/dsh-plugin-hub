// dsh 插件家族共享层 — 旧官方 settings section 到 canonical scope 的通用迁移协议。
//
// 插件差异只经参数进入：legacy namespace、section sanitizer、home/configDir、marker 名称/版本、
// canonical scope/currentUser、logger 与日志 label。本模块不认识任何插件配置键，也不负责选择
// 哪些旧字段仍有意义；它只维护跨插件不变量：imported < settings.yaml < currentUser，任一读取/
// 规范化失败不写 receipt；receipt 创建后，未知写入/marker 失败不重放，明确
// revision 冲突才清理 receipt 重试；完成 marker 命中后不再读旧源。
//
// yaml 是仓库既有构建期依赖，由各包 bundle-host 内联；发布物不新增运行时依赖。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { errorMessage } from "./host-utils.js";

const SETTINGS_DOCUMENT_NAMES = ["settings.yaml", "settings.yaml.imported"];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @returns {Record<string, unknown>} */
function createRecord() {
  // null prototype 让 __proto__ 等键只能成为无副作用的自有数据键。
  return Object.create(null);
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {boolean}
 */
function isJsonCloneable(value, seen = new WeakSet()) {
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

/**
 * @template T
 * @param {T} value
 * @param {WeakSet<object>} [ancestors]
 * @returns {T}
 */
function cloneValue(value, ancestors = new WeakSet()) {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("配置值不能包含循环引用");
    ancestors.add(value);
    try {
      return /** @type {T} */ (value.map((item) => cloneValue(item, ancestors)));
    } finally {
      ancestors.delete(value);
    }
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) throw new TypeError("配置值不能包含循环引用");
    ancestors.add(value);
    try {
      const out = createRecord();
      for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child, ancestors);
      return /** @type {T} */ (out);
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    throw new TypeError("配置值不能包含非 plain object");
  }
  return value;
}

/**
 * imported < high；high 中显式出现的值永远优先。
 * @param {Record<string, unknown>} low
 * @param {Record<string, unknown>} high
 * @param {WeakSet<object>} [ancestors]
 * @returns {Record<string, unknown>}
 */
function mergeRecords(low, high, ancestors = new WeakSet()) {
  if (ancestors.has(low) || ancestors.has(high)) throw new TypeError("配置值不能包含循环引用");
  ancestors.add(low);
  ancestors.add(high);
  try {
    const merged = createRecord();
    for (const [key, value] of Object.entries(low)) merged[key] = cloneValue(value, ancestors);
    for (const [key, highValue] of Object.entries(high)) {
      if (!Object.prototype.hasOwnProperty.call(low, key)) {
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

/**
 * @typedef {object} LegacySettingsDocumentRead
 * @property {string} name
 * @property {boolean} present
 * @property {boolean} valid
 * @property {boolean} hasSection
 * @property {Record<string, unknown>} values
 * @property {string} [error]
 */

/**
 * @typedef {object} LegacySettingsReadResult
 * @property {boolean} ok
 * @property {boolean} hasSection
 * @property {Record<string, unknown>} values
 * @property {readonly LegacySettingsDocumentRead[]} documents
 * @property {string} [error]
 */

/**
 * @typedef {object} LegacySettingsReadOptions
 * @property {string} legacyNamespace
 * @property {string} home
 * @property {(section: Record<string, unknown>) => unknown} sanitize
 */

/** @param {string} name @returns {LegacySettingsDocumentRead} */
function absentDocument(name) {
  return { name, present: false, valid: true, hasSection: false, values: {} };
}

/** @param {unknown} error */
function isMissingFileError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    /** @type {{ code?: unknown }} */ (error).code === "ENOENT"
  );
}

/**
 * @param {string} home
 * @param {string} name
 * @param {string} legacyNamespace
 * @param {(section: Record<string, unknown>) => unknown} sanitize
 * @returns {LegacySettingsDocumentRead}
 */
function readDocument(home, name, legacyNamespace, sanitize) {
  const path = join(home, name);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // ENOENT 是候选源不存在；权限、目录、竞态等错误都必须 fail-closed。
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

  let parsed;
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

  // 空文档是合法的“无旧 section”；非对象根不是 settings 文档。
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
  if (!Object.prototype.hasOwnProperty.call(parsed, legacyNamespace)) {
    return { name, present: true, valid: true, hasSection: false, values: {} };
  }

  const section = parsed[legacyNamespace];
  if (!isPlainRecord(section)) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: true,
      values: {},
      error: `${name} 的 ${legacyNamespace} section 不是对象`,
    };
  }

  let sanitized;
  try {
    sanitized = sanitize(section);
  } catch (error) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: true,
      values: {},
      error: `${name} 的 ${legacyNamespace} section 规范化失败：${errorMessage(error)}`,
    };
  }
  if (!isPlainRecord(sanitized) || !isJsonCloneable(sanitized)) {
    return {
      name,
      present: true,
      valid: false,
      hasSection: true,
      values: {},
      error: `${name} 的 ${legacyNamespace} section 含非法配置值`,
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

/**
 * 读取 settings.yaml.imported 与 settings.yaml，并按 imported < settings.yaml 合并旧 section。
 * @param {LegacySettingsReadOptions} options
 * @returns {LegacySettingsReadResult}
 */
export function readLegacySettings(options) {
  const documents = SETTINGS_DOCUMENT_NAMES.map((name) =>
    readDocument(options.home, name, options.legacyNamespace, options.sanitize),
  );
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

/**
 * @typedef {object} LegacySettingsMigrationOutcome
 * @property {"migrated" | "already-complete" | "skipped" | "failed"} status
 * @property {boolean} migrated
 * @property {boolean} completed
 * @property {string} [error]
 */

/**
 * @typedef {object} LegacySettingsMigrationOptions
 * @property {string} legacyNamespace
 * @property {string} home
 * @property {string} configDir
 * @property {string} markerName
 * @property {string} markerVersion
 * @property {(section: Record<string, unknown>) => unknown} sanitize
 * @property {unknown} [currentUser]
 * @property {number} [expectedRevision]
 * @property {{ update(patch: object, expectedRevision?: number): Promise<unknown> }} scope
 * @property {() => void | Promise<void>} [prepareConfigDir]
 * @property {{ warn?: (...args: unknown[]) => void }} [logger]
 * @property {string} label
 */

/**
 * 只生成旧值中 current 未拥有的字段；同层 plain object 递归补缺。
 * current 的空对象与非 plain 值均是显式决定，不从 old 展开子键。
 * @param {Record<string, unknown>} oldValues
 * @param {Record<string, unknown>} current
 * @param {WeakSet<object>} [ancestors]
 * @returns {Record<string, unknown>}
 */
function diffOverlay(oldValues, current, ancestors = new WeakSet()) {
  const patch = createRecord();
  if (ancestors.has(current)) return patch;
  ancestors.add(current);
  try {
    for (const [key, oldValue] of Object.entries(oldValues)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
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

/**
 * @param {string} configDir
 * @param {string} markerName
 * @param {string} markerVersion
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
function writeCompletionMarker(configDir, markerName, markerVersion) {
  try {
    mkdirSync(configDir, { recursive: true });
    const target = join(configDir, markerName);
    const temporary = join(configDir, `.${markerName}.${process.pid}.tmp`);
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件不存在是正常路径。
    }
    writeFileSync(temporary, `${markerVersion}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `写入 settings 迁移完成 marker 失败：${errorMessage(error)}` };
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

/**
 * @param {string} configDir
 * @param {string} markerName
 * @returns {string}
 */
function pendingMarkerPath(configDir, markerName) {
  return join(configDir, `${markerName}.pending`);
}

/**
 * 在任何 canonical 写入之前占有一次迁移机会。receipt 内容只用于审计；恢复时从不读取或重放旧值。
 * @param {string} configDir
 * @param {string} markerName
 * @param {string} markerVersion
 * @param {string} legacyNamespace
 * @param {number | undefined} expectedRevision
 * @returns {{ ok: true; created: boolean } | { ok: false; error: string }}
 */
function writePendingMarker(
  configDir,
  markerName,
  markerVersion,
  legacyNamespace,
  expectedRevision,
) {
  try {
    mkdirSync(configDir, { recursive: true });
    const target = pendingMarkerPath(configDir, markerName);
    writeFileSync(
      target,
      `version=${markerVersion}\nnamespace=${legacyNamespace}\nrevision=${expectedRevision ?? "unknown"}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return { ok: true, created: true };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return { ok: true, created: false };
    }
    return { ok: false, error: `写入 settings 迁移 pending receipt 失败：${errorMessage(error)}` };
  }
}

/**
 * @param {string} configDir
 * @param {string} markerName
 * @param {string} label
 * @param {{ warn?: (...args: unknown[]) => void }} [logger]
 * @returns {boolean} 是否已清理
 */
function removePendingMarker(configDir, markerName, label, logger) {
  try {
    unlinkSync(pendingMarkerPath(configDir, markerName));
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return true;
    logger?.warn?.(`${label}: 清理 settings 迁移 pending receipt 失败：${errorMessage(error)}`);
    return false;
  }
}

/**
 * pending receipt 表示 canonical 写入可能已经提交。恢复时保守地只完成 marker，绝不重放旧 section。
 * @param {LegacySettingsMigrationOptions} options
 * @returns {LegacySettingsMigrationOutcome}
 */
function finalizePendingMarker(options) {
  const marker = writeCompletionMarker(
    options.configDir,
    options.markerName,
    options.markerVersion,
  );
  if (!marker.ok) return failure(marker.error, options.label, options.logger);
  removePendingMarker(options.configDir, options.markerName, options.label, options.logger);
  options.logger?.warn?.(
    `${options.label}: 恢复 settings 迁移 pending receipt；为避免复活已清除值，本次未重放旧 section`,
  );
  return { status: "already-complete", migrated: false, completed: true };
}

/**
 * @param {string} error
 * @param {string} label
 * @param {{ warn?: (...args: unknown[]) => void }} [logger]
 * @returns {LegacySettingsMigrationOutcome}
 */
function isSettingsConflictError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === "SETTINGS_CONFLICT") ||
      ("name" in error && error.name === "SettingsConflictError"))
  );
}

function failure(error, label, logger) {
  logger?.warn?.(`${label}: ${error}`);
  return { status: "failed", migrated: false, completed: false, error };
}

/**
 * 执行一次旧 settings section 迁移。完成 marker 命中时完全不读旧源、不写 scope；
 * pending receipt 则按 at-most-once 规则恢复。
 * @param {LegacySettingsMigrationOptions} options
 * @returns {Promise<LegacySettingsMigrationOutcome>}
 */
export async function migrateLegacySettings(options) {
  const target = join(options.configDir, options.markerName);
  try {
    if (isRegularFile(target))
      return { status: "already-complete", migrated: false, completed: true };
  } catch (error) {
    return failure(
      `检查 settings 迁移完成 marker 失败：${errorMessage(error)}`,
      options.label,
      options.logger,
    );
  }

  const pending = pendingMarkerPath(options.configDir, options.markerName);
  if (existsSync(pending)) return finalizePendingMarker(options);

  const read = readLegacySettings({
    legacyNamespace: options.legacyNamespace,
    home: options.home,
    sanitize: options.sanitize,
  });
  if (!read.ok) return failure(read.error ?? "旧 settings 读取失败", options.label, options.logger);
  if (!read.hasSection) return { status: "skipped", migrated: false, completed: false };

  let currentUser = createRecord();
  if (options.currentUser !== undefined && options.currentUser !== null) {
    if (!isPlainRecord(options.currentUser)) {
      return failure("当前 canonical user section 不是对象", options.label, options.logger);
    }
    currentUser = options.currentUser;
  }

  // currentUser 是 raw user 层：只补缺失路径，不清洗、不改写，也不展开显式 null/[]/{}。
  const patch = diffOverlay(read.values, currentUser);

  if (options.prepareConfigDir !== undefined) {
    try {
      await options.prepareConfigDir();
    } catch (error) {
      return failure(
        `准备 settings 迁移 marker 目录失败：${errorMessage(error)}`,
        options.label,
        options.logger,
      );
    }
  }

  const receipt = writePendingMarker(
    options.configDir,
    options.markerName,
    options.markerVersion,
    options.legacyNamespace,
    options.expectedRevision,
  );
  if (!receipt.ok) return failure(receipt.error, options.label, options.logger);
  if (!receipt.created) return finalizePendingMarker(options);

  try {
    await options.scope.update(patch, options.expectedRevision);
  } catch (error) {
    if (
      isSettingsConflictError(error) &&
      removePendingMarker(options.configDir, options.markerName, options.label, options.logger)
    ) {
      return failure(
        `旧 settings 写入发生 revision 冲突；pending receipt 已清理，下次启动可重试：${errorMessage(error)}`,
        options.label,
        options.logger,
      );
    }
    return failure(
      `旧 settings 写入 canonical scope 失败；pending receipt 已保留，后续不会重放旧 section：${errorMessage(error)}`,
      options.label,
      options.logger,
    );
  }

  const marker = writeCompletionMarker(
    options.configDir,
    options.markerName,
    options.markerVersion,
  );
  if (!marker.ok) {
    return failure(
      `${marker.error}；pending receipt 已保留，后续不会重放旧 section`,
      options.label,
      options.logger,
    );
  }
  removePendingMarker(options.configDir, options.markerName, options.label, options.logger);
  return {
    status: "migrated",
    migrated: Object.keys(patch).length > 0,
    completed: true,
  };
}
