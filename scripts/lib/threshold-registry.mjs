#!/usr/bin/env node
// @ts-nocheck
/**
 * threshold-registry — 阈值事实源**声明表**的读取、自洽校验与通用比较器（#843 D5）。
 *
 * 设计口径：
 *   - 事实源 + 路径 + 方向 + 删键语义是**数据**（scripts/data/threshold-registry.json）；
 *     比较逻辑按 kind 通用求值，新增同类事实源只需在表里加一条，不必再写读取分支。
 *   - **未登记即红**：枚举口径是运行时读 scripts/data/*.json（除本表自身），不在表里抄第二份
 *     清单——否则「新事实源忘了声明」这个根因会以另一种形态复发。
 *   - 面类判据（覆盖率 exclude / 变异段 mutate 的扩张收缩）**不在这里**：需要 glob 求值，
 *     落在 verify-coverage-scope 与 gen-stryker-conf 的判据⑤（#843 裁决清单 v2 的 C-2/C-3）。
 *   - 本库不碰 git / 不读时间：两侧事实源由调用方注入（readBase / readWorkspace），
 *     使比较器可以对着 fixture 直接跑，也让「基准侧缺失 = 首次引入」这类语义留在调用方。
 *
 * 三态：failures（放宽/摘除，exit 1）/ envErrors（配置或环境故障，exit 2，fail-closed）/
 * warnings（非单调旋钮的收紧方向，只报警不判红）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const REGISTRY_PATH = "scripts/data/threshold-registry.json";
export const DATA_DIR = "scripts/data";
export const IMPLEMENTED_KINDS = ["value", "boolean", "baseline", "existence"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(label + " JSON 解析失败：" + err.message);
  }
}

function joinPath(prefix, key) {
  return prefix === "" ? key : prefix + "." + key;
}

/** 点分路径求值（`*` 展开对象键），返回 [[具体路径, 值], ...]；中途非对象即该分支消失。 */
export function resolveDotted(root, dotted) {
  let level = [["", root]];
  for (const segment of dotted.split(".")) {
    const next = [];
    for (const [prefix, value] of level) {
      if (!isObject(value)) continue;
      if (segment === "*") {
        for (const [key, inner] of Object.entries(value)) next.push([joinPath(prefix, key), inner]);
      } else if (Object.hasOwn(value, segment)) {
        next.push([joinPath(prefix, segment), value[segment]]);
      }
    }
    level = next;
    if (level.length === 0) return [];
  }
  return level;
}

/** 取单个（无通配）路径的值；无命中返回 undefined。 */
export function resolveSingle(root, dotted) {
  const hits = resolveDotted(root, dotted);
  return hits.length === 0 ? undefined : hits[0][1];
}

export function loadRegistry(repoRoot) {
  const path = join(repoRoot, REGISTRY_PATH);
  if (!existsSync(path)) throw new Error("阈值声明表缺失：" + REGISTRY_PATH);
  const json = readJsonText(readFileSync(path, "utf8"), REGISTRY_PATH);
  if (!isObject(json)) throw new Error(REGISTRY_PATH + " 顶层必须是对象");
  if (!Array.isArray(json.guards)) throw new Error(REGISTRY_PATH + " 缺 guards 数组");
  if (!Array.isArray(json.notAGate)) throw new Error(REGISTRY_PATH + " 缺 notAGate 数组");
  return json;
}

/**
 * 按声明顺序取第一个**存在**的事实源。存在但取不到事实（reader 返回 null）时停在原地、
 * 不继续回落——回落链的语义是「基准侧还没迁到新事实源」，不是「取不到就换一个源」。
 */
export function makeSourceLoader({ read, textReaders = {}, label }) {
  return (guard) => {
    for (const source of guard.sources) {
      const text = read(source);
      if (text === null || text === undefined) continue;
      const reader = textReaders[source];
      const value = reader ? reader(text, source) : readJsonText(text, label + " " + source);
      return { source, value };
    }
    return null;
  };
}

