/**
 * scripts/lib/gate-endpoints.mjs — 「判据接线」断言的解析层。
 *
 * 为什么需要归一：同一条判据在两侧写法不同——本地档位计划写 pnpm 别名，CI 的 repo-gate 写
 * 脚本路径直调。直接比字符串会被这类**语义等价的改写**误红，而误红的代价是断言被弱化成装饰。
 * 故统一归一到「被执行的脚本身份」再比。
 */

/**
 * 执行位置上的仓库入口：`node <path>` 这类**命令首词后紧跟脚本**的形态。
 *
 * 必须锚在执行位置而不是「命令里出现过 scripts/ 路径」：本仓有
 * `FILTERS=$(node -e "import('scripts/test/script-test-prereqs.mjs')…")` 这类写法，路径在字符串
 * 参数里、不是被执行者；宽松匹配会把它算成端点，断言要么误红、要么被迫加一条噪音例外。
 */
import { LineCounter, parseDocument } from "yaml";

const EXEC_PATH_RE = /^(?:node|npx|tsx|ts-node|bun)\s+(\S+\.(?:mjs|cjs|mts|cts|ts|js))\b/;
const TOOL_RE = /^(prettier|vitest|tsc|eslint|npm|npx|node|jq|tar|git)\b/;
/**
 * shell 控制关键字之后的执行位：`if node scripts/gate/x.mjs …; then` 这类写法里判据确实在跑，
 * 但命令首词是 `if`——按首词归类会把它算成脚手架，于是它在「执行点全集」里彻底消失。
 * 全仓实测只有一处（ci.yml 的 mutation-verdict），且正是一条真实的变异判分。
 */
const CARRIER_RE = /^(?:if|elif|then|do|&&|\|\|)\s+(.+)$/;
/** run 块里的 shell 脚手架（set -e / if / fi / echo ...）：不是执行点，独立成类供断言忽略。 */
const SHELL_RE =
  /^(set|if|then|else|elif|fi|for|do|done|while|case|esac|echo|exit|export|cd|mkdir|cp|mv|rm|printf|true|false|\[|test|trap|read|source|\.)\b/;

/**
 * 扫描一行 shell 的引号与**词边界**状态：返回 `{ commentAt, unbalanced }`。
 *
 * 为什么需要它：`#` 只在**词首**才是注释开始，而「词首」不是「前一个字符是空白」——
 * `pnpm lint \\ # || true` 里的 `\\ ` 是被转义的空白（仍在同一个词里），`#` 是字面量，
 * `|| true` 照常执行；只看 `text[i-1]` 会把这一行当成注释、把 `|| true` 切掉（对抗复核实测）。
 * 引号与 `$\'…\'`（ANSI-C，反斜杠转义下一个字符）同样按 bash 语义建模：`$\'a\\\' #\'` 里的
 * `\\\'` 不是闭合引号，反引号里的 `#` 也不是外层注释。
 */
function scanQuotes(line) {
  const text = String(line ?? "");
  let quote = null;
  let ansi = false;
  let wordStart = true; // 行首算词首；空白 / 元字符之后也是词首（空白被转义时不算）
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === null) {
      // 反斜杠转义下一个字符：转义出来的字符属于当前词，故此后不是词首。
      if (ch === "\\") {
        wordStart = false;
        i += 1;
        continue;
      }
      if (ch === "$" && text[i + 1] === "\'") {
        quote = "\'";
        ansi = true;
        wordStart = false;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "\'" || ch === "`") {
        quote = ch;
        ansi = false;
        wordStart = false;
        continue;
      }
      if (ch === "#" && wordStart) return { commentAt: i, unbalanced: false };
      // bash 的元字符是 `| & ; ( ) < >` 与空白 / 换行——`{` `}` **不在**其列（`echo a{#b` 输出 `a{#b`）。
      wordStart = /[\s;&|()<>]/.test(ch);
      continue;
    }
    if (ansi) {
      if (ch === "\\") i += 1;
      else if (ch === "\'") {
        quote = null;
        ansi = false;
      }
      continue;
    }
    if ((quote === '"' || quote === "`") && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) quote = null;
  }
  return { commentAt: -1, unbalanced: quote !== null };
}

/** 剥 YAML 行尾注释（引号感知：词中的 `#issue` 与引号内的 `#` 都不算注释）。 */
export function stripLineComment(line) {
  const text = String(line ?? "");
  const { commentAt } = scanQuotes(text);
  return (commentAt === -1 ? text : text.slice(0, commentAt)).trimEnd();
}

/**
 * 一行 shell 的引号是否配对。
 *
 * 未配对时「注释从哪开始」「反斜杠续行是否成立」都不可静态判定，而这两种判定正是把判据藏起来
 * 的入口，故判据步骤按 fail-closed 处理（见 A6b）。
 */
export function hasUnbalancedQuotes(line) {
  return scanQuotes(line).unbalanced;
}

/**
 * 取指定 job 下的 run 步骤：`{ cmd, ifCond, continueOnError, envKeys, id, name }`（`run: |` 块内逐行展开，已剥注释）。
 *
 * 为什么带条件而不是只给命令：命令还在、但 `if:` 被改成永不成立（或加了 continue-on-error）时
 * 判据实际已经不跑，只比对命令文本的断言对此是假绿。
 */
/** 步骤块里**允许出现**的 GHA 键：出现第 12 个（或拼错一个）必须报出来，否则一个能让判据
 * 静默失明的键就跟着 workflow 一起进仓库。 */
const STEP_KEYS = new Set([
  "id",
  "if",
  "name",
  "uses",
  "run",
  "working-directory",
  "shell",
  "with",
  "env",
  "continue-on-error",
  "timeout-minutes",
]);

/**
 * YAML 解析：用成熟的 `yaml` 包（devDependency），不再自己写逐行正则。
 *
 * 为什么换掉手写解析：逐行正则与真 YAML 之间没有收敛点——带引号的键 `"if":`、冒号前空格
 * `if :`、块标量内以 `- ` 开头的续行都是 GHA 照常生效而正则看不见的写法（对抗复核实测），
 * 再补正则也闭不上；解析失败**不吞**，由 parseIssues 报出来判红（重复键同样判红）。
 * 结果按文本缓存：同一份 workflow 会被 extractJobs / extractRunSteps / extractJobIf 各调一次。
 */
const docCache = new Map();

function loadDoc(text) {
  const key = String(text ?? "");
  const hit = docCache.get(key);
  if (hit !== undefined) return hit;
  const lineCounter = new LineCounter();
  // 刻意**不**开 `merge`：YAML 的合并键（`<<: *anchor`）GHA 并不支持，所以它落在
  // parseIssues 的「未建模的键」里判红。开着 merge 反而更危险——我们会用自己的语义把 `<<`
  // 悄悄展开，而 GHA 不会，等于把「作者以为生效、实际不生效」的写法放行。
  // 普通锚点与别名 GHA 支持，照常解析（同一 job 里用锚点复制同一条判据步骤会因步骤键重复判红）。
  const doc = parseDocument(key, { lineCounter, uniqueKeys: true });
  const errors = doc.errors.map((e) => e.message);
  let value = {};
  if (errors.length === 0) {
    try {
      value = doc.toJS({ maxAliasCount: 100 }) ?? {};
    } catch (err) {
      errors.push(String(err.message));
    }
  }
  const entry = { value, errors };
  docCache.set(key, entry);
  return entry;
}

