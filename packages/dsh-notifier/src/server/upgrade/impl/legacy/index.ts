/** upgrade 域存量配置的读取（0.2.3 及更早）：**V1** 是 0.2.3 搬进官方 settings 命名空间的那份，**V0** 是更早的自建
 * JSON 文件（0.2.3 迁移时改名成 `…migrated.bak` 作幂等标记）。**V1 优先于 V0**——反过来取会让「设置回到更早的样子」。
 *
 * V1 从**宿主文档文件**直接读：`describe()` 只列已注册的命名空间，而本插件不再注册它（见 `type.ts` 的说明），
 * 服务面那条路读不到存量的 user 层——把它留在后面只作非文件型 provider 的兜底。 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { legacyFile, settingsDocument } from "../../../shared/interface.ts";
import type { RawSettingValue } from "../../deps.ts";
import type { LegacySettingsFace, LegacyStoredSettings } from "./type.ts";

/** 本插件在官方 settings 服务里的命名空间（0.2.3 用的那个）。 */
const SETTINGS_NS = "dsh-notifier";

/** settings 文档的候选文件名：`.yaml` 是官方文件型 provider 的缺省，`.json` 是它支持的另一种扩展名。 */
const SETTINGS_DOC_FILES: readonly string[] = ["settings.yaml", "settings.json"];

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

/** 读存量设置：V1（宿主文档文件 → 已注册命名空间）优先，回退 V0。
 * @returns 已做语义转换的设置；空对象 = 旧版本没有可迁的东西，它同时是「读不到」与「读到了但一个键都没有」的答案。 */
export function readLegacySettings(settings: LegacySettingsFace): LegacyStoredSettings {
  const fromDocument = readFromDocument(settings.documentPath);
  if (Object.keys(fromDocument).length > 0) return fromDocument;
  const fromSettings = readFromSettings(settings);
  if (Object.keys(fromSettings).length > 0) return fromSettings;
  return readFromFile();
}

/**
 * 读宿主 settings 文档里本插件那一节（V1 的原始 user 层）。
 *
 * 为什么不问服务要：`describe()` 只列已注册的命名空间，而本插件从 0.2.4 起不再注册它——那条路永远读空。
 * `documentPath` 由 provider 自报（文件型 provider 覆盖了该 getter），拿不到就按官方缺省名在 DSH home 下找。
 */
function readFromDocument(documentPath: string | undefined): LegacyStoredSettings {
  for (const path of documentCandidates(documentPath)) {
    const section = readDocumentSection(path);
    if (section !== undefined) return convert(section);
  }
  return {};
}

/** 候选文档路径：provider 自报的优先；它没有文件（或没给出路径）时按官方缺省名找——非文件型 provider 读不到，
 * 也就自然落到下一环（服务面）。 */
function documentCandidates(documentPath: string | undefined): readonly string[] {
  if (typeof documentPath === "string" && documentPath.trim().length > 0) return [documentPath];
  return SETTINGS_DOC_FILES.map((name) => settingsDocument(name));
}

/** 读一份文档并取本插件的分节：文件不存在、读不动、解析失败、分节不是普通对象，一律算「没有存量」。 */
function readDocumentSection(path: string): LegacyStoredSettings | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // 权限或竞态：读存量不该拦住插件启动，按没有存量处理。
    return undefined;
  }
  const document = parseDocumentText(text, path);
  const section = document === undefined ? undefined : document[SETTINGS_NS];
  if (section === undefined) return undefined;
  return isPlainRecord(section) ? section : undefined;
}

/** 按扩展名分派解析：`.json` 用 JSON，其余按 YAML（官方 provider 只认 .yaml / .yml / .json）；坏文本算解释不了。 */
function parseDocumentText(
  text: string,
  path: string,
): Record<string, RawSettingValue> | undefined {
  try {
    const parsed: RawSettingValue = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 普通对象判定：数组与 null 都能被 `Object.keys` 读出一堆假键，认下来就等于往配置里灌用户从没设过的键。 */
function isPlainRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** 读官方 settings 里那个命名空间的 user 层（兜底：只有**已注册**该命名空间的 provider 才会命中）。 */
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
      if (!isPlainRecord(raw)) continue;
      return convert(raw);
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