/** kind=value 的叶子：有 keys 时逐键取数字，否则直接取数字；非数字一律视为「不存在」。 */
function numericLeaves(guard, value) {
  const leaves = new Map();
  if (value === undefined || value === null) return leaves;
  for (const dotted of guard.paths) {
    for (const [path, node] of resolveDotted(value, dotted)) {
      if (Array.isArray(guard.keys)) {
        if (!isObject(node)) continue;
        for (const key of guard.keys) {
          if (typeof node[key] === "number") leaves.set(path + "." + key, node[key]);
        }
      } else if (typeof node === "number") {
        leaves.set(path, node);
      }
    }
  }
  return leaves;
}

function factCount(guard, value) {
  if (value === undefined || value === null) return 0;
  if (guard.kind === "value") return numericLeaves(guard, value).size;
  let count = 0;
  for (const dotted of guard.paths) count += resolveDotted(value, dotted).length;
  return count;
}

function describeWeaken(guard) {
  return guard.weaken === "decrease" ? "下调" : "上调";
}

function compareValueGuard(ctx) {
  const { guard, loadBase, loadWorkspace, failures, warnings, envErrors, skips } = ctx;
  const baseSide = loadBase(guard);
  if (baseSide === null) {
    skips.push(guard.id + "：基准上无 " + guard.sources.join(" / ") + " —— 首次引入，跳过对比");
    return;
  }
  const before = numericLeaves(guard, baseSide.value);
  if (before.size === 0) {
    skips.push(guard.id + "：基准侧无该事实（首次引入），跳过对比");
    return;
  }
  const wsSide = loadWorkspace(guard);
  const after = wsSide === null ? new Map() : numericLeaves(guard, wsSide.value);
  if (guard.missingIsError === true && after.size === 0) {
    envErrors.push(
      guard.id +
        "：工作区 " +
        guard.sources[0] +
        " 缺 " +
        guard.paths.join(", ") +
        " —— 硬门禁被摘除，fail-closed",
    );
    return;
  }
  for (const [path, oldValue] of before) {
    if (!after.has(path)) {
      if (guard.onRemoval === "fail") {
        failures.push(
          guard.id +
            "：" +
            path +
            " 被移除（基准 " +
            oldValue +
            "）—— 删键等价于摘除该维度的硬门禁；" +
            guard.hint,
        );
      }
      continue;
    }
    const newValue = after.get(path);
    const weaker = guard.weaken === "decrease" ? newValue < oldValue : newValue > oldValue;
    if (weaker) {
      failures.push(
        guard.id +
          "：" +
          path +
          " 放宽：" +
          oldValue +
          " → " +
          newValue +
          "（" +
          describeWeaken(guard) +
          "）；" +
          guard.hint,
      );
    } else if (guard.nonMonotonic === true) {
      const tighter = guard.weaken === "decrease" ? newValue > oldValue : newValue < oldValue;
      if (tighter) {
        warnings.push(
          guard.id +
            "：" +
            path +
            " 收紧：" +
            oldValue +
            " → " +
            newValue +
            " —— 该格不是单调旋钮（收紧方向另有风险），本表只报警不判红；" +
            guard.hint,
        );
      }
    }
  }
}

