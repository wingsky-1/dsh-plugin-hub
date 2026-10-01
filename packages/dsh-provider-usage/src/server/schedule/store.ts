/**
 * dsh-provider-usage — server/schedule 域：lastRun 持久化原语（#768 D2，
 * 由 domain2/common/last-run.ts 搬入，零行为变更）。
 *
 * per-root 临界区链唯一实现：读-改-写按 root 串行 + 写前重读全量快照，
 * 防多写方（保存配置 preset / 任务执行器推进）交错 lost-update。调度与执行
 * 经本域 interface.ts 门面消费同一原语（D2 前在 domain2/common，
 * 叶层与 domain2/schedule 构成值环；D2 后归属明确，环消失）。
 */
import { appendFileSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReportPeriod } from "../config/interface.ts";
import {
  alignLastRun,
  deriveLastRun,
  LAST_RUN_SCHEMA,
  type LastRunRecord,
} from "../shared/interface.ts";
import type { ScheduleIndexParser } from "./deps.ts";

/**
 * 临时诊断轨迹的落盘路径（#1058 E1）。未设（或设为空串）时下面 `traceCalib` 第一行
 * 即返回，热路径只多一次布尔比较——不读环境、不开文件、不分配，
 * 本模块行为与不写这段代码逐字相同。
 *
 * 退出条件（写在代码里，不只写在 PR 正文）：本块是**临时诊断仪器、不是产品能力**。
 * 判红定因落在 P1（index 读失败被折叠）/ P2（写侧异常被吞）/ 第七种结局
 * （ensureLastRunMigrated 根本没被调用）之一后，**必须撤除**：删本常量、`traceCalib`、
 * `fsErrCode` 与 6 个 token 调用点，并删 ci.yml 里打印与上传该文件的两个步骤。
 * 撤除另起 PR，不与定因同笔——先定因、后撤除，否则同一处复发时手上又没有仪器。
 */
const CALIB_TRACE_PATH = process.env.DSH_CALIB_TRACE;

/**
 * 6 个决策点各写一行互斥 token。detail 缺省时只写 token 本身。
 *
 * 为什么必须落文件而不是 warn 或 console：两层静默会把诊断吃掉——测试注入的
 * quietWarn 丢弃全部 warn（schedule/composition-root.test.ts），Stryker 的 vitest-runner
 * 又按进程掐掉全部 console（onConsoleLog 返回 false）。appendFileSync 是同步写，
 * 不经过这两层。
 */
function traceCalib(token: string, detail?: string): void {
  if (!CALIB_TRACE_PATH) return;
  appendFileSync(CALIB_TRACE_PATH, `${token}${detail ? ` ${detail}` : ""}\n`, "utf8");
}

/** fs 错误码（B token 要点名 ENOENT 还是 EACCES——两者指向完全不同的定因方向）。 */
function fsErrCode(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String(e.code) : "unknown";
}

/** lastRun 持久化文件。 */
function lastRunFile(root: string): string {
  return join(root, "reports", "last-run.json");
}

