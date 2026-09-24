/**
 * upgrade 域 0.2.3 → 0.2.4：配置形态割接——把散在顶层的渠道开关搬进 `channels` 数组的两条内置条目。
 *
 * 为什么直接读写文件而不是走 config 域的写面：链跑在各域装配**之前**，那时写面没有装配好的配置镜像，
 * 以它当基底合并会把整份配置写空。本步只做结构搬运——读出来、换个位置、写回去——不解释语义，所以
 * 「什么算合法设置」仍旧只有 config 域归一化一个答案；它装配在本步之后，读到的正是割接后的形态。
 *
 * 幂等：条目已在场且没有存量要合并时直接返回，重跑与首次跑的结果逐字相同。
 */
import { readFileSync } from "node:fs";
import { writeTextAtomicSync, CONFIG_FILE_NAME, notifierFile } from "../../../shared/interface.ts";
import type { LegacySettingsFace, RawSettingValue } from "../../deps.ts";
import { readLegacySettings } from "../legacy/index.ts";

/**
 * 内置频道类型。这里是**升级域的清单**（旧格式里哪两个渠道要收进 `channels`），不是 config 域那份的
 * 副本：本域不认识当前设置的形状，只认识「旧文件里有哪几个顶层键、该把它们搬到哪儿」。
 */
const BUILTIN_TYPES = ["browser", "system"] as const;

/**
 * 0.2.3 及更早的顶层渠道键：值搬进内置条目之后**删除**——迁移一次做完，不留「旧键还能读」的第二处表达。
 * 读面（config 域归一化）仍能在未割接的文件上消费这些键，所以即便这一步没跑到，行为也不会退化。
 *
 * 名字里带 MIGRATED 而不是复用 config 域那份 RETIRED_KEYS：两者的成员眼下重合，语义却不同——
 * 这份是「要搬到哪去」的迁移清单，config 域那份是「写面一律拒收」的退役清单（它还含没有后继键的
 * maxConnections）。合成一份会让「搬走」与「删掉」两种事实重新纠缠在一起。
 */
const MIGRATED_TOP_LEVEL_KEYS: readonly string[] = [
  "systemEnabled",
  "browserEnabled",
  "systemNotify",
  "browserNotify",
  "notifyWhenVisible",
  "notifySound",
  "browserSound",
  "systemSound",
];

type BuiltinType = (typeof BUILTIN_TYPES)[number];

/**
 * 割接：宿主 settings 里的存量与当前配置文件合并，再把顶层渠道键搬进两条内置条目。
 *
 * 合并顺序与旧写面同口径（文件为基底、存量覆盖）：「设置回到更早的样子」比「保留当前值」糟得多。
 */
export function migrateConfigShape(settings: LegacySettingsFace): void {
  const file = notifierFile(CONFIG_FILE_NAME);
  const stored = readStoredObject(file);
  const legacy = readLegacySettings(settings);
  const hasLegacy = Object.keys(legacy).length > 0;
  // 既没有文件内容也没有存量 = 全新安装：默认表就是它的形态，凭空建一份文件反而会让设置页把默认值
  // 标成「用户改过」——那正是「文件里每个键都被读成显式提交」这条既有语义的反面。
  if (!hasLegacy && Object.keys(stored).length === 0) return;
  const merged: Record<string, RawSettingValue> = { ...stored, ...legacy };
  const shaped = withBuiltinChannels(merged);
  // 有存量就必须落盘（合并结果与文件不同）；没有存量时只在真的缺内置条目时才写。
  if (!hasLegacy && shaped === null) return;
  const written = writeTextAtomicSync(file, `${JSON.stringify(shaped ?? merged, null, 2)}\n`);
  if (!written.ok) throw new Error(`dsh-notifier: 配置形态割接落盘失败 — ${written.reason}`);
}

/** 割接后的形态；`null` = 没有可搬的键、也没有可删的键（幂等出口）。 */
function withBuiltinChannels(
  stored: Record<string, RawSettingValue>,
): Record<string, RawSettingValue> | null {
  const list = Array.isArray(stored.channels) ? stored.channels : [];
  const present = new Set<RawSettingValue>();
  for (const item of list) {
    if (isRecord(item)) present.add(item.type);
  }
  const missing = BUILTIN_TYPES.filter((type) => !present.has(type));
  const retired = MIGRATED_TOP_LEVEL_KEYS.filter((key) => stored[key] !== undefined);
  if (missing.length === 0 && retired.length === 0) return null;
  // 内置恒在最前：与 config 域归一化后的顺序一致，用户看到的卡片顺序不会因为割接而变。
  const next: Record<string, RawSettingValue> = {
    ...stored,
    channels: [...missing.map((type) => builtinEntry(stored, type)), ...list],
  };
  // 搬完即删：同一个事实不留两处表达——留着旧键就成了下一个 `notifySound` 式的隐患。
  for (const key of retired) delete next[key];
  return next;
}

/** 内置条目：只搬**有值**的存量键，缺的留给 config 域归一化补默认——割接不替用户决定默认值。 */
function builtinEntry(
  stored: Record<string, RawSettingValue>,
  type: BuiltinType,
): Record<string, RawSettingValue> {
  const entry: Record<string, RawSettingValue> = { type, id: type };
  const fields: ReadonlyArray<readonly [string, RawSettingValue]> =
    type === "browser"
      ? [
          ["enabled", stored.browserEnabled],
          ["popup", stored.browserNotify],
          ["sound", firstDefined(stored.browserSound, stored.notifySound)],
          ["whenVisible", stored.notifyWhenVisible],
        ]
      : [
          ["enabled", stored.systemEnabled],
          ["popup", stored.systemNotify],
          ["sound", firstDefined(stored.systemSound, stored.notifySound)],
        ];
  for (const [key, value] of fields) {
    if (value !== undefined) entry[key] = value;
  }
  return entry;
}

/** 存量音效键的取值顺序：按出口的键优先，其次旧的全局键——与 config 域归一侧同序，两处不能各说各话。 */
function firstDefined(outlet: RawSettingValue, legacy: RawSettingValue): RawSettingValue {
  return outlet === undefined ? legacy : outlet;
}

/**
 * 配置文件 → 对象。只有文件不存在是合法空配置；存在却读不动、解析不了或顶层不是普通对象，都代表
 * 迁移基线已经不可信，必须让链失败并把刻度留在原处。
 */
function readStoredObject(file: string): Record<string, RawSettingValue> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return {};
    const detail = cause instanceof Error ? `：${cause.message}` : "";
    throw new Error(`dsh-notifier: 配置形态割接读取失败 — ${file}${detail}`, { cause });
  }

  let parsed: RawSettingValue;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? `：${cause.message}` : "";
    throw new Error(`dsh-notifier: 配置形态割接解析失败 — ${file}${detail}`, { cause });
  }
  if (!isRecord(parsed)) {
    throw new Error(`dsh-notifier: 配置形态割接解析失败 — ${file}：顶层不是普通对象`);
  }
  return parsed;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isRecord(raw: RawSettingValue): raw is Record<string, RawSettingValue> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