function compareBooleanGuard(ctx) {
  const { guard, loadBase, loadWorkspace, failures, envErrors, skips } = ctx;
  const baseSide = loadBase(guard);
  if (baseSide === null) {
    skips.push(guard.id + "：基准上无 " + guard.sources.join(" / ") + " —— 首次引入，跳过对比");
    return;
  }
  const before = new Map();
  for (const dotted of guard.paths) {
    for (const [path, node] of resolveDotted(baseSide.value, dotted)) {
      if (typeof node === "boolean") before.set(path, node);
    }
  }
  if (before.size === 0) {
    skips.push(guard.id + "：基准侧无该开关（首次引入），跳过对比");
    return;
  }
  const wsSide = loadWorkspace(guard);
  const after = new Map();
  if (wsSide !== null) {
    for (const dotted of guard.paths) {
      for (const [path, node] of resolveDotted(wsSide.value, dotted)) {
        if (typeof node === "boolean") after.set(path, node);
      }
    }
  }
  if (guard.missingIsError === true && after.size === 0) {
    envErrors.push(guard.id + "：工作区缺该开关 —— fail-closed");
    return;
  }
  for (const [path, oldValue] of before) {
    if (!after.has(path)) {
      if (guard.onRemoval === "fail") {
        failures.push(
          guard.id +
            "：" +
            path +
            " 被移除（基准 " +
            oldValue +
            "）—— 摘除开关即摘除判据；" +
            guard.hint,
        );
      }
      continue;
    }
    const newValue = after.get(path);
    if (oldValue !== guard.weakenValue && newValue === guard.weakenValue) {
      failures.push(
        guard.id + "：" + path + " 放宽：" + oldValue + " → " + newValue + "；" + guard.hint,
      );
    }
  }
}

function effectiveAnchor(entry, fields) {
  if (!isObject(entry)) return null;
  for (const field of fields) {
    if (typeof entry[field] === "number") return { field, value: entry[field] };
  }
  return null;
}

function compareBaselineGuard(ctx) {
  const { guard, loadBase, loadWorkspace, failures, skips } = ctx;
  const baseSide = loadBase(guard);
  const wsSide = loadWorkspace(guard);
  if (baseSide === null || wsSide === null) {
    skips.push(guard.id + "：基准或工作区缺 " + guard.sources[0] + " —— 跳过对比");
    return;
  }
  const beforeTable = resolveSingle(baseSide.value, guard.paths[0]);
  const afterTable = resolveSingle(wsSide.value, guard.paths[0]);
  if (!isObject(afterTable)) {
    skips.push(guard.id + "：工作区无 " + guard.paths[0] + "（由 existence 守卫负责）");
    return;
  }
  for (const [pkg, entry] of Object.entries(afterTable)) {
    const before = effectiveAnchor(
      isObject(beforeTable) ? beforeTable[pkg] : undefined,
      guard.anchorFields,
    );
    const after = effectiveAnchor(entry, guard.anchorFields);
    if (before === null) continue;
    if (after === null) {
      if (guard.onRemoval === "fail") {
        failures.push(
          guard.id +
            "：" +
            guard.paths[0] +
            "." +
            pkg +
            " 的回落锚点（" +
            guard.anchorFields.join(" / ") +
            "）被移除（基准 " +
            before.value +
            "）—— 掉回观察期语义；" +
            guard.hint,
        );
      }
      continue;
    }
    if (after.value < before.value) {
      failures.push(
        guard.id +
          "：" +
          guard.paths[0] +
          "." +
          pkg +
          " 回落锚点下调：" +
          before.value +
          "（" +
          before.field +
          "）→ " +
          after.value +
          "（" +
          after.field +
          "）；" +
          guard.hint,
      );
    }
  }
}

function readExemptKeys(ctx, guard) {
  if (guard.exemptFrom === undefined) return new Set();
  const side = ctx.loadWorkspace({ sources: [guard.exemptFrom.source] });
  if (side === null || !isObject(side.value)) return new Set();
  const node = resolveSingle(side.value, guard.exemptFrom.path);
  if (!isObject(node)) return new Set();
  return new Set(Object.keys(node).filter((key) => !key.startsWith("$")));
}

/** 按 guard 声明的 universe 从包目录派生应受约束的包集合（目录结构是独立事实源）。 */
function universePackages(guard, packages) {
  const prefix =
    isObject(guard.universe) && typeof guard.universe.prefix === "string"
      ? guard.universe.prefix
      : "";
  const requireDir = isObject(guard.universe) ? guard.universe.requireDir : undefined;
  return packages
    .filter((pkg) => pkg.name.startsWith(prefix))
    .filter((pkg) => requireDir === undefined || requireDir === "" || pkg.dirs.includes(requireDir))
    .map((pkg) => pkg.name);
}