/** 读 lastRun（缺失/损坏返回空表）。导出供手动生成路由读改写复用。 */
export async function readLastRun(root: string): Promise<Partial<Record<ReportPeriod, string>>> {
  try {
    const raw = await readFile(lastRunFile(root), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<ReportPeriod, string>> = {};
    for (const p of ["daily", "weekly", "monthly"] as const) {
      if (typeof parsed[p] === "string") out[p] = parsed[p];
    }
    return out;
  } catch {
    return {};
  }
}

/** 原子写 lastRun（tmp+rename，0600；带 schema 版本）。 */
export async function writeLastRun(
  root: string,
  state: Partial<Record<ReportPeriod, string>>,
): Promise<void> {
  const file = lastRunFile(root);
  await mkdir(join(root, "reports"), { recursive: true });
  const tmp = `${file}.${Date.now()}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ ...state, schema: LAST_RUN_SCHEMA, updatedAt: Date.now() }),
    { mode: 0o600 },
  );
  await rename(tmp, file);
}

/**
 * 读 lastRun 原始全量（不应用 daily/weekly/monthly 白名单投影）——临界区写前重读
 * 专用：投影会静默丢弃非白名单键，round-trip 即 lost-update 的读取投影变体。
 */
async function readLastRunRaw(root: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lastRunFile(root), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const lastRunChainByRoot = new Map<string, Promise<void>>();

/**
 * lastRun 单一临界区：读-改-写按 root 串行（per-root promise 链）+ 写前重读。
 * 所有 lastRun 的 read-modify-write 统一收敛到本函数——patch 只在临界区内、基于
 * 链上最新文件快照计算；同一 root 的更新按提交序串行落盘。
 */
export function updateLastRun(
  root: string,
  // 返回类型必须容纳 Promise：patch 允许实现成 async（用于模拟读-改-写之间的交错窗），
  // 下面 await 它的结果。只声明同步形态属「签名撒谎」——await 非 Promise 不会报错也不会
  // 等待，一旦有人照着类型写同步实现并依赖这里真的等了，就是静默的时序 bug（#764 命中）。
  patch: (
    prev: Partial<Record<ReportPeriod, string>>,
  ) => Partial<Record<ReportPeriod, string>> | Promise<Partial<Record<ReportPeriod, string>>>,
): Promise<void> {
  const prev = lastRunChainByRoot.get(root) ?? Promise.resolve();
  const run = async (): Promise<void> => {
    const cur = await readLastRunRaw(root);
    // await patch 结果：patch 允许挂起（async 形态模拟交错窗），不 await 会让
    // writeLastRun 收到未 resolve 的 Promise、spread 丢全部字段。
    await writeLastRun(root, await patch(cur as Partial<Record<ReportPeriod, string>>));
  };
  const next = prev.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  lastRunChainByRoot.set(root, tail);
  return next;
}

/** 测试隔离钩子：返回指定 root 的临界区链尾（await 确定收敛）。 */
export function __lastRunChainForTests(root: string): Promise<void> | undefined {
  return lastRunChainByRoot.get(root);
}

/** lastRun 校准结果（三键齐备，键存在性为对外契约）。 */
interface LastRunCalibration {
  changed: boolean;
  before: Partial<Record<ReportPeriod, string>>;
  after: Partial<Record<ReportPeriod, string>>;
}

/** plain object 判定（类型谓词，承担当前收窄）。 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** lastRun 文档的 schema 版本；非对象或缺键视作 1（历史无版本文档）。 */
export function schemaVersionOf(parsed: unknown): number {
  return isRecordLike(parsed) && typeof parsed.schema === "number" ? parsed.schema : 1;
}

/** 校准输入事实源：schema 版本 + index 事实。缺任一 → 无事实（raw 为 null）。 */
interface LastRunCalibrationInput {
  schema: number;
  before: Partial<Record<ReportPeriod, string>>;
  records: LastRunRecord[];
}

/**
 * 校准决策（纯函数）：schema 旧 → 全量重算（deriveLastRun）；schema 新 → 温和对齐
 * （alignLastRun）。changed 判据与决策同一口径，落盘后仍可原样复算。
 */
export function calibrateLastRun(
  schema: number,
  previous: Partial<Record<ReportPeriod, string>>,
  records: LastRunRecord[],
): { after: Partial<Record<ReportPeriod, string>>; changed: boolean } {
  const after = schema < LAST_RUN_SCHEMA ? deriveLastRun(records) : alignLastRun(previous, records);
  return {
    after,
    changed: schema < LAST_RUN_SCHEMA || JSON.stringify(previous) !== JSON.stringify(after),
  };
}

/**
 * 采集校准事实：lastRun 原文缺失 → 无 lastRun 事实（facts 为 null）；
 * index.jsonl 缺失或解析端口缺席 → 有 lastRun、无 index 事实（records 为 null）。
 * 端口缺席与「无 index」同语义，不静默捏造校准值。
 */
async function collectLastRunCalibrationInput(
  root: string,
  parseIndex: ScheduleIndexParser | undefined,
): Promise<LastRunCalibrationInput | { before: Partial<Record<ReportPeriod, string>> } | null> {
  const raw = await readFile(lastRunFile(root), "utf8").catch(() => null);
  if (raw === null) {
    traceCalib("A_lastrun_unreadable");
    return null;
  }
  const before = await readLastRun(root);
  const indexRaw = await readFile(join(root, "reports", "index.jsonl"), "utf8").catch(
    (e: unknown) => {
      traceCalib("B_index_unreadable", fsErrCode(e));
      return null;
    },
  );
  if (indexRaw === null || parseIndex === undefined) {
    if (parseIndex === undefined) traceCalib("C_no_port");
    return { before };
  }
  return { schema: schemaVersionOf(JSON.parse(raw)), before, records: parseIndex(indexRaw) };
}

export function isLastRunCalibrationInput(
  facts: LastRunCalibrationInput | { before: Partial<Record<ReportPeriod, string>> },
): facts is LastRunCalibrationInput {
  return "records" in facts;
}

/**
 * 启动时 lastRun 一致性保证：schema 旧 → 全量重算（deriveLastRun）；
 * schema 新 → 温和对齐（alignLastRun）；无 index 视作无事实，不动 lastRun。
 *
 * index 解析经 ScheduleIndexParser 端口注入（C 波单向化：本文件不直引
 * 执行域门面，纯函数实现由组合根装配期经调度器透传；缺端口视同无事实，
 * 不动 lastRun——与“无 index”同语义，不静默捏造校准值）。
 */
export async function ensureLastRunMigrated(
  root: string,
  warn?: (msg: string) => void,
  parseIndex?: ScheduleIndexParser,
): Promise<LastRunCalibration> {
  const diag = warn ?? ((msg: string) => console.warn(`[dsh-provider-usage] report: ${msg}`));
  try {
    const facts = await collectLastRunCalibrationInput(root, parseIndex);
    if (facts === null) return { changed: false, before: {}, after: {} };
    if (!isLastRunCalibrationInput(facts)) {
      return { changed: false, before: facts.before, after: facts.before };
    }
    const { after, changed } = calibrateLastRun(facts.schema, facts.before, facts.records);
    if (!changed) {
      traceCalib("D_nochange", `schema=${facts.schema}`);
      return { changed, before: facts.before, after };
    }
    const finalAfter = await commitLastRunCalibration(root, facts);
    traceCalib("E_commit_ok", JSON.stringify(finalAfter));
    const msg =
      `schema ${facts.schema}→${LAST_RUN_SCHEMA}：` +
      `${JSON.stringify(facts.before)} → ${JSON.stringify(finalAfter)}`;
    diag(`lastRun 已按 index 事实校准（${msg}）`);
    return { changed, before: facts.before, after: finalAfter };
  } catch (e: unknown) {
    traceCalib("F_exception", e instanceof Error ? e.message : String(e));
    diag(`lastRun 校准失败（保持原状）：${e instanceof Error ? e.message : String(e)}`);
    return { changed: false, before: {}, after: {} };
  }
}

/**
 * 唯一写面：校准落盘经 per-root 链（与 preset/执行器同链串行）。
 * 链内按最新快照重算（preset 同形）：链外预读定 changed，链内重算定落盘值。
 */
async function commitLastRunCalibration(
  root: string,
  input: LastRunCalibrationInput,
): Promise<Partial<Record<ReportPeriod, string>>> {
  let written: Partial<Record<ReportPeriod, string>> | undefined;
  await updateLastRun(root, (cur) => {
    const fresh =
      input.schema < LAST_RUN_SCHEMA
        ? deriveLastRun(input.records)
        : alignLastRun(cur, input.records);
    written = fresh;
    return fresh;
  });
  return written ?? calibrateLastRun(input.schema, input.before, input.records).after;
}
