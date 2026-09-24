/**
 * upgrade 域存量设置的读取。正式历史来源固定为 `$DSH_HOME/settings.yaml` 与
 * `$DSH_HOME/settings.yaml.imported`：官方 0.1.7-rc.1 importer 会把前者导入当前 profile，再把原文改名为后者。
 *
 * 优先级是正式双文件（settings.yaml 高于 imported）→ describe → V0 JSON。正式文件存在但读、解析、
 * 分节校验或序列化失败时直接抛错，不能折成 absent 让升级静默成功。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { dshHome } from "../../../../../../../shared/dsh-home.js";
import { legacyFile } from "../../../shared/interface.ts";
import type { RawSettingValue } from "../../deps.ts";
import type { LegacySettingsFace, LegacyStoredSettings } from "./type.ts";

/** 本插件在旧官方 settings 文档里的命名空间。 */
const SETTINGS_NS = "dsh-notifier";

/** 正式来源按低到高排列；字段合并时后读到的当前文件覆盖先前 imported。 */
function formalSettingsFiles(): readonly string[] {
  return [join(dshHome(), "settings.yaml.imported"), join(dshHome(), "settings.yaml")];
}

/** V0 的两个候选文件名，按优先级。…migrated.bak 是 0.2.3 迁移完成后的幂等标记。 */
const LEGACY_FILES: readonly string[] = ["dsh-notifier.json", "dsh-notifier.json.migrated.bak"];

/** 旧配置里属于组合层装配的键；新架构下由启动参数提供。 */
const ENTRY_KEYS: readonly string[] = [
  "enabled",
  "configFile",
  "historyFile",
  "statusFile",
  "toastScript",
];

/** 旧的全局声音开关；新架构按出口拆成两个键。 */
const LEGACY_SOUND_KEY = "notifySound";

/** 两个按出口的声音键。 */
const SOUND_KEYS: readonly string[] = ["browserSound", "systemSound"];

/** 原型链上的危险键名不能进入递归合并结果。 */
const UNSAFE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** 正式文件读取三态中的前两态；第三态（invalid/unreadable）以异常明确失败。 */
type FormalSettingsRead =
  | { readonly kind: "absent" }
  | { readonly kind: "readable"; readonly settings: LegacyStoredSettings };

/**
 * 读存量设置。空对象只在所有正式来源、describe 与 V0 都没有可迁数据时返回。
 * @throws 正式来源或 V0 文件存在但无法读取、解析、校验或序列化时。
 */
export function readLegacySettings(settings: LegacySettingsFace): LegacyStoredSettings {
  const formal = readFormalSettings();
  if (formal.kind === "readable") return convert(formal.settings);

  const described = readFromSettings(settings);
  if (Object.keys(described).length > 0) return described;

  return readFromFile();
}

/** 读正式双文件；任一文件存在就进入字段合并，不因当前分节为空而丢掉 imported 的其余字段。 */
function readFormalSettings(): FormalSettingsRead {
  let found = false;
  let merged: LegacyStoredSettings = {};

  for (const path of formalSettingsFiles()) {
    const section = readDocumentSection(path);
    if (section === undefined) continue;
    found = true;
    merged = mergeSettings(merged, section);
  }

  return found ? { kind: "readable", settings: merged } : { kind: "absent" };
}

/** 读一份正式文档里的 notifier 分节；不存在是 absent，其余失败都不是 absent。 */
function readDocumentSection(path: string): LegacyStoredSettings | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw sourceError(path, "读取失败", error);
  }

  let parsed: RawSettingValue;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw sourceError(path, "YAML 解析失败", error);
  }

  // 官方 importer 允许空 settings 文档并只做改名；它没有 notifier 分节，仍应继续走低优先级兜底。
  if (parsed === null || parsed === undefined) return undefined;
  if (!isPlainRecord(parsed)) throw sourceError(path, "顶层不是普通对象");

  const section = parsed[SETTINGS_NS];
  if (section === undefined) return undefined;
  if (!isPlainRecord(section)) throw sourceError(path, `${SETTINGS_NS} 分节不是普通对象`);
  if (!isSerializable(section)) throw sourceError(path, `${SETTINGS_NS} 分节无法序列化`);
  return section;
}

/** low 为低优先级，high 为高优先级；两边都是普通对象时递归，数组/标量整体替换。 */
function mergeSettings(
  low: LegacyStoredSettings,
  high: LegacyStoredSettings,
): LegacyStoredSettings {
  const merged: Record<string, RawSettingValue> = {};

  for (const key of Object.keys(low)) {
    if (UNSAFE_KEYS.includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(high, key)) {
      merged[key] = low[key];
      continue;
    }
    const lowValue = low[key];
    const highValue = high[key];
    merged[key] =
      isPlainRecord(lowValue) && isPlainRecord(highValue)
        ? mergeSettings(lowValue, highValue)
        : highValue;
  }

  for (const key of Object.keys(high)) {
    if (UNSAFE_KEYS.includes(key) || Object.prototype.hasOwnProperty.call(low, key)) continue;
    merged[key] = high[key];
  }

  return merged;
}

/** describe 只给非文件 provider 或旧注册实例保留低优先级兜底。 */
function readFromSettings(settings: LegacySettingsFace): LegacyStoredSettings {
  let entries: ReturnType<LegacySettingsFace["describe"]>;
  try {
    entries = settings.describe({ redactSecrets: true });
  } catch {
    return {};
  }

  for (const entry of entries) {
    if (entry.ns !== SETTINGS_NS) continue;
    const user = entry.user;
    if (typeof user !== "object" || user === null || Array.isArray(user)) return {};
    if (!isSerializable(user))
      throw new Error(`dsh-notifier: legacy settings describe 来源无法序列化 — ${SETTINGS_NS}`);
    return convert(user as LegacyStoredSettings);
  }
  return {};
}

/** 读 V0 JSON；它只在正式来源和 describe 都没有数据时兜底。 */
function readFromFile(): LegacyStoredSettings {
  for (const name of LEGACY_FILES) {
    const path = legacyFile(name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw sourceError(path, "读取失败", error);
    }

    let raw: RawSettingValue;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw sourceError(path, "JSON 解析失败", error);
    }
    if (!isPlainRecord(raw)) throw sourceError(path, "顶层不是普通对象");
    if (!isSerializable(raw)) throw sourceError(path, "内容无法序列化");
    return convert(raw);
  }
  return {};
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sourceError(path: string, reason: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? `：${cause.message}` : "";
  return new Error(`dsh-notifier: legacy settings 来源 ${reason} — ${path}${detail}`);
}

/** 存量最终会经 JSON.stringify 落进 config.json；不可序列化必须在读取边界失败。 */
function isSerializable(raw: unknown): boolean {
  try {
    JSON.stringify(raw);
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const prototype = Object.getPrototypeOf(raw);
  return prototype === Object.prototype || prototype === null;
}

/** 旧配置语义 → 当前配置语义；未知字段保留，装配键与原型链危险键剔除。 */
function convert(stored: LegacyStoredSettings): LegacyStoredSettings {
  const next: Record<string, RawSettingValue> = {};
  for (const key of Object.keys(stored)) {
    if (ENTRY_KEYS.includes(key) || UNSAFE_KEYS.includes(key)) continue;
    next[key] = stored[key];
  }

  const legacySound = next[LEGACY_SOUND_KEY];
  if (typeof legacySound === "boolean") {
    for (const key of SOUND_KEYS) {
      if (!(key in next)) next[key] = legacySound;
    }
  }
  return next;
}