/**
 * 把一个 run 的取值切成命令：去行尾注释、把反斜杠续行接回一条。
 *
 * 这一层仍然要自己做，但已经是**纯 shell 行**的事，与 YAML 无关：块标量的去缩进、折叠与
 * chomping 都由 yaml 包按 YAML 语义算好了（`>` 折叠出来的就是一行，正合 bash 实际看到的）。
 *
 * 返回两套（用途不同，缺一不可）：
 *   `cmds`      —— 剥掉注释的**命令**（身份 / 形态判据用它）；
 *   `rawLines`  —— 同一套续行规则下的**原始逻辑行**（含注释与 `#` 文本）。
 * 为什么必须留原始文本：`#` 是不是注释起点取决于 bash 的词首规则，而我们的扫描器与它不可能完全
 * 对齐（`" #"` / `{#` / `\ #` / `$\' #\'` / 反引号五种写法实测都能藏 `|| true`）；只钉「解析层看得见
 * 的命令」时，改一行续行注释就能零台账改动地放行（对抗复核实测）。
 */
function splitCommands(run) {
  const cmds = [];
  const rawLines = [];
  // acc 是同一条**逻辑行**的两个视角：raw（原始文本）/ cmd（剥注释后）。
  let acc = null;
  for (const rawLine of String(run ?? "").split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const inContinuation = acc !== null;
    // 整行注释只在**没有未闭合续行**时才是注释：bash 里 `cmd \` + 换行 + `# x` 会把 `# x` 接进上一条
    // 命令（`#` 成了上一条命令的词的一部分），按注释丢掉它就等于丢掉一段会执行的文本（对抗复核实测）。
    if (trimmed.startsWith("#") && !inContinuation) continue;
    const stripped = stripLineComment(trimmed).trim();
    // 逻辑行的**首行**去掉缩进（块标量的缩进对 bash 无意义）；**续行**必须原样保留前导空白——
    // bash 只删掉「反斜杠 + 换行」这两个字符，`--so\` + 换行 + `   ft` 是两个词，而 `--so\` + 换行 + `ft`
    // 是一个词。两处都按 trim 拼接会让这两种文本既撞进同一个摘要、又在解析层被并成一个词（对抗复核实测的残差）。
    acc =
      acc === null
        ? { raw: trimmed, cmd: stripped }
        : { raw: acc.raw + rawLine, cmd: acc.cmd + rawLine };
    // 续行只在**反斜杠未被引号包住**时成立：单引号里的 `\` + 换行是字面量，bash 不合并它。
    // 引号未配对时不做续行判定，交给 A6b 的不变式判红。
    const { unbalanced } = scanQuotes(stripped);
    if (!unbalanced && stripped.endsWith("\\")) {
      // bash 只删掉「反斜杠 + 换行」这两个字符：作者写在反斜杠前的空白会保留，拼接不额外插空格
      // （插空格会让 `$GITHUB_EN` + 续行 + `V` 这类写法在解析层与 bash 眼里变成两个词，对抗复核实测）。
      // 反斜杠前的空白属于上一条命令的文本（bash 只删掉反斜杠 + 换行），故 **不能** trimEnd。
      acc = { raw: acc.raw.slice(0, -1), cmd: acc.cmd.slice(0, -1) };
      continue;
    }
    rawLines.push(acc.raw);
    if (acc.cmd.trim() !== "") cmds.push(acc.cmd.trim());
    acc = null;
  }
  if (acc !== null) {
    rawLines.push(acc.raw);
    if (acc.cmd.trim() !== "") cmds.push(acc.cmd.trim());
  }
  return { cmds, rawLines };
}

/**
 * 整份文本的 YAML 解析错误（**文件级**，不经过 job 枚举）。
 *
 * 为什么需要单独一个出口：parseIssues 按 job 调用，而 `jobs` 本身写坏时 extractJobs 返回空数组
 * ——循环空转、一条错也报不出来（对抗复核实测：多文档、jobs 非映射、顶层重复键都属此类）。
 */
export function yamlErrors(yamlText) {
  return loadDoc(yamlText).errors;
}

/** 取某个 job 的步骤数组（不是 job、没有 steps、或解析失败时返回空数组）。 */
function stepsOfJob(yamlText, jobName) {
  const { value } = loadDoc(yamlText);
  const steps = value?.jobs?.[jobName]?.steps;
  return Array.isArray(steps) ? steps : [];
}

/** 取值转成 GHA 认的字符串（\`if: false\` 这类在 YAML 里是布尔，GHA 按表达式处理）。 */
function asText(v) {
  return v === undefined || v === null ? null : String(v).trim();
}

// GHA 的**内建 shell 关键字**：GHA 自己负责把脚本交给它们（bash → `bash -eo pipefail {0}`、
// sh → `sh -e {0}`，其余是解释器自己的契约）。
const BUILTIN_SHELLS = new Set(["bash", "sh", "pwsh", "python", "python3", "cmd", "powershell"]);
const SHELL_FAMILY_RE = /^(?:bash|sh|zsh|dash|ksh)\b/;

/**
 * 步骤级 / job 级 / workflow 级 shell 覆盖是否**不削弱**退出码语义。
 *
 * GHA 默认 `bash -e {0}`（errexit 开）。放行只有两类：① **内建关键字**（`bash` / `sh` / `pwsh` …
 * 由 GHA 自己展开）；② 取 basename 后属于 bash 家族、**把脚本交给解释器**（含 `{0}`）、没有 `-c`
 * 且显式带 errexit 的自定义模板。其余一律判红，**不设登记出口**：判据步骤没有理由削弱自己的
 * 退出码语义。
 *
 * 为什么要先归一前缀与路径：原实现按**行首**匹配 `bash|sh|…`，于是 `/bin/bash +e {0}` 与
 * `env bash +e {0}` 整类落进「非 shell 家族，放行」分支——关掉 errexit、甚至
 * `/bin/bash -c 'exit 0' {0}`（脚本根本不会被执行）都全绿（对抗复核实测）。
 */
