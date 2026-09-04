/**
 * audit.mjs — 隔离审计核心（#517 B4：隔离审计白名单版）纯函数层。
 *
 * 供 verify-isolated.mjs 的 `--audit` 集成调用：t0 基线快照（挂载完成后、
 * 脚本自身写面之前）与 t1 终态快照（dsh 退出后）对比，白名单外的变化报
 * 「可疑」，不阻断退出（审计是补充非门禁）。本模块零依赖、只做「纯 stat
 * 路径级」判定（lstat 不读文件内容），smoke 用 mkdtemp fixture 直接断言
 * 正反例行为（见 test/smoke.ts）。
 *
 * ## 口径（#517 评论 B4 方案，实现注释说明）
 *
 * 1. **范围硬绑定扫描根**：只扫传入的 root（$ISOLATED_HOME 子树 +
 *    --audit-extra-dirs 指定的额外目录），不扫真实 home——文档写明局限。
 * 2. **symlink 防逃逸（不排除、而是防逃逸）**：快照用 lstat（不跟随），
 *    symlink 只记录 linkTarget 不读目标内容（安全）；profile node_modules
 *    全 `link:` symlink 是挂载机制本身，**t0 已存在且目标未变的外部 symlink
 *    （link: 挂载点）合法不报**；t1 时**新增的**或**目标变化**且 resolve 后
 *    在扫描根外的 symlink 报「越界 symlink」（防插件经 symlink 写回主
 *    checkout）。防逃逸优先于白名单忽略——白名单目录（profiles/** 等）内
 *    新增越界 symlink 同样报可疑。
 * 3. **判定面 = 白名单模式外的新增/删除/修改**（路径级，不读内容）；
 *    白名单内变化忽略（dsh 重写 settings 是常态）。未知顶层路径 → 可疑。
 * 4. **首跑学习**（#517 方案：学习仅交叉校验 dsh 版本写面漂移）本模块不做
 *    判定源——判定面只有预置白名单，版本化 `WHITELIST_V` 随 skill 分发、
 *    smoke 断言存在。
 * 5. **browser-profile/** 整树白名单 + 跳过深扫**：chromium user-data-dir
 *    数万文件，快照只记录目录条目不递归（skipDeep）。
 *
 * resolve 口径说明：越界判定用 path.resolve（第一跳语义，不 realpath
 * 跟随 symlink 链）——与「快照不跟随 symlink、不读目标」原则一致；链接
 * 目标为相对路径时以链接所在目录为基准解析。
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** 白名单版本（预置模式数组版本化；smoke 断言存在与格式）。 */
export const WHITELIST_V = "v1";

/**
 * 预置白名单模式数组（判定面）：命中模式 = 预期写面，变化忽略；未命中 =
 * 可疑（新增/删除/修改）。模式语义：
 *   - `dir/**`：整树前缀匹配（目录本身及其下一切）；
 *   - `*.ext`：**仅顶层**文件扩展名匹配（子目录内不生效——未知顶层目录
 *     下的任何文件都算可疑，贴合「未知顶层路径→可疑」）；
 *   - 其余：顶层精确文件名。
 */
export const WHITELIST = Object.freeze([
  "profiles/**",
  "*.json",
  "*.jsonl",
  "*.log",
  "browser.state",
  "browser-profile/**",
  "evidence/**",
  "audit/**",
  "dsh.log",
  "verdict.json",
]);

/** 跳过深扫的整树白名单（chromium user-data-dir 数万文件，只记目录条目）。 */
export const SKIP_DEEP = Object.freeze(["browser-profile/**"]);

/** 白名单模式匹配（目录前缀 / 顶层扩展名 / 顶层精确文件，见 WHITELIST 注释）。 */
function matchPattern(relPath, pattern) {
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return relPath === dir || relPath.startsWith(dir + "/");
  }
  if (pattern.startsWith("*.")) {
    if (relPath.includes("/")) return false;
    return relPath.endsWith(pattern.slice(1));
  }
  return relPath === pattern;
}

/**
 * 路径级快照：递归 lstat 遍历 root（不跟随 symlink），返回
 * `{ root, entries: Map<relPath, Entry> }`。Entry：
 *   - dir：`{ type: "dir" }`（mtime 变化是子条目副作用，不参与修改判定）；
 *   - file：`{ type: "file", size, mtimeMs }`（修改判定面）；
 *   - symlink：`{ type: "symlink", linkTarget }`（只记录目标，不读内容；
 *     越界判定走 checkSymlinkEscape）；
 *   - other：fifo/socket 等非常规条目。
 * `opts.skipDeep` 命中的目录只记录目录条目、不递归（browser-profile/**）。
 */
