/**
 * dsh-notifier upgrade 域 —— 存量配置的读取（0.2.3 及更早）。
 *
 * 两代旧配置，优先级不同：
 *
 * - **V1**：0.2.3 把配置搬进官方 settings 服务的命名空间，用户的设置在那之后的版本里
 *   改、也写在那里；
 * - **V0**：更早的自建 JSON 文件（写在 DSH home 根目录）。0.2.3 迁移时把它改名成
 *   `…migrated.bak` 作幂等标记，所以两个名字都要看。
 *
 * **V1 优先于 V0**：0.2.3 已经把 V0 的内容迁进了 V1，用户在那一版之后改的值只写在 V1 里，
 * 而 V0 那些文件只是迁移当刻的快照。反过来取的后果是「升级后设置回到了更早的样子」。
 *
 * 依赖方向：只引用本目录、`../../deps.ts` 与包内共享层。
 */
import { existsSync, readFileSync } from "node:fs";
import { legacyFile } from "../../../shared/paths.ts";
import type { RawSettingValue } from "../../deps.ts";
import type { LegacySettingsFace, LegacyStoredSettings } from "./type.ts";

/** 本插件在官方 settings 服务里的命名空间（0.2.3 用的那个）。 */
const SETTINGS_NS = "dsh-notifier";

/**
 * V0 的两个候选文件名，按优先级。
 *
 * `…migrated.bak` 是 0.2.3 迁移完成后改的名——它的内容与改名前的 json 逐字相同，所以
 * 「json 在就用 json、不在就用 bak」不会在两者之间做出错误取舍。
 */
const LEGACY_FILES: readonly string[] = ["dsh-notifier.json", "dsh-notifier.json.migrated.bak"];

/**
 * 旧配置里属于组合层装配的键。
 *
 * 新架构下它们是启动参数（挂载点传入），不再进配置文件；留在配置里会让它们被读成用户
 * 显式设置过的值，而它们在设置页上根本无处可改。
 */
const ENTRY_KEYS: readonly string[] = [
  "enabled",
  "configFile",
  "historyFile",
  "statusFile",
  "toastScript",
];

/** 旧的全局声音开关；新架构按出口拆成两个键。 */
const LEGACY_SOUND_KEY = "notifySound";

/** 两个按出口的声音键：旧键有值而它们缺失时按旧键补齐，让用户原来的选择不作废。 */
const SOUND_KEYS: readonly string[] = ["browserSound", "systemSound"];

/**
 * 读存量设置：V1 优先，回退 V0。
 *
 * @returns 已做语义转换的设置；空对象 = 旧版本没有可迁的东西。空对象同时是「读不到」与
 *   「读到了但一个键都没有」的答案——这两种情况对调用方是同一件事。
 */
export function readLegacySettings(settings: LegacySettingsFace): LegacyStoredSettings {
  const fromSettings = readFromSettings(settings);
  if (Object.keys(fromSettings).length > 0) return fromSettings;
  return readFromFile();
}

/** 读官方 settings 里那个命名空间的 user 层。服务在、但调用失败时按「没有存量」处理。 */
function readFromSettings(settings: LegacySettingsFace): LegacyStoredSettings {
  let entries: ReadonlyArray<{ ns: string; user?: RawSettingValue }>;
  try {
    entries = settings.describe({ redactSecrets: true });
  } catch {
    // 服务在，但它拒绝了这次调用（版本不匹配、内部错误）。读存量不该拦住插件启动：
    // 报错就在这里结束，用户看到的是「设置回到默认」，而那正是没有存量时的样子。
    return {};
  }
  for (const entry of entries) {
    if (entry.ns !== SETTINGS_NS) continue;
    const user = entry.user;
    if (typeof user !== "object" || user === null || Array.isArray(user)) return {};
    return convert(user as LegacyStoredSettings);
  }
  return {};
}

/** 读 V0 文件；第一个能解释的名字胜出，全都读不出来就是空。 */
function readFromFile(): LegacyStoredSettings {
  for (const name of LEGACY_FILES) {
    const path = legacyFile(name);
    if (!existsSync(path)) continue;
    try {
      const raw: RawSettingValue = JSON.parse(readFileSync(path, "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      return convert(raw as LegacyStoredSettings);
    } catch {
      // 损坏：换下一个候选。原地保留文件——用户可能还想手工看看里面是什么。
      continue;
    }
  }
  return {};
}

/**
 * 旧配置语义 → 当前配置语义：剔掉装配键、把旧的全局声音键摊到两个出口键上。
 *
 * 契约不认识的键**原样保留**：它们可能是用户手写的，也可能是更高版本留下的，迁移没有
 * 资格替他们决定哪些该丢。
 */
function convert(stored: LegacyStoredSettings): LegacyStoredSettings {
  const next: Record<string, RawSettingValue> = {};
  for (const key of Object.keys(stored)) {
    if (ENTRY_KEYS.includes(key)) continue;
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
