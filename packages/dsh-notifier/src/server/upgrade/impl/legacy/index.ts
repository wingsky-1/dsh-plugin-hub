/** upgrade 域存量配置的读取（0.2.3 及更早）：**V1** 是 0.2.3 搬进官方 settings 服务命名空间的那份，**V0** 是更早的自建
 * JSON 文件（0.2.3 迁移时改名成 `…migrated.bak` 作幂等标记）。**V1 优先于 V0**——反过来取会让「设置回到更早的样子」。 */
import { existsSync, readFileSync } from "node:fs";
import { legacyFile } from "../../../shared/interface.ts";
import type { RawSettingValue } from "../../deps.ts";
import type { LegacySettingsFace, LegacyStoredSettings } from "./type.ts";

/** 本插件在官方 settings 服务里的命名空间（0.2.3 用的那个）。 */
const SETTINGS_NS = "dsh-notifier";

/** V0 的两个候选文件名，按优先级。`…migrated.bak` 是 0.2.3 迁移完成后改的名，内容与改名前的 json 逐字相同，所以
 * 「json 在就用 json、不在就用 bak」不会在两者之间做出错误取舍。 */
const LEGACY_FILES: readonly string[] = ["dsh-notifier.json", "dsh-notifier.json.migrated.bak"];

/** 旧配置里属于组合层装配的键：新架构下它们是启动参数（挂载点传入），不再进配置文件——留在配置里会被读成用户显式
 * 设置过的值，而它们在设置页上根本无处可改。 */
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

/** 读存量设置：V1 优先，回退 V0。
 * @returns 已做语义转换的设置；空对象 = 旧版本没有可迁的东西，它同时是「读不到」与「读到了但一个键都没有」的答案。 */
export function readLegacySettings(settings: LegacySettingsFace): LegacyStoredSettings {
  const fromSettings = readFromSettings(settings);
  if (Object.keys(fromSettings).length > 0) return fromSettings;
  return readFromFile();
}

/** 读官方 settings 里那个命名空间的 user 层。服务在、但调用失败时按「没有存量」处理。 */
function readFromSettings(settings: LegacySettingsFace): LegacyStoredSettings {
  let entries: ReturnType<LegacySettingsFace["describe"]>;
  try {
    entries = settings.describe({ redactSecrets: true });
  } catch {
    // 服务在，但它拒绝了这次调用（版本不匹配、内部错误）：读存量不该拦住插件启动，
    // 报错就在这里结束。
    return {};
  }
  for (const entry of entries) {
    if (entry.ns !== SETTINGS_NS) continue;
    // settings 对自己的 `user` 只承诺「有值」，形状判断归读它的人：不是普通对象就按没有存量处理。
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

/** 旧配置语义 → 当前配置语义：剔掉装配键、把旧的全局声音键摊到两个出口键上。契约不认识的键**原样保留**——它们可能
 * 是用户手写的、也可能是更高版本留下的，迁移没有资格替他们决定哪些该丢。 */
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