export function isSafeShellOverride(shell) {
  const raw = String(shell ?? "")
    .trim()
    .toLowerCase();
  if (raw === "") return true;
  if (BUILTIN_SHELLS.has(raw)) return true;
  // 去掉 `env` / `/usr/bin/env` / `command` 前缀与解释器绝对路径后判家族，理由见上。
  const s = raw
    .replace(/^(?:\/?(?:[\w.-]+\/)*)?(?:env|command|builtin)\s+/, "")
    .replace(/^\/?(?:[\w.-]+\/)*/, "");
  if (!SHELL_FAMILY_RE.test(s)) return false;
  // 没把脚本交给解释器（模板里没有 {0}）或 `-c` 形态（脚本路径成了命令字符串的参数）都判红。
  if (!s.includes("{0}")) return false;
  // `-c` 的紧贴写法（`-c'exit 0' {0}`）同样要判红：bash/sh/dash 都拒绝它，脚本根本不会被执行。
  if (/(?:^|\s)-[a-z]*c[a-z]*(?:\s|$|['"`])/.test(s)) return false;
  if (/\+\S*e/.test(s)) return false;
  if (/-o\s+errexit\b/.test(s)) return true;
  return /(?:^|\s)-[a-z]*e[a-z]*(?:\s|$)/.test(s);
}

/**
 * workflow 级与 job 级 `defaults.run.shell`（没有则 null）。
 *
 * 为什么必须读它：`defaults: { run: { shell: 'bash +e {0}' } }` 一行就能对所有 run 步骤关掉
 * errexit，而步骤自己一个 `shell:` 都没写——只看步骤级覆盖会让这条旁路完全不可见（复核实测）。
 */
export function shellDefaults(yamlText, jobName) {
  const { value } = loadDoc(yamlText);
  return {
    workflow: asText(value?.defaults?.run?.shell),
    job: asText(value?.jobs?.[jobName]?.defaults?.run?.shell),
  };
}

/**
 * workflow 级与 job 级 `env:` 的键集合。
 *
 * 为什么必须读这两层：`env: { BASH_ENV: … }` 挂在 job 或 workflow 上同样作用于其中每个 run 步骤，
 * 而步骤自己一个 env 键都没写——只看步骤级会让这条路完全不可见（对抗复核实测的两条绕过）。
 */
export function envLayers(yamlText, jobName) {
  const { value } = loadDoc(yamlText);
  const keysOf = (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).map(String) : [];
  // `container.env` 是第四层：镜像里挂的 env 同样作用于该 job 的每个 run 步骤，而它既不在 workflow 层、
  // 也不在 job 层的 `env:` 里（复核实测：`container: { image: node:24, env: { BASH_ENV: /tmp/x } }` 全绿）。
  return {
    workflow: keysOf(value?.env),
    job: keysOf(value?.jobs?.[jobName]?.env),
    container: keysOf(value?.jobs?.[jobName]?.container?.env),
  };
}
/**
 * 一个步骤映射的**全键**规范化文本（键排序，嵌套映射展开一层）。
 *
 * 为什么要整步而不是挑键：`uses:` 步骤的静默开关不只有 `with`——`if:`、`timeout-minutes`、
 * `env:`、乃至一个解析层没建模的键都能让这一步（或它的产物）失效，而逐个列举等于又开一份会漂移的
 * 白名单。整步进摘要后，「这一步变没变」就是一次摘要比对（对抗复核实测：把上传 artifact 那步改成
 * `if: false`，只钉 `uses` + `with` 时全绿）。
 */
function canonicalLines(prefix, value, out = []) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const k of Object.keys(value).sort())
      canonicalLines(prefix === "" ? k : `${prefix}.${k}`, value[k], out);
    return out;
  }
  out.push(`${prefix}=${String(value)}`);
  return out;
}

function canonicalStepText(step) {
  return Object.keys(step)
    .sort()
    .flatMap((k) => canonicalLines(k, step[k]));
}

/**
 * job 级「执行环境面」的规范化文本：`container` 与 `defaults` 整块（含 `container.env`、`container.image`、
 * `defaults.run.working-directory`）。
 *
 * 为什么这两块必须进摘要：它们都是「改一处即换掉整 job 执行环境」的 job 级键——`container` 里的镜像与 env
 * 决定每条判据在什么环境里跑，`defaults.run.working-directory` 决定每条判据在哪个目录里跑，而两者都不在
 * `envLayers` 的 job 层 `env:` 里（复核实测：给 observe.yml quality 加 container 或给判据 job 加 defaults
 * 时 73/73 全绿）。
 */
export function jobLevelFace(yamlText, jobName) {
  const { value } = loadDoc(yamlText);
  const job = value?.jobs?.[jobName];
  const out = [];
  for (const k of ["container", "defaults"]) {
    const v = job?.[k];
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...canonicalLines(k, v));
    } else {
      out.push(`${k}=${String(v)}`);
    }
  }
  return out;
}

/**
 * job 里的 `uses:` 步骤（`{ uses, with, text }`：`with` 是排序后的 `k=v` 文本，
 * `text` 是整步全键规范化文本——登记面用它）。
 *
 * 为什么要它：已登记条件的**产出步骤**往往从 `uses:` 步骤（如 `actions/download-artifact`）取输入——
 * 把 `pattern:` 改成不匹配的一行，产出步骤文本一字未动，而 output 会变成 0、条件永不成立
 * （对抗复核实测）。故条件输入的登记也要覆盖「这个 job 的 uses 步骤」这一层。
 */
export function usesSteps(yamlText, jobName) {
  const out = [];
  for (const step of stepsOfJob(yamlText, jobName)) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
    const uses = asText(step.uses);
    if (uses === null) continue;
    const withObj = step.with;
    const keys =
      withObj !== null && typeof withObj === "object" && !Array.isArray(withObj)
        ? Object.keys(withObj).sort()
        : [];
    // `with` 原始键值留给「pattern / name 前缀」这类结构化读取；**登记面**用 text（整步全键）：
    // 挑几个键列举就是又一份会漂移的白名单——`if: false`、一分钟 `timeout-minutes`、注入 `env`
    // 或一个没建模的键都能让这一步（或它的产物）静默失效而挑出来的键一字未动（对抗复核实测）。
    out.push({
      uses,
      with: keys.map((k) => `${k}=${String(withObj[k])}`),
      text: canonicalStepText(step).join("\n"),
    });
  }
  return out;
}

/** 步骤级 `env:` 的键集合（不是映射时返回空数组——那种写法由 parseIssues 判红）。 */
function envKeysOf(step) {
  const env = step?.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) return [];
  return Object.keys(env).map((k) => String(k));
}

export function extractRunSteps(yamlText, jobName) {
  const out = [];
  stepsOfJob(yamlText, jobName).forEach((step, stepIndex) => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) return;
    const ifCond = asText(step.if);
    const envKeys = envKeysOf(step);
    const name = asText(step.name);
    const id = asText(step.id);
    // 只认显式 false：表达式取值的 continue-on-error 静态判不了，保守当作「可能生效」——
    // 漏判一个就等于放过一条永不判红的判据。
    const coe = asText(step["continue-on-error"]);
    const continueOnError = coe !== null && coe !== "false";
    const shell = asText(step.shell);
    // `working-directory` 在 STEP_KEYS 白名单里（是合法 GHA 键），故它不会落进 unknownKeys——但它是
    // 「这条命令在哪个目录里跑」的一部分：不读出来就等于让 cwd 完全不在任何摘要里（对抗复核实测：
    // 给判据步骤加 `working-directory: /tmp` 时 73/73 全绿）。
    const workingDirectory = asText(step["working-directory"]);
    const unknownKeys = Object.keys(step).filter((k) => !STEP_KEYS.has(k));
    if (typeof step.run !== "string") return;
    const { cmds: stepCmds, rawLines } = splitCommands(step.run);
    for (const cmd of stepCmds) {
      out.push({
        cmd,
        ifCond,
        continueOnError,
        envKeys,
        id,
        name,
        rawLines,
        shell,
        unknownKeys,
        workingDirectory,
        stepIndex,
      });
    }
  });
  return out;
}

