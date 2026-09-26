#!/usr/bin/env node
/**
 * scripts/maintenance/equiv-check.ts —— 等价重构的「机制性等价性检查器」（#843 M10）。
 *
 * **它是什么**：机制性抽取 + 登记表对账器。**它不是判据**——它不对「某条差异是否无害」作
 * 任何判定（那是 §4.1 第 3 件「被改函数的差分对拍」的活），它做的是把两侧的记号多重集差集
 * 抽出来，再拿登记表去对账：对得上 exit 0，对不上 exit 1。
 *
 * 定位：docs/DEVELOPMENT.md §4.1「等价重构类改动的验证三件套」第 2 件。三件套里的探针
 * （第 1 件）是一次性动作，第 3 件是被改函数的差分对拍；只有第 2 件是**机制**——它需要一份
 * 每次都能重跑的抽取与对账。#839 把它写成了一次性草稿（只存在于当次的 .maintenance-drafts/，
 * 已 gitignore），任何人 clone 都拿不到，评审无法证伪，故在此入库。
 *
 * 覆盖面（本工具**不构成等价性证明**，边界常驻 --help 与每次输出）：
 * 它把「基线 ref」与「改动 ref」两侧源码各解一次 AST，抽取四类**多重集**做差集：
 *   ① 字面量（字符串 / 数字 / 布尔 / null / 模板片段）
 *   ② 非计算对象键（含解构模式的键——抽函数时它正是「结构回声」的来源）
 *   ③ 正则字面量
 *   ④ process.exit(n) / process.exitCode = n
 * 外加 §4.1 点名要求的两个专项（各自独立成类，登记一张不能顺带豁免另一张）：
 *   ⑤ 数字字面量整段消失（防丢上界 / 阈值）
 *   ⑥ 新增函数零引用（防抽了不用）
 * 比对面只含源码文件：文档 / 数据等非源码面被跳过，不参与比对。
 *
 * §4.1 说「差异只允许两类：空，或抽函数必然产生的结构回声（计数 +N）」，而**本工具不
 * 执行这条限制**：它只校验登记项**非空**、且与实测集合**互相吻合**（多一条算登记失效、
 * 少一条算未登记，两者都 exit 1）。**理由是否真的落在那两类之内由人负责**——逐条填一句
 * "TODO" 同样能过。登记表的正当性是**人的责任**，工具只保证「没人偷偷漏登 / 多登」。
 *
 * **具体披露（本仓自带的示例表）**：仓内 #839 那份差异登记表共 281 条，其中 **68 条（24.2%）
 * 是负向 delta**——同一记号的计数**下降**，成因是去重收敛与消息参数化，如
 * `scripts/gate/local-gate.mjs` 的 `str:"--filter"` 7→4、
 * `scripts/lib/config-matrix-lib.ts` 的 `num:12` 2→1。§4.1 对「结构回声」给的是计数 **+N**
 * 的字面定义，**这 68 条按该定义不属该类**——该表因此构成对 §4.1 允许类别的一次**放宽**。
 * 本工具不校验此类，**该放宽是否可接受由评审环节判断，不由工具判断**。逐条清单见
 * `scripts/test/equiv-check.test.ts` 的 `PR839_REGISTRY`，其文件头有同样披露与计数。
 *
 * **看不见的三类改法**（均经实测，不是推演）：
 *   a 控制流：分支顺序对调、条件取反、状态少复位一次——只要没有增删上述记号，一律报 0
 *     差异（#732 的 stripComments 状态复位 bug、§4.1 记的「分支顺序变了」都属此类）；
 *   b 语义对调：**记号原样保留、只在语义上被对调**（如 if(len>3) return "A"; return "B";
 *     两条 return 的值互换）——多重集逐位相同，同样报 0 差异；
 *   c 其余一切只改运行期状态、不改记号形态的改法。
 * 因此本工具**不能单独**作为「行为没变」的结论；§4.1 第 3 件（被改函数的差分对拍）才是
 * 那一层的证据。把它当证明用，是本工具最可能的误用。
 *
 * 定位：维护者 / 本地工具，需 git 与完整历史，**不进 CI**（进 CI 属 .github/ 红线段；
 * 「维护工具不进 CI」本身是 AGENTS.md 明写的设计）。
 *
 * 用法：
 *   node scripts/maintenance/equiv-check.ts --base <ref> --head <ref> [选项]
 *   node scripts/maintenance/equiv-check.ts --base origin/main --head HEAD
 *   node scripts/maintenance/equiv-check.ts --base 8447025d --head df68b9b1 --json
 *   node scripts/maintenance/equiv-check.ts --base A --head B --path scripts/gate/local-gate.mjs
 *
 * 退出码：0 = 比对完成且无未登记差异；1 = 存在未登记差异（判红可信）；
 *         2 = 环境或输入错误（ref 不存在、文件读不到、解析失败、登记表本身坏了）。
 *         **纯文档 diff（比对面没有源码文件）走 2 是预期行为**，既不是判红也不是门禁故障
 *         ——本工具对这类 diff 无话可说，不要把它读成「门禁坏了」。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTs, type AstNode, type AstProgram } from "../lib/config-matrix-lib.ts";

/** 覆盖面边界（常驻 --help 与每次输出；--json 走 boundary 字段）。 */
const BOUNDARY =
  "覆盖面边界：本工具只比对字面量 / 对象键 / 正则 / process.exit 的多重集差集与 §4.1 的两个专项" +
  "（数字字面量整段消失、新增函数零引用），不构成等价性证明——控制流等价性不在覆盖面内" +
  "（分支顺序对调、条件取反、状态少复位，只要没有增删上述记号都照样报 0 差异），字面量在语义上" +
  "被对调（如两个 return 的返回值互换）同样不可见，须由 DEVELOPMENT §4.1 第 3 件的差分对拍证明。" +
  "它不校验理由的类别，只校验登记项非空且与实测集合互相吻合；理由是否落在 §4.1 允许的两类内由人" +
  "负责——它不对「差异是否无害」作任何判定。比对面只含源码文件，非源码面被跳过。";

