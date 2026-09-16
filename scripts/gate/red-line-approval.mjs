#!/usr/bin/env node
/**
 * red-line-approval —— 红线路径改动的「人工批准」留痕判据（#843 M1 的代码侧落点）。
 *
 * 为什么是仓内 status check 而不是 CODEOWNERS：本仓 `enforce_admins=true`，分支保护只认
 * required check，而 GitHub 不允许自批自己的 PR——把 CODEOWNERS 指向唯一维护者会**永久冻结**
 * 每一处红线改动。判据做成可测的纯函数后，维护者只需把承载它的 job 注册成 required check，
 * 就能在不引入 CODEOWNERS 的前提下，让「red-line 改动缺少 approved 标签」变成红的。
 *
 * 它是**防疏忽与留痕**，不是对抗性守卫：判据脚本与 workflow 都在被评审的合并树里，愿意改
 * 门禁的人可以直接改掉它（本 PR 自身即证据——main 上还没有这个脚本，job 已执行 PR 版）。真
 * 对抗需要平台侧力量：把承载本判据的 job 注册成 required check，或对 `.github/**` 单独设
 * ruleset；两者都是维护者动作，不在本文件能力范围内。
 *
 * 判据是 fail-closed 的：取数失败、响应不是 JSON、字段缺失一律 exit 2。它刻意把「输入缺失 /
 * 不可解析」与「判红」分成两个退出码——把「判据没跑起来」伪装成「有违规」会让门禁的可信度
 * 一起贬值（1 才是违规）。
 *
 * 红线面是**派生**的，不是常量：基座只有 `AGENTS.md` 明写的 `.github/**`，其余进面的是数据
 * 事实源声明表里被声明为 `sources` 的每个文件（外加声明表自身）。三条理由与代价见
 * `redLinePatterns` 的注释——一句话：关闸开关是数据不是代码，谁被声明为事实源谁就该在面内。
 *
 * 用法：
 *   node scripts/gate/red-line-approval.mjs --files <逗号分隔|@json 路径> [--labels <同上>]
 *   node scripts/gate/red-line-approval.mjs --files-json <原始 JSON 路径> --labels-json <同>
 *   [--registry <声明表路径>] 换一份声明表派生红线面（默认 `scripts/data/threshold-registry.json`）；
 *   [--patterns <逗号分隔 glob>] 直接给面，与 --registry 互斥（面只能有一种来源）。
 * 字段取值 `@<path>` 表示读该文件里的列表；`--files-json` 读的是 API 原始响应——实测
 * gh 2.101 的 `--paginate` 对数组端点会把各页**合并成一个 JSON 数组**（`per_page=2` 强制
 * 4 页仍整体可解析），脚本同时容忍「多个 JSON 文档首尾相连」这一旧形态。同一 flag 重复给出
 * 即 exit 2（不取最后一次）。三种取数都只是为了不在 workflow 里重写一遍解析与校验——口径只
 * 有这一份。
 *
 * 退出码：0 = 放行；1 = 有未批准的红线改动；2 = 输入缺失/不可解析（fail-closed）。
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, matchesGlob, normalize, relative } from "node:path";

/**
 * 红线面的**基座**：仓库 `AGENTS.md` 明写的红线之一（`.github/` 下 workflow 与分支保护）。
 *
 * 它是本文件里唯一的静态项；其余红线面一律**派生**自数据事实源声明表（`redLinePatterns`）。
 * 上一版把 `scripts/gate/**` 也钉成静态项，等于自行扩大 `AGENTS.md` 的红线定义，且在 GitHub
 * 侧没有任何 `approved` 留痕——#851 裁决撤回，改由「被声明为事实源」派生。
 */
export const RED_LINE_BASE_PATTERNS = [".github/**"];

/** 声明表的规范仓库路径（#850）。声明表自身也在面内：改它的 `sources` 等于改红线面。 */
export const REGISTRY_REL_PATH = "scripts/data/threshold-registry.json";

/** 默认声明表按本模块位置解析，不依赖 cwd——CI 与自测的 cwd 未必都是仓库根。 */
export const DEFAULT_REGISTRY_PATH = join(
  import.meta.dirname,
  "..",
  "data",
  "threshold-registry.json",
);

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** 告警出口（与仓内其他脚本的 `::warning::` 同款：console.warn → stderr）。 */
function warnToStderr(message) {
  console.warn(message);
}

