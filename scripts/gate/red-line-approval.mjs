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
 * 用法：
 *   node scripts/gate/red-line-approval.mjs --files <逗号分隔|@json 路径> [--labels <同上>]
 *   node scripts/gate/red-line-approval.mjs --files-json <原始 JSON 路径> --labels-json <同>
 * 字段取值 `@<path>` 表示读该文件里的列表；`--files-json` 读的是 API 原始响应——实测
 * gh 2.101 的 `--paginate` 对数组端点会把各页**合并成一个 JSON 数组**（`per_page=2` 强制
 * 4 页仍整体可解析），脚本同时容忍「多个 JSON 文档首尾相连」这一旧形态。同一 flag 重复给出
 * 即 exit 2（不取最后一次）。三种取数都只是为了不在 workflow 里重写一遍解析与校验——口径只
 * 有这一份。
 *
 * 退出码：0 = 放行；1 = 有未批准的红线改动；2 = 输入缺失/不可解析（fail-closed）。
 */
import { readFileSync, realpathSync } from "node:fs";
import { matchesGlob, normalize } from "node:path";

/**
 * 红线路径常量（单一事实源）。新增红线面时改这里，别把判定散成 if。
 *
 * 两条各有出处，治理后果不同，别当成同一种东西：
 *   · `.github/**` —— 仓库 AGENTS.md 明写的红线面（workflow 与分支保护），改动须维护者
 *     在原 issue 内 approved；
 *   · `scripts/gate/**` —— #843 D1 提出的**加固面**，口径出自本批《红线批实施提案 + 排期》
 *     的 R-1（「红线路径先收敛为 `.github/**` 与 `scripts/gate/**`」）。代价是任何改门禁
 *     实现的 PR 都要 `approved` 标签，**包括 agent 的批次工作**（这会实打实拖慢自治循环）；
 *     若维护者裁决缩回仅 `.github/**`，删掉这一行即可——判定逻辑、事件域判据与 fail-closed
 *     口径都不在常量里，缩回不动其余任何一行。
 */
export const RED_LINE_PATTERNS = [".github/**", "scripts/gate/**"];

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
const KNOWN_FLAGS = new Set(["--files", "--labels", "--files-json", "--labels-json", "--patterns"]);

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
 * CLI 参数解析。返回 `{ ok: true, files, labels, patterns }` 或 `{ ok: false, error }`——
 * 解析失败是**输入错误**（exit 2），不是「有违规」（exit 1）。
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
  const mode = hasJson ? "json" : "literal";
  return {
    ok: true,
    mode,
    sources: {
      files: mode === "json" ? values.get("--files-json") : values.get("--files"),
      labels: mode === "json" ? values.get("--labels-json") : values.get("--labels"),
    },
    patterns: values.has("--patterns") ? splitList(values.get("--patterns")) : RED_LINE_PATTERNS,
  };
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