type Facet = "literal" | "key" | "regex" | "exit" | "number-lost" | "function-orphan" | "file";

/** 差异项：定位到「哪个文件的哪一类、哪个值、计数差多少」。 */
interface Entry {
  path: string;
  facet: Facet;
  value: string;
  delta: number;
}

/** 登记项 = 差异项 + 理由。理由缺失即视为登记表本身坏了（exit 2），不得静默放行。 */
interface RegistryEntry extends Entry {
  reason: string;
}

const FACETS: readonly Facet[] = [
  "literal",
  "key",
  "regex",
  "exit",
  "number-lost",
  "function-orphan",
  "file",
];

/** 输入 / 环境类错误：调用方据此走 exit 2（门禁故障，不可信），不走判红。 */
class InputError extends Error {}

const LOADER_BY_EXT: Record<string, "ts" | "tsx" | "js"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".mjs": "js",
  ".cjs": "js",
  ".js": "js",
  ".jsx": "js",
};

/** acorn 附带的非子节点字段（位置 / 正则对象），遍历时必须跳过，否则会把它们当节点下钻。 */
const NON_CHILD_KEYS = new Set(["loc", "start", "end", "range", "regex", "raw"]);

interface Collected {
  literal: string[];
  key: string[];
  regex: string[];
  exit: string[];
  /** 函数名 → 声明处数（函数声明，或 const f = function/arrow）。 */
  declared: Map<string, number>;
  /** 标识符名 → 出现次数（引用粗口径：声明点自身也计入，故它是上界）。 */
  identifiers: Map<string, number>;
  nodeCount: number;
}

function emptyCollected(): Collected {
  return {
    literal: [],
    key: [],
    regex: [],
    exit: [],
    declared: new Map(),
    identifiers: new Map(),
    nodeCount: 0,
  };
}

function bump(m: Map<string, number>, name: string): void {
  m.set(name, (m.get(name) ?? 0) + 1);
}

