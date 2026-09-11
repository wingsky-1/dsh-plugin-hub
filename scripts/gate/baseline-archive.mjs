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
 * 段固化成旧版本，两个「本来就没有基线」的段（provider-usage-errsurf、web-file-preview）
 * 更是每次合并都被抹掉。故本模块把「分页取全」与「对账后判缺口」做成纯函数。
 */

/** 归档分支上参与对账的文件名形态（段级增量基线）。 */
export const BASELINE_FILE_RE = /^incremental-.+\.json$/

/** mutation artifact 的命名前缀（ci.yml 的 upload-artifact name 约定）。 */
export const MUTATION_ARTIFACT_PREFIX = 'mutation-incremental-'

/** GitHub API 单页上限；请求时显式带上它，避免默认 30 条截断。 */
export const GH_API_PER_PAGE = 100

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
  const incoming = Array.isArray(page?.artifacts) ? page.artifacts : []
  const merged = [...items, ...incoming]
  const total = typeof page?.total_count === 'number' ? page.total_count : merged.length
  const done = incoming.length === 0 || merged.length >= total
  return { items: merged, nextPage: done ? null : pageNo + 1, done }
}

/**
 * 从 artifact 列表里挑出变异增量产物。
 * 段文件名不从 artifact 名切分（`provider-usage-errsurf` 这类含连字符的段名不可靠），
 * 而是等下载后按产物内**实际文件名**（`incremental-*.json`）判定。
 */
export function mutationArtifacts(artifacts) {
  return (artifacts ?? []).filter((a) => typeof a?.name === 'string' && a.name.startsWith(MUTATION_ARTIFACT_PREFIX))
}

/**
 * 期望被归档的段文件名集合（由 stryker.conf.d/*.json 派生，与 stryker 配置同源）。
 * `dsh-web-file-preview.json`（未拆分包的 seg="0"）→ `incremental-web-file-preview.json`；
 * `dsh-mcp-manager-entry.json` → `incremental-mcp-manager-entry.json`。
 */
export function expectedBaselineFiles(confFileNames) {
  return (confFileNames ?? [])
    .filter((f) => typeof f === 'string' && f.endsWith('.json'))
    .map((f) => `incremental-${f.replace(/^dsh-/, '')}`)
    .sort()
}

/**
 * 对账：把「本次真正覆盖的文件」与「旧基线已有的文件」并起来，找出期望集合里的缺口。
 * 调用方据此决定是否判红——缺口意味着该段在归档分支上没有可用基线：
 *   · 增量班次每次都会全量恢复并强推，所以缺口会**持续**存在；
 *   · 修法不是拒绝推送（那会让归档停在更旧的整棵树），而是**判红 + 点名**，
 *     让维护者知道要查上游（产物上传失败 / 分页截断 / 段配置漂移）。
 */
export function reconcileArchive({ expected, overlaid, carriedForward }) {
  const have = new Set([...(overlaid ?? []), ...(carriedForward ?? [])])
  const missing = (expected ?? []).filter((f) => !have.has(f))
  return { missing, carriedCount: (carriedForward ?? []).length, overlaidCount: (overlaid ?? []).length }
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
  if (ok) return 'present'
  if (code === 2) return 'absent'
  return 'unreachable'
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
 * 本函数无从区分。这一支上唯一实际生效的防护是 workflow 层 `mutation-suites` 的 outcome 门控
 * （依赖 restore 非零退出，见 observe-incremental.yml）；**代码里并不存在「推送侧拒绝空/缺段
 * 快照」的保护**，补该保护已登记在 #718 的方案中（并集入档），尚未实施。
 */
export function decideRestoreOutcome({ probeStatus, fetchOk }) {
  if (fetchOk) return { action: 'restore' }
  if (probeStatus === 'present') {
    return { action: 'fail', reason: '远端基线分支存在但拉取失败（拒绝以空基线覆盖）' }
  }
  if (probeStatus === 'unreachable') {
    return { action: 'fail', reason: '远端不可达，无法判定是否存在基线（拒绝以空基线继续）' }
  }
  if (probeStatus === 'absent') {
    return { action: 'bootstrap', reason: '远端基线分支尚不存在，本次安全降级为全量变异' }
  }
  return { action: 'fail', reason: `未知的探针状态 ${String(probeStatus)}（拒绝以空基线继续）` }
}
