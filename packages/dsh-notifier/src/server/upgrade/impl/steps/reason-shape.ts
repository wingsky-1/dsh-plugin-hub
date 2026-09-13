/**
 * upgrade 域 0.2.3 → 0.2.4：投递理由形态割接——`status.json` 与 `history.jsonl` 里存的是散文，
 * 之后存结构化对象（`{ code, params?, detail? }`）。
 *
 * 为什么放在升级链里而不是让读面各判一次：这两个文件都是**整份重写**的存储，割接一次之后磁盘上
 * 只剩一种形态，客户端不必为「同一字段两种形态」写两遍渲染。读面留下的值域校验只兜手改与半截
 * 写入，不再承担「历史形态」这条主线。
 *
 * 幂等：已经是结构化对象的条目原样保留，重跑不叠加。**解析不出内容时不动那个文件**——两个存储
 * 的读面本来就容错（坏行跳过、半截 JSON 从空表开始），为一份读不出的旧文件拦住启动是更坏的结果；
 * 而写失败必须抛出，那才是「迁移没做完」（与 storage-layout 同一口径）。
 */
import { readFileSync } from "node:fs";
import {
  writeTextAtomicSync,
  HISTORY_FILE_NAME,
  STATUS_FILE_NAME,
  normalizeReason,
  notifierFile,
  sameReasonShape,
} from "../../../shared/interface.ts";

/** 形态割接的落点：文件名 + 一份「把一条记录里嵌的理由挑出来重写」的转换。 */
export function migrateReasonShape(): void {
  rewriteFile(notifierFile(STATUS_FILE_NAME), migrateStatusText);
  rewriteFile(notifierFile(HISTORY_FILE_NAME), migrateHistoryText);
}

/**
 * 读 → 转换 → 有变化才写回。
 *
 * 「只在有变化时写」不是省一次 IO：`history.jsonl` 是追加式存储，无条件重写在并发 append 时
 * 会把那一行盖掉；没有旧形态可割接时什么都不碰，是唯一不引入新竞争窗口的形态。
 */
function rewriteFile(file: string, transform: (text: string) => string | undefined): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // 文件不存在：storage-layout 已经建出初始形态，这里没有活要干。
    return;
  }
  const migrated = transform(text);
  if (migrated === undefined || migrated === text) return;
  const written = writeTextAtomicSync(file, migrated);
  if (!written.ok) throw new Error(`投递理由割接写入失败：${file} — ${written.reason}`);
}

/** `status.json`：逐条把 `lastError` 的旧散文形态换成结构化理由，其余字段原样保留。 */
function migrateStatusText(text: string): string | undefined {
  const table = parseObject(text);
  if (table === undefined) return undefined;
  let changed = false;
  const rebuilt: Record<string, unknown> = {};
  for (const [channelId, entry] of Object.entries(table)) {
    const migrated = migrateStatusEntry(entry);
    if (migrated !== entry) changed = true;
    rebuilt[channelId] = migrated;
  }
  return changed ? `${JSON.stringify(rebuilt, null, 2)}\n` : undefined;
}

/** 单条状态：只认「有 lastError 且它不是规范化后的形态」这一种需要动的形状，其余原样返回。 */
function migrateStatusEntry(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const source = entry as Record<string, unknown>;
  if (source.lastError === undefined) return entry;
  const reason = normalizeReason(source.lastError);
  if (reason === undefined) return entry;
  // 已经是同一个对象级形态（`normalizeReason` 对结构化输入是恒等语义的）就不再重写。
  if (sameReasonShape(source.lastError, reason)) return entry;
  return { ...source, lastError: reason };
}

/** `history.jsonl`：逐行换掉 `channels[].reason`，坏行原样保留（读侧本来就跳过它）。 */
function migrateHistoryText(text: string): string | undefined {
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (line === "") return line;
    const migrated = migrateHistoryLine(line);
    if (migrated === undefined) return line;
    changed = true;
    return migrated;
  });
  return changed ? lines.join("\n") : undefined;
}

function migrateHistoryLine(line: string): string | undefined {
  const entry = parseObject(line);
  if (entry === undefined) return undefined;
  const channels = entry.channels;
  if (!Array.isArray(channels)) return undefined;
  let changed = false;
  const rebuilt = channels.map((delivery) => {
    if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery))
      return delivery;
    const source = delivery as Record<string, unknown>;
    if (source.reason === undefined) return delivery;
    const reason = normalizeReason(source.reason);
    if (reason === undefined || sameReasonShape(source.reason, reason)) return delivery;
    changed = true;
    return { ...source, reason };
  });
  return changed ? JSON.stringify({ ...entry, channels: rebuilt }) : undefined;
}

/** 解析成 JSON 对象；数组、标量、坏 JSON 都算读不出（调用点按此跳过而不是猜）。 */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
