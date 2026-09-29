/**
 * scripts/lib/ci-ism-denylist.mjs — 仓库根的 CI-ism 未跟踪文件判据（#843 评论侧 L4）。
 *
 * 出处：#843 评论侧的 L4。注意该 issue 正文里另有一个 L4（mutation-segment-ledger 的段面
 * 指纹），与本判据不是同一件事——引用时写明是哪一侧，别把两者合并。
 *
 * 为什么需要：CI 专有文件（`GITHUB_ENV` 等）与运行时产物（`*.jsonl`、`undefined/`）会在仓库根
 * 留下残留，而 `.gitignore` 恰好把它们从 `git status` 的**默认**输出里藏起来——实证是主 checkout
 * 根目录一个 12 字节的 `GITHUB_ENV`（内容 `BASH_ENV=/z`）挂了一整轮才被评审者发现。
 * AGENTS.md 的「改完自查」是人工口径（`git status --porcelain` 全清单），本判据把同一件事
 * 收窄成机器可判的 denylist。
 *
 * 为什么是 denylist 而不是「仓库根必须干净」：后者会在并行 worktree、开发草稿与临时产物下假红，
 * 一个常态假红的判据等于没有判据。这里只判已知的 CI-ism 形态，草稿文件一律放行。
 *
 * 扫描面与载体自证（判据不得因为「没扫到东西」而恒绿）：
 *   - 扫描面 = 仓库根的**全部目录项**（`readdir`）；面为空、或面里没有仓库根标记文件
 *     （`package.json`）即判红——`--root` 指错地方时不能静默放行；
 *   - denylist 必须覆盖 `CONTROL_SAMPLES`（`scripts/data/ci-ism-samples.json` 独立声明的形态
 *     清单）：删掉一条 denylist 条目 → 自证失败判红，而不是安静地少判一条。**该独立性此前是假的**
 *     ——样本与 denylist 同由 `GITHUB_ACTIONS_FILES` 派生，删该常量一条即两者同时少掉（已改）；
 *   - **执行点：目前仍只有本判据的自测**，这是审计实测的结论（`.github/**`、`package.json`、
 *     `gate-steps.mjs`、`local-gate.mjs` 全无 ci-ism 引用）。补执行点的 CLI 与接线**本刀受阻**，
 *     三条出路逐条实测都撞本仓红线：
 *       (a) 挂本地 `pr` 档 → 接线断言 A1 要求 `ci.yml` 的 repo-gate 有同名步骤，而 `.github/**` 属
 *           红线段、且与在飞的 #1079 冲突；
 *       (b) 挂本地 `full` 档 → 接线断言 A14 与「pr 档须含 full 档全部判据端点」强制要求在
 *           `data/gate-wiring-exceptions.json` 登记 tier-only（实测：不登记即两条断言判红），而
 *           `maxExceptions` 由 `gateWiring.budgets` 守卫（`weaken: increase`，任何上调无条件判红）；
 *       (c) 登记 `indirect`（判据只在自测里执行）→ 同样要加例外条目，同样撞 (b) 的预算守卫。
 *     故 CLI 本体（`scripts/gate/ci-ism-check.mjs`）**连同接线一起留在批次二**：覆盖性断言 A8 规定
 *     `scripts/gate/**` 下每个文件要么有执行点、要么被会跑的判据可达地 import、要么登记 indirect——
 *     落一个没有执行点的判据文件本身就是红的。本刀先把裁决收进本文件的 `ciIsmVerdict`，批次二只剩
 *     「薄 CLI + 接线」两步；
 *   - `git status` 探测失败（非仓库 / git 不可用）即判红（fail-closed），不退回「看不见即通过」。
 *
 * 边界（如实声明，勿误读）：只覆盖**仓库根**这一层，`packages/<pkg>/undefined/` 这类深层产物不在本
 * 判据面内；被**跟踪**的同名文件报为 note 而不判红——那种形态会进 diff 由评审接手，本判据管的是
 * 「.gitignore 藏起来的残留」这条静默通道。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

/** 仓库根标记文件：扫描面里没有它就说明 `--root` 不是仓库根（自证用，不参与判红对象）。 */
export const ROOT_MARKER = "package.json";