/**
 * 解析层的**结构性存疑**清单：YAML 解析错误、未建模的步骤键、以及不是映射的步骤。
 *
 * 这是「换真解析器」之后仍需保留的一道网：解析器保证**语法**正确，白名单保证**语义**在我们
 * 建模过的范围内。两者都过不去的东西必须判红，而不是静默略过。
 */
export function parseIssues(yamlText, jobName) {
  const { value, errors } = loadDoc(yamlText);
  const issues = [...errors];
  if (errors.length > 0) return issues;
  stepsOfJob(yamlText, jobName).forEach((step, i) => {
    const at = "第 " + (i + 1) + " 个步骤：";
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      issues.push(at + "不是映射（flow 写法？锚点？）");
      return;
    }
    for (const k of Object.keys(step)) {
      if (!STEP_KEYS.has(k)) issues.push(at + "解析层未建模的键「" + k + "」");
    }
    // `run: 42` 这类非字符串：extractRunSteps 会**静默 return**，于是这一步在执行点全集里
    // 彻底消失，而 A13 也报不出任何东西——此前它只是碰巧被别的断言连带判红（对抗复核实测：
    // 单独看解析面时 `run: 42` 是一条静默失明通道）。
    if ("run" in step && typeof step.run !== "string") {
      issues.push(at + "run 不是字符串（整条步骤会被解析层静默跳过）");
    }
    // `env` 是「已建模的键」，但只有映射形态才读得出键名；列表 / 标量形态会让 env 整块失明
    // （它正是能改变 shell 行为的那一类，见 dangerousShellEnv）。
    if (
      "env" in step &&
      (step.env === null || typeof step.env !== "object" || Array.isArray(step.env))
    ) {
      issues.push(at + "env 不是映射（键名读不出来，无法核对是否注入 shell 行为变量）");
    }
  });
  void value;
  return issues;
}

/**
 * 抹掉命令替换、表达式插值与引号内容。
 *
 * `--packages "$(… | jq …)"` 里那条管道属于子命令，不影响外层 node 的退出码；把它算成吞码
 * 会立刻制造误红。字符串参数同理：里面的 `||` / `;` 是数据不是控制流。
 */
function withoutSubstitutions(command) {
  return String(command ?? "")
    .replace(/\$\([^()]*\)/g, "")
    .replace(/\$\{\{[^}]*\}\}/g, "")
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, "");
}

/**
 * 判据命令是否含**顶层 shell 控制操作符**（管道 / 逻辑连接 / 顺序 / 后台）。
 *
 * 这是本族判据从「枚举已知吞码写法」转向「形态白名单」的那一步：`node X||echo` / `node X | sed` /
 * `node X;` 都能让退出码到不了步骤，写法却列举不完；反过来要求「判据就是一条简单命令」是一句
 * 话能说清的约束，且不误伤既有调用（`$(…)` 在引号里，已被 withoutSubstitutions 抹掉）。
 */
export function hasShellControlOperator(command) {
  // `if …; then` / `for …; do` 里的分号是结构语法，不是链式操作符，先剥掉再找；
  // 其余 `|` / `||` / `&&` / `&` / 结尾 `;` 一律算控制操作符。
  const bare = withoutSubstitutions(command)
    .replace(/;\s*(?:then|do)\b/g, "")
    // 重定向里的 `&` 不是控制操作符：`2>&1` / `&>file` 只改流向，不影响退出码。
    // 不先剥掉它们，`node X 2>&1` 这条最常见的调试写法会被判成「非单命令」（复核实测）。
    .replace(/\d*>&\s*\d+/g, "")
    .replace(/&>\s*\S+/g, "");
  return /[|;&]/.test(bare);
}

/**
 * 剥掉行首的变量赋值前缀（`X=1 set +e` 与 `set +e` 是同一件事）。
 *
 * 只认**简单赋值**：刻意不收命令替换 / 管道 / 重定向——`HIT_PACKAGES=$(printf '%s' …)` 的等号右侧
 * 含空格，贪婪匹配只吃掉 `$(printf`，后半截会被当成一条命令，凭空造出 unknown 端点（本轮实测）。
 */
