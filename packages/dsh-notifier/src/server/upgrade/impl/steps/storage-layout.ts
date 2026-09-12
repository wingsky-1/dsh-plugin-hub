/**
 * dsh-notifier upgrade 域 —— 0.2.3 → 0.2.4：存储布局归位。
 *
 * 把散在 DSH home 根目录的四个文件收进包私有目录，并按新架构改写配置语义。
 * **没有旧文件的安装同样在这一步落定**：直接建出初始形态，让目标目录一次到位，
 * 而不是留一个空目录等各域自己想起来补——「存储在哪、长什么样」这个问题，应该在
 * 升级这一步就有答案。
 *
 * 初始形态一律是**空结构**而不是默认值快照：设置文件写全量默认值会把「用户覆盖
 * 过哪些键」这个语义冲掉（文件里的每一个键都会被读成用户显式提交的），而这份差别
 * 正是设置页判断哪些字段该标记为「已改」的依据。
 *
 * 逐文件独立：一个搬不动不影响其余——四个文件之间没有依赖，配置坏了不该连历史
 * 一起丢。**搬不动都抛出**：迁移没做完而启动照常，等于让各域按错误的形态去读数
 * 据，而那正是最难查的一类故障。内容损坏是唯一例外——它不是「搬不动」而是「没得
 * 搬」，归档留痕后用初始形态补位，让插件带着默认配置起来。
 *
 * 幂等：目标已存在即视为处理过，只归档源文件；归档名固定，重跑不会累积。
 *
 * 依赖方向：只引用本目录、`../../deps.ts`、包内共享层。
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { writeTextAtomicSync } from "../../../shared/file-io.ts";
import {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  legacyFile,
  notifierFile,
} from "../../../shared/paths.ts";
import type { StoredSettings } from "../../deps.ts";

/** 旧文件改名后缀：搬完留证据，也是「这一份处理过了」的标记。 */
const MIGRATED_SUFFIX = ".migrated.bak";

/** 内容损坏时的后缀：留证据但不写入新文件——坏内容搬过去只是把故障挪个地方。 */
const CORRUPTED_SUFFIX = ".corrupted.bak";

/** 空 JSON 对象的落盘形态。 */
const EMPTY_OBJECT = "{}\n";

/** 旧配置里属于组合层装配的键：新架构下它们是启动参数，不再进配置文件。 */
const ENTRY_KEYS: readonly string[] = [
  "enabled",
  "configFile",
  "historyFile",
  "statusFile",
  "toastScript",
];

/** 旧全局声音开关；新架构按出口拆成两个键。 */
const LEGACY_SOUND_KEY = "notifySound";

/** 新的按出口声音键：旧键有值而它们缺失时按旧键补齐，让用户原来的选择不作废。 */
const SOUND_KEYS: readonly string[] = ["browserSound", "systemSound"];

/** 存储布局的一项。 */
interface StorageEntry {
  /** 旧文件名（DSH home 根目录下）。 */
  legacy: string;
  /** 新文件名（包私有存储目录下）。 */
  target: string;
  /** 是否按设置语义转换内容；历史与状态是原样搬运的。 */
  legacySettings: boolean;
  /** 目标缺失且无旧文件时的初始形态。 */
  initial: string;
}

/** 搬运内容准备结果；`ok: false` = 内容读得出来但解释不了（损坏），改用初始形态。 */
type Prepared = { ok: true; text: string } | { ok: false };

const LAYOUT: readonly StorageEntry[] = [
  {
    legacy: "dsh-notifier.json",
    target: CONFIG_FILE_NAME,
    legacySettings: true,
    initial: EMPTY_OBJECT,
  },
  {
    legacy: "dsh-notifier-history.jsonl",
    target: HISTORY_FILE_NAME,
    legacySettings: false,
    initial: "",
  },
  {
    legacy: "dsh-notifier-status.json",
    target: STATUS_FILE_NAME,
    legacySettings: false,
    initial: EMPTY_OBJECT,
  },
  {
    legacy: "notifier-seq.json",
    target: SEQ_FILE_NAME,
    legacySettings: false,
    initial: EMPTY_OBJECT,
  },
];

/** 旧存储 → 新存储布局：有旧文件的搬过来，没有的建出初始形态。 */
export function migrateStorageLayout(): void {
  for (const entry of LAYOUT) settleOne(entry);
}

/**
 * 落定一项。
 *
 * 目标已存在即视为「这一份处理过了」：不覆盖、只把源文件归档。用户可能在新位置
 * 已经改过东西，用旧文件盖回去等于用历史覆盖现在。
 */
function settleOne(entry: StorageEntry): void {
  const target = notifierFile(entry.target);
  const source = legacyFile(entry.legacy);

  if (existsSync(target)) {
    archive(source, MIGRATED_SUFFIX);
    return;
  }
  if (!existsSync(source)) {
    writeTarget(target, entry.initial);
    return;
  }
  const prepared = prepare(source, entry);
  writeTarget(target, prepared.ok ? prepared.text : entry.initial);
  archive(source, prepared.ok ? MIGRATED_SUFFIX : CORRUPTED_SUFFIX);
}

/** 读不出来即抛（搬不动）；内容解释不了交给调用方用初始形态补位。 */
function prepare(source: string, entry: StorageEntry): Prepared {
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (cause) {
    throw new Error(`旧存储文件不可读：${source}`, { cause });
  }
  return entry.legacySettings ? convertSettings(text) : { ok: true, text };
}

/** 旧配置 → 新配置：剔除装配键、把旧全局声音键摊到两个出口键上。 */
function convertSettings(text: string): Prepared {
  try {
    const raw: StoredSettings = JSON.parse(text);
    // 数组也是对象，但按设置解释它只会产出数字键的怪东西；连同 null 一起交给 catch。
    if (Array.isArray(raw)) return { ok: false };
    return { ok: true, text: `${JSON.stringify(upgradeSettings(raw), null, 2)}\n` };
  } catch {
    return { ok: false };
  }
}

/**
 * 配置语义升级。
 *
 * 契约不认识的键原样保留：它们可能是用户手写的，也可能是更高版本留下的，迁移没
 * 有资格替他们决定哪些该丢。
 */
function upgradeSettings(stored: StoredSettings): StoredSettings {
  const next: Record<string, StoredSettings[string]> = {};
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

function writeTarget(target: string, text: string): void {
  const written = writeTextAtomicSync(target, text);
  if (!written.ok) throw new Error(`存储文件落盘失败：${target} — ${written.reason}`);
}

/** 归档旧文件；本来就没有就什么都不做。后缀区分「搬走了」与「内容坏了」两种情况。 */
function archive(source: string, suffix: string): void {
  if (!existsSync(source)) return;
  try {
    renameSync(source, `${source}${suffix}`);
  } catch (cause) {
    throw new Error(`旧存储文件改名失败：${source}`, { cause });
  }
}
