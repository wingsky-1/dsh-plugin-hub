/**
 * dsh-provider-usage — upgrade 域 last-run 迁移（schema 旧 → 全量重算，schema 新 → 温和对齐）。
 *
 * 语义与 server/schedule/store.ts 的 ensureLastRunMigrated 同源（D2 前在 domain2/common/last-run.ts），但文件原语走 S2 注入面
 *（deps.readOldFile 读 + 同域 writeFileAtomic 写），不调业务实例
 *（readLastRun/writeLastRun/updateLastRun/ensureLastRunMigrated 均不导入）。
 * deriveLastRun/alignLastRun/LAST_RUN_SCHEMA 经 server/shared/interface.ts 以纯函数复用
 *（#768 A波4 由 schedule 下沉 shared；零 node 依赖，确定性无副作用；S2 允许的 type+pure 面）。
 *
 * per-root 临界区链留 schedule（METHOD §3 Q1 有主即止）：本步在装配前单线程跑，
 * 无并发写方（preset/执行器尚未装配），直接写安全；装配后的并发写仍走 schedule 的
 * updateLastRun 链，本域不自建临界区、不新建 file-io 叶。
 * 坏文件容错（保持原状 + 诊断，不抛）；写失败即抛。
 */
import { basename, join } from "node:path";
import type { ReportPeriod } from "../config/interface.ts";
import {
  LAST_RUN_SCHEMA,
  alignLastRun,
  deriveLastRun,
  type LastRunRecord,
} from "../shared/interface.ts";
import type { UpgradeDeps } from "./deps.ts";
import { targetLastRunFile, writeFileAtomic } from "./storage-layout.ts";

function indexFile(root: string): string {
  return join(root, "reports", "index.jsonl");
}

function projectLastRun(parsed: Record<string, unknown>): Partial<Record<ReportPeriod, string>> {
  const out: Partial<Record<ReportPeriod, string>> = {};
  for (const period of ["daily", "weekly", "monthly"] as const) {
    const value = parsed[period];
    if (typeof value === "string") out[period] = value;
  }
  return out;
}

/** 普通对象判定（承担类型收窄：数组与 null 都不是可投影的 last-run 顶层）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 报告周期白名单（承担类型收窄：非三周期值一律丢弃该行）。 */
function isReportPeriod(value: unknown): value is ReportPeriod {
  return value === "daily" || value === "weekly" || value === "monthly";
}

/**
 * index 记录形状白名单（承担类型收窄）：六个字段逐个按类型校验，任一不符即丢弃该行。
 * 字段集与 common/report-index.ts 同白名单，不导入它以守纯面边界。
 */
function isIndexRecord(value: unknown): value is LastRunRecord {
  if (!isPlainObject(value)) return false;
  return (
    isReportPeriod(value.period) &&
    typeof value.key === "string" &&
    typeof value.endDay === "string" &&
    typeof value.generatedAt === "number" &&
    typeof value.ok === "boolean"
  );
}

/** index.jsonl 单行解析（坏行与形状不符行一律丢弃）。 */
function parseIndexRecord(line: string): LastRunRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  return isIndexRecord(obj) ? obj : null;
}

/** index.jsonl 最小解析（坏行跳过）。 */
function parseIndexRecords(raw: string): LastRunRecord[] {
  const out: LastRunRecord[] = [];
  for (const line of raw.split("\n")) {
    const record = parseIndexRecord(line.trim());
    if (record !== null) out.push(record);
  }
  return out;
}

/** last-run 顶层文档解析与形状校验（损坏/非对象 → 诊断 + 保持原状）。 */
function parseLastRunDocument(
  deps: UpgradeDeps,
  file: string,
  text: string,
): { record: Record<string, unknown>; schema: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    deps.logger.warn(`dsh-provider-usage: last-run 文件 ${basename(file)} 损坏，保持原状`);
    return null;
  }
  if (!isPlainObject(parsed)) {
    deps.logger.warn(`dsh-provider-usage: last-run 文件 ${basename(file)} 顶层非对象，保持原状`);
    return null;
  }
  return {
    record: parsed,
    schema: typeof parsed.schema === "number" ? parsed.schema : 1,
  };
}

/** 索引文本读取（读不到 → null = 无事实，不动 last-run）。 */
async function readIndexText(deps: UpgradeDeps, root: string): Promise<string | null> {
  const indexRaw = await deps.readOldFile(indexFile(root));
  return indexRaw.ok === false ? null : indexRaw.text;
}

/**
 * last-run 迁移。幂等：无 index 视作无事实不动；已对齐即无改写；坏文件保持原状 + 诊断。
 */
export async function migrateLastRun(deps: UpgradeDeps): Promise<void> {
  const root = deps.resolveRoot();
  const file = targetLastRunFile(root);
  const raw = await deps.readOldFile(file);
  if (raw.ok === false) return;
  const document = parseLastRunDocument(deps, file, raw.text);
  if (document === null) return;
  const before = projectLastRun(document.record);
  const indexText = await readIndexText(deps, root);
  if (indexText === null) return;
  let indexParsed: LastRunRecord[];
  try {
    indexParsed = parseIndexRecords(indexText);
  } catch {
    deps.logger.warn(`dsh-provider-usage: 报告索引损坏，保持 last-run 原状`);
    return;
  }
  const schema = document.schema;
  const after =
    schema < LAST_RUN_SCHEMA ? deriveLastRun(indexParsed) : alignLastRun(before, indexParsed);
  const changed = schema < LAST_RUN_SCHEMA || JSON.stringify(before) !== JSON.stringify(after);
  if (changed === false) return;
  await writeFileAtomic(
    file,
    `${JSON.stringify({ ...after, schema: LAST_RUN_SCHEMA, updatedAt: Date.now() }, null, 2)}\n`,
  );
  deps.logger.warn(
    `dsh-provider-usage: last-run 已按 index 事实校准（schema ${schema}→${LAST_RUN_SCHEMA}）`,
  );
}