/**
 * 值 → 记号（带类型前缀，避免字符串 "1" 与数字 1 在登记表里撞键）。字面量面与键面共用
 * 这一处转换：两处各写一遍的话，改前缀时会漏改一处，而漏改的后果是同一个值在两个面上
 * 撞键，差异集静默错位。
 */
function valueToken(v: unknown): string | null {
  if (typeof v === "string") return "str:" + JSON.stringify(v);
  if (typeof v === "number") return "num:" + String(v);
  if (typeof v === "boolean") return "bool:" + String(v);
  if (v === null) return "null:";
  return null;
}

/** 字面量记号。 */
function literalToken(n: AstNode): string | null {
  return valueToken(n.value);
}

/** 非计算属性键记号。计算键（obj[k]）不收——它的值运行期才决定，本就不可静态比对。 */
function keyToken(n: AstNode): string | null {
  const key = n.key;
  if (key === null || key === undefined) return null;
  if (key.type === "Identifier") return "id:" + String(key.name);
  if (key.type !== "Literal") return null;
  return valueToken(key.value);
}

/** 模板片段记号（多行文本按行拆成多个 quasis，逐条计数）。 */
function templateToken(n: AstNode): string {
  const v = n.value as { cooked?: unknown } | undefined;
  const cooked = typeof v?.cooked === "string" ? v.cooked : "";
  return "tpl:" + JSON.stringify(cooked);
}

/** process.NAME 的成员访问形态。 */
function isProcessMember(n: AstNode | null | undefined, name: string): boolean {
  if (n === null || n === undefined) return false;
  return (
    n.type === "MemberExpression" &&
    n.computed !== true &&
    n.object?.type === "Identifier" &&
    n.object.name === "process" &&
    n.property?.type === "Identifier" &&
    n.property.name === name
  );
}

/** 退出码实参记号；非字面量实参记 dynamic（仍进多重集，不当「没有退出码」）。 */
function argumentToken(n: AstNode | null | undefined): string {
  if (n === null || n === undefined) return "dynamic";
  if (n.type === "Literal") {
    const v = n.value;
    if (typeof v === "string" || typeof v === "number") return JSON.stringify(v);
  }
  return "dynamic";
}

function exitToken(n: AstNode): string | null {
  if (n.type === "CallExpression" && isProcessMember(n.callee, "exit")) {
    return "exit:" + argumentToken(n.arguments?.[0]);
  }
  if (
    n.type === "AssignmentExpression" &&
    n.operator === "=" &&
    isProcessMember(n.left, "exitCode")
  ) {
    return "exitCode:" + argumentToken(n.right);
  }
  return null;
}

/** 本节点声明的函数名（无则 null）：函数声明，或 const f = function/arrow。 */
function declaredFunctionName(n: AstNode): string | null {
  if (n.type === "FunctionDeclaration" && n.id?.type === "Identifier") return String(n.id.name);
  if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.init) {
    const t = n.init.type;
    if (t === "FunctionExpression" || t === "ArrowFunctionExpression") return String(n.id.name);
  }
  return null;
}

/** 正则字面量记号：pattern + flags 合成一条，flags 参与比对（少一个 i 就算改过）。 */
function regexToken(n: AstNode): string {
  const re = n.regex as { pattern?: unknown; flags?: unknown };
  return "re:" + String(re.pattern) + "/" + String(re.flags);
}

/** 单节点的字面量类记号（字面量 / 模板片段 / 正则）；不属于这一类则 null。 */
function literalOrRegexToken(n: AstNode): { facet: "literal" | "regex"; token: string } | null {
  if (n.type === "TemplateElement") return { facet: "literal", token: templateToken(n) };
  if (n.type !== "Literal") return null;
  if (n.regex) return { facet: "regex", token: regexToken(n) };
  const tok = literalToken(n);
  return tok === null ? null : { facet: "literal", token: tok };
}

/** 标识符 / 退出码 / 函数声明三类计数（声明与引用是专项⑥的输入）。 */
function harvestNames(n: AstNode, sink: Collected): void {
  if (n.type === "Identifier" && typeof n.name === "string") bump(sink.identifiers, n.name);
  const exit = exitToken(n);
  if (exit !== null) sink.exit.push(exit);
  const fn = declaredFunctionName(n);
  if (fn !== null) bump(sink.declared, fn);
}

