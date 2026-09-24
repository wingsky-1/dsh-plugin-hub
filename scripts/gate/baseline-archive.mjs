#!/usr/bin/env node
/**
 * scripts/gate/baseline-archive.mjs — 变异基线归档分支的纯函数面（#572 / #714 后续修复）
 *
 * 为什么单独成文件：`overlay-baseline.mjs` 是带副作用的一次性同步脚本（拉产物、建孤立
 * commit、强推），它的判定逻辑（分页合并、对账、缺口）必须能被单测覆盖——否则「归档
 * 少了一半段」这类静默数据丢失只能靠人事后比对才发现（实际发生过：见下）。
 *
 * 背景（真实缺陷，2026-09-11 定位）：
 * `gh api repos/<repo>/actions/runs/<id>/artifacts` 默认分页 30 条，而一次 PR CI 会产生
 * 70 个 artifact（31 个 mutation-incremental + 报告/产物）。原实现直接读 `.artifacts`，
 * 只拿到第 1 页 → 只有 14 个 mutation-incremental 被覆盖；随后整棵快照强推会把未被覆盖的
 * 段固化成旧版本，「本来就没有基线」的段（provider-usage-errsurf；另一段 web-file-preview
 * 已随 #840 退役）更是每次合并都被抹掉。故本模块把「分页取全」与「对账后判缺口」做成纯函数。
 */

/** 归档分支上参与对账的文件名形态（段级增量基线）。 */
export const BASELINE_FILE_RE = /^incremental-.+\.json$/;

/** mutation artifact 的命名前缀（ci.yml 的 upload-artifact name 约定）。 */
export const MUTATION_ARTIFACT_PREFIX = "mutation-incremental-";

/** GitHub API 单页上限；请求时显式带上它，避免默认 30 条截断。 */
export const GH_API_PER_PAGE = 100;

/**
 * 把「一页 artifact」合并进结果集，返回 { items, nextPage, done }。
 * 入参 page 是 GitHub API 的响应体（`{ artifacts, total_count }`），pageNo 是**刚请求的那一页**。
 *
 * 终止条件（两条，任一成立即 done）：
 *   · 本页为空（已过末页）——GitHub 并发上传时可能返回短页而 total_count 仍更大，
 *     只按条数判会拿到不完整的结果；
 *   · 已收条数 >= total_count。
 * 页号严格递增（pageNo + 1），不用「已收条数 / perPage」反推——短页时那会算回同一页，
 * 造成重复请求同一页（脚本侧另有 MAX_PAGES 硬上限兜底）。
 */
export function mergeArtifactPage(items, page, pageNo = 1) {
  const incoming = Array.isArray(page?.artifacts) ? page.artifacts : [];
  const merged = [...items, ...incoming];
  const total = typeof page?.total_count === "number" ? page.total_count : merged.length;
  const done = incoming.length === 0 || merged.length >= total;
  return { items: merged, nextPage: done ? null : pageNo + 1, done };
}

/**
 * 从 artifact 列表里挑出变异增量产物。
 * 段文件名不从 artifact 名切分（`provider-usage-errsurf` 这类含连字符的段名不可靠），
 * 而是等下载后按产物内**实际文件名**（`incremental-*.json`）判定。
 */
export function mutationArtifacts(artifacts) {
  return (artifacts ?? []).filter(
    (a) => typeof a?.name === "string" && a.name.startsWith(MUTATION_ARTIFACT_PREFIX),
  );
}

/**
 * ci.yml 变异矩阵实例的 job 名形态：`Mutation gate (<pkg> · <seg>)`。
 *
 * 它与 ci.yml 的 `name:` 行是一对契约：job 改名会让这里静默失配（漏认 ⇒ 恒判「没跑」；
 * 正则放宽 ⇒ 把汇总判分 job 也算成实例）。契约由 `scripts/test/workflow-assert.test.ts`
 * 双向锁定：ci.yml 的 job 级 `name:` 行里命中者恰好 1 条，且 `Mutation gate verdict (...)`
 * 不命中。
 */
