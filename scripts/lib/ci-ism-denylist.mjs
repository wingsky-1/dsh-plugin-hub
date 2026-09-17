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
 *   - denylist 必须覆盖 `CONTROL_SAMPLES`（独立写死的形态清单）：删掉一条 denylist 条目
 *     → 自证失败判红，而不是安静地少判一条；
 *   - `git status` 探测失败（非仓库 / git 不可用）即判红（fail-closed），不退回「看不见即通过」。
 *
 * 边界（如实声明，勿误读）：只覆盖**仓库根**这一层，`packages/<pkg>/undefined/` 这类深层产物不在本
 * 判据面内；被**跟踪**的同名文件报为 note 而不判红——那种形态会进 diff 由评审接手，本判据管的是
 * 「.gitignore 藏起来的残留」这条静默通道。
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

/** 仓库根标记文件：扫描面里没有它就说明 `--root` 不是仓库根（自证用，不参与判红对象）。 */
export const ROOT_MARKER = "package.json";

/** GitHub Actions 的运行时文件：只会由 CI 步骤（或本地误执行 workflow 片段）生成。 */
const GITHUB_ACTIONS_FILES = ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STEP_SUMMARY"];

/**
 * denylist 的单一事实源。`kind`：`exact`=目录项名全等；`suffix`=目录项名后缀。
 * 放宽这条清单需要同时改 `CONTROL_SAMPLES`，所以「悄悄少判一条」做不到。
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

/** 载体自证样本：与 `CI_ISM_PATTERNS` 的结构无关的独立清单，用来钉住「必须覆盖的形态」。 */
export const CONTROL_SAMPLES = Object.freeze([
  ...GITHUB_ACTIONS_FILES,
  "residue.jsonl",
  "undefined",
]);

/** 单个目录项名是否命中某条 pattern。 */
function matches(name, { pattern, kind }) {
  return kind === "exact" ? name === pattern : name.endsWith(pattern);
}

/** 自证问题清单：面为空、面不是仓库根、denylist 为空或漏了形态，任一条都判红。 */
function selfProofProblems(rootEntries, patterns, samples) {
  const problems = [];
  if (patterns.length === 0) problems.push("denylist 为空——没有判据的判据");
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