/** 收单个节点的记号与计数（遍历骨架见 walk）。 */
function harvest(n: AstNode, sink: Collected): void {
  const lit = literalOrRegexToken(n);
  if (lit !== null) {
    sink[lit.facet].push(lit.token);
    return;
  }
  if (n.type === "Property" && n.computed !== true) {
    const tok = keyToken(n);
    if (tok !== null) sink.key.push(tok);
    return;
  }
  harvestNames(n, sink);
}

/** 直接子节点。位置字段与正则对象不是节点，必须靠 NON_CHILD_KEYS 挡掉。 */
function childNodes(n: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const k of Object.keys(n)) {
    if (NON_CHILD_KEYS.has(k)) continue;
    const v: unknown = n[k];
    if (Array.isArray(v)) {
      for (const c of v) out.push(c as AstNode);
      continue;
    }
    if (v !== null && typeof v === "object" && typeof (v as AstNode).type === "string") {
      out.push(v as AstNode);
    }
  }
  return out;
}

/** 遍历 AST 的计数骨架。 */
function walk(n: AstNode, sink: Collected): void {
  if (n === null || typeof n !== "object" || typeof n.type !== "string") return;
  sink.nodeCount += 1;
  harvest(n, sink);
  for (const c of childNodes(n)) walk(c, sink);
}

/** 解析并抽取一个源码文本。loader 决定 esbuild 的剥类型面（ts / tsx / js）。 */
function collectSource(src: string, loader: "ts" | "tsx" | "js"): Collected {
  const sink = emptyCollected();
  let program: AstProgram;
  try {
    program = parseTs(src, loader);
  } catch (e) {
    throw new InputError("解析失败：" + String((e as Error).message).split("\n")[0]);
  }
  walk(program as unknown as AstNode, sink);
  return sink;
}
/* --------------------------------- git 读取面 -------------------------------- */

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new InputError(
      "git " + args.join(" ") + " 失败：" + String((e as Error).message).split("\n")[0],
    );
  }
}

/** ref 必须能解析到 commit——读不到即输入错误，不当「无差异」放行（fail-closed）。 */
function assertRef(ref: string): void {
  try {
    execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], { stdio: "ignore" });
  } catch {
    throw new InputError("ref 不存在或不可解析为 commit：" + ref);
  }
}

/**
 * 该 ref 上是否存在这个路径。
 * 为什么用 ls-tree 而不是 cat-file -e：后者在「路径不存在」与「git 侧任何异常」时都是同一个
 * 非零退出码，catch 后一律 return false 就把 git 故障退化成了「整文件增删」差异项（判红而非
 * exit 2），与本文件「读不到即输入错误 fail-closed」的自述矛盾。ls-tree 在路径不存在时输出空
 * 且退出码为 0，只有 git 真出问题时才非零，于是异常经 git() 抛成 InputError → exit 2。
 */
function existsAtRef(ref: string, path: string): boolean {
  return git(["ls-tree", "--name-only", ref, "--", path]).trim() !== "";
}

function readAtRef(ref: string, path: string): string {
  return git(["show", ref + ":" + path]);
}

/** 源码面后缀 → esbuild loader。非源码面（本工具解不了）返回 null。 */
function loaderOf(path: string): "ts" | "tsx" | "js" | null {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? null : (LOADER_BY_EXT[path.slice(dot)] ?? null);
}

/* ------------------------------- 差集与两个专项 ------------------------------ */

function multiset(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of list) bump(m, x);
  return m;
}

/** 多重集差集：head − base，逐值给出计数差（0 视为无差异，不出条目）。 */
function facetDiff(path: string, facet: Facet, base: string[], head: string[]): Entry[] {
  const b = multiset(base);
  const h = multiset(head);
  const out: Entry[] = [];
  for (const v of new Set([...b.keys(), ...h.keys()])) {
    const delta = (h.get(v) ?? 0) - (b.get(v) ?? 0);
    if (delta !== 0) out.push({ path, facet, value: v, delta });
  }
  return out;
}

