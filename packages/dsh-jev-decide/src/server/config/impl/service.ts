/**
 * config 域实现：磁盘状态机（VERSION 刻度 + 三文件读写 + 双轨密钥解析）。
 *
 * - VERSION 文件版本化：存储版本与插件版本相遇处，未升级逐刻度推进；
 * - 三文件独立：config.json（形态）/ presets.json（开关覆盖）/ secrets.json（明文唯一处）；
 * - 双轨密钥：ENV 引用优先（apiKeyRef 命中环境即胜），明文折叠（需二次确认，已在 PUT 校验）；
 * - 落盘一律经注入 io（0600 原子写），本域不直引 store 实现。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigDeps } from "../deps.ts";
import { normalizeLoadedConfig } from "./model.ts";
import type { ConfigPutPatch } from "./model.ts";
import { configFile, presetsFile, secretsFile, versionFile } from "./paths.ts";
import { keyShapeCategory } from "../../../shared/interface.ts";
import type { ConfigV1 } from "../../../shared/interface.ts";

/**
 * 无版本文件时的起点（BASELINE 语义钉死：字面 "0.0.0"，与 "0" 数值等价——
 * compareVersions 缺位补零，故 upgrade 侧“缺失按 0”与本字面是同一事实的两面写法）。
 */
export const BASELINE_VERSION = "0.0.0";
/** 读不到插件版本时的兜底（不阻断启动）。 */
const UNKNOWN_VERSION = "0.0.0";

/** 已加载状态（组合根持有，活对象不进模块级变量）。 */
export interface LoadedState {
  readonly config: ConfigV1;
  readonly plaintext: string | undefined;
  readonly retired: string[];
  readonly storedVersion: string;
}

/** 读存储版本（缺席/空即基线）。 */
export function readStoredVersion(home: string | undefined, deps: ConfigDeps): string {
  const read = deps.io.readTextSync(versionFile(home));
  if (!read.ok) return BASELINE_VERSION;
  const text = read.text.trim();
  return text === "" ? BASELINE_VERSION : text;
}

/** 写存储版本（一步升级完成即推进一档）。 */
export function writeStoredVersion(
  home: string | undefined,
  version: string,
  deps: ConfigDeps,
): void {
  deps.io.atomicWrite0600Sync(versionFile(home), version + "\n");
}

/** 版本号比较（逐段数值；段数不同缺位补零；预发布后缀不参与比较）。 */
export function compareVersions(left: string, right: string): number {
  const parse = (text: string): number[] =>
    text.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** 本插件版本（读包根 package.json；产物形态下本模块位于 lib/server/config/impl/）。 */
export function pluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = join(here, "..", "..", "..", "..", "package.json");
    const parsed: { version?: string } = JSON.parse(readFileSync(manifest, "utf8")) as {
      version?: string;
    };
    return typeof parsed.version === "string" ? parsed.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/** 加载全部状态（三文件合并：presets.json 覆盖 config.json 的开关；退役键剥离告警）。 */
export function loadState(home: string | undefined, deps: ConfigDeps): LoadedState {
  const storedVersion = readStoredVersion(home, deps);
  const raw = deps.io.readJsonSync(configFile(home));
  const normalized = normalizeLoadedConfig(raw.ok ? raw.value : undefined);
  const overlay = deps.io.readJsonSync(presetsFile(home));
  let config = normalized.config;
  if (
    overlay.ok &&
    overlay.value !== null &&
    typeof overlay.value === "object" &&
    !Array.isArray(overlay.value)
  ) {
    const rec = overlay.value as Record<string, unknown>;
    if (Array.isArray(rec["presets"])) {
      const again = normalizeLoadedConfig({ connection: {}, presets: rec["presets"], history: {} });
      const switches = new Map(again.config.presets.map((entry) => [entry.id, entry]));
      config = {
        ...config,
        presets: config.presets.map((entry) => switches.get(entry.id) ?? entry),
      };
    }
  }
  const secrets = deps.io.readJsonSync(secretsFile(home));
  let plaintext: string | undefined;
  if (
    secrets.ok &&
    secrets.value !== null &&
    typeof secrets.value === "object" &&
    !Array.isArray(secrets.value)
  ) {
    const rec = secrets.value as Record<string, unknown>;
    if (typeof rec["apiKeyPlaintext"] === "string") plaintext = rec["apiKeyPlaintext"] as string;
  }
  const retired = [...normalized.retired];
  if (retired.length > 0) deps.logger.warn("dsh-jev-decide: 退役键已剥离 —— " + retired.join(", "));
  const synced: ConfigV1 = {
    ...config,
    connection: {
      ...config.connection,
      hasPlaintextKey: plaintext !== undefined && plaintext.length > 0,
    },
  };
  return { config: synced, plaintext, retired, storedVersion };
}

/**
 * 开关按 id 合并（M1 写死语义：子集补丁只改命中项，未提及项保持存量，
 * 缺失项永不按默认复活——整列替换会让 secret-leak 等开关静默回默认值）。
 */
function mergePresetSwitches(
  current: ConfigV1["presets"],
  patch: NonNullable<ConfigPutPatch["presets"]>,
): ConfigV1["presets"] {
  const switches = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of patch) switches.set(entry.id, { ...entry });
  return current.map((entry) => switches.get(entry.id) ?? entry);
}

