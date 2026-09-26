/**
 * 绑定表纯逻辑：形状校验、按会话索引、revision 递增规则。
 *
 * 不碰磁盘、不碰宿主——所以「损坏文件当空表」「revision 单调」「摘不存在的会话不涨 revision」
 * 这三条判据可以被单测直接打红，不需要起 cordis，也不需要真文件。
 */
import { BINDINGS_VERSION } from "./type.ts";
import type { BindingRecord, BindingsFile } from "./type.ts";

/** 空表。revision 从 0 起：它是**内容版本**而不是写入次数，客户端只做相等比较。 */
export function emptyTable(): BindingsFile {
  return { version: BINDINGS_VERSION, revision: 0, bindings: {} };
}

/** 单条记录的字段校验。任何一项不合格就丢弃该条——半条记录比没有记录更危险。 */
export function validateRecord(value: unknown): BindingRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const repoRoot = raw["repoRoot"];
  const worktreeRoot = raw["worktreeRoot"];
  const branch = raw["branch"];
  const createdAt = raw["createdAt"];
  const sessionCreatedAt = raw["sessionCreatedAt"];
  if (!isNonEmptyString(repoRoot)) return undefined;
  if (!isNonEmptyString(worktreeRoot)) return undefined;
  if (typeof branch !== "string") return undefined;
  if (typeof createdAt !== "string") return undefined;
  // 身份凭据缺席就丢弃这条记录：留着它等于留着「新会话可能继承旧登记」那个洞。
  if (typeof sessionCreatedAt !== "number" || !Number.isFinite(sessionCreatedAt)) return undefined;
  return { repoRoot, worktreeRoot, branch, createdAt, sessionCreatedAt };
}

/** 非空字符串（类型谓词，故下面读出后就是 string，不必再判）。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 解析绑定表文本。**任何**异常与形状不符都回落空表：这里没有「部分恢复」的选项——
 * 一条来源不明的绑定会把会话的文件树指向一个用户没选过的目录。
 */
export function parseTable(text: string): BindingsFile {
  const parsed = parseJsonOrUndefined(text);
  if (parsed === undefined) return emptyTable();
  const header = tableHeaderOf(parsed);
  if (header === undefined) return emptyTable();
  return { version: BINDINGS_VERSION, revision: header.revision, bindings: recordsOf(header) };
}

/** 解析失败即 undefined（解析不了与形状不对同归「空表」，调用方不必分两处处理）。 */
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 表头三道守卫：版本 / revision / bindings 容器。任一不过即整表作废。
 *
 * 与「逐条记录」分开：前者判的是这份文件**是不是**本版格式（整表的生死），后者判的是**某一条**
 * 能不能留（一条不合格只丢那一条）。原先揉在一个函数里时，「丢整表」与「丢一条」的后果差别
 * 会被同样的 `return emptyTable()` 淹没。
 */
function tableHeaderOf(
  parsed: unknown,
): { readonly revision: number; readonly entries: Record<string, unknown> } | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  // 只接受当前版本：更高版本字段含义未定，猜错会静默挂错目录；更低版本的迁移路径在真正出现旧版时才引入。
  if (raw["version"] !== BINDINGS_VERSION) return undefined;
  const revision = raw["revision"];
  if (typeof revision !== "number" || !Number.isFinite(revision) || revision < 0) return undefined;
  const entries = raw["bindings"];
  if (typeof entries !== "object" || entries === null) return undefined;
  return { revision, entries: entries as Record<string, unknown> };
}

/** 逐条记录：空 sessionId 与不合格的记录各自跳过（半条记录比没有记录更危险）。 */
function recordsOf(header: {
  readonly entries: Record<string, unknown>;
}): Record<string, BindingRecord> {
  const bindings: Record<string, BindingRecord> = {};
  for (const [sessionId, value] of Object.entries(header.entries)) {
    if (sessionId.length === 0) continue;
    const record = validateRecord(value);
    if (record !== undefined) bindings[sessionId] = record;
  }
  return bindings;
}

/** 序列化。带缩进是为了让人能直接看这份文件——它的内容就是「哪个会话指向哪」的全部答案。 */
export function serializeTable(table: BindingsFile): string {
  return JSON.stringify(table, null, 2) + "\n";
}

/** 落一条绑定。revision 递增：客户端以它判定「宿主侧是否已经变了」。 */
export function putBinding(
  table: BindingsFile,
  sessionId: string,
  record: BindingRecord,
): BindingsFile {
  return {
    version: table.version,
    revision: table.revision + 1,
    bindings: { ...table.bindings, [sessionId]: record },
  };
}

/** 摘一条绑定。目标不存在时**原样返回**（不涨 revision）：否则每次「清理一个本来就没有的会话」都会让全网客户端白刷一次。 */
export function dropBinding(table: BindingsFile, sessionId: string): BindingsFile {
  if (!(sessionId in table.bindings)) return table;
  const bindings = { ...table.bindings };
  delete bindings[sessionId];
  return { version: table.version, revision: table.revision + 1, bindings };
}