/**
 * 专项⑤：数字字面量**整段消失**（base 有、head 计数归零）。
 * 为什么单独成类、且不因登记 literal 就被豁免：它对应「丢上界 / 阈值」这类回归，而
 * 这类改动往往只动一个数字，在上千条字面量里极易翻页漏看。
 */
function droppedNumbers(path: string, base: string[], head: string[]): Entry[] {
  const h = multiset(head);
  const out: Entry[] = [];
  for (const [v, n] of multiset(base)) {
    if (!v.startsWith("num:")) continue;
    if ((h.get(v) ?? 0) === 0) out.push({ path, facet: "number-lost", value: v, delta: -n });
  }
  return out;
}

/**
 * 专项⑥：**新增**函数在改动侧的引用数为 0（声明点之外再无出现）。
 * 为什么只查新增：存量里的孤儿函数是既有事实，不该由一次等价重构来背锅。
 * 口径边界：引用数是上界——同名标识符若恰好落在对象键 / 属性名位置会被一并计入，故本
 * 本项偏保守（可能漏报，不会误报）。
 */
function orphanFunctions(path: string, base: Collected, head: Collected): Entry[] {
  const out: Entry[] = [];
  for (const [name, declCount] of head.declared) {
    if (base.declared.has(name)) continue;
    if ((head.identifiers.get(name) ?? 0) > declCount) continue;
    out.push({ path, facet: "function-orphan", value: "fn:" + name, delta: 1 });
  }
  return out;
}

/** 单个文件的全部差异项（整文件增删各算一条 file 差异）。 */
function entriesOfFile(path: string, base: Collected | null, head: Collected | null): Entry[] {
  if (base === null) return [{ path, facet: "file", value: "added", delta: 1 }];
  if (head === null) return [{ path, facet: "file", value: "removed", delta: -1 }];
  return [
    ...facetDiff(path, "literal", base.literal, head.literal),
    ...facetDiff(path, "key", base.key, head.key),
    ...facetDiff(path, "regex", base.regex, head.regex),
    ...facetDiff(path, "exit", base.exit, head.exit),
    ...droppedNumbers(path, base.literal, head.literal),
    ...orphanFunctions(path, base, head),
  ];
}

/* ---------------------------------- 登记表 ---------------------------------- */

function entryKey(e: Entry): string {
  return e.path + "\u0000" + e.facet + "\u0000" + e.value + "\u0000" + String(e.delta);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** 单条登记项校验：字段缺一即 exit 2——登记表坏了不能降级成「未登记」或「放行」。 */
function parseItem(
  raw: unknown,
  base: Omit<RegistryEntry, "value" | "delta">,
  where: string,
): RegistryEntry {
  if (!isRecord(raw)) throw new InputError(where + " 不是对象");
  if (!nonEmptyString(raw.value)) throw new InputError(where + " 缺 value");
  const delta = raw.delta;
  if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
    throw new InputError(where + " 的 delta 必须是非零整数：" + String(delta));
  }
  return { path: base.path, facet: base.facet, value: raw.value, delta, reason: base.reason };
}

/** 登记组校验：path / facet / reason / items 缺一即 exit 2。 */
function parseGroup(raw: unknown, where: string): RegistryEntry[] {
  if (!isRecord(raw)) throw new InputError(where + " 不是对象");
  if (!nonEmptyString(raw.path)) throw new InputError(where + " 缺 path");
  if (!nonEmptyString(raw.facet) || !FACETS.includes(raw.facet as Facet)) {
    throw new InputError(
      where + " 的 facet 非法：" + String(raw.facet) + "（取值 " + FACETS.join("/") + "）",
    );
  }
  if (!nonEmptyString(raw.reason))
    throw new InputError(where + " 缺理由（§4.1 要求登记并写明理由）");
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new InputError(where + " 的 items 必须是非空数组");
  }
  const head = { path: raw.path, facet: raw.facet as Facet, reason: raw.reason };
  return raw.items.map((it, i) => parseItem(it, head, where + ".items[" + i + "]"));
}

