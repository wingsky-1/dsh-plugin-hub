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

/** index.jsonl 最小解析（坏行跳过；与 common/report-index.ts 同白名单，不导入它以守纯面边界）。 */
function parseIndexRecords(raw: string): LastRunRecord[] {
  const out: LastRunRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<LastRunRecord> | null;
      if (
        obj !== null &&
        typeof obj === "object" &&
        (obj.period === "daily" || obj.period === "weekly" || obj.period === "monthly") &&
        typeof obj.key === "string" &&
        typeof obj.endDay === "string" &&
        typeof obj.generatedAt === "number" &&
        typeof obj.ok === "boolean"
      ) {
        out.push({
          period: obj.period,
          key: obj.key,
          generatedAt: obj.generatedAt,
          endDay: obj.endDay,
          ok: obj.ok,
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * last-run 迁移。幂等：无 index 视作无事实不动；已对齐即无改写；坏文件保持原状 + 诊断。
 */
export async function migrateLastRun(deps: UpgradeDeps): Promise<void> {
  const root = deps.resolveRoot();
  const file = targetLastRunFile(root);
  const raw = await deps.readOldFile(file);
  if (raw.ok === false) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text) as unknown;
  } catch {
    deps.logger.warn(`dsh-provider-usage: last-run 文件 ${basename(file)} 损坏，保持原状`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    deps.logger.warn(`dsh-provider-usage: last-run 文件 ${basename(file)} 顶层非对象，保持原状`);
    return;
  }
  const record = parsed as Record<string, unknown>;
  const schema = typeof record.schema === "number" ? record.schema : 1;
  const before = projectLastRun(record);
  const indexRaw = await deps.readOldFile(indexFile(root));
  if (indexRaw.ok === false) return;
  let indexParsed: LastRunRecord[];
  try {
    indexParsed = parseIndexRecords(indexRaw.text);
  } catch {
    deps.logger.warn(`dsh-provider-usage: 报告索引损坏，保持 last-run 原状`);
    return;
  }
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