/** GitHub Actions 的运行时文件：只会由 CI 步骤（或本地误执行 workflow 片段）生成。 */
const GITHUB_ACTIONS_FILES = ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STEP_SUMMARY"];

/**
 * denylist 的单一事实源。`kind`：`exact`=目录项名全等；`suffix`=目录项名后缀。
 *
 * 本清单与自证样本（`CONTROL_SAMPLES`）**刻意是两份独立声明**：放宽/收紧 denylist 必须同时改
 * `scripts/data/ci-ism-samples.json`，两处改动都进 diff。此前两者由同一个 `GITHUB_ACTIONS_FILES`
 * 派生，从那一个常量里删一条会让 denylist 与样本同时少掉那条、自证照样通过（实测证伪）。
 */
export const CI_ISM_PATTERNS = Object.freeze([
  ...GITHUB_ACTIONS_FILES.map((pattern) => ({
    pattern,
    kind: "exact",
    why: "#843 评论侧 L4 点名的 CI-ism：GitHub Actions 运行时文件，出现在仓库根只可能是 CI 步骤被本地误执行",
  })),
  {
    pattern: ".jsonl",
    kind: "suffix",
    why: "AGENTS.md 零污染红线点名的运行时产物形态（.gitignore 已兜底，但兜底不等于许可）",
  },
  {
    pattern: "undefined",
    kind: "exact",
    why: "AGENTS.md 零污染红线点名的产物目录（路径拼接失败时生成）",
  },
]);

/**
 * 载体自证样本的**独立声明文件**（相对本模块解析，故与调用方 cwd 无关）。
 *
 * 为什么必须是独立文件而不是本文件里的一段字面量：本文件同时是 denylist 的定义处，两处声明
 * 放在同一个文件时，编辑 denylist 的人删样本与删条目是同一个动作里顺手做完的事，独立文件让
 * 「改判据」与「改判据的自证」变成 diff 里的两处。
 */
const SAMPLES_FILE = new URL("../data/ci-ism-samples.json", import.meta.url);

/**
 * 载体自证样本：与 `CI_ISM_PATTERNS` 无派生关系的独立清单，用来钉住「必须覆盖的形态」。
 *
 * 加载失败一律抛错（fail-closed）：样本文件读不到 / 形状非法时，**不能**退回「没有样本」——
 * 空样本会让自证恒绿，正是本判据要消灭的那种静默。
 */
export const CONTROL_SAMPLES = Object.freeze(loadControlSamples());

function loadControlSamples() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(SAMPLES_FILE, "utf8"));
  } catch (e) {
    throw new Error(
      `CI-ism 自证样本文件不可读或不可解析（${SAMPLES_FILE.pathname}）：${e.message}`,
    );
  }
  const samples = doc?.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error(
      `CI-ism 自证样本文件形状非法：samples 必须是非空数组（${SAMPLES_FILE.pathname}）`,
    );
  }
  const bad = samples.filter((s) => typeof s !== "string" || s === "");
  if (bad.length > 0) {
    throw new Error(
      `CI-ism 自证样本含非法条目（须为非空字符串）：${bad.map((s) => JSON.stringify(s)).join(", ")}`,
    );
  }
  return samples;
}

/** 单个目录项名是否命中某条 pattern。 */
function matches(name, { pattern, kind }) {
  return kind === "exact" ? name === pattern : name.endsWith(pattern);
}

/** 自证问题清单：面为空、面不是仓库根、denylist 为空或漏了形态，任一条都判红。 */
function selfProofProblems(rootEntries, patterns, samples) {
  const problems = [];
  if (patterns.length === 0) problems.push("denylist 为空——没有判据的判据");
  // 空样本面与空 denylist 同类：uncovered 恒为空 → 「未覆盖自证样本」这条恒不触发 → 自证恒绿。
  // 与 denylist 那条对称写死，否则「把样本删光」是一条比「删一条 denylist 条目」更短的静默通道。
  if (samples.length === 0) problems.push("自证样本为空——载体自证形同虚设");
  if (rootEntries.length === 0) problems.push("扫描面为空：仓库根一个目录项都没有");
  if (rootEntries.length > 0 && !rootEntries.includes(ROOT_MARKER)) {
    problems.push(`扫描面里没有 ${ROOT_MARKER}——--root 指向的不是仓库根`);
  }
  const uncovered = samples.filter((s) => !patterns.some((p) => matches(s, p)));
  if (uncovered.length > 0) problems.push(`denylist 未覆盖自证样本：${uncovered.join(", ")}`);
  return problems;
}