/**
 * 声明表自身在面内的表示：表在本仓库内时用仓库相对路径，否则退回规范路径。红线面表达的是
 * 「仓库里哪些路径被声明为事实源」，与调用方喂进来的是哪份副本无关——自测用 `/tmp` 下的
 * fixture，那个绝对路径不可能命中任何一条 changed files。
 */
function registrySelfPattern(registryPath) {
  const rel = normalizePath(relative(REPO_ROOT, registryPath));
  return rel.startsWith("..") ? REGISTRY_REL_PATH : rel;
}

/**
 * 从声明表文本里取「每个 guard 声明的每个事实源路径」。
 *
 * 只认 `guards[].sources`：`notAGate` 是显式声明「不是可放宽的阈值」的登记面，把它们一并拉进
 * 红线面等于把红线定义偷偷扩大到第二类登记面——那正是本轮撤回 `scripts/gate/**` 的同一条理由。
 * 结构不合法时返回 `{ error }` 而不抛：import 期抛出会让 CLI 以未捕获异常退出，退出码 1 与
 * 「判红」同码，读起来像「有未批准的红线改动」。
 */
function declaredSources(text) {
  let registry;
  try {
    registry = JSON.parse(text);
  } catch (e) {
    return { error: `JSON 不可解析（${e.message}）` };
  }
  if (!Array.isArray(registry?.guards)) return { error: "缺少 guards 数组" };
  const sources = [];
  for (const guard of registry.guards) {
    if (guard?.sources === undefined) continue;
    if (!Array.isArray(guard.sources))
      return { error: `guard ${guard?.id ?? "?"} 的 sources 不是数组` };
    for (const source of guard.sources) {
      if (typeof source !== "string" || source.trim() === "") {
        return { error: `guard ${guard?.id ?? "?"} 的 sources 含非字符串或空项` };
      }
      sources.push(source);
    }
  }
  return { sources };
}

/** 规范化面：去 `./`、去重、排序（同一个路径被多个 guard 声明只算一条）。 */
function normalizePatterns(patterns) {
  const normalized = patterns
    .map((pattern) => normalizePath(String(pattern).trim()))
    .filter((pattern) => pattern !== "" && pattern !== ".");
  return [...new Set(normalized)].sort();
}

/**
 * 由声明表**派生**红线面（#843 M1 / #851 裁决后的口径）。
 *
 * 三条理由：
 *   ① `scripts/gate/**` 不在 `AGENTS.md` 的红线清单里（清单只有公共 API 行为变更 / 新增第三方
 *      依赖 / `.github/` 下 workflow 与分支保护 / 发版）。把它写进面里是**扩大红线定义**，且在
 *      GitHub 侧没有 `approved` 留痕——「加固面」是无据的自我加冕；
 *   ② 代价与收益不成比例：实测最近 20 个 merged PR 有 14 个（70%）触及 `scripts/gate/**`，
 *      面落在这里只会把自治循环卡死，拦住的却是「改门禁实现」这类正常迭代；
 *   ③ 真正的关闸开关是**数据**不是代码：`sources` 指向哪个文件，守卫就读哪个文件——改一个数据
 *      文件外加一条声明即可静默关闸（F-1 已实证：前置一个影子源 + 掏空真实事实源后四道闸全绿）。
 *      故红线面改为派生：谁被声明为事实源，谁就在面内。
 * 代价如实写明：派生面实测会让最近 20 个 merged PR 里的 7 个（35%）进面（读数口径见 PR #851）。
 *
 * 边界（如实声明，勿误读）：
 *   · 声明表**缺失**（#850 尚未合入）时退化为基座面并打 `::warning::`，不 fail-closed——本判据的
 *     合并顺序在 #850 之后，但 #850 合入前 CI 也要能跑；退化必须留痕，静默退化等于面被悄悄缩小；
 *   · 声明表**存在但不可用**（读失败 / JSON 不可解析 / 结构不符）同样退化并报警，但**不**在这里
 *     判红：同一份表的 fail-closed 归属 #850 的 `threshold-monotonic`（解析失败即 exit 2），在这里
 *     再 fail-closed 只会给所有 PR 增加第二个断线通道。告警词点名具体原因，不冒充「无声明」。
 *
 * @param {string} registryPath 声明表路径（默认取与本模块同仓的规范位置）
 * @param {(message: string) => void} warn 告警出口
 * @returns {string[]} 去重、排序后的红线面
 */
