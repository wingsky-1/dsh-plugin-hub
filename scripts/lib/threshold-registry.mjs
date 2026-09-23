#!/usr/bin/env node
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
 *   - `sources` 是**回落链**（按声明顺序取第一个存在的源）。它相对基准只许**尾部追加**：
 *     前置或重排会让守卫读到另一个文件，而基准侧与工作区侧各自独立解析，两侧就可能对着不同的
 *     事实源比较——影子源正是这样把守卫与被守护的事实源解耦的。比较器另记录两侧实际命中的源，
 *     工作区命中一个基准未声明的文件即判红。
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
export function makeSourceLoader({ read, textReaders = {}, label, onHit }) {
  return (guard) => {
    for (const source of guard.sources) {
      const text = read(source);
      if (text === null || text === undefined) continue;
      const reader = textReaders[source];
      const value = reader ? reader(text, source) : readJsonText(text, label + " " + source);
      if (typeof onHit === "function") onHit(source, guard);
      return { source, value };
    }
    return null;
  };
}

/** kind=value 的叶子：有 keys 时逐键取数字，否则直接取数字；非数字一律视为「不存在」。
 *
 * 导出给调用方层（threshold-monotonic 的改名识别）复用：纯值函数，不含任何路径启发式，
 * 模板对齐（`*` 段比较）一律留在调用方，lib 只做「模板→叶子」的通用求值。 */