function findDuplicate(entries: RegistryEntry[]): RegistryEntry | null {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(entryKey(e))) return e;
    seen.add(entryKey(e));
  }
  return null;
}

/** 展开一张登记表。重复登记同一条差异即 exit 2——两份理由指向同一事实，判词不自洽。 */
function expandRegistry(raw: unknown, where: string): RegistryEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.groups)) throw new InputError(where + " 缺 groups 数组");
  const out = raw.groups.flatMap((g, i) => parseGroup(g, where + " groups[" + i + "]"));
  const dup = findDuplicate(out);
  if (dup !== null)
    throw new InputError(where + " 重复登记：" + dup.path + " / " + dup.facet + " / " + dup.value);
  return out;
}

/** 读登记表。坏表是输入错误（exit 2），不是「未登记」（exit 1）——两者不可互相退化。 */
function loadRegistry(file: string): RegistryEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new InputError("登记表不可读：" + file);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new InputError("登记表不是合法 JSON：" + String((e as Error).message).split("\n")[0]);
  }
  return expandRegistry(data, file);
}

/**
 * 差异 × 登记表求交。返回三分：已登记 / 未登记（判红）/ 登记失效（判红）。
 * 「登记失效」= 表里写了、这次却没测到——#843 的反向腐烂口径：不登记会漏掉本该被看见的差异，
 * 登记了却没发生同样说明这张表已经和现实脱节，两者都要红。
 */
function matchRegistry(
  entries: Entry[],
  registry: RegistryEntry[],
): { registered: Entry[]; unregistered: Entry[]; stale: RegistryEntry[] } {
  const index = new Map(registry.map((r) => [entryKey(r), r] as const));
  const registered: Entry[] = [];
  const unregistered: Entry[] = [];
  for (const e of entries) {
    if (index.has(entryKey(e))) registered.push(e);
    else unregistered.push(e);
  }
  const hit = new Set(registered.map(entryKey));
  return { registered, unregistered, stale: registry.filter((r) => !hit.has(entryKey(r))) };
}
/* ------------------------------------ CLI ----------------------------------- */

interface Options {
  base: string;
  head: string;
  paths: string[];
  allow: string | null;
  json: boolean;
  help: boolean;
}

interface FileReport {
  path: string;
  nodes: number;
}

interface Report {
  tool: string;
  boundary: string;
  base: string;
  head: string;
  facets: readonly string[];
  files: FileReport[];
  skipped: string[];
  registered: Entry[];
  unregistered: Entry[];
  stale: RegistryEntry[];
  counts: {
    files: number;
    skipped: number;
    nodes: number;
    differences: number;
    registered: number;
    unregistered: number;
    stale: number;
  };
  exit: 0 | 1;
}

/** 文本输出里未登记差异最多列这么多条，其余走 --json（防刷屏淹没判词）。 */
const PRINT_LIMIT = 40;

const USAGE = [
  "用法：",
  "  node scripts/maintenance/equiv-check.ts --base <ref> --head <ref> [选项]",
  "",
  "选项：",
  "  --base <ref>   基线 ref（必填，须能解析为 commit）",
  "  --head <ref>   改动 ref（必填）",
  "  --path <p>     只比对该路径，可重复；缺省 = base..head 之间改动的全部源码文件",
  "  --allow <f>    登记表（JSON）。未登记差异即 exit 1；登记项在本次没测到同样 exit 1",
  "  --json         机器可读输出（单对象 JSON 走 stdout，诊断走 stderr）",
  "  --help         打印本帮助",
  "",
  "比对内容：字面量 / 非计算对象键 / 正则字面量 / process.exit(n) 与 process.exitCode = n 的",
  "多重集差集，外加 DEVELOPMENT §4.1 点名的两个专项（数字字面量整段消失、新增函数零引用）。",
  "",
  "退出码：",
  "  0  比对完成，无未登记差异",
  "  1  存在未登记差异（或登记项已失效）——判红可信",
  "  2  环境或输入错误：ref 不存在 / 文件读不到 / 解析失败 / 登记表本身坏了",
  "     纯文档 diff（比对面没有源码文件）也走 2，属预期：它既不是判红，也不是门禁故障",
  "",
  "它做什么 / 不做什么（请连同下面的边界声明一起读）：",
  "  做——把两侧记号多重集的差集抽出来，再拿登记表逐条对账：对得上 exit 0，对不上 exit 1；",
  "  不做——不校验理由的**类别**：理由是否落在 §4.1 允许的两类内由人负责，逐条填 TODO 也能过；",
  "  不做——**不对「差异是否无害」作任何判定**，那是 §4.1 第 3 件差分对拍的活。",
  "",
  BOUNDARY,
  "",
].join("\n");