function compareExistenceGuard(ctx) {
  const { guard, loadWorkspace, exemptions, failures, envErrors } = ctx;
  const universe = universePackages(guard, ctx.packages);
  const wsSide = loadWorkspace(guard);
  if (wsSide === null) {
    if (universe.length > 0) {
      envErrors.push(
        guard.id +
          "：工作区无 " +
          guard.sources[0] +
          " 而有 " +
          universe.length +
          " 个应受约束的包 —— 事实源缺失，fail-closed",
      );
    }
    return;
  }
  const table = resolveSingle(wsSide.value, guard.paths[0]);
  const exemptKeys = readExemptKeys(ctx, guard);
  const fields = Array.isArray(guard.requireFields) ? guard.requireFields : [];
  for (const pkg of universe) {
    if (exemptKeys.has(pkg)) continue;
    const ledgerKey = guard.paths[0] + "." + pkg;
    if (exemptions.has(ledgerKey)) continue;
    const entry = isObject(table) ? table[pkg] : undefined;
    if (!isObject(entry)) {
      failures.push(
        guard.id +
          "：包 " +
          pkg +
          " 有 src 但不在 " +
          guard.paths[0] +
          " —— 整包退出变异门禁；" +
          guard.hint,
      );
      continue;
    }
    if (fields.length > 0 && !fields.some((field) => typeof entry[field] === "number")) {
      failures.push(
        guard.id +
          "：包 " +
          pkg +
          " 没有声明任何回落锚点（" +
          fields.join(" / ") +
          "）—— 回落判据对它恒为假（regressed 永远 false），该包永远不会被判回落；" +
          guard.hint,
      );
    }
  }
}

const COMPARATORS = {
  value: compareValueGuard,
  boolean: compareBooleanGuard,
  baseline: compareBaselineGuard,
  existence: compareExistenceGuard,
};

/** 逐条求值声明表；返回 { failures, warnings, envErrors, skips }。 */
export function compareRegistry({
  registry,
  readBase,
  readWorkspace,
  textReaders = {},
  packages = [],
  exemptions = new Map(),
}) {
  const ctx = {
    loadBase: makeSourceLoader({ read: readBase, textReaders, label: "基准" }),
    loadWorkspace: makeSourceLoader({ read: readWorkspace, textReaders, label: "工作区" }),
    packages,
    exemptions,
    failures: [],
    warnings: [],
    envErrors: [],
    skips: [],
  };
  for (const guard of registry.guards) {
    ctx.guard = guard;
    COMPARATORS[guard.kind](ctx);
  }
  return {
    failures: ctx.failures,
    warnings: ctx.warnings,
    envErrors: ctx.envErrors,
    skips: ctx.skips,
  };
}

function validateGuardShape(guard, problems) {
  const id =
    typeof guard.id === "string" && guard.id !== "" ? guard.id : JSON.stringify(guard).slice(0, 80);
  if (typeof guard.id !== "string" || guard.id === "") problems.push("guard 缺 id：" + id);
  if (!IMPLEMENTED_KINDS.includes(guard.kind)) {
    problems.push(
      id +
        "：kind " +
        JSON.stringify(guard.kind) +
        " 没有实现（值域 " +
        IMPLEMENTED_KINDS.join(" / ") +
        "）",
    );
  }
  for (const field of ["why", "hint"]) {
    if (typeof guard[field] !== "string" || guard[field] === "")
      problems.push(id + "：缺 " + field);
  }
  if (!Array.isArray(guard.sources) || guard.sources.length === 0)
    problems.push(id + "：缺 sources");
  if (!Array.isArray(guard.paths) || guard.paths.length === 0) problems.push(id + "：缺 paths");
  if (guard.kind === "value" && guard.weaken !== "decrease" && guard.weaken !== "increase") {
    problems.push(id + "：kind=value 必须声明 weaken（decrease / increase）");
  }
  if (guard.kind === "boolean" && typeof guard.weakenValue !== "boolean") {
    problems.push(id + "：kind=boolean 必须声明 weakenValue（等于该值即放宽）");
  }
  if (
    guard.kind === "baseline" &&
    (!Array.isArray(guard.anchorFields) || guard.anchorFields.length === 0)
  ) {
    problems.push(id + "：kind=baseline 必须声明 anchorFields（回退链顺序）");
  }
  if (guard.kind === "existence" && !isObject(guard.universe)) {
    problems.push(id + "：kind=existence 必须声明 universe（枚举口径）");
  }
  if (guard.kind !== "existence" && guard.onRemoval !== "fail" && guard.onRemoval !== "ignore") {
    problems.push(id + "：必须声明 onRemoval（fail / ignore）——删键语义不能靠默认值");
  }
}

