#!/usr/bin/env node
/**
 * scripts/gate/mutation-plan.mjs —— 夜间变异矩阵的段清单与逐段超时派生（#718 S1.1 / S1.4）。
 *
 * 为什么单独成脚本：GHA 的动态 matrix 只能引用 needs 的 output（不能读工作区文件），
 * 而「哪些段要跑」的唯一事实源是 `stryker.conf.d/*.json`（段集合随拆段/加包自动演进）。
 * 故由一个秒级 plan job 把「文件系统事实」翻译成 matrix 可消费的 JSON。
 *
 * 为什么超时按段派生而不是取一个全局值：#718 的两次事故都是**单段擦边超时**
 * （run 34536263640 的 mcp-manager-runtime 21.2 min 对 90 min 的整班预算）。矩阵化后
 * 每段独立 job，超时若仍取全局值，长段会把短段的风险预算一并吃掉；按段取实测 P95
 * 才能让「单段异常」只影响单段。
 *
 * 超时取值（口径必须随数字一起引用）：
 *   - 有 `scope=full` 实测的段：`ceil(实测最长 wallSeconds / 60 × 1.5) + 构建开销`（1.5 为安全系数）；
 *   - 无实测的段：`DEFAULT_TIMEOUT_MINUTES`（保守值，与 ci.yml 的 mutation-gate 同源）；
 *   - 一律不低于 `TIMEOUT_FLOOR_MINUTES`（定标依据见该常量）。
 * 之所以只用 `scope=full` 的实测：全量冷跑的段耗时可达同段增量耗时（有基线复用）的数倍
 * （实测 mcp-manager-supervisor：全量 10.19 min 对增量 104 s，约 5.9 倍），拿增量值定超时会
 * 造成系统性擦边。
 *
 * 用法：node scripts/gate/mutation-plan.mjs        # 打印 matrix JSON（供 GITHUB_OUTPUT）
 * 退出码：0 = 成功；2 = 环境错误（conf 目录为空 / 台账不可解析）。
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failClosed } from "../lib/gate-exit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONF_DIR = join(ROOT, "stryker.conf.d");
const LEDGER_PATH = join(ROOT, "scripts", "data", "mutation-segment-ledger.json");

/**
 * 无全量实测时的保守超时。ci.yml 的 mutation-gate 与 observe.yml 的 shards 都从这里取值
 * （#742 阶段 1 起 PR 侧也走逐段派生，不再有独立的固定值）。
 */
export const DEFAULT_TIMEOUT_MINUTES = 30;
/** #718 整合版规定的下限：低于它会让短段在正常的 runner 抖动下擦边。 */
/**
 * 超时下限。定标依据（#742 阶段 1 落地时重定，2026-09-13）：
 *
 * 历史第一级台阶：#718 整合版规定「下限 10 分钟」，2026-09-12 实测证明不够——run 34681565987
 * 里 dsh-notifier-events 与 -server 都卡在下限被杀，events 被杀时只跑到 67%（336/475），
 * 实际需要约 13 分钟，故提到 20。
 *
 * 本批再抬到 30 的原因不是「20 不够」，而是**强制化改变了误杀的代价结构**：#742 阶段 1 起
 * 变异在 PR 上按命中切片强制跑，一次误杀 = 该段没有报告 → 判分 fail-closed 红 → PR 卡住并要
 * 重跑（实测形态见 run 34628767342：实例 1819s 被 canceled、无 artifact、verdict 9 秒即失败）。
 * 而短段的实测墙钟是 20.6~944.2 s（对应派生值 20~28 分钟），台账又靠人工按需刷新——主干增长
 * 超过 1/3 就会擦边。
 *
 * 故本批取「**任何一段的预算都不低于原来的固定 30 分钟**」作为放开基线：27 个短段从 20~28 抬到
 * 30（对实测有 ≥1.9x 余量，贴地板段里最长的实测 10.3 分钟），4 个长段仍按派生的 32/36/40/42 走
 * （这才是固定值真正不够的地方）。GHA 的 `timeout-minutes` 是**上限**，正常执行不受影响，
 * 只有卡死时才多等几分钟；误杀的代价远大于多等。
 *
 * 收窄路径（#742 记录，不在本批）：台账刷新自动化、或连续若干班观测到派生值相对实测仍有 ≥2x
 * 余量之后，再降回 20 并用当时的台账数据留证。
 */ export const TIMEOUT_FLOOR_MINUTES = 30;