/**
 * 纯裁决：给定仓库根的目录项名集合与「未跟踪/被忽略的路径名集合」，判出违规与 note。
 *
 * 判红条件 = 目录项命中 denylist 且它未进 git index（`??`=未跟踪 / `!!`=被忽略，两者在本仓都属红线）。
 * 命中的**已跟踪**文件只记 note：它进得了 diff，可见性由评审保证。
 */
export function judgeRepoRoot({
  rootEntries,
  untracked,
  patterns = CI_ISM_PATTERNS,
  samples = CONTROL_SAMPLES,
}) {
  const violations = [];
  const notes = [];
  for (const name of rootEntries) {
    const hit = patterns.find((p) => matches(name, p));
    if (hit === undefined) continue;
    const entry = { path: name, pattern: hit.pattern, why: hit.why };
    if (untracked.has(name)) violations.push(entry);
    else notes.push(entry);
  }
  return {
    violations,
    notes,
    selfProofProblems: selfProofProblems(rootEntries, patterns, samples),
    scanned: rootEntries.length,
  };
}

/** `git status --porcelain -z` 输出 → 未跟踪/被忽略的路径名集合（目录项去掉尾斜杠）。 */
function untrackedNames(stdout) {
  const names = new Set();
  for (const record of stdout.split("\0")) {
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    if (status !== "??" && status !== "!!") continue;
    names.add(record.slice(3).replace(/\/+$/, ""));
  }
  return names;
}

/**
 * 探测仓库：仓库根目录项 + 未跟踪/被忽略路径。任何一步失败都抛出（调用方 fail-closed）。
 * `--ignored=matching` 是必需的：`.gitignore` 兜底的形态默认根本不出现在 `git status` 里，
 * 只看默认输出等于对本判据点名的形态盲。
 */
export function probeRepoRoot(root) {
  const probe = spawnSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain",
      "-z",
      "--ignored=matching",
      "--untracked-files=normal",
      "--",
      ".",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (probe.error !== undefined && probe.error !== null) {
    throw new Error(`git status 无法执行：${probe.error.message}`);
  }
  if (probe.status !== 0) {
    throw new Error(
      `git status 退出码 ${probe.status}：${(probe.stderr ?? "").trim().slice(0, 200)}`,
    );
  }
  let rootEntries;
  try {
    rootEntries = readdirSync(root);
  } catch (e) {
    throw new Error(`仓库根不可读（${root}）：${e.message}`);
  }
  return { rootEntries, untracked: untrackedNames(probe.stdout) };
}

/** 端到端扫描：探测 + 裁决。探测失败向上抛，调用方按 fail-closed 处理。 */
export function scanRepoRoot(root, opts = {}) {
  const { rootEntries, untracked } = probeRepoRoot(root);
  return judgeRepoRoot({ rootEntries, untracked, ...opts });
}

/**
 * 裁决 → 三态退出码映射（0 通过 / 1 判红可信 / 2 门禁故障不可信）。CLI 入口直接消费它。
 *
 * 为什么自证优先于违规：自证失败意味着「判据自己不可信」（面不是仓库根 / denylist 漏了形态）。
 * 此时若按违规数报 1，读者会把门禁故障读成「改动不达标」——#843 P-2 那次事故正是 exit 2 被读成
 * 判红并汇报为「判决已生效」。
 *
 * 为什么在本文件里：CLI 入口 `scripts/gate/ci-ism-check.mjs` 与接线一并待批准（见本文件头
 * 「执行点」段），而接线获批前先把裁决与格式化收在这里，可避免那一步再重写一遍判词口径。
 */
export function ciIsmVerdict(result) {
  if (result.selfProofProblems.length > 0) {
    return { code: 2, verdict: "门禁故障", lines: result.selfProofProblems };
  }
  if (result.violations.length > 0) {
    return {
      code: 1,
      verdict: "FAIL",
      lines: result.violations.map((v) => `${v.path}（命中 ${v.pattern}）：${v.why}`),
    };
  }
  return { code: 0, verdict: "PASS", lines: [] };
}
