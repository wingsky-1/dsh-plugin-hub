#!/usr/bin/env node
'use strict'

/**
 * verify-docs — 文档一致性轻量门禁（EPLAN F-4，web-ui verify-docs 的简化版）。
 *
 * 检查：
 *   1. 每包 README.md 存在；
 *   2. Markdown 相对链接目标存在（判于当前文件目录）；
 *   3. package.json 的 description 无脚手架占位符（__NAME__ 等）；
 *   4. README.en.md 配对：若存在则其同级相对链接也有效（中英配对校验）；
 *      存在性用 --strict-en 强制（根 README.en.md 同样适用，见检查 6）。
 *   6. 根 README.en.md（若存在）纳入与包级相同的 relLinks 相对链接检查
 *      （#474 R3：根 en 的相对链接断了要红）。
 *   9. 文件内 #fragment 锚点必须可解析（#693）：GitHub 会给**所有**标题 id 加
 *      `user-content-` 前缀（显式 <a id> 一并改写），故裸 slug href 会静默失效
 *      （实测 #0-构建总览 / #1-宿主端srcindexts规范 / #通用机制 三处皆断）。
 *      判定：显式 id 字面命中，或按 GitHub slug 规则推出的 user-content-<slug> 命中。
 *   8. 文档内反引号包裹的 `pnpm <script>` 必须真实存在于根 package.json（#693：
 *      防文档写出不存在的门禁命令——human/agent 都会照抄不存在的命令）。
 *   7. Agent 规则文档（根/包级 AGENTS.md、.dsh/skills/**、agents/**）的相对链接（含裸路径）
 *      目标存在（#693：这类文件此前完全在门禁面之外，过期规则得以长期存活）。
 *
 * 砍掉的 web-ui 重型项：词数预算、i18n 结构签名镜像、语言切换行、锚点存在性
 * （本仓 README 规模小，不引入预算与签名镜像）。
 *
 * 用法：node scripts/gate/verify-docs.ts [--strict-en]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STRICT_EN = process.argv.includes('--strict-en')

// --root 仅覆盖 agent 规则文档扫描根（测试用 fixture 注入）；包/根 README 面固定判真实仓库，
// 避免 fixture 被迫伪造整个 packages/ 树（#693）。
const AGENT_ROOT = ((): string => {
  const i = process.argv.indexOf("--root")
  const v = i >= 0 ? process.argv[i + 1] : undefined
  return v !== undefined && v !== "" ? v : ROOT
})()
const failures: string[] = []

const isRelLink = (t: string): boolean => /^\.{1,2}\//.test(t)
// 提取 markdown 中的相对链接目标（[t](target) 与 [t]: target 引用）
function relLinks(md: string): string[] {
  const out: string[] = []
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) out.push(m[1])
  for (const m of md.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) out.push(m[1])
  return out.filter(isRelLink).filter((t) => !/#/.test(t)) // 锚点链接跳过
}

// 断一条相对链接是否有效（返回失败消息，null = 通过）
function checkRelTarget(baseFile: string, target: string): string | null {
  const abs = join(dirname(baseFile), decodeURIComponent(target.split('#')[0]))
  return existsSync(abs) ? null : target
}

/** Agent 规则文档相对链接面：根/包级 AGENTS.md + .dsh/skills/** + agents/**（#693）。
 *  比 README 面更严：**裸相对路径（无 ./ 前缀）也检查**——AGENTS.md / skill 里最常用
 *  的正是这种写法，而它此前完全不在门禁面内。 */
function walkAgentDocs(dir: string, out: string[], inSkills = false): string[] {
  // inSkills 必须随递归下传：.dsh/skills 自身在第二层，仅靠路径包含判断
  // 会漏掉 .dsh/skills/<a>/<b>/SKILL.md 这类深层文件（#693 自测反例锁定）。
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const full = join(dir, entry.name)
    const isSkillsDir = inSkills || (entry.name === 'skills' && dir.endsWith(sep + '.dsh'))
    if (entry.isDirectory()) walkAgentDocs(full, out, isSkillsDir)
    else if (entry.name === "AGENTS.md" || inSkills || full.startsWith(join(AGENT_ROOT, "agents"))) out.push(full)
  }
  return out
}

