/**
 * scripts/gate/local-scope.mjs — 「这次改了什么 → 本地该跑哪些包」的纯函数（#722 门禁分层）。
 *
 * 为什么从 ci.yml 解析包面，而不是本地另写一份路径规则：包面归属的单一事实源就是
 * ci.yml 的 paths-filter `filters` 块。本地抄一份必然漂移——docs/** 是否算全局面
 * 历史上就改过一次（#429 回归 / #220 收敛），漂移的后果是「本地绿而 CI 红」。
 * 故本模块只解析、不重述；解析失败一律 fail-closed 回退全量。
 *
 * 纯函数、无副作用：CLI 与测试都要 import 它（见 local-gate.mjs）。
 */
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * 解析 ci.yml 里 dorny/paths-filter 的 `filters: |` 块。
 * 返回 { global: [...globs], '<pkg>': [...globs] }；块缺失返回 null（调用方 fail-closed）。
 *
 * @param {string} ciYmlText ci.yml 全文。
 * @returns {Record<string, string[]> | null} 面名 -> glob 列表；块缺失或不可解析为 null。
 */
export function parseFilterBlock(ciYmlText) {
  const lines = ciYmlText.split("\n");
  const start = lines.findIndex((l) => /^\s*filters: \|\s*$/.test(l));
  if (start === -1) return null;
  const rootIndent = lines[start].match(/^\s*/)[0].length;

  // 块体：比 `filters:` 缩进更深，直到缩进回落到同一层或更浅。
  // 块内允许注释行（ci.yml 的 global 面就地写了为何某些路径刻意不在其中）。
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.match(/^\s*/)[0].length <= rootIndent) break;
    body.push(line);
  }
  if (body.length === 0) return null;

  const keyIndent = Math.min(...body.map((l) => l.match(/^\s*/)[0].length));
  const filters = {};
  let current = null;
  for (const line of body) {
    const indent = line.match(/^\s*/)[0].length;
    if (indent === keyIndent) {
      const m = /^\s*([^:\s#]+):\s*(?:#.*)?$/.exec(line);
      if (m === null) return null;
      current = m[1];
      filters[current] = [];
      continue;
    }
    const item =
      /^\s*-\s*'([^']+)'\s*(?:#.*)?$/.exec(line) ?? /^\s*-\s*"([^"]+)"\s*(?:#.*)?$/.exec(line);
    if (item === null || current === null) return null;
    filters[current].push(item[1]);
  }
  return Object.keys(filters).length > 0 ? filters : null;
}

/** 按 filters 匹配变更文件清单；返回 { globalHit, packages }（packages 为 filters 里的键）。 */
export function matchFilterBlock(filters, files) {
  const hit = new Set();
  let globalHit = false;
  for (const file of files) {
    for (const [key, globs] of Object.entries(filters)) {
      if (globs.some((glob) => safeMatchesGlob(file, glob))) {
        if (key === "global") globalHit = true;
        else hit.add(key);
      }
    }
  }
  return { globalHit, packages: [...hit].sort() };
}

function safeMatchesGlob(file, glob) {
  try {
    return matchesGlob(file, glob);
  } catch {
    // 仅防非字符串入参一类的调用错误：实测 Node 的 matchesGlob 对畸形 glob（`[`、`a{b` 等）
    // 返回 false 而不抛，故「畸形 glob」表现为不命中，靠 ci-face-coverage 的死 glob / 悬空
    // 条目断言判红，不靠这里兜底。真抛出来时宁可当作命中（放大跑的面），不可静默漏跑。
    return true;
  }
}

/** 纯文档 diff 的路径形态：它们收窄前也不命中任何面，不属 #742 引入的落差。 */
const PURE_DOC_PREFIXES = [".dsh/"];

function isPureDocPath(file) {
  return (
    file.startsWith("docs/") ||
    file.endsWith(".md") ||
    PURE_DOC_PREFIXES.some((p) => file.startsWith(p))
  );
}

/**
 * 本地快线（changed 档）是否升到 pr 档。
 *
 * 两种升档形态：
 *   ① 命中全局面（#722 起）——本地快线覆盖不到静态闸，只能升档；
 *   ② 空切片但有非文档改动（#742 阶段 2.1 补）——整树 scripts/** 收窄成白名单后，
 *      `scripts/maintenance/**`、`scripts/release/**`、`scripts/test/**` 这类条目的改动不再命中
 *      任何面；但它们的消费方正是 CI 上恒跑的静态闸（lint / format:check / test:scripts /
 *      docs:check…），若本地就此 exit 0，就等于把「本地绿而 CI 红」重新引进来——**收窄前**这些
 *      改动是会升档到 pr 的，故这里按「回归守卫」语义补上，而不是新立一套本地策略。
 *      纯文档 diff（docs/**、`*.md`、.dsh/**）不升档：它们收窄前也不命中任何面。
 *   文件清单取不到（git 不可用 / 基准失效）时按不升档处理——那条路径上 planChangedScope 已
 *   经 fail-closed 回退成全量包，快线本来就会跑全包。
 */
export function shouldEscalateChangedTier({ globalHit, hitPackages, files }) {
  if (globalHit) return true;
  if (hitPackages.length > 0) return false;
  if (files === null || files.length === 0) return false;
  return !files.every(isPureDocPath);
}

/**
 * 汇总：变更文件 + 包清单 → 本次该跑哪些包的 build/test/typecheck。
 * fail-closed 语义与 ci.yml 一致：全局面命中 → 全量；filters 不可解析 → 全量。
 */
export function planChangedScope({ root, files, allPackages }) {
  let filters = null;
  try {
    filters = parseFilterBlock(readFileSync(join(root, CI_WORKFLOW), "utf8"));
  } catch {
    filters = null;
  }
  if (filters === null) {
    return {
      hitPackages: [...allPackages],
      globalHit: true,
      escalated: true,
      reason: `${CI_WORKFLOW} 的 filters 块不可解析 —— 回退全量（fail-closed）`,
    };
  }
  const { globalHit, packages } = matchFilterBlock(filters, files);
  if (globalHit) {
    return {
      hitPackages: [...allPackages],
      globalHit,
      escalated: false,
      reason: "命中全局面（shared/scripts/.github/包管理文件）—— 回退全量",
    };
  }
  const known = packages.filter((p) => allPackages.includes(p));
  const unknown = packages.filter((p) => !allPackages.includes(p));
  return {
    hitPackages: known,
    globalHit,
    escalated: false,
    unknown,
    reason:
      known.length > 0 ? `命中 ${known.length} 个包面` : "未命中任何包面（纯文档/纯 meta 改动）",
  };
}
