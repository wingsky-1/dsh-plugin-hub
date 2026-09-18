#!/usr/bin/env node
/**
 * verify-prose-counts — gauntlet.config.json 里 config/scope 类散文字段的段数判据（#767 P6 试点）。
 *
 * 为什么需要它：gauntlet.config.json 的 mutation.packages 下每个包的 config / scope 两个字段是
 * 自由散文（"stryker.conf.d/dsh-xxx-{a,b,c}.json（…）" / "src 级九段（…）：…"），而真正的段集合只活在
 * scripts/data/mutation-topology.json 的 segments 里。散文一旦过期（加段/并段后忘了改注释），后人
 * 读到的就是假 topology——此前没有任何判据守着，注释与事实的漂移只能靠人肉发现。
 *
 * 事实源：mutation-topology.json 里各包 segments 的键集合是唯一事实源；散文只许复述、不许另起口径。
 * 顺序无关：散文枚举顺序与拓扑键序可能不同（如 provider-usage 散文是 entry 打头、拓扑是 apply 打头），
 * 故一律按集合比对，不按顺序。
 *
 * 解析规则（config 字段，三形态）：
 *   1. 枚举 {a,b,c}——花括号内逗号分隔的段名清单，逐项 trim；空项或非法字符即未知形态。
 *   2. 区间 {m..n}——花括号内严格形如"数字..数字"（如 lan-proxy 的 {1..4}），展开为十进制字符串
 *      序列；m > n 或非纯数字即未知形态。
 *   3. 无括号——整段 config 不含任何花括号字符（如 dsh-web-file-preview.json），断言拓扑恰为一段；
 *      段名不限（单段在拓扑里的键名由 gen-stryker-conf.mjs 派生，不在本闸复述）。
 *   未知形态（多组花括号、括号不配平、{a..z} 这类非数字区间、{a,,b} 空项等）：无法求值，一律
 *      fail-closed（exit 2），不读成通过、也不读成不达标。
 *
 * 解析规则（scope 字段，辅助）：只看 "src 级"之后、第一个中文括号/冒号/逗号之前的段首小节；
 * 其中"X段"（中文数字或阿拉伯数字，如九段/十二段/9段）须等于拓扑段数；小节里既无段数词（如"全量"，
 * 它描述的是覆盖口径而非段数）则该包 scope 项跳过、不判。段首之外的"阶段三""六段"等一律不看——
 * 它们是变更历史注记，不是当前段数。小节有段数词但数字无法解析即未知形态（exit 2）。
 *
 * 用法：node scripts/gate/verify-prose-counts.mjs [--root <dir>] [--gauntlet <file>] [--topology <file>] [--help]
 *   --root     仓库根（fixture 用），默认本仓库根；--gauntlet / --topology 可单独覆盖数据文件路径
 * 退出码：0 = 全部一致；1 = 散文与拓扑失配（判红，结论可信）；2 = 门禁故障（配置不可读、事实源缺失、
 *   散文形态未知——经文件内 failClosed 出口，禁裸 exit 2，禁止合并）。
 *
 * 基线注记：本分支基线尚无 scripts/lib/gate-exit.mjs，唯一出口暂为文件内 failClosed（判词与之同形，
 * 便于 rebase 后换成 import 而语义不变）；本文件唯一的直接退出口是 `process.exit(main())`，字面
 * exit 2 只出现在 failClosed 内一处。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const GAUNTLET_REL = join("scripts", "data", "gauntlet.config.json");
const TOPOLOGY_REL = join("scripts", "data", "mutation-topology.json");

/** 段名的合法形态：拓扑键的实际字符集（字母数字 + 下划线/连字符，如 trend-aggregate、1）。 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** 区间形态的严格文法：纯十进制数字..纯十进制数字。 */
const RANGE_RE = /^(\d+)\.\.(\d+)$/;
/** scope 段首小节的终止符：段数词只认小节内，括号后的变更历史不看。 */
const SCOPE_PREFIX_END = /[（：:，,；;\n]/;
/** scope 段数词：中文数字或阿拉伯数字 + 段。 */
const SCOPE_COUNT_RE = /([一二三四五六七八九十百零〇两\d]+)\s*段/;

const CN_DIGITS = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  两: 2,
  〇: 0,
  零: 0,
};

/** 取 `--flag value` / `--flag=value` 形式的参数值；未给出返回 fallback（与仓内其余判据同形）。 */
function argValue(argv, flag, fallback) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/**
 * 门禁故障的唯一出口：打印可检索的 `::error::` 注解后由调用方返回 exit 2。
 * 返回数字而不是直接退出——main 的直接退出口只有 `process.exit(main())` 一处，字面 exit 2
 * 只允许出现在这里（禁裸 exit 2：散落在各分支的直接退出是第二份语义的来源）。
 */
function failClosed(why) {
  console.error(`::error::门禁故障（非判据结论）：${why}`);
  return 2;
}