export const MUTATION_GATE_JOB_RE = /^Mutation gate \(/;

/**
 * 唯一「本该产出增量产物」的 job 结论（#718 S2.1 第二版）。
 *
 * 依据是 ci.yml 里实例内的上传步骤 `if: success()`：**实例不成功就没有产物**。反过来讲，
 * 只有 success 的实例才谈得上「产物本该存在」。第一版把「job 名匹配」当成「执行过」，
 * 于是 `skipped` 的占位 job（`if` 为假时 GHA 仍返回条目、名字保持未展开形态）被算成实例，
 * 恒判产物丢失。
 */
const PRODUCTIVE_CONCLUSION = "success";

/** 跑过但结构上不产出产物的结论：缺席可解释，处置是重跑而不是查丢失。 */
const INCOMPLETE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);

/**
 * 按「job 名 × 结论」把一次 CI run 的变异实例分成两拨（纯函数，供 overlay 与自测共用）。
 *
 * 既不是 `success` 也不在 `incomplete` 里的（`skipped` / `null` / `neutral` / 未知取值）
 * 一律**不算实例**：判据的形状是「确实执行过」，将来 GitHub 新增结论值时默认落到「没跑」。
 * fail-safe 的方向是少报丢失（那段下次重算一遍即可），而不是把每次合并都判红。
 */
export function classifyMutationInstances(jobs) {
  const productive = [];
  const incomplete = [];
  for (const job of jobs ?? []) {
    if (typeof job?.name !== "string" || !MUTATION_GATE_JOB_RE.test(job.name)) continue;
    if (job.conclusion === PRODUCTIVE_CONCLUSION) productive.push(job.name);
    else if (INCOMPLETE_CONCLUSIONS.has(job.conclusion)) incomplete.push(job.name);
  }
  return { productive, incomplete };
}

/**
 * 「看不到变异产物」的三态分流（#718 S2.1 第二版）。
 *
 * 第一版把「真·无产物」与「产物丢了」压成同一个静默 no-op；第二版按 job **名**筛实例却漏了
 * 状态，把「根本没跑」的 skipped 占位 job 也算成实例 ⇒ **恒判丢失**（实测该形态连续 6 次
 * 假红，连引入它的那次合并都没放过）。故判据改为「执行过**且**本该产出产物」。
 *
 * `expiredArtifactCount` 不再是入参：过期的 artifact 仍留在 `/artifacts` 列表里（实测过期
 * 3 天后仍在列），能走到本函数时它结构性恒为 0，是零信息量的旁证。过期导致「有产物却一个都
 * 没覆盖成功」的情形，由 overlay-baseline.mjs 的另一条 fail-loud 分支承担。
 */
export function classifyMissingMutationProducts({ jobs } = {}) {
  const { productive, incomplete } = classifyMutationInstances(jobs);
  if (productive.length > 0) {
    return {
      kind: "lost",
      instanceCount: productive.length,
      reason:
        `CI 有 ${productive.length} 个变异实例成功执行（上传步骤 if: success() 门控，本该产出增量产物），` +
        "但本次 run 的 artifact 列表里一个变异产物都没有",
    };
  }
  if (incomplete.length > 0) {
    return {
      kind: "incomplete",
      instanceCount: incomplete.length,
      reason:
        `CI 有 ${incomplete.length} 个变异实例跑过但未成功（failure/cancelled/timed_out）——` +
        "实例内上传步骤为 if: success()，本就不产出增量产物",
    };
  }
  return {
    kind: "none",
    instanceCount: 0,
    reason: "CI 未运行任何变异矩阵实例（纯文档 / 未触及变异切片）",
  };
}

/**
 * 期望被归档的段文件名集合（由 stryker.conf.d/*.json 派生，与 stryker 配置同源）。
 * 段级 `dsh-mcp-manager-entry.json` → `incremental-mcp-manager-entry.json`；
 * 包级（seg="0"）`<pkg>.json` → `incremental-<pkg>.json`（#840 起仓库已无包级实例，
 * 派生规则保留以兼容归档历史上的包级形态）。
 */
export function expectedBaselineFiles(confFileNames) {
  return (confFileNames ?? [])
    .filter((f) => typeof f === "string" && f.endsWith(".json"))
    .map((f) => `incremental-${f.replace(/^dsh-/, "")}`)
    .sort();
}

/** 归档分支上参与对账的 manifest 文件名（记录每份基线文件的 size/mtime/sha256）。 */
export const BASELINE_MANIFEST_FILE = "manifest.json";