/** 允许被当作路径检查的相对链接形态：含目录分隔符且以已知文档/代码后缀结尾。
 *  过滤掉文档里作为**示例**出现的正则片段（如 `@deepseek-ai/[a-z0-9-]+|cordis`），
 *  这类文本会被 markdown 链接正则误捕，但不是链接（#693 实测反例）。 */
const AGENT_DOC_EXT = /\.(md|mdx|ts|tsx|js|mjs|cjs|json|ya?ml|sh|py)$/
const isAgentRelLink = (t: string): boolean =>
  t.includes("/") && AGENT_DOC_EXT.test(t) && !/[\[\]*|`]/.test(t)

const agentRelLinks = (md: string): string[] =>
  [...md.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!.split("#")[0]!)
    .filter((t) => t !== "" && !/^(https?:|mailto:|#)/.test(t) && isAgentRelLink(t))

/** 仅在「相对当前文件」与「相对仓库根」（GitHub 对 bare 路径的解析）都不存在时判红。 */
function checkAgentLink(baseFile: string, target: string): boolean {
  const rel = decodeURIComponent(target)
  return existsSync(join(dirname(baseFile), rel)) || existsSync(join(AGENT_ROOT, rel))
}

/** 文档面（比 agent 面更宽，含 docs/）：用于命令引用校验。 */
function walkDocFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkDocFiles(full, out)
    else if (entry.name.endsWith(".md") && !full.includes("release-notes")) out.push(full)
  }
  return out
}

/** npm/pnpm 自带子命令，不是仓库脚本，不做存在性校验。 */
const NPM_BUILTIN = new Set([
  "install", "i", "ci", "add", "remove", "why", "exec", "dlx", "run", "publish",
  "pack", "update", "list", "ls", "outdated", "audit", "config", "init", "link",
  "prune", "store", "licenses",
])

/** 校验文档里反引号包裹的 `pnpm <script>`：命令不存在即判红（#693）。 */
function checkAgentCommands(): number {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }
  const known = new Set(Object.keys(pkg.scripts ?? {}))
  const docs = walkDocFiles(AGENT_ROOT, []).sort()
  for (const f of docs) {
    const rel = relative(AGENT_ROOT, f)
    for (const m of readFileSync(f, "utf8").matchAll(/[`]{1,3}pnpm ([a-z][a-z:-]*)/g)) {
      const cmd = m[1]!
      if (NPM_BUILTIN.has(cmd) || known.has(cmd)) continue
      failures.push(`${rel}: 引用了不存在的 pnpm 命令 ${cmd}`)
    }
  }
  return docs.length
}

function checkAgentDocs(): number {
  const docs = walkAgentDocs(AGENT_ROOT, []).filter((f) => f.endsWith(".md")).sort()
  for (const f of docs) {
    const rel = relative(AGENT_ROOT, f)
    for (const target of agentRelLinks(readFileSync(f, "utf8"))) {
      if (!checkAgentLink(f, target)) failures.push(`${rel}: 相对链接目标缺失 ${target}`)
    }
  }
  return docs.length
}

/** GitHub 标题 slug 规则（实测口径）：小写、去反引号与标点、空格转 -、保留中日韩。 */
function ghSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
}

/** 可命中的锚点 id：显式 id 字面 + 标题 slug（GitHub 会统一加 user-content- 前缀）。 */
function anchorIds(md: string): Set<string> {
  const ids = new Set<string>()
  for (const m of md.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]!)
  for (const m of md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) ids.add("user-content-" + ghSlug(m[1]!))
  return ids
}