/** 解析百以内中文数字（十二/二十/二十五/一百二十三）与阿拉伯数字；无法解析返回 null。 */
export function parseCountNumeral(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[一二三四五六七八九十百零〇两]+$/.test(s)) return null;
  if (s.includes("百")) {
    const parts = s.split("百");
    if (parts.length !== 2) return null;
    const [head, rest] = parts;
    if (head.length !== 1 || CN_DIGITS[head] === undefined || CN_DIGITS[head] === 0) return null;
    const restValue = rest === "" ? 0 : parseBelowHundred(rest);
    if (restValue === null) return null;
    return CN_DIGITS[head] * 100 + restValue;
  }
  return parseBelowHundred(s);
}

/** 解析百以内的中文数字片段；无法解析返回 null。 */
function parseBelowHundred(s) {
  if (s === "") return 0;
  const tenAt = s.indexOf("十");
  if (tenAt === -1) {
    return s.length === 1 && CN_DIGITS[s] !== undefined ? CN_DIGITS[s] : null;
  }
  const left = s.slice(0, tenAt);
  const right = s.slice(tenAt + 1);
  if (left !== "" && (left.length !== 1 || CN_DIGITS[left] === undefined)) return null;
  if (right !== "" && (right.length !== 1 || CN_DIGITS[right] === undefined)) return null;
  return (left === "" ? 1 : CN_DIGITS[left]) * 10 + (right === "" ? 0 : CN_DIGITS[right]);
}

/**
 * 解析 config 散文字段，返回 { kind, segments, reason }。
 * kind：enum（{a,b,c}）/ range（{m..n}）/ single（无括号）/ unknown（无法求值，reason 说明形态）。
 * single 的 segments 为空——它不断言段名，只断言拓扑恰为一段。
 */
export function parseConfigProse(text) {
  if (typeof text !== "string")
    return { kind: "unknown", segments: [], reason: "config 字段缺失/非字符串" };
  const groups = [...text.matchAll(/\{([^{}]*)\}/g)];
  const hasBraceChar = text.includes("{") || text.includes("}");
  if (groups.length === 0) {
    if (hasBraceChar) {
      return { kind: "unknown", segments: [], reason: "花括号不配平，无法确定段清单" };
    }
    return { kind: "single", segments: [], reason: "" };
  }
  if (groups.length > 1) {
    return { kind: "unknown", segments: [], reason: "含多组花括号，无法确定哪组是段清单" };
  }
  const inner = groups[0][1].trim();
  if (inner.includes("..")) {
    const m = RANGE_RE.exec(inner);
    if (m === null) return { kind: "unknown", segments: [], reason: `区间形态非法：{${inner}}` };
    const [from, to] = [Number(m[1]), Number(m[2])];
    if (from > to) return { kind: "unknown", segments: [], reason: `区间倒置：{${inner}}` };
    const segments = [];
    for (let i = from; i <= to; i += 1) segments.push(String(i));
    return { kind: "range", segments, reason: "" };
  }
  const items = inner.split(",").map((s) => s.trim());
  const bad = items.find((s) => s === "" || !SEGMENT_RE.test(s));
  if (bad !== undefined) {
    return { kind: "unknown", segments: [], reason: `枚举项非法：{${inner}}` };
  }
  return { kind: "enum", segments: items, reason: "" };
}

/**
 * 解析 scope 散文字段的段首段数词，返回 { kind, count, reason }。
 * kind：count（有明确段数词）/ absent（无段数词，如"全量"，该包 scope 项跳过）/
 * unknown（有段数词但数字无法解析，reason 说明）。
 */
export function parseScopeCount(text) {
  if (typeof text !== "string" || text === "") return { kind: "absent", count: 0, reason: "" };
  const end = SCOPE_PREFIX_END.exec(text);
  const prefix = end === null ? text : text.slice(0, end.index);
  const m = SCOPE_COUNT_RE.exec(prefix);
  if (m === null) return { kind: "absent", count: 0, reason: "" };
  const count = parseCountNumeral(m[1]);
  if (count === null) return { kind: "unknown", count: 0, reason: `段数词无法解析：${m[1]}段` };
  return { kind: "count", count, reason: "" };
}

/**
 * 单包比对：散文（config 段清单 + scope 段数词）vs 拓扑段键集合。
 * 返回 { problems（失配，exit 1）, fatals（无法求值，exit 2） }。
 */
export function checkPackage(pkgName, configText, scopeText, segKeys) {
  const problems = [];
  const fatals = [];
  if (!Array.isArray(segKeys) || segKeys.length === 0) {
    fatals.push(`[${pkgName}] 拓扑 segments 为空或缺失——没有可比对的事实源`);
    return { problems, fatals };
  }
  const parsed = parseConfigProse(configText);
  if (parsed.kind === "unknown") {
    fatals.push(`[${pkgName}] config 散文形态未知（${parsed.reason}）——无法求值`);
  } else if (parsed.kind === "single") {
    if (segKeys.length !== 1) {
      problems.push(
        `[${pkgName}] config 无括号（单段形态）但拓扑有 ${segKeys.length} 段（${segKeys.join("、")}）`,
      );
    }
  } else {
    const expected = new Set(parsed.segments);
    const actual = new Set(segKeys);
    const missing = segKeys.filter((k) => !expected.has(k));
    const extra = parsed.segments.filter((k) => !actual.has(k));
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `[${pkgName}] config 段清单与拓扑不一致（${parsed.kind}形态）：` +
          `拓扑多出${missing.length > 0 ? missing.join("、") : "无"}；` +
          `散文多出${extra.length > 0 ? extra.join("、") : "无"}` +
          `（拓扑 ${actual.size} 段，散文 ${expected.size} 段）`,
      );
    }
  }
  const scope = parseScopeCount(scopeText);
  if (scope.kind === "unknown") {
    fatals.push(`[${pkgName}] scope 段数词无法解析（${scope.reason}）——无法求值`);
  } else if (scope.kind === "count" && scope.count !== segKeys.length) {
    problems.push(`[${pkgName}] scope 段数词 ${scope.count}段 与拓扑 ${segKeys.length} 段不一致`);
  }
  return { problems, fatals };
}