/**
 * 从 CI face registry 派生 PR 不要求上传 artifact 的段。
 * 只有显式 artifactPolicy=nightly-only 的 stryker 配置进入该集合；普通段缺产物仍 fail-closed。
 */
export function nightlyOnlyBaselineFiles({ confFileNames, faceRegistry }) {
  if (
    typeof faceRegistry !== "object" ||
    faceRegistry === null ||
    !Array.isArray(faceRegistry.entries)
  ) {
    throw new Error("ci-face-registry.json 缺少 entries，无法判定 nightly-only artifact");
  }
  const byPath = new Map(faceRegistry.entries.map((entry) => [entry?.path, entry]));
  const configPathByExpected = new Map(
    (confFileNames ?? [])
      .filter((name) => typeof name === "string" && name.endsWith(".json"))
      .map((name) => [expectedBaselineFiles([name])[0], `stryker.conf.d/${name}`]),
  );
  return expectedBaselineFiles(confFileNames).filter((file) => {
    const entry = byPath.get(configPathByExpected.get(file));
    return entry?.artifactPolicy === "nightly-only";
  });
}

/** 回滚快照 tag 前缀。刻意不以 `v` 开头——release.yml 由 `push: tags: v*` 触发。 */
export const ARCHIVE_SNAPSHOT_TAG_PREFIX = "baseline-snap-";

/** 保留的回滚快照个数（每次入档产生一个，超出即删最旧）。 */
export const ARCHIVE_SNAPSHOT_KEEP = 10;

/**
 * 入档对账（#718 S1.2 的核心判定，纯函数）。
 *
 * 为什么需要它：旧实现把「本班次目录里有什么」当成「归档的全部内容」整树替换。段一旦没
 * 产出（实例超时/被杀），该段文件就不在新树里 → 归档**静默缩水**；实测发生过 33 → 31，
 * 且没有任何日志说出来。并集语义下缩水在物理上不可能，于是「本次没产出什么」必须变成
 * 一条显式记账，而不是一个消失的文件。
 *
 * 四类互斥且完备（expected 为 `stryker.conf.d/` 派生的期望集合，是唯一事实源）：
 *   · 新算   = 本次产出（本地有文件）——内容以本次为准；
 *   · 沿用   = 本次未产出但远端有——保留旧内容继续用（Stryker 增量模式会自行识别内容已变）；
 *   · 缺     = 两边都没有——该段在归档上没有可用基线，必须点名告警；
 *   · 退役   = 不在期望集合里却存在于任一侧（段被拆并/改名后的遗留）——从归档移除，
 *              否则并集语义会让它永远留在基线里（整树替换时代是被顺带清掉的）。
 */
export function planArchive({ expected, produced, carried } = {}) {
  const expectedSet = new Set(expected ?? []);
  const producedSet = new Set(produced ?? []);
  const carriedSet = new Set(carried ?? []);
  const expectedList = expected ?? [];
  const newlyMeasured = expectedList.filter((f) => producedSet.has(f));
  const carriedOver = expectedList.filter((f) => !producedSet.has(f) && carriedSet.has(f));
  const missing = expectedList.filter((f) => !producedSet.has(f) && !carriedSet.has(f));
  const retired = [...new Set([...(carried ?? []), ...(produced ?? [])])]
    .filter((f) => !expectedSet.has(f))
    .sort();
  return { newlyMeasured, carriedOver, missing, retired };
}

/**
 * 回滚快照 tag 名：`baseline-snap-<UTC 紧凑时间戳>-<旧 tip 短 sha>`。
 * 定长时间戳（ISO basic）保证字典序 = 时间序，保留策略不必解析时间。
 * 附短 sha 是为了同一秒内两次入档也不撞名（撞名会让 `git push <sha>:refs/tags/<t>` 直接失败）。
 */
