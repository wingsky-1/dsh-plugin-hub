/**
 * scripts/lib/gate-wiring-lib.ts — 「判据接线」断言的**判定层**（审计 P0-1）。
 *
 * 为什么独立成库：这里放的是断言的说服力所在（「怎样才算同一个判据」「什么条件下算恒假」），
 * 原先写在测试文件里——而写测试的文件本身没有独立单测，逻辑改错只会表现为「断言变绿」。
 * 分层：逻辑在本库（scripts/test/gate-wiring-lib.test.ts 单测），仓库实例化在测试文件；
 * 凡需要「当前这个仓库」才有意义的量（执行点全集、判据全集、可达库闭包）一律参数注入，
 * 故本库不 import 任何仓库状态。
 */
import { createHash } from "node:crypto";
import { dirname, join, normalize } from "node:path";

import { parseTs } from "./config-matrix-lib.ts";
import { walkFiles } from "./walk-files.ts";
import {
  embeddedExecutions,
  endpointOf,
  endpointSet,
  envLayers,
  extractJobIf,
  extractJobs,
  extractLefthookSteps,
  extractRunSteps,
  jobLevelFace,
  unwrapDeadBranch,
  usesSteps,
} from "./gate-endpoints.mjs";

export type Endpoint = { kind: string; id: string };
export type PlanStep = { label: string; cmd?: string; args: string[] };
export type Scripts = Record<string, string>;

/** 端点键是否算「判据」：脚手架（shell）与未归一（unknown/alias/pkg-filter）都不是。 */
export function isJudgment(key: string): boolean {
  return key.startsWith("script:") || key.startsWith("tool:");
}

/** 锚定在仓库内的目录遍历：返回 `<dir>/<相对路径>` 形态（/ 分隔）。 */
export function walkRepo(
  root: string,
  dir: string,
  predicate: (name: string) => boolean,
): string[] {
  return walkFiles(join(root, dir), predicate).map((rel) => dir + "/" + rel);
}

/**
 * 条件表达式是否恒为常量（恒真或恒假）。
 *
 * 用**白名单**而不是枚举黑名单：合法条件必须引用运行时上下文（github / needs / steps / …）
 * 或 GHA 内建函数（always / success / hashFiles / format / join / toJSON / contains …），一个
 * 都不沾的必然是常量。少列一个内建函数就是一次**死锁**——合法条件被判成常量，而 stepIfs
 * 要求带 if 的步骤逐字登记、又拒绝常量条件，该写法就没有出口（独立复核实测 hashFiles /
 * format 两例）。白名单之下再补两条静态可判的恒假形态：自比（`A != A`）与同一 `||` 分支内
 * 的矛盾合取。
 */