function stripLeadingAssignments(text) {
  return String(text ?? "").replace(
    /^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`$()|;&<>]*)\s+)+/,
    "",
  );
}

/**
 * 剥掉 `cd <dir> && <cmd>` 载体：变的是工作目录，被执行者与整行退出码都由内层命令决定
 * （`cd` 失败会让整行失败，是响的）。返回内层命令；不是这种形态时返回 null。
 *
 * 不认这种形态时 `cd X && 判据` 会「丢掉执行点」：A1/A2 误红，且它无法登记（登记要求非闭合形态），
 * 即一条合法写法既跑不了也登记不了（对抗复核实测）。载体行仍需吃控制操作符与吞码检查，故形态族
 * 也用它剥一层再判。
 */
export function stripCdCarrier(command) {
  const m = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)$/.exec(String(command ?? "").trim());
  return m === null ? null : m[1];
}

/**
 * 命令前缀里**不改变被执行者**的部分：`command` / `builtin` / `env` 与 `env` 之后的赋值。
 *
 * 不剥它们时 `env FOO=1 node scripts/gate/x.mjs` 会被归成 unknown——一个真实执行点凭空消失，
 * 而在本断言里「执行点消失」与「判据不存在」长得一样（覆盖面静默变小，而不是判红）。
 * 刻意只剥这三种：`sudo` / `nice` 之类会改变运行身份或调度，不做静态假设。
 */
function stripExecPrefixes(text) {
  let t = String(text ?? "").trim();
  for (;;) {
    const before = t;
    t = t.replace(/^(?:command|builtin|env)\s+/, "");
    if (t === before) return t;
    t = stripLeadingAssignments(t);
  }
}

/** 去掉一层包裹引号。 */
function unquoteToken(token) {
  return String(token ?? "").replace(/^(["'])([\s\S]*)\1$/, "$2");
}

/**
 * `exit` 的参数是否把状态码钉成 0。
 *
 * 判据步骤里 `exit` 的唯一正当用途是**把上游失败传出去**（`exit $rc` / `exit 1`）；0 的各种字面
 * 写法、算术展开、带默认值的参数展开都在吃掉失败。**无法证明非零的一律按吞码判**：漏判一个就是
 * 放过一条永不判红的判据。裸 `exit`（无参数）不在此列——它传播的是上一条命令的状态码。
 */
function exitArgSwallows(arg) {
  if (arg === undefined) return false;
  const a = unquoteToken(String(arg).trim());
  if (a === "") return true;
  // `$?` / `$VAR` 都传播上一条命令的状态码；`$?` 原先是漏的，于是 `cmd; exit $?`（合法的传播写法）
  // 被判成吞码（对抗复核实测的误红）。
  if (/^\$(?:\?|\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/.test(a)) return false;
  if (/^0[xX][0-9a-fA-F]+$/.test(a)) return Number.parseInt(a, 16) === 0;
  if (/^[+-]?\d+$/.test(a)) return Number(a) === 0;
  return true;
}

/**
 * 一段命令是否把失败传出去：只有 `false` 与「非零 / 证明非零的 exit」算。
 *
 * `|| { …; exit 1; }` 是本仓的 fail-closed 惯用收尾，失败确实传了出去；只看首词会把它误判成
 * 吞码。故先剥一层花括号组，再按**最后一条语句**判定。
 */
function propagatesFailure(text) {
  let t = stripLeadingAssignments(String(text ?? "").trim());
  const group = /^\{([\s\S]*)\}$/.exec(t.replace(/;\s*$/, "").trim());
  if (group !== null) t = group[1];
  const last = t
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .pop();
  if (last === undefined) return false;
  if (/^false\b/.test(last)) return true;
  const m = /^exit\b\s*([^\s;&|]*)?/.exec(last);
  if (m !== null) return !exitArgSwallows(m[1]);
  return false;
}

/**
 * run 行是否把退出码吞掉（判据仍在跑，但永远不会判红）。
 *
 * `|| true` / `| cat` / `; true` / 显式 `exit 0` 都是合法 shell，却把判据的判红能力整个消掉。
 * `||` 的判定不看右侧写了什么：只有 `exit <非零>` 与 `false` 算「把失败传出去」。
 * `exit` 的位置不限于行尾——写在判据**之前**同样让整个步骤以 0 结束（复核实测 24/24 全绿），
 * 故按命令边界扫描全部 exit 子句。
 */
export function swallowsExitCode(command) {
  const cmd = stripLeadingAssignments(String(command ?? "").trim());
  const bare = withoutSubstitutions(cmd);
  const orIndex = cmd.lastIndexOf("||");
  if (/\|\|/.test(bare) && orIndex !== -1 && !propagatesFailure(cmd.slice(orIndex + 2)))
    return true;
  if (/\|/.test(bare.replace(/\|\|/g, ""))) return true;
  if (/;\s*true\s*$/.test(cmd)) return true;
  // exit 子句的边界不止 `行首 | ; & |`：花括号组 `{ exit 0; }`、子 shell `(exit 0)`，
  // 以及 `command exit` / `builtin exit` / `exec exit` / `\exit` 这些前缀写法同样是
  // 「在命令边界上 exit」（对抗复核实测：`{ exit 0; }` 与 `command exit 0` 当时都全绿）。
  for (const m of cmd.matchAll(
    /(?:^|[;&|({]|\bthen\b|\belse\b|\bdo\b|\b(?:builtin|command|exec)\b)\s*(?:\\?exit)\b\s*([^\s;&|}]*)?/g,
  )) {
    if (exitArgSwallows(m[1])) return true;
  }
  return false;
}

/**
 * run 步骤是否关掉了 errexit（`set +e`）。
 *
 * GHA 的默认 shell 是 `bash -e`：`set +e` 之后判据失败不再使步骤失败——命令跑过，但永不判红。
 * 它与吞码同罪，却是一条独立的 shell 行，逐行看只会被当成脚手架跳过。
 */
export function disablesErrexit(commands) {
  return commands.some((c) => {
    // `set +e` 与 `set +o errexit` 是同一件事的两种写法；`trap '…' ERR` 则是把 ERR 上的动作
    // 换掉，等价于吃掉失败。判据步骤没有任何理由需要它们，故按形态一律判红。
    // 前缀与行首赋值同样不改变语义：`builtin set +e` / `\set +e` / `X=1 set +e` 都关掉了
    // errexit——原先只给 trap 分支写了前缀白名单，set 分支仍是行首匹配，是一条不对称的遗漏
    // （复核实测：`X=1 set +e` 24/24 全绿而判据永不判红）。
    const t = stripLeadingAssignments(String(c).trim())
      .replace(/^(?:builtin|command)\s+/, "")
      .replace(/^\\/, "");
    // `set +e` 只是「关掉 errexit」的一种写法：`set +ex` / `set +eu` / `set "+e"` 都是
    // 「+ 号后带 e 的 flag 组合」，而 `\b` 边界只认孤立的 `+e`（独立对抗复核实测三种全漏，
    // 且 bash 实证 `set +ex; false; true` 退出码为 0）。故按语义判：+ 后的 flag 里出现 e 即关掉。
    const flags = /^set\s+['"]?\+([A-Za-z]*)['"]?/.exec(t);
    if (flags !== null && flags[1].toLowerCase().includes("e")) return true;
    return /^(?:set\s+\+o\s+errexit\b|trap\b)/.test(t);
  });
}

/**
 * 条件表达式是否**恒为假**（静态可判的那些形态）。
 *
 * 不能只看字面 `false`：字面量比较同样恒假（复核实测：把全仓调用埋进 `if [ 1 = 2 ]` 里，A9 仍看见
 * 两种形态）。**只认两侧都不是变量的比较**——`[ "$FULL_GATE" = "true" ]` 完全合法，判成恒假会
 * 立刻误红三条真实判据。
 */
/**
 * 测试表达式的三值求值：true / false / null（静态判不出）。
 *
 * `[ ]`、`[ "" ]`、`[ -n "" ]`、`[ -z "x" ]` 都是 bash 恒假，而只认 `[ A = B ]` 的枚举看不见它们
 * （把判据裹进 `if [ ]; then` 里，形态断言全绿而判据永不执行）。只对**字面量**下结论：含 `$` 的
 * 操作数一律返回 null，否则真实条件会被误判成恒假。
 */
function testEval(expr) {
  const e = String(expr ?? "").trim();
  if (e === "") return false;
  if (e.startsWith("!")) {
    const inner = testEval(e.replace(/^!\s*/, ""));
    return inner === null ? null : !inner;
  }
  const unary = /^(-[nz])\s+(.+)$/.exec(e);
  if (unary !== null) {
    const operand = unary[2].trim();
    if (operand.includes("$")) return null;
    const empty = unquoteToken(operand) === "";
    return unary[1] === "-n" ? !empty : empty;
  }
  if (/^["'][\s\S]*["']$/.test(e) || /^[\w.:@/-]+$/.test(e)) {
    if (e.includes("$")) return null;
    return unquoteToken(e) !== "";
  }
  return null;
}

export function isConstantFalseCondition(condition) {
  const c = String(condition ?? "").trim();
  if (/^(?:false|0)$/.test(c)) return true;
  if (/^!\s*true$/.test(c)) return true;
  const arith = /^\(\(\s*(-?\d+)\s*\)\)$/.exec(c);
  if (arith !== null) return Number(arith[1]) === 0;
  const body = c.replace(/^(?:\[\[?|test)\s+/, "").replace(/\s*\]\]?$/, "");
  if (/^(?:\[\[?|test)(?:\s|$)/.test(c)) {
    const verdict = testEval(body);
    if (verdict !== null) return !verdict;
  }
  const cmp = /^(.+?)\s*(===|==|=|!==|!=|-eq|-ne|-lt|-gt|-le|-ge)\s*(.+?)$/.exec(body);
  if (cmp === null) return false;
  const literal = (s) => !s.includes("$") && /^(?:"[^"]*"|'[^']*'|[\w.:@/-]+)$/.test(s.trim());
  const left = cmp[1].trim();
  const right = cmp[3].trim();
  if (!literal(left) || !literal(right)) return false;
  const l = left.replace(/^["']|["']$/g, "");
  const r = right.replace(/^["']|["']$/g, "");
  const num = Number(l);
  const numR = Number(r);
  const numeric = !Number.isNaN(num) && !Number.isNaN(numR);
  switch (cmp[2]) {
    case "=":
    case "==":
    case "===":
      return l !== r;
    case "!=":
    case "!==":
      return l === r;
    case "-eq":
      return numeric ? num !== numR : true;
    case "-ne":
      return numeric ? num === numR : true;
    case "-lt":
      return numeric ? num >= numR : true;
    case "-gt":
      return numeric ? num <= numR : true;
    case "-le":
      return numeric ? num > numR : true;
    case "-ge":
      return numeric ? num < numR : true;
    default:
      return false;
  }
}

/**
 * 剔除被恒假分支包住的命令，返回仍然会被执行的命令。
 *
 * 必须行级跟踪而不能整段判定：恒假分支可以嵌在更大的 run 块里（前面还有 set -e、别的 if），
 * 整段判定会把它当活代码（复核实测：藏在块中间、甚至单独一行的假形态照样被数到）。
 */
export function stripDeadBranchCommands(commands) {
  const out = [];
  const stack = [];
  // `if <cond>` 与 `while <cond>` 允许把 then / do 写到下一行，此时条件要先挂起。
  let pending = null;
  // 条件位本身也是**会执行的代码**：`if node scripts/gate/x.mjs "$pkg"; then …` 里判据就跑在
  // 条件上。控制流跟踪会消费掉这一行，若不同时把它记进「会执行的命令」，这种载体形态的判据
  // 在 live 清单里会凭空消失，被误判成「位于恒假分支」（推广到全部 workflow 时实测命中
  // ci.yml 的 mutation-verdict）。
  const live = () => !stack.includes(true);
  const push = (cond) => stack.push(!live() || isConstantFalseCondition(cond));
  const pushOpener = (cond, raw) => {
    if (live() && !isConstantFalseCondition(cond)) out.push(raw);
    push(cond);
  };
  for (const raw of commands) {
    const cmd = String(raw).trim();
    const single = /^if\s+(.+?);\s*then\s+(.+?);?\s*fi\s*$/.exec(cmd);
    if (single !== null) {
      if (!stack.includes(true) && !isConstantFalseCondition(single[1])) out.push(single[2]);
      continue;
    }
    const singleLoop = /^while\s+(.+?);?\s*do\s+(.+?);?\s*done\s*$/.exec(cmd);
    if (singleLoop !== null) {
      if (!stack.includes(true) && !isConstantFalseCondition(singleLoop[1]))
        out.push(singleLoop[2]);
      continue;
    }
    if (pending !== null && /^(?:then|do)\b/.test(cmd)) {
      // 条件行在上一行已按 pushOpener 记过一次，这里只补栈帧。
      push(pending);
      pending = null;
      continue;
    }
    const opensIf = /^if\s+(.*?);\s*then\b/.exec(cmd);
    if (opensIf !== null) {
      pushOpener(opensIf[1], raw);
      continue;
    }
    const opensLoop = /^while\s+(.*?);?\s*do\b/.exec(cmd);
    if (opensLoop !== null) {
      pushOpener(opensLoop[1], raw);
      continue;
    }
    const bareIf = /^if\s+(.+)$/.exec(cmd);
    if (bareIf !== null) {
      pushOpener(bareIf[1], raw);
      pending = bareIf[1];
      continue;
    }
    const bareLoop = /^while\s+(.+)$/.exec(cmd);
    if (bareLoop !== null) {
      pushOpener(bareLoop[1], raw);
      pending = bareLoop[1];
      continue;
    }
    if (/^(?:fi|done)\b/.test(cmd)) {
      stack.pop();
      // 收尾关键字行本身也可能带执行位或改写退出码：`done < <(node scripts/x.mjs)` 的进程替换
      // 在循环建立时就执行，`fi || true` 的吞码也发生在这里。整行丢掉会让这两种形态在
      // 「真的会执行的命令」清单里彻底消失（复核实测：release 的 publish-if-missing 因此
      // 完全看不见）。
      if (cmd.replace(/^(?:fi|done)\b\s*;?\s*/, "").trim() !== "") out.push(raw);
      continue;
    }
    if (!stack.includes(true)) out.push(raw);
  }
  return out;
}

/**
 * 剥掉恒假分支的包装，露出它内部的命令。
 * 仅用于「这条判据被关掉了」的判定——剥壳结果绝不能进执行点全集，否则死代码会被当成活执行点。
 */
export function unwrapDeadBranch(command) {
  const c = String(command).trim();
  const single = /^if\s+(.+?);\s*then\s+(.+?);?\s*fi$/.exec(c);
  if (single !== null && isConstantFalseCondition(single[1])) return single[2].trim();
  const singleLoop = /^while\s+(.+?);?\s*do\s+(.+?);?\s*done$/.exec(c);
  if (singleLoop !== null && isConstantFalseCondition(singleLoop[1])) return singleLoop[2].trim();
  return c;
}

/**
 * job 级 `if:` 的原文（没有则 null）。
 *
 * job 级 if 是「改一处即静默停闸」的开关：换成一个永不成立的条件，该 job 下全部判据一次消失，
 * 而只看步骤内容的断言原封不动（复核实测 24/24 全绿）。
 */
export function extractJobIf(yamlText, jobName) {
  const { value } = loadDoc(yamlText);
  const job = value?.jobs?.[jobName];
  if (job === null || typeof job !== "object" || Array.isArray(job)) return null;
  return asText(job.if);
}

/**
 * 枚举 workflow 里声明的 job 名，供「执行点全集」扫描。
 *
 * 取的是 `jobs:` 映射的键，不是「全文里长得像 job 的行」：顶层 `on:` / `env:` / `concurrency:` 同形，
 * 靠缩进猜会造出并不存在的 job，而空 job 只返回零条步骤——这种错误静默无感。
 */
export function extractJobs(yamlText) {
  const { value } = loadDoc(yamlText);
  const jobs = value?.jobs;
  if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) return [];
  return Object.keys(jobs);
}

/**
 * lefthook.yml 的 run 步骤。
 *
 * 为什么不复用 extractRunSteps：lefthook 的 `run:` 挂在 `<hook>:
  jobs:` 的列表项下，套 job 口径
 * 会读成空集，而空集在本断言里是静默全绿。这里按它自己的形状取：顶层每个 hook 下的
 * `jobs[].run`，行内与块标量都认。
 */
export function extractLefthookSteps(yamlText) {
  const { value } = loadDoc(yamlText);
  const out = [];
  for (const hook of Object.values(value ?? {})) {
    if (hook === null || typeof hook !== "object" || Array.isArray(hook)) continue;
    const jobs = Array.isArray(hook.jobs) ? hook.jobs : [];
    for (const item of jobs) {
      if (item === null || typeof item !== "object" || typeof item.run !== "string") continue;
      for (const cmd of splitCommands(item.run).cmds) {
        out.push({ cmd, ifCond: null, continueOnError: false, shell: null, unknownKeys: [] });
      }
    }
  }
  return out;
}

/**
 * 命令**内部**的执行位：进程替换（`done < <(node scripts/x.ts)`）与命令替换里的直接调用。
 *
 * 为什么不并进 endpointOf：它的契约是「一条命令 → 一个身份」，而这类写法的主身份是脚手架
 * （done / while），执行位藏在替换语法里且可以有多处。补上它之前
 * `done < <(node scripts/release/publish-if-missing.ts)` 被归成 shell:done——「判据在跑」与
 * 「判据不存在」在执行点全集里没有区别。
 */
export function embeddedExecutions(command) {
  const out = [];
  for (const m of String(command ?? "").matchAll(
    /(?:[<(]|`)\s*(?:node|npx|tsx|ts-node|bun)\s+(\S+\.(?:mjs|cjs|mts|cts|ts|js))\b/g,
  )) {
    out.push(m[1].replace(/^\.\//, ""));
  }
  return out;
}

/**
 * 能**改变判据执行环境**、让整步在本判据之前结束（或让判据跑在别的东西上）的变量名。
 *
 * 为什么单独列：它们不改变执行点、也不改变两侧身份，只是让 shell / 运行时先做别的事——
 * `BASH_ENV=<内容为 exit 0 的文件>` 下 `bash -e body.sh` 退出 0 且脚本体完全未执行；
 * `NODE_OPTIONS=--require <内容为 process.exit(0) 的文件>` 下 `node gate.mjs` 同理（复核实测）。
 * 判据脚本自己读的业务 env（如 VERIFY_DIR_IMPORTS_BASELINE）属判据自身的契约，归宿是它的测试；
 * 这一层由 stepEnvs 的**逐键登记**兜住，不在这里拦。
 */
const DANGEROUS_ENV =
  /^(?:BASH_ENV|ENV|SHELLOPTS|PROMPT_COMMAND|BASH_XTRACEFD|ZDOTDIR|NODE_OPTIONS|NODE_PATH|PATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONSTARTUP|PERL5OPT|RUBYOPT)$/i;
export function dangerousStepEnv(keys) {
  return [...new Set(keys.map((k) => String(k)))].filter(
    (k) => DANGEROUS_ENV.test(k) || /^BASH_FUNC_/i.test(k),
  );
}

/** 命令行里的**行首赋值名**（`FOO=1 cmd` 形态；`--flag=value` 这类参数不算）。 */
export function leadingAssignmentNames(command) {
  const out = [];
  for (const m of String(command ?? "").matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(?=\S)/g)) {
    out.push(m[1]);
  }
  return out;
}