/** 取值型开关分发表（表驱动，避免一条链 if 顶穿复杂度阈值）。 */
const VALUE_FLAGS: Record<string, (o: Options, v: string) => void> = {
  "--base": (o, v) => {
    o.base = v;
  },
  "--head": (o, v) => {
    o.head = v;
  },
  "--path": (o, v) => {
    o.paths.push(v);
  },
  "--allow": (o, v) => {
    o.allow = v;
  },
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { base: "", head: "", paths: [], allow: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
      continue;
    }
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    const setter = VALUE_FLAGS[a];
    if (setter === undefined) throw new InputError("未知参数：" + a);
    const value = argv[i + 1];
    if (value === undefined) throw new InputError(a + " 缺取值");
    setter(opts, value);
    i += 1;
  }
  return opts;
}

/** base..head 之间改动的文件（--no-renames：改名按增删两条如实报，不折叠）。 */
function changedPaths(base: string, head: string): string[] {
  return git(["diff", "--name-only", "--no-renames", base, head])
    .split("\n")
    .filter((line) => line !== "");
}

/** 比对面：显式 --path 时不做扩展过滤（非源码面直接 exit 2），缺省时跳过非源码面。 */
function resolveScope(opts: Options): { paths: string[]; skipped: string[] } {
  if (opts.paths.length > 0) {
    for (const p of opts.paths) {
      if (loaderOf(p) === null) throw new InputError("--path 指向非源码面（本工具解不了）：" + p);
    }
    return { paths: opts.paths, skipped: [] };
  }
  const paths: string[] = [];
  const skipped: string[] = [];
  for (const p of changedPaths(opts.base, opts.head)) {
    (loaderOf(p) === null ? skipped : paths).push(p);
  }
  if (paths.length === 0) {
    // docs-only diff 是正常输入，不是判红也不是门禁故障：显式把 exit 2 说成预期，
    // 免得它被按 AGENTS.md 的「exit 2 = 门禁故障不可信 ⇒ 禁止合并」读成熔断信号。
    throw new InputError(
      "比对面为空：base..head 之间没有可解析的源码文件（纯文档 / 数据 diff 属正常输入，" +
        "本工具对此无话可说，exit 2 是预期结果，不是判红也不是门禁故障）",
    );
  }
  return { paths, skipped };
}

/** 某一侧（ref）的抽取结果；该 ref 上没有这个文件时为 null（= 整文件增删）。 */
function loadSide(ref: string, path: string): Collected | null {
  const loader = loaderOf(path);
  if (loader === null || !existsAtRef(ref, path)) return null;
  try {
    return collectSource(readAtRef(ref, path), loader);
  } catch (e) {
    throw new InputError(ref + ":" + path + " —— " + (e as Error).message);
  }
}