/** checkout + pnpm install + 全量 build 的墙钟开销（矩阵实例每段都要付一次）。 */
export const SETUP_OVERHEAD_MINUTES = 4;
/** 实测值的放大系数：runner 抖动 + 主干代码增长。 */
export const SAFETY_FACTOR = 1.5;

/** 段清单：`stryker.conf.d/dsh-*.json` 的文件名去 `.json`（与 ci-matrix / mutation-gate 同源口径）。 */
export function listSegments(confDir = CONF_DIR) {
  return readdirSync(confDir)
    .filter((f) => f.startsWith("dsh-") && f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/**
 * 从台账抽取每段在 `scope=full` 下的最长实测墙钟（秒）；无实测的段不出现在结果里。
 *
 * 按段名取 max，不区分文件面代际：#733 之类重写会让同一个段名先后对应不同文件面
 * （如 dsh-notifier-config 旧面 2365 mutant / 615.6s、新面 941 mutant / 117.5s），而台账的
 * superseded 条目提醒「历史 wallSeconds 描述的是旧文件面，不得用于新面的定标」。取 max 是
 * 安全侧：它可能把超时定得比新面所需更长（多等几分钟），但绝不会把新面定得比旧面更短——
 * 反之（拿旧的小值去定一个变大了的新面）才是会误杀的方向。
 */
export function fullScopePeaks(ledger) {
  const peaks = new Map();
  for (const m of ledger?.measurements ?? []) {
    if (m.scope !== "full") continue;
    for (const s of m.segments ?? []) mergeSegmentPeak(peaks, s);
  }
  return peaks;
}

/** 把一段的实测墙钟并入峰值表：无实测 / 非正值的段不参与，同段名取 max（取 max 的理由见上）。 */
function mergeSegmentPeak(peaks, s) {
  if (typeof s.wallSeconds !== "number" || !(s.wallSeconds > 0)) return;
  const prev = peaks.get(s.seg) ?? 0;
  if (s.wallSeconds > prev) peaks.set(s.seg, s.wallSeconds);
}

/**
 * 读台账并返回全量实测峰值（Map）；台账文件缺失时返回空 Map（全部回退默认超时）。
 *
 * 为什么导出读盘入口而不是让调用方各自解析：PR 矩阵（scripts/ci/ci-matrix.mjs）与夜间矩阵
 * 必须用**同一套**「台账 + 峰值 + 公式」派生超时。两处各写一份必然漂移，而超时漂移的代价是
 * 长段擦边被杀（run 34628767342 的 dsh-notifier · config 跑到 1819s 被 30 分钟固定值砍掉）。
 * 台账存在但不可解析时抛出：调用方 fail-closed，与 main() 的 exit 2 同源。
 */
export function loadFullScopePeaks(rootDir = ROOT) {
  const p = join(rootDir, "scripts", "data", "mutation-segment-ledger.json");
  if (!existsSync(p)) return new Map();
  return fullScopePeaks(JSON.parse(readFileSync(p, "utf8")));
}

/** 单段超时（分钟）：有全量实测则按其放大 + 构建开销，否则取保守默认；一律不低于下限。 */
export function timeoutForSegment(seg, peaks) {
  const measured = peaks.get(seg);
  if (measured === undefined) return DEFAULT_TIMEOUT_MINUTES;
  const minutes = Math.ceil((measured / 60) * SAFETY_FACTOR + SETUP_OVERHEAD_MINUTES);
  return Math.max(TIMEOUT_FLOOR_MINUTES, minutes);
}

/**
 * 段耗时估计（秒），只用于排序：有全量实测的取实测峰值；无实测的由「它会拿到默认超时」反推
 * （默认超时 = 估计耗时 × 安全系数 + 构建开销）——排序用的估计与超时用的假设同源，不另立口径。
 */
function estimateSeconds(seg, peaks) {
  const measured = peaks.get(seg);
  if (measured !== undefined) return measured;
  return ((DEFAULT_TIMEOUT_MINUTES - SETUP_OVERHEAD_MINUTES) * 60) / SAFETY_FACTOR;
}

/**
 * 生成 matrix：`[{ seg, timeoutMinutes }]`，按**估计耗时降序**（长段先跑）。
 *
 * 为什么排序而不是保持字典序：GHA 以 `max-parallel` 个槽位按 matrix 声明顺序消费，声明顺序
 * 就是调度顺序；字典序等价于随机顺序。实测代价（2026-09-13 run 34752395124，32 段）：字典序
 * makespan 52.9 min，LPT 顺序 42.1 min，而串行合计/并发度给出的下界是 41.4 min——即每晚白等
 * 约 11 分钟。「长段先跑」是 LPT 的贪心形式：把最长项压到最前面即可逼近下界。
 * 同估计值按段名升序，保证同一份台账派生出同一份 matrix（可复现）。
 *
 * 依赖说明：GHA 只承诺「按 max-parallel 限流」，**没有**承诺按声明顺序消费；这里依赖的是实测
 * 到的实现行为（32 个 job 的 start 顺序在槽位模型下 30/32 精确吻合，另 2 处为 runner 排队
 * 延迟）。该行为若变化，退化结果只是顺序不再最优，不影响正确性。
 */
export function buildShardMatrix(segs, peaks) {
  return [...segs]
    .sort((a, b) => {
      const byWeight = estimateSeconds(b, peaks) - estimateSeconds(a, peaks);
      return byWeight !== 0 ? byWeight : a.localeCompare(b);
    })
    .map((seg) => ({ seg, timeoutMinutes: timeoutForSegment(seg, peaks) }));
}

/**
 * 矩阵派生入口。路径默认指向仓库真实文件（CLI 只能对真仓求值），测试可注入临时路径；
 * 默认行为与原来逐字一致（形态同 listSegments(confDir = CONF_DIR)）。
 */
export function main({ confDir = CONF_DIR, ledgerPath = LEDGER_PATH } = {}) {
  const segs = listSegments(confDir);
  if (segs.length === 0) {
    failClosed(`[mutation-plan] ${confDir} 下无 dsh-*.json —— 段集合为空（fail-closed）`);
  }
  let ledger = null;
  if (existsSync(ledgerPath)) {
    try {
      ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    } catch (e) {
      failClosed(
        `[mutation-plan] 台账不可解析：${ledgerPath} —— ${String(e.message).split("\n")[0]}`,
      );
    }
  }
  const peaks = fullScopePeaks(ledger);
  const matrix = buildShardMatrix(segs, peaks);
  const measured = matrix.filter((m) => peaks.has(m.seg)).length;
  const json = JSON.stringify(matrix);
  // 诊断走 stderr：stdout 只放 matrix JSON，避免污染 GITHUB_OUTPUT
  console.error(
    `[mutation-plan] ${matrix.length} 段；其中 ${measured} 段有全量实测超时，` +
      `${matrix.length - measured} 段用保守默认 ${DEFAULT_TIMEOUT_MINUTES} min；` +
      `超时区间 ${Math.min(...matrix.map((m) => m.timeoutMinutes))}~${Math.max(...matrix.map((m) => m.timeoutMinutes))} min`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `shards=${json}\n`, "utf8");
    console.log(`shards 已写入 GITHUB_OUTPUT（${matrix.length} 项）`);
  } else {
    console.log(`shards=${json}`);
  }
  return 0;
}

// CLI 守卫：被测试 import 时不执行 main（纯函数可离线复用）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