export function numericLeaves(guard, value) {
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

/**
 * 「声明的判据在事实源里到底命中了几处」。count>0 才算这条声明不是幽灵——
 * 因此每种 kind 必须按**它自己的语义**数：路径存在与「取到了能参与判据的事实」不是一回事，
 * 对 boolean 声明一个字符串字段、对 baseline 声明一个不存在的锚点字段，都会让判据恒不生效。
 */
function factCount(guard, value) {
  if (value === undefined || value === null) return 0;
  if (guard.kind === "value") return numericLeaves(guard, value).size;
  if (guard.kind === "boolean") {
    let count = 0;
    for (const dotted of guard.paths) {
      for (const [, node] of resolveDotted(value, dotted)) {
        if (typeof node === "boolean") count += 1;
      }
    }
    return count;
  }
  if (guard.kind === "baseline") {
    const table = resolveSingle(value, guard.paths[0]);
    if (!isObject(table)) return 0;
    return Object.values(table).filter(
      (entry) => effectiveAnchor(entry, guard.anchorFields) !== null,
    ).length;
  }
  let count = 0;
  for (const dotted of guard.paths) count += resolveDotted(value, dotted).length;
  return count;
}

function describeWeaken(guard) {
  return guard.weaken === "decrease" ? "下调" : "上调";
}

function compareValueGuard(ctx) {
  const { guard, loadBase, loadWorkspace, failures, warnings, envErrors, skips } = ctx;
  const { exemptions, usedExemptions } = ctx;
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
  // 绝对下限（minAllowed）：相对基准的比较对**新增条目**天然无效（首次引入 = 跳过对比），
  // 于是「包改名后按 threshold=1 重新登记」能绕过逐包阈值——下限不受首次引入影响。
  if (typeof guard.minAllowed === "number") {
    for (const [path, value] of after) {
      if (value < guard.minAllowed) {
        failures.push(
          guard.id +
            "：" +
            path +
            " = " +
            value +
            " 低于下限 " +
            guard.minAllowed +
            "（新增条目同样受约束）；" +
            guard.hint,
        );
      }
    }
  }
  // 绝对上限（maxAllowed）：weaken=increase 的旋钮没有上限时，新增条目可以取任意大值——
  // 相对比较对它天然无效（首次引入 = 跳过对比），与 minAllowed 同理。
  if (typeof guard.maxAllowed === "number") {
    for (const [path, value] of after) {
      if (value > guard.maxAllowed) {
        failures.push(
          guard.id +
            "：" +
            path +
            " = " +
            value +
            " 超过上限 " +
            guard.maxAllowed +
            "（新增条目同样受约束）；" +
            guard.hint,
        );
      }
    }
  }
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
        // 整包退役这类「条目该删」的场景与「静默摘除判据」在数据上同形，故给前者一条显式台账
        // 通道：豁免键是**被移除的具体叶子路径** + `#removal`，与 existence 守卫的
        // `#membership` / `#anchor` 一样按判据分开登记，不放宽任何阈值的比较。
        const removalKey = path + "#removal";
        if (exemptions.has(removalKey)) {
          usedExemptions.add(removalKey);
          continue;
        }
        failures.push(
          guard.id +
            "：" +
            path +
            " 被移除（基准 " +
            oldValue +
            "）—— 删键等价于摘除该维度的硬门禁；确要退役该条目请在 " +
            removalKey +
            " 登记豁免；" +
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

/** 回退链生效锚（anchorFields 顺序第一个命中的数字字段）；调用方层的锚同治复用，同上纯值。 */
export function effectiveAnchor(entry, fields) {
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
    const beforeEntry = isObject(beforeTable) ? beforeTable[pkg] : undefined;
    // 逐字段各自只许抬不许降：只比「生效锚点」会漏掉非生效字段被悄悄下调
    // （fixedCovered 仍在、baselineCovered 92.27 → 0.5），而 why 声明的是「逐包回落锚点只许抬不许降」。
    const beforeFields = guard.anchorFields.filter(
      (field) => typeof beforeEntry?.[field] === "number",
    );
    const afterFields = guard.anchorFields.filter((field) => typeof entry[field] === "number");
    for (const field of beforeFields) {
      if (typeof entry[field] !== "number" || entry[field] >= beforeEntry[field]) continue;
      failures.push(
        guard.id +
          "：" +
          guard.paths[0] +
          "." +
          pkg +
          "." +
          field +
          " 回落锚点下调：" +
          beforeEntry[field] +
          " → " +
          entry[field] +
          "；" +
          guard.hint,
      );
    }
    // 字段集合没变时上面已覆盖；只有集合变了（换字段 / 摘字段）才读回退链的**生效值**，
    // 否则同一处下调会被两条判据各计一次。
    if (beforeFields.join(",") === afterFields.join(",")) continue;
    const before = effectiveAnchor(beforeEntry, guard.anchorFields);
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
  if (guard.exemptFrom === undefined) return { keys: new Set(), problems: [] };
  const problems = [];
  const side = ctx.loadWorkspace({ sources: [guard.exemptFrom.source] });
  if (side === null || !isObject(side.value)) return { keys: new Set(), problems };
  const node = resolveSingle(side.value, guard.exemptFrom.path);
  if (!isObject(node)) return { keys: new Set(), problems };
  const keys = new Set();
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    keys.add(key);
    // 豁免理由必须是可读的裁决记录：空串与缺值都使「为什么这个包不进变异面」无从复核。
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(
        guard.id +
          "：" +
          guard.exemptFrom.source +
          " 的 " +
          guard.exemptFrom.path +
          "「" +
          key +
          "」的豁免理由必须是非空字符串",
      );
    }
  }
  return { keys, problems };
}

/**
 * 声明表自身可被削弱的字段，以及每个字段「怎么算变弱」。它不是「值的范围」而是「判据的形状」：
 * 翻 direction、把删键语义改成 ignore、摘掉一条 paths/keys/sources，都会让原本判红的放宽变成合法——
 * 而表本身是数据，改一行不需要碰任何代码，所以必须由同一套「相对基准只许补全收紧」的语义守住它自己。
 * 语义必须分档：一律「变了就红」会把收紧也拦下（例如给逐包阈值补一个绝对下限、给 onRemoval 从
 * ignore 改成 fail），那会让合法的加固也需要批准块，最终逼出「批准块写满」的假治理。
 */
const CONTRACT_RULES = {
  kind: "equal",
  weaken: "equal",
  weakenValue: "equal",
  onRemoval: "from-fail",
  paths: "superset",
  keys: "superset",
  anchorFields: "superset",
  requireFields: "superset",
  sources: "tail-append",
  missingIsError: "from-true",
  nonMonotonic: "from-true",
  minAllowed: "floor",
  maxAllowed: "ceiling",
};

/** 该字段相对基准是否被「削弱」（true = 变弱，需要批准块）。 */
function isWeakenedChange(rule, before, after) {
  if (rule === "equal") return JSON.stringify(before) !== JSON.stringify(after);
  if (rule === "superset") {
    if (!Array.isArray(before) || before.length === 0) return false;
    const now = Array.isArray(after) ? after : [];
    return before.some((item) => !now.includes(item));
  }
  // 回落链只许**尾部追加**：前置或重排会让守卫读到另一个文件，而基准侧与工作区侧各自
  // 独立解析——「先加一个镜像基准值的影子源、再篡改真实事实源」正是靠前置把两侧解耦的。
  if (rule === "tail-append") {
    if (!Array.isArray(before)) return false;
    const now = Array.isArray(after) ? after : [];
    if (now.length < before.length) return true;
    return before.some((item, index) => now[index] !== item);
  }
  if (rule === "from-fail") return before === "fail" && after !== "fail";
  if (rule === "from-true") return before === true && after !== true;
  if (rule === "floor") {
    if (typeof before !== "number") return false;
    return typeof after !== "number" || after < before;
  }
  if (rule === "ceiling") {
    if (typeof before !== "number") return false;
    return typeof after !== "number" || after > before;
  }
  return false;
}

const CONTRACT_FIELDS = [
  "kind",
  "weaken",
  "weakenValue",
  "onRemoval",
  "paths",
  "keys",
  "anchorFields",
  "requireFields",
  "sources",
  "missingIsError",
  "nonMonotonic",
  "minAllowed",
  "maxAllowed",
];

function approvalKey(id, field) {
  return id + "::" + field;
}

/**
 * 声明表自身的对比（#843 对抗评审 P0-1）：guard **只许新增**，同 id 的判据形状字段只许
 * 「补全 / 收紧」（`sources` 是尾部追加，不是任意改写），除非在 `retired`（整条退役）或
 * `contractApprovals`（改某个字段）里显式登记 id + trackingIssue + reason。
 * 两条通道都做反向腐烂：登记了却无对应改动 = 失效条目，判红。
 */
export function compareDeclarationTable(baseRegistry, workspaceRegistry) {
  const failures = [];
  const retired = new Map();
  for (const entry of workspaceRegistry.retired ?? []) {
    if (isObject(entry) && typeof entry.id === "string") retired.set(entry.id, entry);
  }
  const approvals = new Map();
  for (const entry of workspaceRegistry.contractApprovals ?? []) {
    if (isObject(entry) && typeof entry.id === "string" && typeof entry.field === "string") {
      approvals.set(approvalKey(entry.id, entry.field), entry);
    }
  }
  const usedRetired = new Set();
  const usedApprovals = new Set();
  const wsById = new Map((workspaceRegistry.guards ?? []).map((guard) => [guard.id, guard]));

  for (const baseGuard of baseRegistry.guards ?? []) {
    const nowGuard = wsById.get(baseGuard.id);
    if (nowGuard === undefined) {
      if (retired.has(baseGuard.id)) usedRetired.add(baseGuard.id);
      else {
        failures.push(
          "声明表：" +
            baseGuard.id +
            " 被整体移除 —— 删掉一条 guard 等于摘掉该事实源的判据；确要退役请在 retired 里登记 { id, trackingIssue, reason }",
        );
      }
      continue;
    }
    for (const field of CONTRACT_FIELDS) {
      if (!isWeakenedChange(CONTRACT_RULES[field], baseGuard[field], nowGuard[field])) continue;
      const key = approvalKey(baseGuard.id, field);
      if (approvals.has(key)) {
        usedApprovals.add(key);
        continue;
      }
      failures.push(
        "声明表：" +
          baseGuard.id +
          "." +
          field +
          " 相对基准被改动（" +
          JSON.stringify(baseGuard[field]) +
          " → " +
          JSON.stringify(nowGuard[field]) +
          "）—— 判据形状只许补全收紧，确要改动请在 contractApprovals 里登记 { id, field, trackingIssue, reason }",
      );
    }
  }
  for (const id of retired.keys()) {
    if (!usedRetired.has(id)) {
      failures.push(
        "声明表：retired 里的 " + id + " 已无对应退役（基准上没有这条 guard）—— 失效条目，请删除",
      );
    }
  }
  for (const [key, entry] of approvals) {
    if (!usedApprovals.has(key)) {
      failures.push(
        "声明表：contractApprovals 里的 " +
          entry.id +
          " / " +
          entry.field +
          " 已无对应改动 —— 批准块失效，请删除该条",
      );
    }
  }
  return failures;
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
  const { guard, loadWorkspace, exemptions, usedExemptions, failures, envErrors } = ctx;
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
  const exempt = readExemptKeys(ctx, guard);
  failures.push(...exempt.problems);
  const fields = Array.isArray(guard.requireFields) ? guard.requireFields : [];
  // 表 → 磁盘的反向悬空检查：包改名/退役后忘删的条目会让阈值判据对它空转（而且改名后
  // 新条目天然走「首次引入」，等于用改名换一次免检）。
  if (ctx.packages.length > 0 && isObject(table)) {
    for (const key of Object.keys(table)) {
      if (key.startsWith("$")) continue;
      if (universe.includes(key) || exempt.keys.has(key)) continue;
      failures.push(
        guard.id +
          "：" +
          guard.paths[0] +
          "." +
          key +
          " 没有对应的真实包（packages/" +
          key +
          " 下无 " +
          (guard.universe?.requireDir ?? "src") +
          "）—— 条目只许随包存在，改名或退役必须同步；" +
          guard.hint,
      );
    }
  }
  for (const pkg of universe) {
    if (exempt.keys.has(pkg)) continue;
    // 豁免按判据分开登记：一条豁免只能关掉它声明的那一条（否则「只豁免锚点」会顺带
    // 豁免「整包退出变异面」，条目 reason 与机制就会不符）。
    const membershipKey = guard.paths[0] + "." + pkg + "#membership";
    const anchorKey = guard.paths[0] + "." + pkg + "#anchor";
    const membershipExempt = exemptions.has(membershipKey);
    const anchorExempt = exemptions.has(anchorKey);
    if (membershipExempt) usedExemptions.add(membershipKey);
    if (anchorExempt) usedExemptions.add(anchorKey);
    const entry = isObject(table) ? table[pkg] : undefined;
    if (!isObject(entry)) {
      if (!membershipExempt) {
        failures.push(
          guard.id +
            "：包 " +
            pkg +
            " 有 src 但不在 " +
            guard.paths[0] +
            " —— 整包退出变异门禁；" +
            guard.hint,
        );
      }
      continue;
    }
    // 「有锚点」不是「字段是数字」：observe-check 的回退链取 fixedCovered ?? baselineCovered，
    // 生效锚点为 0（或负数）时 regressed = covered < 0 - 1 恒为假，与没有锚点等价，
    // 于是绝对下限必须落在**生效值**上，而不是逐个字段判类型。
    const anchorValue = effectiveAnchor(entry, fields);
    const hasAnchor = fields.length === 0 || (anchorValue !== null && anchorValue.value > 0);
    if (!hasAnchor && !anchorExempt) {
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
    // 台账反向腐烂：豁免还在，但它要豁免的缺口已经不存在了——照 gate-wiring 台账的同形做法判红，
    // 否则台账会长期挂着一堆「已经没有缺口」的条目，把到期复核变成噪音。
    if (membershipExempt) {
      failures.push(
        guard.id +
          "：台账里 " +
          membershipKey +
          " 的豁免已无对应缺口（该包已在 " +
          guard.paths[0] +
          " 里）—— 反向腐烂，请删除该条目",
      );
    }
    if (anchorExempt && hasAnchor) {
      failures.push(
        guard.id +
          "：台账里 " +
          anchorKey +
          " 的豁免已无对应缺口（该包已声明回落锚点）—— 反向腐烂，请删除该条目",
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

/**
 * 逐条求值声明表；返回 { failures, warnings, envErrors, skips }。
 *
 * @param {object} args
 * @param {{ guards: Array<{ id: string } & Record<string, unknown>> }} args.registry 声明表（比较器真实形状：guard 具 id）
 * @param {(rel: string) => string | null} args.readBase 基准读取
 * @param {(rel: string) => string | null} args.readWorkspace 工作区读取
 * @param {Record<string, unknown>} [args.textReaders] 文本读取器
 * @param {Array<{ name: string, dirs: string[] }>} [args.packages] 工作区包清单
 * @param {Map<string, unknown>} [args.exemptions] 豁免台账（只读）
 */
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
    usedExemptions: new Set(),
    failures: [],
    warnings: [],
    envErrors: [],
    skips: [],
  };
  for (const guard of registry.guards) {
    ctx.guard = guard;
    COMPARATORS[guard.kind](ctx);
  }
  // 台账反向腐烂：识别不了的键（后缀写错 / 包已不存在 / 缺口已消失）与「缺口消失」同罪，
  // 否则台账会长期挂着一堆其实什么也没豁免的条目，把到期复核变成噪音。
  for (const key of exemptions.keys()) {
    if (ctx.usedExemptions.has(key)) continue;
    ctx.failures.push(
      "台账里的 " + key + " 没有对应的判据缺口（无法识别的键或反向腐烂）—— 请删除该条目",
    );
  }
  return {
    failures: ctx.failures,
    warnings: ctx.warnings,
    envErrors: ctx.envErrors,
    skips: ctx.skips,
  };
}

function guardDisplayId(guard) {
  if (typeof guard.id === "string" && guard.id !== "") return guard.id;
  return JSON.stringify(guard).slice(0, 80);
}
function checkGuardIdentity(guard, id, out) {
  if (typeof guard.id !== "string" || guard.id === "") out.push("guard 缺 id：" + id);
  if (!IMPLEMENTED_KINDS.includes(guard.kind)) {
    out.push(
      id +
        "：kind " +
        JSON.stringify(guard.kind) +
        " 没有实现（值域 " +
        IMPLEMENTED_KINDS.join(" / ") +
        "）",
    );
  }
}
function checkGuardDocs(guard, id, out) {
  for (const field of ["why", "hint"]) {
    if (typeof guard[field] !== "string" || guard[field] === "") out.push(id + "：缺 " + field);
  }
  if (!Array.isArray(guard.sources) || guard.sources.length === 0) out.push(id + "：缺 sources");
  if (!Array.isArray(guard.paths) || guard.paths.length === 0) out.push(id + "：缺 paths");
}
function checkGuardSimpleKinds(guard, id, out) {
  if (guard.kind === "value" && guard.weaken !== "decrease" && guard.weaken !== "increase") {
    out.push(id + "：kind=value 必须声明 weaken（decrease / increase）");
  }
  if (guard.kind === "boolean" && typeof guard.weakenValue !== "boolean") {
    out.push(id + "：kind=boolean 必须声明 weakenValue（等于该值即放宽）");
  }
}
function checkGuardAnchoredKinds(guard, id, out) {
  if (
    guard.kind === "baseline" &&
    (!Array.isArray(guard.anchorFields) || guard.anchorFields.length === 0)
  ) {
    out.push(id + "：kind=baseline 必须声明 anchorFields（回退链顺序）");
  }
  if (guard.kind === "existence" && !isObject(guard.universe)) {
    out.push(id + "：kind=existence 必须声明 universe（枚举口径）");
  }
  if (guard.kind !== "existence" && guard.onRemoval !== "fail" && guard.onRemoval !== "ignore") {
    out.push(id + "：必须声明 onRemoval（fail / ignore）——删键语义不能靠默认值");
  }
}
function checkGuardKindFields(guard, id, out) {
  checkGuardSimpleKinds(guard, id, out);
  checkGuardAnchoredKinds(guard, id, out);
}
function checkGuardBounds(guard, id, out) {
  // 两个绝对边界写错类型会被静默忽略（字符串不与数字比较），于是「加了上限」变成一句没有判据的声明。
  for (const field of ["minAllowed", "maxAllowed"]) {
    if (guard[field] !== undefined && typeof guard[field] !== "number") {
      out.push(id + "：" + field + " 必须是数字（当前 " + JSON.stringify(guard[field]) + "）");
    }
  }
}
function validateGuardShape(guard) {
  const out = [];
  const id = guardDisplayId(guard);
  checkGuardIdentity(guard, id, out);
  checkGuardDocs(guard, id, out);
  checkGuardKindFields(guard, id, out);
  checkGuardBounds(guard, id, out);
  return out;
}

/**
 * 「未登记即红」的枚举边界：只认 dataDir **顶层**、扩展名 .json（大小写不敏感）的文件。
 * .jsonc、子目录与其它扩展名不在面内——它们是文档化的边界，不是运行时才发现的漏洞；
 * 边界写进常量是为了让这条口径有唯一出处，改动它会同时改到用例。
 */
export const DATA_FILE_EXTENSION = ".json";
export function isEnumeratedDataFile(name) {
  return name.toLowerCase().endsWith(DATA_FILE_EXTENSION);
}

/**
 * 声明表的结构与覆盖面校验（不读基准侧）：未登记的数据文件 / 幽灵声明 / 缺字段。
 * consumed 是工作区侧**实际被读取**的事实源集合：只在 sources 里列一个文件名不算登记，
 * 否则任何新 JSON 只要挂进某条 guard 的 sources 就能绕过「未登记即红」（影子源攻击的洗白路径）。
 * 基准侧尚无本表（本表首次引入的 PR）时，声明表比对与命中源比对都无从进行，该形态在这里
 * 以「列过名字但谁都没读到」的判词 fail-closed 走 exit 2；本表入库后同一攻击走 exit 1。
 */
function checkGuardEntries(registry, repoRoot) {
  const out = [];
  const ids = new Set();
  for (const guard of registry.guards) {
    if (ids.has(guard.id)) out.push("guard id 重复：" + guard.id);
    ids.add(guard.id);
    out.push(...validateGuardShape(guard));
    if (typeof repoRoot === "string" && Array.isArray(guard.sources)) {
      const existing = guard.sources.filter((source) => existsSync(join(repoRoot, source)));
      if (existing.length === 0)
        out.push(guard.id + "：sources 一个都不存在（" + guard.sources.join(" / ") + "）");
    }
  }
  return out;
}
function retiredDetailProblems(entry, guardIds) {
  const out = [];
  if (typeof entry.trackingIssue !== "string" || !/^#\d+$/.test(entry.trackingIssue)) {
    out.push("retired " + entry.id + "：缺 trackingIssue（形如 #123）—— 退役必须可审计");
  }
  if (typeof entry.reason !== "string" || entry.reason === "") {
    out.push("retired " + entry.id + "：缺 reason");
  }
  if (guardIds.has(entry.id)) {
    out.push("retired " + entry.id + "：该 id 仍在 guards 里（退役登记与事实不符）");
  }
  return out;
}
function checkRetiredEntries(registry) {
  const out = [];
  const guardIds = new Set((registry.guards ?? []).map((guard) => guard.id));
  const retiredIds = new Set();
  for (const entry of registry.retired ?? []) {
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id === "") {
      out.push("retired 条目缺 id");
      continue;
    }
    if (retiredIds.has(entry.id)) out.push("retired id 重复：" + entry.id);
    retiredIds.add(entry.id);
    out.push(...retiredDetailProblems(entry, guardIds));
  }
  return out;
}
function approvalDetailProblems(entry, label) {
  const out = [];
  if (typeof entry.field !== "string" || entry.field === "") {
    out.push("contractApprovals 条目缺 field：" + label);
  }
  if (typeof entry.trackingIssue !== "string" || !/^#\d+$/.test(entry.trackingIssue)) {
    out.push("contractApprovals " + label + "：缺 trackingIssue（形如 #123）");
  }
  if (typeof entry.reason !== "string" || entry.reason === "") {
    out.push("contractApprovals " + label + "：缺 reason");
  }
  return out;
}
function checkApprovalEntries(registry) {
  const out = [];
  for (const entry of registry.contractApprovals ?? []) {
    if (!isObject(entry)) {
      out.push("contractApprovals 含非对象项");
      continue;
    }
    const label = String(entry.id) + " / " + String(entry.field);
    if (typeof entry.id !== "string" || entry.id === "") out.push("contractApprovals 条目缺 id");
    out.push(...approvalDetailProblems(entry, label));
  }
  return out;
}
function checkNotAGateEntries(registry, repoRoot, declared) {
  const out = [];
  for (const item of registry.notAGate) {
    if (!isObject(item) || typeof item.source !== "string" || item.source === "") {
      out.push("notAGate 条目缺 source：" + JSON.stringify(item).slice(0, 80));
      continue;
    }
    if (typeof item.why !== "string" || item.why === "")
      out.push("notAGate " + item.source + "：缺 why（不守护也要说明为什么）");
    if (typeof repoRoot === "string" && !existsSync(join(repoRoot, item.source))) {
      out.push("notAGate " + item.source + "：声明的文件不存在（幽灵声明，删除时须同步本表）");
    }
    declared.add(item.source);
  }
  return out;
}
function collectDeclared(registry, consumed) {
  const declared = new Set(consumed ?? []);
  // 「出现在某条 guard 的 sources 里」与「确实被读到」是两件事：前者只是意向声明。
  // 影子源攻击正是靠前者洗白（把新文件挂进 sources），所以判词要能区分这两种状态。
  const declaredAsSource = new Set();
  for (const guard of registry.guards) {
    for (const source of guard.sources ?? []) declaredAsSource.add(source);
    if (consumed === undefined) {
      for (const source of guard.sources ?? []) declared.add(source);
    }
    // exemptFrom 读的是**另一份事实源**（如 topology 的 `$noMutationPackages`）：它同样要进已声明集合，
    // 否则「existence 守卫的豁免清单」会以未登记数据文件的形态被判红，而修法是把它塞进 sources 假声明。
    if (isObject(guard.exemptFrom) && typeof guard.exemptFrom.source === "string") {
      declared.add(guard.exemptFrom.source);
    }
  }
  return { declared: declared, declaredAsSource: declaredAsSource };
}
function checkUndeclaredFiles(repoRoot, dataDir, declared, declaredAsSource) {
  const out = [];
  if (typeof repoRoot === "string") {
    const dir = join(repoRoot, dataDir);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(isEnumeratedDataFile).sort();
      for (const name of files) {
        const rel = dataDir + "/" + name;
        if (rel === REGISTRY_PATH) continue;
        if (!declared.has(rel)) {
          // 只在 sources 里列名、却没有任何 guard 真读到它：真实源被更靠前的源接管（影子源），
          // 或该源已脱管。基准侧有本表时这条会先落在 exit 1 的判据放宽通道；基准侧还没有本表
          // （本表首次引入）时无从比对，只能按未登记 fail-closed 走 exit 2——判词要点名这一形态。
          out.push(
            rel +
              (declaredAsSource.has(rel)
                ? " 未在声明表登记：有 guard 在 sources 里列过它，但工作区里没有任何 guard 实际读到它（更靠前的源接管了该守卫，即影子源；或该源已脱管）"
                : " 未在声明表登记 —— 每个阈值事实源必须显式声明「守护」或 not-a-gate（未登记即红）"),
          );
        }
      }
    }
  }
  return out;
}
export function validateDeclarations(registry, { repoRoot, dataDir = DATA_DIR, consumed } = {}) {
  const problems = [];
  problems.push(...checkGuardEntries(registry, repoRoot));
  problems.push(...checkRetiredEntries(registry));
  problems.push(...checkApprovalEntries(registry));
  const { declared, declaredAsSource } = collectDeclared(registry, consumed);
  problems.push(...checkNotAGateEntries(registry, repoRoot, declared));
  problems.push(...checkUndeclaredFiles(repoRoot, dataDir, declared, declaredAsSource));
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
      // 判词按 kind 指向真正没命中的那部分声明：baseline 的判据在 anchorFields 上，
      // 只报 paths 会让人去找一个其实存在、只是没有锚点的表。
      const what =
        guard.kind === "baseline"
          ? "声明的锚点字段 " +
            guard.anchorFields.join(", ") +
            " 在两侧都取不到值（幽灵判据：回退链没有任何一个字段命中）"
          : guard.kind === "boolean"
            ? "声明的路径 " +
              guard.paths.join(", ") +
              " 在两侧都没有取到布尔值（幽灵判据：这条开关判据恒不生效）"
            : "声明的路径 " + guard.paths.join(", ") + " 在两侧都取不到值（幽灵判据）";
      problems.push(guard.id + "：" + what);
    }
  }
  return problems;
}