function check(opts: Options): Report {
  if (opts.base === "" || opts.head === "") throw new InputError("--base 与 --head 都是必填");
  assertRef(opts.base);
  assertRef(opts.head);
  const registry = opts.allow === null ? [] : loadRegistry(opts.allow);
  const scope = resolveScope(opts);
  const entries: Entry[] = [];
  const files: FileReport[] = [];
  let nodes = 0;
  for (const path of scope.paths) {
    const base = loadSide(opts.base, path);
    const head = loadSide(opts.head, path);
    entries.push(...entriesOfFile(path, base, head));
    const side = head ?? base;
    files.push({ path, nodes: side === null ? 0 : side.nodeCount });
    nodes += side === null ? 0 : side.nodeCount;
  }
  const m = matchRegistry(entries, registry);
  return {
    tool: "equiv-check",
    boundary: BOUNDARY,
    base: opts.base,
    head: opts.head,
    facets: FACETS,
    files,
    skipped: scope.skipped,
    registered: m.registered,
    unregistered: m.unregistered,
    stale: m.stale,
    counts: {
      files: files.length,
      skipped: scope.skipped.length,
      nodes,
      differences: entries.length,
      registered: m.registered.length,
      unregistered: m.unregistered.length,
      stale: m.stale.length,
    },
    exit: m.unregistered.length > 0 || m.stale.length > 0 ? 1 : 0,
  };
}

function facetCounts(entries: Entry[]): string {
  return FACETS.map((f) => f + "=" + entries.filter((e) => e.facet === f).length).join("  ");
}

function signed(n: number): string {
  return n > 0 ? "+" + String(n) : String(n);
}

function renderText(r: Report): string {
  const all = [...r.registered, ...r.unregistered];
  const lines: string[] = [];
  lines.push("[equiv] " + r.boundary);
  lines.push(
    "[equiv] 基线 " +
      r.base +
      " → 改动 " +
      r.head +
      "；比对面 " +
      r.counts.files +
      " 个文件" +
      "（AST 节点合计 " +
      r.counts.nodes +
      "，跳过非源码面 " +
      r.counts.skipped +
      " 个）",
  );
  lines.push("[equiv] 差异项 " + r.counts.differences + " 条  " + facetCounts(all));
  lines.push(
    "[equiv] 已登记 " +
      r.counts.registered +
      "，未登记 " +
      r.counts.unregistered +
      "，登记失效 " +
      r.counts.stale,
  );
  for (const e of r.unregistered.slice(0, PRINT_LIMIT)) {
    lines.push(
      "[equiv]   未登记  " + e.path + "  " + e.facet + "  " + signed(e.delta) + "  " + e.value,
    );
  }
  if (r.unregistered.length > PRINT_LIMIT) {
    lines.push("[equiv]   …… 其余 " + (r.unregistered.length - PRINT_LIMIT) + " 条见 --json");
  }
  for (const s of r.stale) {
    lines.push(
      "[equiv]   登记失效  " + s.path + "  " + s.facet + "  " + signed(s.delta) + "  " + s.value,
    );
  }
  lines.push("[equiv] 结论：" + verdictText(r));
  return lines.join("\n");
}

function verdictText(r: Report): string {
  if (r.exit === 0) return "0 条未登记差异。仍需 §4.1 第 3 件的差分对拍才能声称行为等价。";
  return (
    r.counts.unregistered +
    " 条未登记差异" +
    (r.counts.stale > 0 ? " + " + r.counts.stale + " 条登记失效" : "") +
    "：要么改回去，要么逐条登记并写明理由（--allow <登记表>）"
  );
}

/** exit 2 专用出口：诊断走 stderr，判词与判红（exit 1）在日志上必须可区分。 */
function failInput(e: unknown): number {
  const why = e instanceof InputError ? e.message : String((e as Error)?.message ?? e);
  process.stderr.write("[equiv] 输入 / 环境错误（exit 2，非判据结论）：" + why + "\n");
  return 2;
}

function main(argv: string[]): number {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    return failInput(e);
  }
  if (opts.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  try {
    const report = check(opts);
    process.stdout.write((opts.json ? JSON.stringify(report, null, 2) : renderText(report)) + "\n");
    return report.exit;
  } catch (e) {
    return failInput(e);
  }
}

export type { Entry, Facet, FileReport, Options, RegistryEntry, Report };
export {
  BOUNDARY,
  FACETS,
  USAGE,
  check,
  collectSource,
  droppedNumbers,
  entriesOfFile,
  facetDiff,
  matchRegistry,
  multiset,
  orphanFunctions,
  parseArgs,
  renderText,
};

// CLI 守卫：被 import 时（argv[1] 不是本文件）不执行 main，便于复用纯函数。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