/** 应用已校验补丁并落盘（config.json + presets.json + secrets.json 各归其位）。 */
export function savePatch(
  home: string | undefined,
  patch: ConfigPutPatch,
  deps: ConfigDeps,
): LoadedState {
  const current = loadState(home, deps);
  const next: ConfigV1 = {
    ...current.config,
    connection: {
      ...current.config.connection,
      ...(patch.apiKeyRef !== undefined
        ? patch.apiKeyRef === null
          ? { apiKeyRef: undefined }
          : { apiKeyRef: patch.apiKeyRef }
        : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
      ...(patch.maxConcurrency !== undefined ? { maxConcurrency: patch.maxConcurrency } : {}),
      ...(patch.truncBudget !== undefined ? { truncBudget: patch.truncBudget } : {}),
    },
    ...(patch.presets !== undefined
      ? { presets: mergePresetSwitches(current.config.presets, patch.presets) }
      : {}),
    ...(patch.history !== undefined
      ? { history: { ...current.config.history, ...patch.history } }
      : {}),
  };
  let plaintext = current.plaintext;
  if (patch.apiKeyPlaintext !== undefined) {
    plaintext = patch.apiKeyPlaintext;
    deps.io.atomicWrite0600Sync(
      secretsFile(home),
      JSON.stringify({ apiKeyPlaintext: plaintext }, null, 2) + "\n",
    );
  } else if (patch.apiKeyRef !== undefined && patch.apiKeyRef !== null) {
    // 切到 ENV 轨即折叠明文：secrets.json 清空，明文不再落盘。
    plaintext = undefined;
    deps.io.atomicWrite0600Sync(secretsFile(home), JSON.stringify({}, null, 2) + "\n");
  }
  const synced: ConfigV1 = {
    ...next,
    connection: {
      ...next.connection,
      hasPlaintextKey: plaintext !== undefined && plaintext.length > 0,
    },
  };
  deps.io.atomicWrite0600Sync(configFile(home), JSON.stringify(synced, null, 2) + "\n");
  if (patch.presets !== undefined) {
    deps.io.atomicWrite0600Sync(
      presetsFile(home),
      JSON.stringify({ presets: synced.presets }, null, 2) + "\n",
    );
  }
  return { config: synced, plaintext, retired: [], storedVersion: current.storedVersion };
}

/** 掩码视图（GET 回显：形状同 v1，只含 apiKeyRef 名与 hasPlaintextKey，永无原文）。 */
export function toMaskedConfig(state: LoadedState): ConfigV1 {
  return {
    version: state.config.version,
    connection: {
      ...(state.config.connection.apiKeyRef !== undefined
        ? { apiKeyRef: state.config.connection.apiKeyRef }
        : {}),
      hasPlaintextKey: state.config.connection.hasPlaintextKey,
      timeoutMs: state.config.connection.timeoutMs,
      maxConcurrency: state.config.connection.maxConcurrency,
      truncBudget: state.config.connection.truncBudget,
    },
    presets: state.config.presets.map((entry) => ({ ...entry })),
    history: { ...state.config.history },
  };
}

/** 解析可用密钥（ENV 引用优先；手改的坏形状明文视同无 key 并告警）。 */
export function resolveApiKey(
  state: LoadedState,
  env: Record<string, string | undefined>,
  deps: ConfigDeps,
): { readonly key: string | undefined; readonly source: "env" | "plaintext" | "none" } {
  const ref = state.config.connection.apiKeyRef;
  if (ref !== undefined) {
    const value = env[ref];
    if (value !== undefined && value.length > 0) return { key: value, source: "env" };
  }
  const plain = state.plaintext;
  if (plain !== undefined && plain.length > 0) {
    if (keyShapeCategory(plain) === null) return { key: plain, source: "plaintext" };
    deps.logger.warn("dsh-jev-decide: 明文密钥形状非法，已视同无 key");
  }
  return { key: undefined, source: "none" };
}