export function redLinePatterns(registryPath = DEFAULT_REGISTRY_PATH, warn = warnToStderr) {
  const base = [...RED_LINE_BASE_PATTERNS, registrySelfPattern(registryPath)];
  let text;
  try {
    text = readFileSync(registryPath, "utf8");
  } catch (e) {
    return degradeToBase(`读取失败（${e.code ?? e.message}）`, registryPath, warn);
  }
  const declared = declaredSources(text);
  if (declared.error !== undefined) {
    return degradeToBase(declared.error, registryPath, warn);
  }
  return normalizePatterns([...base, ...declared.sources]);
}

/**
 * 退化为基座面并报警。声明表不存在时**不**把规范路径塞进面里——表都没落地，那个路径不可能被
 * 任何一次改动命中，塞进去只会让「面恰好等于 `.github/**`」这个可断言的事实变模糊。
 */
function degradeToBase(reason, registryPath, warn) {
  warn(
    `::warning::红线面退化为 ${RED_LINE_BASE_PATTERNS.join(", ")}：数据事实源声明表不可用（${reason}）` +
      `——${registryPath}；本次无额外文件进面（#851）`,
  );
  return normalizePatterns(RED_LINE_BASE_PATTERNS);
}

/**
 * 默认红线面：模块加载时按默认声明表**静默**派生一次（`judgeRedLine` 的默认值必须无副作用，
 * 不能因为被 import 就往外写告警）。
 *
 * 退化告警记在 DEFAULT_DEGRADATION 里，由 `resolvePatterns` 在**真的用到默认面**时补出——
 * 本次给了 `--registry` / `--patterns` 的运行里，默认表根本没被读，却打出「退化为 .github/**…
 * 本次无额外文件进面」的告警，与实际判的那一面不符（评审 ②）。
 */
let DEFAULT_DEGRADATION;
export const RED_LINE_PATTERNS = redLinePatterns(DEFAULT_REGISTRY_PATH, (message) => {
  DEFAULT_DEGRADATION = message;
});

/**
 * JSON 响应里要抽取的字段键名（GitHub REST 的 pulls.files / issues.labels 形状）。
 *
 * `files.alsoFields` 为什么必须带上 `previous_filename`：重命名条目的**旧路径**才是本次改动
 * 真正触碰的路径。只看 filename 时，把 `.github/workflows/ci.yml` 改名成 `docs/ci.yml.bak`
 * 会被判成「只改了 docs/」（实测 exit 0）——那是一条不需要 approved 就能把红线文件搬出红线面
 * 的通道。labels 无同形字段。
 */
export const JSON_SOURCES = {
  files: { field: "filename", alsoFields: ["previous_filename"] },
  labels: { field: "name" },
};

/**
 * 前缀与白名单都必须是显式的：静默忽略未知 flag 会把「调用点写错参数名」变成「用默认值判了
 * 一轮」，那是比判红更坏的假绿（门禁看起来跑了，判的却不是本次输入）。
 */
const FLAG_PREFIX = "--";
const KNOWN_FLAGS = new Set([
  "--files",
  "--labels",
  "--files-json",
  "--labels-json",
  "--patterns",
  "--registry",
]);

/** 逗号分隔值 → 去空白、丢空项。 */
function splitList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 路径归一化：`./.github/x` 与 `.github/x` 必须走同一条判据（否则多写一个 `./` 就能
 * 绕过红线并静默进入下一道门禁）。只做 POSIX 归一化，**不折大小写**：匹配器是仓内共用的
 * node:path `matchesGlob`，实测语义是「字面段大小写敏感、`**` 段大小写不敏感」——折过
 * 大小写会把 `.GITHUB/workflows/ci.yml` 这类**另一个目录**误判成红线（自测里钉了这条）。
 */
function normalizePath(p) {
  return normalize(p);
}

/** 标签归一化：GitHub 标签大小写不敏感（`Approved` 与 `approved` 是同一个标签）。 */
function normalizeLabel(label) {
  return String(label ?? "")
    .trim()
    .toLowerCase();
}