export function snapshotTagFor(tipSha, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${ARCHIVE_SNAPSHOT_TAG_PREFIX}${stamp}-${String(tipSha).slice(0, 7)}`;
}

/** 保留最近 keep 个快照 tag，返回应删除的 ref 全名（字典序即时间序）。 */
export function pruneSnapshotPlan(refNames, keep = ARCHIVE_SNAPSHOT_KEEP) {
  const ours = (refNames ?? [])
    .filter(
      (r) => typeof r === "string" && r.startsWith(`refs/tags/${ARCHIVE_SNAPSHOT_TAG_PREFIX}`),
    )
    .sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}

/**
 * 对账：把「本次真正覆盖的文件」与「旧基线已有的文件」并起来，找出期望集合里的缺口。
 * 调用方（overlay）据此决定是否判红——缺口意味着该段在归档分支上没有可用基线：
 *   · overlay 是差量覆盖，缺口不会自愈，该段在后续每次 PR 门禁里都会降级为全量重跑；
 *   · 修法不是拒绝推送（那会让归档停在更旧的整棵树），而是**判红 + 点名**，
 *     让维护者知道要查上游（产物上传失败 / 分页截断 / 段配置漂移）。
 */
export function reconcileArchive({
  expected,
  overlaid,
  carriedForward,
  optionalMissing = /** @type {string[]} */ ([]),
}) {
  const have = new Set([...(overlaid ?? []), ...(carriedForward ?? [])]);
  const optional = new Set(optionalMissing ?? []);
  const missing = (expected ?? []).filter((f) => !have.has(f) && !optional.has(f));
  const deferred = (expected ?? []).filter((f) => !have.has(f) && optional.has(f));
  return {
    missing,
    deferred,
    carriedCount: (carriedForward ?? []).length,
    overlaidCount: (overlaid ?? []).length,
  };
}

/**
 * 远端 ref 探针的三态分类（唯一判据，两个入口共用）。
 *
 * 用 `git ls-remote --exit-code --heads origin <ref>` 的退出码，而不是「stdout 是否为空」：
 *   · 0 = 本次广告里**有**这条 ref；
 *   · 2 = 本次广告里**没有**这条 ref（git 自己提供的语义，`--exit-code` 专为此设）；
 *   · 其它（128 等）= 远端不可达 / 权限故障 / URL 不可解析 —— 属**环境故障**，可能瞬时，需重试。
 * 「空 stdout」在这里不再承担判据职责，避免与「远端只广告了部分 ref」混淆。
 */
export function classifyRemoteProbe({ ok, code }) {
  if (ok) return "present";
  if (code === 2) return "absent";
  return "unreachable";
}

/**
 * 恢复远端基线树的判定：`restore` / `bootstrap` / `fail`。
 *
 * 为什么不能只看「fetch 成不成功」：fetch 失败有两种完全相反的含义——
 *   · `absent` = 远端可达但这条 ref 不在广告里，没有基线可恢复，降级为全量变异是正常的（首夜）；
 *   · `present` / `unreachable` = 基线**可能存在但取不到**，此时若当成空分支继续，本班产物会被
 *     当成「全部内容」推回去，把沿用中的基线整批删掉。
 * 2026-09-11 05:18 的 overlay 就出现过后者（分支明明存在，日志却是「尚不可达或为空」），
 * 修复先落在 overlay-baseline.mjs（#716）；本函数让 orphan-baseline.mjs 走同一判据，
 * 避免同一操作两份实现长期分叉。
 *
 * 已知边界（必须诚实记录）：`absent` 只能证明「本次广告里没有这条 ref」，**不能**证明
 * 「服务端上不存在」——服务端可用 `uploadpack.hideRefs` 隐藏某条 ref，此时与真·首夜完全同形，
 * 本函数无从区分。写路径侧的保护已由 #718 S1.2 落地：并集入档（`planArchive`）且拉取失败一律
 * fail-loud，不再存在「取不到就当空归档推回去」的分支；旧增量班在 workflow 层的
 * `mutation-suites` outcome 门控已随 #718 S2.2 退役（并集语义不依赖「产物齐全」）。
 */
export function decideRestoreOutcome({ probeStatus, fetchOk }) {
  if (fetchOk) return { action: "restore" };
  if (probeStatus === "present") {
    return { action: "fail", reason: "远端基线分支存在但拉取失败（拒绝以空基线覆盖）" };
  }
  if (probeStatus === "unreachable") {
    return { action: "fail", reason: "远端不可达，无法判定是否存在基线（拒绝以空基线继续）" };
  }
  if (probeStatus === "absent") {
    return { action: "bootstrap", reason: "远端基线分支尚不存在，本次安全降级为全量变异" };
  }
  return { action: "fail", reason: `未知的探针状态 ${String(probeStatus)}（拒绝以空基线继续）` };
}