/**
 * 全包比对：gauntlet.mutation.packages 的每包 config/scope vs topology.packages 的 segments。
 * 段数一律现算现比，不写死任何包的当前段数。
 */
export function checkAll(gauntlet, topology) {
  const report = [];
  const problems = [];
  const fatals = [];
  let scopeSkipped = 0;
  const pkgs = gauntlet?.mutation?.packages;
  if (pkgs === null || typeof pkgs !== "object" || Object.keys(pkgs).length === 0) {
    fatals.push("gauntlet 的 mutation.packages 为空或缺失——没有待核对的散文面");
    return { report, problems, fatals, checked: 0, scopeSkipped };
  }
  const topoPkgs = topology?.packages;
  if (topoPkgs === null || typeof topoPkgs !== "object") {
    fatals.push("拓扑事实源的 packages 为空或缺失——没有可比对的事实源");
    return { report, problems, fatals, checked: 0, scopeSkipped };
  }
  for (const [pkgName, entry] of Object.entries(pkgs)) {
    const segKeys = topoPkgs[pkgName] ? Object.keys(topoPkgs[pkgName].segments ?? {}) : null;
    if (segKeys === null) {
      fatals.push(`[${pkgName}] 拓扑中无此包——没有可比对的事实源`);
      continue;
    }
    const { problems: p, fatals: f } = checkPackage(pkgName, entry?.config, entry?.scope, segKeys);
    problems.push(...p);
    fatals.push(...f);
    if (p.length === 0 && f.length === 0) {
      const scope = parseScopeCount(entry?.scope);
      const scopeNote =
        scope.kind === "count" ? `scope ${scope.count}段一致` : "scope 无段数词跳过";
      if (scope.kind !== "count") scopeSkipped += 1;
      const parsed = parseConfigProse(entry?.config);
      const configNote =
        parsed.kind === "single"
          ? "config 单段形态一致"
          : `config ${parsed.kind}清单 ${parsed.segments.length} 项一致`;
      report.push(`PASS | [${pkgName}] ${configNote}；${scopeNote}（拓扑 ${segKeys.length} 段）`);
    }
  }
  return {
    report,
    problems,
    fatals,
    checked: report.length + problems.length + fatals.length,
    scopeSkipped,
  };
}

/** 打印用法（--help 出口，恒 exit 0）。 */
function printUsage() {
  console.log(
    [
      "用法：node scripts/gate/verify-prose-counts.mjs [--root <dir>] [--gauntlet <file>] [--topology <file>] [--help]",
      "  比对 gauntlet.config.json 的 config/scope 散文与 mutation-topology.json 的 segments 事实源。",
      "  退出码：0 = 全部一致；1 = 散文与拓扑失配；2 = 门禁故障（配置不可读/事实源缺失/散文形态未知，禁止合并）。",
    ].join("\n"),
  );
}

function readJson(path, label) {
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")), error: "" };
  } catch (e) {
    return {
      data: null,
      error: `${label}不可读/解析失败（${path}）：${String(e?.message ?? e).split("\n")[0]}`,
    };
  }
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return 0;
  }
  const root = argValue(argv, "--root", ROOT);
  const gauntletPath = argValue(argv, "--gauntlet", join(root, GAUNTLET_REL));
  const topologyPath = argValue(argv, "--topology", join(root, TOPOLOGY_REL));
  const gauntlet = readJson(gauntletPath, "gauntlet 配置");
  if (gauntlet.error !== "") return failClosed(gauntlet.error);
  const topology = readJson(topologyPath, "拓扑事实源");
  if (topology.error !== "") return failClosed(topology.error);

  const { report, problems, fatals, scopeSkipped } = checkAll(gauntlet.data, topology.data);
  for (const line of report) console.log(line);
  if (fatals.length > 0) {
    for (const p of problems) console.error(`FAIL | ${p}`);
    return failClosed(fatals.join("；"));
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL | ${p}`);
    console.error(`verify-prose-counts: FAIL（${problems.length} 条失配）`);
    return 1;
  }
  console.log(
    `verify-prose-counts: OK（${report.length} 包全一致，scope 跳过 ${scopeSkipped} 包）`,
  );
  return 0;
}

/** 仅直接执行时跑 main（被自测 import 时只取纯函数，与仓内其他门禁同口径）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(main(process.argv.slice(2)));