/** 声明表的结构与覆盖面校验（不读基准侧）：未登记的数据文件 / 幽灵声明 / 缺字段。 */
export function validateDeclarations(registry, { repoRoot, dataDir = DATA_DIR } = {}) {
  const problems = [];
  const ids = new Set();
  for (const guard of registry.guards) {
    if (ids.has(guard.id)) problems.push("guard id 重复：" + guard.id);
    ids.add(guard.id);
    validateGuardShape(guard, problems);
    if (typeof repoRoot === "string" && Array.isArray(guard.sources)) {
      const existing = guard.sources.filter((source) => existsSync(join(repoRoot, source)));
      if (existing.length === 0)
        problems.push(guard.id + "：sources 一个都不存在（" + guard.sources.join(" / ") + "）");
    }
  }
  const declared = new Set();
  for (const guard of registry.guards) {
    for (const source of guard.sources ?? []) declared.add(source);
    // exemptFrom 读的是**另一份事实源**（如 topology 的 $noMutationPackages）：它同样要进已声明集合，
    // 否则「existence 守卫的豁免清单」会以未登记数据文件的形态被判红，而修法是把它塞进 sources 假声明。
    if (isObject(guard.exemptFrom) && typeof guard.exemptFrom.source === "string") {
      declared.add(guard.exemptFrom.source);
    }
  }
  for (const item of registry.notAGate) {
    if (!isObject(item) || typeof item.source !== "string" || item.source === "") {
      problems.push("notAGate 条目缺 source：" + JSON.stringify(item).slice(0, 80));
      continue;
    }
    if (typeof item.why !== "string" || item.why === "")
      problems.push("notAGate " + item.source + "：缺 why（不守护也要说明为什么）");
    if (typeof repoRoot === "string" && !existsSync(join(repoRoot, item.source))) {
      problems.push("notAGate " + item.source + "：声明的文件不存在（幽灵声明，删除时须同步本表）");
    }
    declared.add(item.source);
  }
  if (typeof repoRoot === "string") {
    const dir = join(repoRoot, dataDir);
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort();
      for (const name of files) {
        const rel = dataDir + "/" + name;
        if (rel === REGISTRY_PATH) continue;
        if (!declared.has(rel)) {
          problems.push(
            rel +
              " 未在声明表登记 —— 每个阈值事实源必须显式声明「守护」或 not-a-gate（未登记即红）",
          );
        }
      }
    }
  }
  return problems;
}

/** 声明的路径必须真的取得到值（两侧都取不到 = 幽灵判据），否则守卫是自我安慰。 */
export function validateGuardFacts(registry, { loadBase, loadWorkspace }) {
  const problems = [];
  for (const guard of registry.guards) {
    const base = loadBase(guard);
    const ws = loadWorkspace(guard);
    if (base === null && ws === null) {
      problems.push(guard.id + "：sources 在工作区与基准上都不存在（悬空声明）");
      continue;
    }
    const count =
      factCount(guard, base === null ? undefined : base.value) +
      factCount(guard, ws === null ? undefined : ws.value);
    if (count === 0) {
      problems.push(
        guard.id + "：声明的路径 " + guard.paths.join(", ") + " 在两侧都取不到值（幽灵判据）",
      );
    }
  }
  return problems;
}