const CONDITION_CONTEXTS =
  /\b(?:github|needs|matrix|env|steps|runner|inputs|vars|job|secrets)\b|\b(?:always|success|failure|cancelled|hashFiles|format|join|toJSON|fromJSON|contains|startsWith|endsWith)\s*\(/;

export function isConstantCondition(condition: string): boolean {
  const c = String(condition ?? "").trim();
  if (!CONDITION_CONTEXTS.test(c)) return true;
  // 自比：`github.event_name != github.event_name` 恒假、`==` 恒真——「提到上下文」这一条
  // 白名单拦不住它（复核实测）。比较两侧字面同形即判常量。
  for (const m of c.matchAll(/([\w.$[\]"\']+)\s*(?:===|==|!==|!=)\s*([\w.$[\]"\']+)/g)) {
    if (m[1] === m[2]) return true;
  }
  // 矛盾合取：逐个「或」分支看该分支内部是否自相矛盾。
  // 为什么按 || 分支而不是「整体含 || 就跳过」：`A || B` 里 A 与 B 各取一个值并不矛盾，但
  // `(A && B) || false` 的矛盾藏在第一个分支里，整体带 || 就跳过检测会漏（复核实测两种写法
  // 都能让判据在 CI 永不执行）。同时收 == 与 !=，`!= x && == x` 也自相矛盾。
  for (const alt of c.split("||")) {
    const eq = new Map<string, Set<string>>();
    const ne = new Map<string, Set<string>>();
    for (const m of alt.matchAll(/([\w.$]+)\s*(==|!=)\s*([\x27"][^\x27"]*[\x27"])/g)) {
      const target = m[2] === "==" ? eq : ne;
      const set = target.get(m[1]) ?? new Set<string>();
      set.add(m[3]);
      target.set(m[1], set);
    }
    for (const [key, set] of eq) {
      if (set.size > 1) return true;
      const negs = ne.get(key);
      if (negs !== undefined && [...negs].some((v) => set.has(v))) return true;
    }
  }
  return false;
}

/**
 * 步骤键：`<workflow 文件名>|<作业名>|<该步骤的判据身份集合（排序去重）>`。
 *
 * 身份用**完整身份**（含判据面摘要）：否则同一脚本的两个调用点（3 包硬判 / provider-usage
 * --soft）会共用一个键，一条登记同时豁免两条。
 * 带文件名是因为不同 workflow 可以有同名 job。不用步骤名或下标：下标随任何插入失效，步骤名
 * 与「这一步在判什么」无关，而判据集合恰好就是「这一步在判什么」——集合一变登记即悬空，步骤
 * 内部多写一行则由逐行形态检查与文本摘要接管。进程替换里的执行位也算判据。
 */
export function stepKeyOf(scripts: Scripts, file: string, job: string, cmds: string[]): string {
  const paths = [...new Set(cmds.flatMap((c) => judgmentPathsOf(scripts, c)))].sort();
  return [file, job, paths.join(",")].join("|");
}

/** 一条命令里出现的判据身份（完整端点键 + 进程替换等内部执行位）。 */
function judgmentPathsOf(scripts: Scripts, command: string): string[] {
  const out: string[] = [];
  const ep = endpointOf(command, scripts);
  if (ep !== null && isJudgment(ep.kind + ":" + ep.id)) out.push(ep.kind + ":" + ep.id);
  for (const path of embeddedExecutions(command)) out.push("script:" + path);
  return out;
}

/**
 * 把 run 步骤按 stepIndex 归组：恒假分支、set +e 这类语义单位是**步骤**而不是行。
 * 逐行判定会让守卫永远够不着——`if false; then` 是脚手架行、被判据行落在另一条 cmd 上，
 * 于是「判据在死分支里」这件事在两行里各看不见一半（复核实测：守卫 101/101 不可达）。
 */
export type StepShape = {
  cmds: string[];
  key: string;
  /** 步骤级 `shell:` 覆盖（null = 用 GHA 默认的 bash -e {0}）。 */
  shell: string | null;
  /** 步骤级 `working-directory:`（null = 用仓库根）：它决定命令在哪个目录里跑，故也算「命令的一部分」。 */
  workingDirectory: string | null;
  /** 步骤级 `if:` 原文（null = 无条件）。**没有它就看不出「这一步永不执行」**。 */
  ifCond: string | null;
  /** `continue-on-error` 是否生效（非显式 false 即算生效）。 */
  continueOnError: boolean;
  /** 该步骤 `run:` 的**原始逻辑行**（含注释与 `#` 文本，续行已按 bash 语义拼接）：文本摘要与 `#` 兜底都基于它。 */
  rawLines: string[];
  /** 步骤 `id:`（登记条件里的 `steps.<id>.outputs.<name>` 靠它反查产出步骤）。 */
  id: string | null;
  /** 步骤名（`name:` 原文；前序步骤的登记键 `<file>|<job>|<name>` 用它）。 */
  name: string | null;
  /** 步骤级 `env:` 的键名（值随事件变化，故只钉「有没有这个键」）。 */
  envKeys: string[];
  /** 解析层白名单之外的键：可能是一个没被建模的静默开关。 */
  unknownKeys: string[];
};

export function stepsOf(
  yamlText: string,
  file: string,
  job: string,
  scripts: Scripts,
): StepShape[] {
  // 有效 env = workflow 级 ∪ job 级 ∪ 步骤级：三层都作用于这一步，只看步骤级会漏掉"挂在 job 或
  // workflow 上的一行 env"（对抗复核实测的两条绕过）。
  const layers = envLayers(yamlText, job);
  const byIndex = new Map<number, Omit<StepShape, "key">>();
  for (const s of extractRunSteps(yamlText, job)) {
    const rec =
      byIndex.get(s.stepIndex) ??
      ({
        cmds: [],
        shell: null,
        workingDirectory: null,
        ifCond: null,
        continueOnError: false,
        rawLines: [],
        id: null,
        name: null,
        envKeys: [],
        unknownKeys: [],
      } as Omit<StepShape, "key">);
    rec.cmds.push(s.cmd);
    rec.shell = s.shell ?? null;
    rec.workingDirectory = s.workingDirectory ?? null;
    rec.ifCond = s.ifCond ?? null;
    rec.continueOnError = s.continueOnError === true;
    rec.rawLines = s.rawLines ?? [];
    rec.id = s.id ?? null;
    rec.name = s.name ?? null;
    rec.envKeys = [
      ...new Set([...(s.envKeys ?? []), ...layers.job, ...layers.container, ...layers.workflow]),
    ].sort();
    rec.unknownKeys = s.unknownKeys ?? [];
    byIndex.set(s.stepIndex, rec);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, rec]) => ({ ...rec, key: stepKeyOf(scripts, file, job, rec.cmds) }));
}

/**
 * 步骤里出现的判据端点键（含藏在进程替换里的执行位）。
 * `unwrap` 为真时先剥掉恒假分支的壳——死代码要能先被认出来，否则「文本上写着会跑」与
 * 「真的会跑」在执行点清单里没有区别。
 */
export function judgmentKeysIn(scripts: Scripts, cmds: string[], unwrap: boolean): string[] {
  const probe = unwrap ? cmds.map(unwrapDeadBranch) : cmds;
  const out = new Set<string>();
  for (const raw of probe) for (const key of judgmentPathsOf(scripts, raw)) out.add(key);
  return [...out].sort();
}

/** 去掉脚本扩展名，用于「基线名 → 仓库路径」的索引。 */
export function stripExt(p: string): string {
  return p.replace(/\.(mjs|cjs|ts)$/, "");
}

/** AST 里的一条**模块求值边**：静态 import / export-from / export * from。 */
export type ModuleEdge = { source: string; locals: string[] };

/**
 * 递归收集 AST 里的**模块求值边**说明符。
 *
 * 刻意不收动态 import()：它只能证明「某个不可达的地方写了它」，把它算成「有人依赖它」是一条
 * 洗白路径（复核实测）。库判定问的是「它会被加载吗」。
 */
export function collectSpecifiers(node: unknown, out: ModuleEdge[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectSpecifiers(item, out);
    return;
  }
  const rec = node as Record<string, unknown>;
  const type = rec.type;
  if (
    type === "ImportDeclaration" ||
    type === "ExportNamedDeclaration" ||
    type === "ExportAllDeclaration"
  ) {
    const src = rec.source as { value?: unknown } | undefined;
    if (typeof src?.value === "string") {
      // 具名 import 记下本地绑定名；`import "./x.mjs"` 这种纯副作用 import 没有绑定。
      const locals: string[] = [];
      for (const spec of (rec.specifiers as { local?: { name?: unknown } }[]) ?? []) {
        if (typeof spec?.local?.name === "string") locals.push(spec.local.name);
      }
      out.push({ source: src.value, locals });
    }
  }
  for (const [key, value] of Object.entries(rec)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    collectSpecifiers(value, out);
  }
}

/** 递归收集某个 AST 子树里的全部字符串字面量。 */
export function collectStringLiterals(node: unknown, out: string[]): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectStringLiterals(item, out);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (rec.type === "Literal" && typeof rec.value === "string") out.push(rec.value);
  for (const [key, value] of Object.entries(rec)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    collectStringLiterals(value, out);
  }
}

/**
 * 收集 spawnSync / execFileSync 的**数组形态 argv 字面量**（路径）。
 *
 * 走 AST 而不是正则：注释与模板字符串里的路径能满足「附近出现过该路径」的正则写法，而那正是
 * 这条断言此前被抓到的假证据来源；只认数组形态则不把 `spawnSync("node", "路径")` 这种运行期
 * 会 TypeError 的废调用当成证据（复核实测两种形状）。
 */
export function spawnTargets(text: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (rec.type === "CallExpression") {
      const callee = rec.callee as { name?: unknown } | undefined;
      if (callee?.name === "spawnSync" || callee?.name === "execFileSync") {
        for (const arg of (rec.arguments as Record<string, unknown>[]) ?? []) {
          if (arg?.type === "ArrayExpression") collectStringLiterals(arg, out);
        }
      }
    }
    for (const [key, value] of Object.entries(rec)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      walk(value);
    }
  };
  walk(parseTs(text, "ts"));
  return out;
}

/**
 * 该文件 import 到的 **scripts/gate 内** 的模块（自引用不算）。四重收紧扣着四类洗白路径：
 *   1. 只在判据全集内部建边——外部文件没有执行点，它的一句 import 不证明任何东西；
 *   2. 用 AST 扫说明符——正则剥注释却不剥字符串，模板字符串里写一行 import 就能造出假依赖；
 *   3. `import type` 不算——esbuild 转译时本就丢弃，不构成运行期依赖；
 *   4. import 必须**具名且该名字在文件里被引用**——纯副作用 import 是一张免死金牌。
 * 残留边界：仍是语法级判定，不证明目标脚本的判据入口会被执行（彻底闭合需要调用图）。
 */
export function importedGateTargets(
  file: string,
  text: string,
  gateByBase: Map<string, string>,
): string[] {
  const ast = parseTs(text, file.endsWith(".ts") ? "ts" : "js") as { body: unknown };
  const edges: ModuleEdge[] = [];
  collectSpecifiers(ast.body, edges);
  const hit: string[] = [];
  for (const edge of edges) {
    if (!edge.source.startsWith(".")) continue;
    if (edge.locals.length === 0) continue;
    if (
      !edge.locals.some(
        (name) => (text.match(new RegExp("\\b" + name + "\\b", "g")) ?? []).length > 1,
      )
    ) {
      continue;
    }
    const resolved = stripExt(normalize(join(dirname(file), edge.source)));
    const target = gateByBase.get(resolved);
    if (target !== undefined && target !== file) hit.push(target);
  }
  return hit;
}

/**
 * 执行点全集 E：全部 workflow 的全部 job ∪ 本地 pr/full 档 ∪ lefthook。
 *
 * 为什么收全部 workflow 与 lefthook：判据不只活在 repo-gate（observe / release /
 * baseline-overlay / health-report 各有执行点），只看一处时脚本会「看起来没有任何执行点」。
 * 除端点身份外还收命令内部的执行位（进程替换）：release 的
 * `done < <(node scripts/release/publish-if-missing.ts)` 主身份是 shell:done。
 *
 * **只收活的执行点**：恒假条件（`if: false` / `if: ${{ 0 }}`）下的步骤与 job 一律不算，否则一个
 * decoy 步骤就能顶替被删掉的判据（对抗复核实测）。`if: <提到上下文但永不成立>` 这类静态判不出，
 * 由 stepIfs / jobIfs 的逐字登记兜住，不靠这里。
 */
export function collectExecutionPoints({
  workflowTexts,
  scripts,
  localEndpoints,
  lefthookText,
}: {
  workflowTexts: string[];
  scripts: Scripts;
  localEndpoints: (tier: string) => Map<string, Endpoint>;
  lefthookText: string;
}): Map<string, Endpoint> {
  const out = new Map<string, Endpoint>();
  for (const text of workflowTexts) {
    for (const job of extractJobs(text)) {
      if (isDeadCondition(extractJobIf(text, job))) continue;
      for (const step of extractRunSteps(text, job)) {
        if (isDeadCondition(step.ifCond)) continue;
        const ep = endpointOf(step.cmd, scripts);
        if (ep !== null && ep.kind !== "shell") out.set(ep.kind + ":" + ep.id, ep);
        for (const path of embeddedExecutions(step.cmd)) {
          out.set("script:" + path, { kind: "script", id: path });
        }
      }
    }
  }
  for (const tier of ["pr", "full"]) {
    for (const [key, ep] of localEndpoints(tier)) out.set(key, ep);
  }
  const lefthookCmds = extractLefthookSteps(lefthookText).map((s) => s.cmd);
  for (const [key, ep] of endpointSet(lefthookCmds, scripts)) out.set(key, ep);
  return out;
}

/**
 * 一个 if 条件是否**恒假**（恒真也算：它在每种事件下都跑，同样不是闸的常态）。
 * 恒真与恒假只差一个字，登记制下两者都被 stepIfs / jobIfs 逐字钉住；这里只负责把死代码从
 * 执行点全集里剔掉。
 */
export function isDeadCondition(condition: string | null | undefined): boolean {
  return condition !== null && condition !== undefined && isConstantCondition(String(condition));
}

/**
 * 已登记判据步骤的**文本摘要**（按行归一：去行尾空白、丢空行，与解析层切行口径一致）。
 *
 * 为什么光有步骤键不够：键只钉住「这一步有哪些判据」，脚手架行不进键——一行 `break` /
 * `continue` 就能让循环里剩下的判据不再执行，而键、执行点、两侧身份全不变（对抗复核实测全绿）。
 * 多命令步骤无法用「单命令闭合」约束，故改为**文本钉死**：任何一行改动都必须在台账里显式更新
 * 摘要，与 stepIfs / jobIfs 同一套思路。
 */
export function stepDigest(cmds: string[]): string {
  const normalized = cmds.map((c) => String(c).trimEnd()).filter((c) => c.trim() !== "");
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 16);
}

/**
 * 执行点全集里出现过的**全部**脚本路径（是不是判据由调用方拿判据全集求交）。
 * 必须取路径段而不是整串键：同一脚本的多个调用点按 --package 值集合区分身份（verify-dir-imports
 * 的 3 包硬判与 provider-usage --soft），整串比对会把它们全判成「没有执行点」——那是误红。
 */

/**
 * 判据 job 的**环境面**：判据步骤之前的每一个非判据 run 步骤。
 *
 * 为什么按**位置**而不是按字样：写 `$GITHUB_ENV` / `$GITHUB_PATH` 只是改变后续步骤环境的一种写法，
 * 名字匹配总有绕法——`D=$(ls /home/runner/work/_temp/_runner_file_commands/set_env_* | head -1)` 里
 * 没有 `GITHUB_` / `RUNNER_TEMP` / `printenv` 任何一个字样，`D=$(node -e 'console.log(process.env["GITHUB"+"_ENV"])')`
 * 也一样（两条对抗复核实测全绿）。判据能读到的环境只可能由它前面的步骤建立，于是「判据 job 里、最后一条
 * 判据步骤之前的非判据 run 步骤」是一个**闭合集合**，集合外的写法不存在。
 */
export function priorRunStepsOf(
  yamlText: string,
  file: string,
  job: string,
  scripts: Scripts,
): { key: string; digest: string; envKeys: string[] }[] {
  const steps = stepsOf(yamlText, file, job, scripts);
  const isJudgment = steps.map((s) => judgmentKeysIn(scripts, s.cmds, true).length > 0);
  const last = isJudgment.lastIndexOf(true);
  const out: { key: string; digest: string; envKeys: string[] }[] = [];
  for (let i = 0; i <= last; i++) {
    if (isJudgment[i] === true) continue;
    const step = steps[i];
    out.push({
      key: [file, job, step.name ?? step.id ?? `step-${i}`].join("|"),
      digest: priorStepDigest(step),
      envKeys: [...step.envKeys].sort(),
    });
  }
  return out;
}

/**
 * 前序步骤的**整步**摘要：文本行 + `if` / `continue-on-error` / `shell` / env 键 / 白名单外的键一起进。
 * 只钉 `run:` 文本时，给这一步加 `continue-on-error: true` 或 `if: false` 仍是零台账改动的静默开关。
 */
function priorStepDigest(step: StepShape): string {
  return stepDigest([
    ...step.rawLines,
    `if=${step.ifCond ?? ""}`,
    `continue-on-error=${String(step.continueOnError)}`,
    `shell=${step.shell ?? ""}`,
    `workdir=${step.workingDirectory ?? ""}`,
    `env=${[...step.envKeys].sort().join(",")}`,
    `unknown=${[...step.unknownKeys].sort().join(",")}`,
  ]);
}

/**
 * 判据 job 的**执行面**摘要（`null` = 这个 job 不含判据）：前序 run 步骤的**有序**序列 + 该 job 全部
 * `uses:` 步骤整步面 + job 级 `container` / `defaults` 整块。
 *
 * 三部分各管一段**登记表本身盖不住**的面：
 *   - 前序步骤序列：`priorRunSteps` 逐条钉了文本，但集合只钉「成员与文本」——把两条前序步骤**换序**
 *     （复核实测：`Build script-test prerequisites` 移到 `Build all packages` 之前）不影响任何一条摘要；
 *     序列进摘要后顺序也上锁。
 *   - `uses:` 步骤：action 里是任意代码，同样能写 `$GITHUB_ENV`；而一处 `if: false` / 一分钟
 *     `timeout-minutes` 也能让产出步骤静默不跑（复核实测：只钉 `uses` + `with` 时全绿）。按 job 一条
 *     而不是逐条登记：uses 步骤的改动是整批的（升级 / 新增一步），逐条只是让台账变又一份副本。
 *   - job 级 `container` / `defaults`：镜像、`container.env`、`defaults.run.working-directory` 都是
 *     「改一处即换掉整 job 执行环境」的键，且都不在 `envLayers` 的 `env:` 里（复核实测两条全绿）。
 */
export function jobFaceOf(
  yamlText: string,
  file: string,
  job: string,
  scripts: Scripts,
): string | null {
  const steps = stepsOf(yamlText, file, job, scripts);
  if (!steps.some((s) => judgmentKeysIn(scripts, s.cmds, true).length > 0)) return null;
  const prior = priorRunStepsOf(yamlText, file, job, scripts).map((s) => `${s.key}#${s.digest}`);
  const uses = usesSteps(yamlText, job).map((u) => u.text);
  return stepDigest([...prior, ...uses, ...jobLevelFace(yamlText, job)]);
}

/** 已登记条件的**输入面**：产出步骤文本、同 job 的 uses 步骤整步面、跨 job 的 artifact 产出端。 */
export type ConditionInputFace = {
  digest: string;
  inputsDigest: string;
  /** `null` = 这个 job 没有 download-artifact，不受产出端约束；空数组 = 有 pattern 但匹配不到产出端。 */
  producers: string[] | null;
};

/**
 * 条件 `steps.<id>.outputs.<name>` 的输入面（`null` = 现场没有 id 为 `stepId` 的步骤）。
 *
 * 为什么三处都要：条件原文登记住了，但**操作数来源**没登记——把产出步骤改成 `COUNT=0`、把它的输入
 * （同 job 的 `download-artifact` 的 `pattern:`）改成不匹配的一行、或把另一个 job 的 `upload-artifact`
 * 的 `name:` 改掉，都能让条件永不成立而条件一字未动（对抗复核实测三例）。产出端的匹配规则是
 * `pattern:` 去掉 `${{…}}` 后按 `*` 前缀匹配 `name:`——匹配不到任何 upload 即 fail-closed。
 */
export function conditionInputFaceOf(
  yamlText: string,
  file: string,
  job: string,
  scripts: Scripts,
  stepId: string,
  workflowTexts: Map<string, string>,
): ConditionInputFace | null {
  const producer = stepsOf(yamlText, file, job, scripts).find((s) => s.id === stepId);
  if (producer === undefined) return null;
  const uses = usesSteps(yamlText, job);
  const patterns = uses
    .filter((u) => /actions\/download-artifact/.test(u.uses))
    .flatMap((u) =>
      u.with
        .filter((w) => w.startsWith("pattern="))
        .map((w) =>
          w
            .slice("pattern=".length)
            .split("*")[0]
            .replace(/\$\{\{.*$/, ""),
        ),
    )
    .filter((p) => p !== "");
  let producers: string[] | null = null;
  if (patterns.length > 0) {
    producers = [];
    for (const [file2, yaml2] of workflowTexts) {
      for (const job2 of extractJobs(yaml2)) {
        for (const u of usesSteps(yaml2, job2)) {
          if (!/actions\/upload-artifact/.test(u.uses)) continue;
          const names = u.with
            .filter((w) => w.startsWith("name="))
            .map((w) => w.slice("name=".length));
          if (!names.some((n) => patterns.some((p) => n.startsWith(p)))) continue;
          producers.push([file2, job2, u.text].join(" "));
        }
      }
    }
    producers.sort();
  }
  return {
    digest: stepDigest(producer.rawLines),
    inputsDigest: stepDigest(uses.map((u) => u.text)),
    producers,
  };
}
export function coveredGatePaths(points: Map<string, Endpoint>): Set<string> {
  const out = new Set<string>();
  for (const key of points.keys()) {
    if (key.startsWith("script:")) out.add(key.slice("script:".length).split("|")[0]);
  }
  return out;
}