/** 校验文件内 #fragment 引用（#693）：命中显式 id 或 GitHub slug 推导 id 才算有效。 */
function checkAnchorRefs(): number {
  const files = walkDocFiles(AGENT_ROOT, [])
    .concat([join(AGENT_ROOT, "README.md"), join(AGENT_ROOT, "README.en.md")])
    .filter((f) => existsSync(f))
    .sort()
  let refs = 0
  for (const f of files) {
    const md = readFileSync(f, "utf8")
    const rel = relative(AGENT_ROOT, f)
    const selfIds = anchorIds(md)
    const linkTargets = [
      ...md.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g),        // 行内 [t](target)
      ...md.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm),          // 引用式 [t]: target
      ...md.matchAll(/<a\s[^>]*href="([^"]+)"/g),              // HTML <a href="...">
    ].map((m) => m[1]!)
    for (const target of linkTargets) {
      if (/^https?:|^mailto:/.test(target)) continue
      const hashAt = target.indexOf("#")
      if (hashAt < 0) continue
      const frag = target.slice(hashAt + 1)
      if (frag === "") continue
      refs++
      const rawPath = target.slice(0, hashAt)
      const targetFile = rawPath === "" ? f : join(dirname(f), decodeURIComponent(rawPath))
      if (rawPath !== "" && !existsSync(targetFile)) continue // 文件缺失归 7 号检查
      const ids = rawPath === "" ? selfIds : anchorIds(readFileSync(targetFile, "utf8"))
      if (!ids.has(frag)) {
        const where = rawPath === "" ? "本文件" : relative(AGENT_ROOT, targetFile)
        failures.push(`${rel}: 锚点 #${frag} 在 ${where} 中不存在`)
      }
    }
  }
  return refs
}

function checkPkg(pkgDir: string): string | undefined {
  const name = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name
  const readme = join(pkgDir, 'README.md')
  if (!existsSync(readme)) {
    failures.push(`${name}: 缺 README.md`)
    return
  }
  const md = readFileSync(readme, 'utf8')
  // 相对链接目标存在
  for (const target of relLinks(md)) {
    if (checkRelTarget(readme, target) !== null) failures.push(`${name}: README 相对链接目标缺失 ${target}`)
  }
  // README.en.md 配对
  const en = join(pkgDir, 'README.en.md')
  if (existsSync(en)) {
    const emd = readFileSync(en, 'utf8')
    for (const target of relLinks(emd)) {
      if (checkRelTarget(en, target) !== null) failures.push(`${name}: README.en 相对链接目标缺失 ${target}`)
    }
  } else if (STRICT_EN) {
    failures.push(`${name}: 缺 README.en.md（--strict-en）`)
  }
  // description 无脚手架占位符
  const desc = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).description ?? ''
  if (/__NAME__|__PLUGIN__|<name>|TODO/.test(desc)) failures.push(`${name}: description 含脚手架占位符`)

  return name
}

const pkgs = readdirSync(join(ROOT, 'packages')).filter((d) => d.startsWith('dsh-')).sort()
let checked = 0
for (const p of pkgs) {
  const name = checkPkg(join(ROOT, 'packages', p))
  if (name) checked++
}
// 根 README：存在性 + 根 README.en.md 纳入与包级相同的 relLinks 检查（#474 R3）
for (const f of ['README.md']) {
  if (!existsSync(join(ROOT, f))) failures.push(`根缺 ${f}`)
}
const rootEn = join(ROOT, 'README.en.md')
if (existsSync(rootEn)) {
  const emd = readFileSync(rootEn, 'utf8')
  for (const target of relLinks(emd)) {
    if (checkRelTarget(rootEn, target) !== null) failures.push(`根 README.en 相对链接目标缺失 ${target}`)
  }
} else if (STRICT_EN) {
  failures.push(`根缺 README.en.md（--strict-en）`)
}

const agentDocs = checkAgentDocs()
checkAgentCommands()
checkAnchorRefs()

const ok = failures.length === 0
console.log(`verify-docs：检查 ${checked} 个包 + 根 README + ${agentDocs} 个 agent 规则文档`)
if (!ok) { for (const f of failures) console.error(`  ✘ ${f}`) }
console.log(ok ? '文档一致性：通过' : `文档一致性：${failures.length} 个问题`)
process.exit(ok ? 0 : 1)