/** 去掉包裹引号。 */
function unquote(token) {
  return token.replace(/^["']|["']$/g, "");
}

/**
 * 读一个 shell「词」：从 `from` 起跳空白，按 bash 的引号 / `$\'…\'` / 反引号 / `$( … )` 规则吃到
 * 词尾（空白或控制操作符），返回 `[词, 结束位置]`。
 *
 * 为什么需要它：`--packages` 的取值在 CI 里是 `"$(printf \'%s\' … | jq …)"`，直接用 `split(/\s+/)`
 * 会把它切成好几个 token。取**一个完整词**做边界，才谈得上「值之后的 token 仍然进身份」。
 */
function readShellWord(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const start = i;
  let depth = 0;
  let quote = null;
  let ansi = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ansi) {
      if (ch === "\\") i += 1;
      else if (ch === "\'") {
        ansi = false;
        quote = null;
      }
      continue;
    }
    if (quote !== null) {
      if ((quote === '"' || quote === "`") && ch === "\\") {
        i += 1;
        continue;
      }
      if (quote === '"' && ch === "$" && text[i + 1] === "(") depth += 1;
      else if (quote === '"' && ch === ")" && depth > 0) depth -= 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (depth === 0 && (/(?:)/.test(""), /\s|[;&|]/.test(ch))) break;
    if (ch === "$" && text[i + 1] === "\'") {
      quote = "\'";
      ansi = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "\'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      depth += 1;
      i += 1;
    } else if (ch === ")" && depth > 0) depth -= 1;
  }
  return [text.slice(start, i), i];
}

/**
 * 把命令行切成 `--packages` 之前 / 之后两部分（取值为一个完整词，见 readShellWord）。
 *
 * 为什么不能像原来那样「截掉 `--packages` 及其之后」：那样 `--packages` 之后的 token 完全不进身份，
 * 于是靠引号分歧把 `|| true` 藏在值后面的写法（`--packages "" $\'a\\\' #\' || true`）身份不变、
 * A1/A2 看不见（对抗复核实测的绕过）。取值本身仍需归一（CI 切片 / 本地全仓是真实口径差异，由 A9
 * 的形态断言单独守），但**值之后的 token 照旧进身份**。
 */
function splitAtPackages(raw) {
  const m = /(?:^|\s)--packages(?=\s|=)/.exec(raw);
  if (m === null) return { head: raw, suffix: "" };
  const at = m.index + m[0].length;
  if (raw[at] === "=") return { head: raw.slice(0, m.index), suffix: raw.slice(at + 1).trim() };
  const [, end] = readShellWord(raw, at);
  return { head: raw.slice(0, m.index), suffix: raw.slice(end).trim() };
}

/** 排序去重的 token 摘要。 */
function digestOf(tokens) {
  return [...new Set(tokens.map(unquote))].sort().join(",");
}

/** 值之后的残余 token 归一成一个身份项（`--packages` 的取值本身不进身份）。 */
const suffixToken = (suffix) => (suffix === "" ? [] : ["trailing:" + suffix.replace(/\s+/g, " ")]);

/**
 * tool 端点的判据面摘要：**除工具名外的全部 token**。
 *
 * 原口径只收路径样操作数与几个选择面选项，于是改变判据的 flag 被视而不见——
 * `node --test --test-name-pattern \'zzz-nope\' …` 与不带该 flag 的命令身份完全相同，而运行期是
 * 0 断言、exit 0（复核实测）。能改变「跑哪些用例」的 flag 列举不完，故改为全收：宁可要求对合法的
 * 形式差异写一条显式登记，也不留静默放行的开关。
 */
function toolDigest(command) {
  const raw = String(command ?? "").trim();
  const { head, suffix } = splitAtPackages(raw);
  return digestOf([...head.trim().split(/\s+/).slice(1), ...suffixToken(suffix)]);
}

/**
 * script 端点的判据面摘要：`--package` 取值 + 其余全部 token（flag 名与位置参数），`--packages`
 * 的取值归一为占位、其后的 token 照旧进身份。
 *
 * 必须收非 `--package` 的 token：`--soft` 把 verify-dir-imports 的硬判降级为只进软报告、不判红，
 * 而原口径只比 `--package` 值集合，于是「给 3 包硬判追加 --soft」身份不变、断言全绿（复核实测）。
 */
function scriptDigest(command) {
  const raw = String(command ?? "").trim();
  const { head, suffix } = splitAtPackages(raw);
  const tokens = head.trim().split(/\s+/);
  const picked = [];
  for (let i = 2; i < tokens.length; i += 1) {
    const bare = unquote(tokens[i]);
    if (bare === "--package" && tokens[i + 1] !== undefined) {
      picked.push(unquote(tokens[i + 1]));
      i += 1;
      continue;
    }
    picked.push(bare);
  }
  return digestOf([...picked, ...suffixToken(suffix)]);
}

/** `tool:<工具名>`，带判据面摘要时补 `|摘要`。 */
function toolId(name, command) {
  const d = toolDigest(command);
  return d === "" ? name : `${name}|${d}`;
}

/**
 * 把一条命令行归一为 `{ kind, id }`；kind 值域（断言据此分类，未分类即红）：
 *   script     仓库内脚本入口，id = 相对路径（判据身份的主形态）
 *   tool       外部工具（prettier / vitest / node --test …），id = 工具名[|判据面摘要]
 *   alias      pnpm 别名未能展开（package.json 里没有），需登记
 *   pkg-filter 包面切片命令（build/test/typecheck 的 --filter 形态），非判据
 *   shell      run 块脚手架，非执行点
 *   unknown    无法识别，必须显式分类
 */
export function endpointOf(command, scripts = {}) {
  const head = String(command ?? "")
    .replace(/^run:\s*/, "")
    .trim();
  if (head === "") return null;
  // 行首的变量赋值前缀不改变「被执行的是谁」：`FOO=1 node scripts/gate/x.mjs` 执行的仍是
  // x.mjs。不剥前缀时它被归成 shell:statement——作为**额外**执行点会被静默忽略（覆盖面变小
  // 而没人判红）。剥完什么都不剩说明这条命令本身就是赋值，仍归脚手架。
  const cmd = stripExecPrefixes(stripLeadingAssignments(head));
  if (cmd === "") return { kind: "shell", id: "shell:statement" };
  const pnpmAlias = /^pnpm\s+(?:exec\s+)?([^-\s][^\s]*)\s*(.*)$/.exec(cmd);
  if (pnpmAlias !== null) {
    const alias = pnpmAlias[1];
    // `pnpm $VAR …`：别名由 shell 变量在运行时决定，静态解析不出身份，归脚手架。
    if (alias.startsWith("$")) return { kind: "shell", id: "pnpm:variable" };
    const extra = (pnpmAlias[2] ?? "").trim();
    const expansion = scripts[alias];
    if (typeof expansion === "string" && expansion.trim() !== cmd) {
      // 调用方附加的参数必须带进展开结果：pnpm 会把它们透传给脚本。`pnpm lint tools` 只检查
      // 2 个文件、裸 `pnpm lint` 检查 492 个——丢掉附加参数等于把判据面整个换掉却不改身份
      // （复核实测：一行改动、无需台账、无需新文件即可让 24 条全绿）。
      return endpointOf(extra === "" ? expansion : expansion + " " + extra, scripts);
    }
    return { kind: "alias", id: alias };
  }
  if (/^pnpm\s+-/.test(cmd)) return { kind: "pkg-filter", id: "pnpm:flags" };
  if (/^node\s+--test\b/.test(cmd)) return { kind: "tool", id: toolId("node:test", cmd) };
  const exec = EXEC_PATH_RE.exec(cmd);
  if (exec !== null) {
    const path = exec[1].replace(/^\.\//, "");
    // 同一脚本的多个调用点必须区分开，区分维度是**全部参数**（--package 取值 + 其余 token）：
    // 只按路径归一会让 verify-dir-imports 的「4 包硬判」与「provider-usage --soft」塌缩成一个
    // 身份，删掉其中一步或给它追加 --soft 都不判红（复核实测过的两条缺口）。
    const d = scriptDigest(cmd);
    return { kind: "script", id: d === "" ? path : `${path}|${d}` };
  }
  const tool = TOOL_RE.exec(cmd);
  if (tool !== null) return { kind: "tool", id: toolId(tool[1], cmd) };
  // shell 赋值（`VAR=$(…)` / `VAR="…"`）与测试命令（`[ -d … ]`）是 run 块的脚手架，
  // 不是执行点。它们天然没有可归一的脚本身份，混进端点集合只会制造需要人工分类的噪音。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd) || cmd.startsWith("[")) {
    return { kind: "shell", id: "shell:statement" };
  }
  // 控制关键字之后的执行位：只在内层**确实是执行点**时才采用内层身份。`for dir in …` 剥掉
  // 首词后是 unknown、`if [ -d x ]` 剥掉后是 shell 语句——它们不是执行点，必须仍按脚手架归类，
  // 否则脚手架会被误升成执行点，凭空多出一批需要人工分类的端点。
  const cdInner = stripCdCarrier(cmd);
  if (cdInner !== null) {
    const inner = endpointOf(cdInner, scripts);
    if (inner !== null && ["script", "tool", "alias", "pkg-filter"].includes(inner.kind)) {
      return inner;
    }
  }
  const carrier = CARRIER_RE.exec(cmd);
  if (carrier !== null) {
    // 剥掉尾部的 shell 终止符（`; then` / `; do` / `;` / `&`）：它们是载体语法的一部分，
    // 带进内层会把 `"$pkg"; then` 这种噪音算进判据面摘要。
    const innerCmd = carrier[1]
      .replace(/;\s*(?:then|do)\s*$/, "")
      .replace(/[;&]\s*$/, "")
      .trim();
    const inner = endpointOf(innerCmd, scripts);
    if (inner !== null && ["script", "tool", "alias", "pkg-filter"].includes(inner.kind))
      return inner;
  }
  if (SHELL_RE.test(cmd)) return { kind: "shell", id: cmd.split(/\s+/)[0] };
  return { kind: "unknown", id: cmd };
}

/** 一批命令 → 端点身份（丢掉 shell 脚手架）：键为 `kind:id`。 */
export function endpointSet(commands, scripts = {}) {
  const out = new Map();
  for (const command of commands) {
    const endpoint = endpointOf(command, scripts);
    if (endpoint === null || endpoint.kind === "shell") continue;
    out.set(`${endpoint.kind}:${endpoint.id}`, endpoint);
  }
  return out;
}
