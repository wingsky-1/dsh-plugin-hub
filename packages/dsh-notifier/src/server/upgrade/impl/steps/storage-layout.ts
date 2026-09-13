/**
 * upgrade 域 0.2.3 → 0.2.4：存储布局归位——把散在 DSH home 根目录的数据文件收进包私有目录；**没有旧文件的安装同样
 * 在这一步落定**（直接建出初始形态）。配置文件不在这里：它有两代旧形态，读取要等宿主服务就绪（装配期拿不到的时机）。
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import {
  writeTextAtomicSync,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  legacyFile,
  notifierFile,
} from "../../../shared/interface.ts";
/** 旧文件改名后缀：搬完留证据，也是「这一份处理过了」的标记。 */
const MIGRATED_SUFFIX = ".migrated.bak";

/** 空 JSON 对象的落盘形态。 */
const EMPTY_OBJECT = "{}\n";

/** 序号文件的初始形态：与流侧落盘同形（流侧写 `${seq}\n`），首次读取直接得到 0。 */
const ZERO_SEQ = "0\n";

/** 存储布局的一项。 */
interface StorageEntry {
  /** 旧文件名（DSH home 根目录下）。 */
  legacy: string;
  /** 新文件名（包私有存储目录下）。 */
  target: string;
  /** 目标缺失且无旧文件时的初始形态。 */
  initial: string;
}

const LAYOUT: readonly StorageEntry[] = [
  {
    legacy: "dsh-notifier-history.jsonl",
    target: HISTORY_FILE_NAME,
    initial: "",
  },
  {
    legacy: "dsh-notifier-status.json",
    target: STATUS_FILE_NAME,
    initial: EMPTY_OBJECT,
  },
  {
    legacy: "notifier-seq.json",
    target: SEQ_FILE_NAME,
    initial: ZERO_SEQ,
  },
];

/**
 * 旧存储 → 新存储布局：有旧文件的搬过来，没有的建出初始形态。初始形态一律是**空结构**而不是默认值快照
 * ——写全量默认值会把「用户覆盖过哪些键」这个语义冲掉（文件里每个键都会被读成用户显式提交的），而那份差别
 * 正是设置页判断哪些字段该标记为「已改」的依据。逐文件独立（一个搬不动不影响其余），但**搬不动都抛出**：
 * 迁移没做完而启动照常，等于让各域按错误的形态去读数据。幂等：目标已存在即处理过，归档名固定、重跑不累积。
 */
export function migrateStorageLayout(): void {
  for (const entry of LAYOUT) settleOne(entry);
}

/**
 * 落定一项。目标已存在即视为「这一份处理过了」：不覆盖、只把源文件归档——用户可能在新位置已经改过东西，
 * 用旧文件盖回去等于用历史覆盖现在。
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
  writeTarget(target, readSource(source));
  archive(source, MIGRATED_SUFFIX);
}

/** 读旧文件；读不出来即抛——那是「搬不动」，不该被当成「没有旧数据」。 */
function readSource(source: string): string {
  try {
    return readFileSync(source, "utf8");
  } catch (cause) {
    throw new Error(`旧存储文件不可读：${source}`, { cause });
  }
}

function writeTarget(target: string, text: string): void {
  const written = writeTextAtomicSync(target, text);
  if (!written.ok) throw new Error(`存储文件落盘失败：${target} — ${written.reason}`);
}

/** 归档旧文件；本来就没有就什么都不做。后缀是「这一份处理过了」的标记。 */
function archive(source: string, suffix: string): void {
  if (!existsSync(source)) return;
  try {
    renameSync(source, `${source}${suffix}`);
  } catch (cause) {
    throw new Error(`旧存储文件改名失败：${source}`, { cause });
  }
}