/**
 * 按括号配对把**首尾相连**的多个 JSON 文档切开（无分隔符）。只在整体 `JSON.parse` 失败后启用：
 * 实测 gh 2.101 的 `--paginate` 对数组端点已把各页合并成一个数组，这条分支是防御性的。
 *
 * 为什么不能沿用正则切分：`pulls/N/files` 每个条目都带 `patch`（统一 diff 文本），其中的
 * `]` 会让非贪婪的 `\[[\s\S]*?\]` 在数组真正结尾之前收口，`JSON.parse` 在字符串中间断开，
 * 于是**真实响应必然 exit 2**（退出码 2 会让 repo-gate 因 needs 连坐，对所有 PR 判红）。
 * 扫描器必须感知字符串与转义，才能把 `patch` 里的括号当数据而不是结构。
 */
function splitJsonDocuments(text) {
  const docs = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
      } else if (!/\s/.test(ch)) {
        throw new Error(`JSON 文档之外出现多余内容（偏移 ${i}）`);
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        docs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (inString || depth !== 0) throw new Error("JSON 不完整（引号或括号未闭合）");
  return docs;
}

/**
 * 读一个文件里的 JSON 值：先整体 `JSON.parse`（真实 gh 响应的形态），失败再按多文档切分。
 * 整体优先是刻意的——它是唯一能证明「这份响应自始自终是一个完整 JSON」的路径，回退分支只
 * 用来兼容旧形态。
 */
function readJsonValues(text) {
  const raw = String(text).trim();
  if (raw === "") return [];
  try {
    return [JSON.parse(raw)];
  } catch {
    const docs = splitJsonDocuments(raw);
    if (docs.length === 0) throw new Error("响应里找不到 JSON 文档");
    return docs.map((doc) => JSON.parse(doc));
  }
}

/**
 * 从原始响应里按 `field`（以及 `alsoFields`）抽取字符串列表；形态不符即抛（由调用方转 exit 2）。
 * `alsoFields` 只在条目真的带该字段时追加，不要求每个条目都有（GitHub 只在 renamed 条目上给
 * `previous_filename`）。
 */
function extractField(values, field, alsoFields = []) {
  const out = [];
  for (const value of values) {
    if (!Array.isArray(value)) throw new Error(`响应不是 JSON 数组（拿到 ${typeof value}）`);
    for (const item of value) {
      const v = item?.[field];
      if (typeof v !== "string" || v === "") throw new Error(`条目缺少字符串字段 ${field}`);
      out.push(v);
      for (const extra of alsoFields) {
        const extraValue = item?.[extra];
        if (typeof extraValue === "string" && extraValue !== "") out.push(extraValue);
      }
    }
  }
  return out;
}

/**
 * 按取值来源读取字段列表：
 *   `--files-json` 模式——取值是**文件路径**，读原始 JSON 响应并按字段抽取；
 *   字面模式——`@path` 表示读该文件（原生字符串列表或 JSON 响应），否则是逗号分隔的字面清单。
 */
function resolveField(raw, source) {
  const text = String(raw ?? "").trim();
  if (text === "") return [];
  const isFile = source.json || text.startsWith("@");
  if (!isFile) return splitList(text);
  const fileText = readFileSync(source.json ? text : text.slice(1), "utf8");
  const values = readJsonValues(fileText);
  if (values.length === 0) return [];
  // 原生列表形态：`["a","b"]`；否则按 JSON 响应的字段抽取（含 renamed 的旧路径）。
  const isPlainList = values.every(
    (v) => Array.isArray(v) && v.every((item) => typeof item === "string"),
  );
  if (isPlainList) return values.flat();
  return extractField(values, source.field, source.alsoFields);
}

/**
 * 判据本体（纯函数）。
 *
 * @param {{ changedFiles?: string[]|string, labels?: string[]|string, patterns?: string[] }} input
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function judgeRedLine({ changedFiles, labels, patterns = RED_LINE_PATTERNS } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles : splitList(changedFiles);
  const labelList = Array.isArray(labels) ? labels : splitList(labels);
  const normalized = files.map((f) => normalizePath(String(f).trim())).filter((f) => f !== "");
  const approved = labelList.map(normalizeLabel).includes("approved");
  const hits = normalized.filter((file) => patterns.some((pattern) => matchesGlob(file, pattern)));
  if (approved || hits.length === 0) return { ok: true, violations: [] };
  return {
    ok: false,
    violations: hits.map(
      (file) => `红线文件 ${file} 命中红线面，但本次 PR 缺少 approved 标签（#843 M1）`,
    ),
  };
}

/**
 * CLI 参数解析。返回 `{ ok: true, mode, sources, patterns }` 或 `{ ok: false, error }`——
 * 解析失败是**输入错误**（exit 2），不是「有违规」（exit 1）。
 *
 * 面的三种来源按优先级收起且互斥：`--patterns` 直接给面、`--registry` 换一份声明表派生、都不给
 * 则用默认声明表派生的 `RED_LINE_PATTERNS`。给两种来源是**调用点写错参数**，判 exit 2 而不是
 * 悄悄取其一：判了一轮却不是调用方以为的那一面，是比判红更坏的假绿。
 */