export function scanSnapshot(root, opts = {}) {
  const entries = new Map();
  const skipDeep = opts.skipDeep ?? [];
  const walk = (dir, rel) => {
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      const childPath = resolve(dir, d.name);
      if (d.isSymbolicLink()) {
        let target = null;
        try { target = readlinkSync(childPath); } catch {}
        entries.set(childRel, { type: "symlink", linkTarget: target });
        continue; // 不跟随 symlink（防逃逸核心：快照不读链接目标内容）
      }
      if (d.isDirectory()) {
        entries.set(childRel, { type: "dir" });
        if (skipDeep.some((p) => matchPattern(childRel, p))) continue;
        walk(childPath, childRel);
      } else if (d.isFile()) {
        let st = null;
        try { st = lstatSync(childPath); } catch {}
        entries.set(childRel, { type: "file", size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 });
      } else {
        entries.set(childRel, { type: "other" });
      }
    }
  };
  walk(root, "");
  return { root, entries };
}

/** 条目是否构成「修改」（目录自身 mtime 变化不报，防子条目副作用噪音）。 */
function isModified(e0, e1) {
  if (e0.type === "dir" && e1.type === "dir") return false;
  if (e0.type === "file" && e1.type === "file") {
    return e0.size !== e1.size || e0.mtimeMs !== e1.mtimeMs;
  }
  if (e0.type === "symlink" && e1.type === "symlink") {
    return e0.linkTarget !== e1.linkTarget;
  }
  return e0.type !== e1.type; // 类型变化（file→dir 等）也算修改
}

/**
 * 白名单 diff：t1 相对 t0 的**白名单外**新增/删除/修改（symlink 的目标
 * 变化在此报「修改」，但 runAudit 组合层会把越界 symlink 剔除单独报）。
 * 返回 `{ added, removed, modified }`，每项 `{ path, type }`。
 */
export function diffAgainstWhitelist(t0, t1, whitelist) {
  const added = [];
  const removed = [];
  const modified = [];
  const isWl = (rel) => whitelist.some((p) => matchPattern(rel, p));
  for (const [rel, e1] of t1.entries) {
    if (isWl(rel)) continue;
    const e0 = t0.entries.get(rel);
    if (!e0) { added.push({ path: rel, type: e1.type }); continue; }
    if (isModified(e0, e1)) modified.push({ path: rel, type: e1.type });
  }
  for (const [rel, e0] of t0.entries) {
    if (isWl(rel)) continue;
    if (!t1.entries.has(rel)) removed.push({ path: rel, type: e0.type });
  }
  return { added, removed, modified };
}

/** child 是否位于 parent 内（含自身；resolve 后的绝对路径比较）。 */
function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * symlink 越界几何判定（单快照）：返回该快照内全部 resolve 后在
 * isolatedRoot 外的 symlink `{ path, target, resolved }`。**不含 t0/t1
 * 对比**——「t0 已存在且目标未变的外部 symlink 合法不报」的剔除在
 * runAudit 组合层（见下）。
 */
export function checkSymlinkEscape(snapshot, isolatedRoot) {
  const rootAbs = resolve(snapshot.root);
  const boundAbs = resolve(isolatedRoot);
  const escapes = [];
  for (const [rel, e] of snapshot.entries) {
    if (e.type !== "symlink" || e.linkTarget === null) continue;
    const linkAbs = resolve(rootAbs, rel);
    const targetAbs = isAbsolute(e.linkTarget)
      ? resolve(e.linkTarget)
      : resolve(dirname(linkAbs), e.linkTarget);
    if (!isInside(targetAbs, boundAbs)) {
      escapes.push({ path: rel, target: e.linkTarget, resolved: targetAbs });
    }
  }
  return escapes;
}

/**
 * 组合审计：单扫描根对（t0 基线 → t1 终态）的可疑项全集。
 * `isolatedRoot` 为越界判定基准（= 该扫描根自身：$ISOLATED_HOME 或
 * --audit-extra-dirs 目录）。返回
 * `{ suspicious: [{path, type, detail?}], count, conclusion }`：
 *   - 白名单外新增/删除/修改（diffAgainstWhitelist，剔除越界重复报）；
 *   - 越界 symlink：t1 全部越界中剔除「t0 已存在且 linkTarget 未变」
 *     （link: 挂载点合法）；防逃逸优先于白名单——白名单内新增越界 symlink
 *     仍报。
 * 类型文案：新增 / 删除 / 修改 / 越界 symlink。
 */
export function runAudit({ t0, t1, isolatedRoot, whitelist = WHITELIST }) {
  const diff = diffAgainstWhitelist(t0, t1, whitelist);
  const escapes = checkSymlinkEscape(t1, isolatedRoot).filter((s) => {
    const e0 = t0.entries.get(s.path);
    return !e0 || e0.type !== "symlink" || e0.linkTarget !== s.target;
  });
  const escapePaths = new Set(escapes.map((s) => s.path));
  const suspicious = [
    ...diff.added.filter((x) => !escapePaths.has(x.path)).map((x) => ({ path: x.path, type: "新增" })),
    ...diff.removed.map((x) => ({ path: x.path, type: "删除" })),
    ...diff.modified.filter((x) => !escapePaths.has(x.path)).map((x) => ({ path: x.path, type: "修改" })),
    ...escapes.map((s) => ({
      path: s.path,
      type: "越界 symlink",
      detail: `${s.target} → ${s.resolved}`,
    })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    suspicious,
    count: suspicious.length,
    conclusion: suspicious.length === 0 ? "pass" : "suspicious",
  };
}