export function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith(FLAG_PREFIX) || arg === FLAG_PREFIX) {
      return { ok: false, error: `无法解析的参数：${arg}` };
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!KNOWN_FLAGS.has(name)) return { ok: false, error: `未知参数：${name}` };
    let value;
    if (eq === -1) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith(FLAG_PREFIX)) {
        return { ok: false, error: `${name} 缺少参数值` };
      }
      value = argv[++i];
    } else {
      value = arg.slice(eq + 1);
    }
    if (values.has(name)) return { ok: false, error: `${name} 重复给出` };
    values.set(name, value);
  }
  const hasLiteral = values.has("--files") || values.has("--labels");
  const hasJson = values.has("--files-json") || values.has("--labels-json");
  if (!hasLiteral && !hasJson) {
    return {
      ok: false,
      error:
        "缺少输入（--files / --files-json 至少给一个）；用法：node scripts/gate/red-line-approval.mjs --files a,b --labels x,y",
    };
  }
  if (hasLiteral && hasJson) {
    return { ok: false, error: "--files 与 --files-json 互斥（同一字段只能有一种取数口径）" };
  }
  if (values.has("--patterns") && values.has("--registry")) {
    return { ok: false, error: "--patterns 与 --registry 互斥（红线面只能有一种来源）" };
  }
  const mode = hasJson ? "json" : "literal";
  return {
    ok: true,
    mode,
    sources: {
      files: mode === "json" ? values.get("--files-json") : values.get("--files"),
      labels: mode === "json" ? values.get("--labels-json") : values.get("--labels"),
    },
    patterns: resolvePatterns(values),
  };
}

/** 面来源三选一：`--patterns` > `--registry` > 默认派生的 `RED_LINE_PATTERNS`。 */
function resolvePatterns(values) {
  if (values.has("--patterns")) return splitList(values.get("--patterns"));
  if (values.has("--registry")) {
    // 声明表不可用时 redLinePatterns 已报警并退化，这里不需要再兜一层错——退化后的面就是它给的。
    return redLinePatterns(values.get("--registry"));
  }
  // 默认面在 import 期已静默派生过（同一份 `RED_LINE_PATTERNS`），只在本次真的用到它时才补出
  // 那条退化告警：没有这一句，退化会变成静默缩小面；无条件在 import 期打，又会冤枉注入面的运行。
  if (DEFAULT_DEGRADATION !== undefined) warnToStderr(DEFAULT_DEGRADATION);
  return RED_LINE_PATTERNS;
}

/**
 * CLI 主流程。
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`red-line-approval: ${parsed.error} —— fail-closed（exit 2）`);
    return 2;
  }
  let changedFiles;
  let labels;
  try {
    changedFiles = resolveField(parsed.sources.files, {
      ...JSON_SOURCES.files,
      json: parsed.mode === "json",
    });
    labels = resolveField(parsed.sources.labels, {
      ...JSON_SOURCES.labels,
      json: parsed.mode === "json",
    });
  } catch (e) {
    console.error(`red-line-approval: 输入不可解析（${e.message}）—— fail-closed（exit 2）`);
    return 2;
  }
  if (changedFiles.length === 0) {
    console.error(
      "red-line-approval: 变更文件集为空 —— 无法判定（不是「无红线改动」），fail-closed（exit 2）",
    );
    return 2;
  }
  const result = judgeRedLine({
    changedFiles,
    labels,
    patterns: parsed.patterns,
  });
  if (result.ok) {
    console.log(
      `red-line-approval: OK（changedFiles=${changedFiles.length}、labels=${labels.length}、红线面[${parsed.patterns.join(", ")}]）`,
    );
    return 0;
  }
  console.error(`red-line-approval: FAIL（${result.violations.length} 条未批准的红线改动）`);
  for (const v of result.violations) console.error(`  - ${v}`);
  return 1;
}

/** 仅直跑时执行 main（被自测 import 时不产生副作用，与仓内其他门禁同口径）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(import.meta.filename) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(main());
