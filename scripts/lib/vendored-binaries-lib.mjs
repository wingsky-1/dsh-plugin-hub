/**
 * vendored-binaries-lib — vendored 裸二进制的「分发面」判定、内容嗅探与登记表校验
 * （#784 遗留 D 项 / 批 2b）。
 *
 * 为什么判据轴是「会不会随发布物分发」而不是「文件是不是二进制」：本仓发布物自包含，
 * **内联 / 随包 = 分发库副本 = 合规义务**。而 `collect-licenses` 的内联证据来自 esbuild
 * 产物的 node_modules 路径注释——它对 vendored 裸二进制（.exe/.node/.dll）完全失明，
 * 于是「分发了一个副本却没附许可文本」可以一路静默到用户手里（#104 khroma 漏收同类）。
 *
 * 分发面 = 各包 package.json 的 files 白名单 **∪ npm 无论 files 都强制包含的位置**
 * （package.json、根级 README/LICENSE/CHANGELOG/NOTICE 变体、bin、main、
 * bundledDependencies 展开出的包内 node_modules 子树）：只读 files 会把「确实随包分发」
 * 的二进制判成不分发（实测 npm pack）。不另维护「排除 docs/lib/node_modules」这类硬编码
 * 排除表——那是第二份事实源（改包结构时不会同步），且会对 `test/fixtures/*.bin` 这种
 * 不分发的二进制产生假阳性，逼出门禁的逃生分支。
 *
 * 登记表是**数据**（scripts/data/vendored-binaries.json）：登记与豁免不得内嵌在门禁
 * 代码里（仓库硬约束）。哈希绑定用 node:crypto；内容嗅探用 isbinaryfile
 * （根 devDependency：内容判据、零运行时依赖、不制造环境前提）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { isBinaryFileSync } from "isbinaryfile";

import {
  AGGREGATE_NAME,
  MANIFEST_PATH_SEGMENTS,
  filterOutRetiredDirs,
  listPluginDirs,
  loadManifest,
} from "./plugins-manifest-lib.ts";
import { walkFiles } from "./walk-files.ts";

export const REGISTRY_REL = join("scripts", "data", "vendored-binaries.json");

/** 登记项字段与形态（语义判据由 verifyVendoredBinaries 逐条报 problem，此处只声明）。 */
export const ENTRY_FIELDS = ["path", "sha256", "license", "source", "licenseFile"];
const HEX64 = /^[0-9a-f]{64}$/;
const PKG_PATH = /^packages\/dsh-[a-z0-9-]+\//;
/** 通配符字符：命中即走 glob 展开（否则按字面路径处理，目录则整棵递归）。 */
const GLOB_CHARS = /[*?[\]{}]/;
/** npm 缺省 files 语义下不外发的顶层条目。 */
const DEFAULT_EXCLUDES = new Set(["node_modules", ".git"]);
/** npm 根级强制包含的松散文件名（README/LICENSE/CHANGELOG/NOTICE 的大小写与后缀变体）。 */
const FORCED_ROOT_FILE = /^(readme|licen[cs]e|changelog|notice)(\.[^/]*)?$/i;

/** 读登记表。结构非法（文件缺失 / 非法 JSON / 缺 entries）抛单行错误，不返回半成品。 */
export function loadVendoredRegistry(registryPath) {
  if (!existsSync(registryPath)) throw new Error(`登记表不存在：${registryPath}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (e) {
    throw new Error(`登记表非法 JSON：${String(e.message).split("\n")[0]}`);
  }
  if (!Array.isArray(raw?.entries)) throw new Error(`登记表缺 entries 数组：${registryPath}`);
  return raw.entries;
}

export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * 参与扫描的包目录：物理插件目录 + 聚合包（聚合包同样有 files 白名单、同样会分发）。
 * 退役残留目录无 package.json，按 pack-check 同因剔除；fixture 根（`--root` 只换扫描面）
 * 没有 manifest，此时无退役登记可言，取物理目录全集。
 */
export function packageDirs(root) {
  const dirs = listPluginDirs(root);
  if (existsSync(join(root, "packages", AGGREGATE_NAME))) dirs.push(AGGREGATE_NAME);
  const manifestPath = join(root, ...MANIFEST_PATH_SEGMENTS);
  if (!existsSync(manifestPath)) return dirs.sort();
  return filterOutRetiredDirs(dirs, loadManifest(root)).kept.sort();
}

/** 读某包的 package.json（缺失或非法返回 undefined，由展开逻辑按 npm 缺省语义处理）。 */
function readPackageJson(pkgDirAbs) {
  try {
    return JSON.parse(readFileSync(join(pkgDirAbs, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** 是否为普通文件：软链指向的目录不是，内容嗅探与读取会抛错（见 verify 的非文件报告）。 */
function isRegularFile(absPath) {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/**
 * files 条目的路径归一化：去首尾空白、前导 `./`、尾部 `/`。
 * npm 把 `lib/` 当 `lib`。不归一化会展开出 `lib//sub/tool.exe`，而登记表按规范路径写
 * （`lib/sub/tool.exe`），登记项反而被判「不在发布物面内」——把正确动作判红。
 */
function normalizeRel(entry) {
  return String(entry).trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** bin 字段的值形态：单个字符串，或 `名 → 字符串 | 字符串数组` 的映射。 */
function binPaths(bin) {
  const values =
    typeof bin === "string" ? [bin] : bin && typeof bin === "object" ? Object.values(bin) : [];
  return values
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => typeof v === "string" && v.trim() !== "");
}

/** bundledDependencies / bundleDependencies 里的依赖名（数组形态；legacy `true` 不展开）。 */
function bundledNames(pkgJson) {
  const raw = pkgJson.bundledDependencies ?? pkgJson.bundleDependencies;
  return Array.isArray(raw) ? raw.filter((n) => typeof n === "string" && n.trim() !== "") : [];
}

/**
 * npm「无论 files 都强制包含」的位置：package.json、根级 README/LICENSE/CHANGELOG/NOTICE
 * 变体、bin、main，以及 bundledDependencies 展开出的包内 `node_modules/<dep>` 子树。
 *
 * 只认**根级** README/LICENSE：npm 的强制包含规则不递归到子目录（实测 `files:["lib"]` 下
 * `docs/README` 不随包）；把非根级同名文件算进来是多报，会逼出逃生分支。只收磁盘上真实
 * 存在的普通文件——`files` 之外的位置若不存在就不是分发物，不该扩大扫描面。
 */
function forcedPaths(pkgDirAbs) {
  const out = new Set();
  if (isRegularFile(join(pkgDirAbs, "package.json"))) out.add("package.json");
  for (const name of readdirSync(pkgDirAbs)) {
    if (FORCED_ROOT_FILE.test(name) && isRegularFile(join(pkgDirAbs, name))) out.add(name);
  }
  const pkgJson = readPackageJson(pkgDirAbs) ?? {};
  const declared = [
    ...binPaths(pkgJson.bin),
    ...(typeof pkgJson.main === "string" ? [pkgJson.main] : []),
  ];
  for (const raw of declared) {
    const rel = normalizeRel(raw);
    if (rel !== "" && isRegularFile(join(pkgDirAbs, rel))) out.add(rel);
  }
  for (const dep of bundledNames(pkgJson)) {
    for (const p of expandEntry(pkgDirAbs, `node_modules/${dep}`)) out.add(p);
  }
  return out;
}

/** 读某包的 files 字段（缺省返回 undefined，由展开逻辑按 npm 缺省语义处理）。 */
function readFilesField(pkgDirAbs) {
  return readPackageJson(pkgDirAbs)?.files;
}

/**
 * 展开单个 files 条目为包内相对路径（/ 分隔）。
 * 目录条目整棵递归；glob 条目以**第一个通配符之前的目录**为遍历根——否则为匹配一个
 * `shared/**\/*.d.ts` 要遍历整包（含 node_modules），把秒级闸拖成分钟级。
 */
function expandEntry(pkgDirAbs, entry) {
  const globAt = entry.search(GLOB_CHARS);
  if (globAt === -1) {
    const abs = join(pkgDirAbs, entry);
    if (!existsSync(abs)) return [];
    if (!statSync(abs).isDirectory()) return [entry];
    return walkFiles(abs, () => true).map((r) => `${entry}/${r}`);
  }
  const head = entry.slice(0, globAt);
  const slash = head.lastIndexOf("/");
  const baseDir = slash === -1 ? "" : head.slice(0, slash);
  const absBase = baseDir ? join(pkgDirAbs, baseDir) : pkgDirAbs;
  if (!existsSync(absBase)) return [];
  return walkFiles(absBase, () => true)
    .map((r) => (baseDir ? `${baseDir}/${r}` : r))
    .filter((p) => matchesGlob(p, entry));
}

/**
 * 某包发布物面的包内相对路径全集（files 白名单展开，去重排序）。
 *
 * `!` 否定条目**不解释**：npm 的 files 是否支持否定模式（那是 .npmignore 的特性）无法从
 * 本仓现状证实，猜错的方向恰好是 fail-open（把真会分发的文件当成被排除）。故 `!x` 只按
 * 字面路径匹配、通常什么都不命中；真出现时表现为多报而非漏报，方向安全。
 */
export function distributionPaths(pkgDirAbs, filesField = readFilesField(pkgDirAbs)) {
  const patterns = Array.isArray(filesField)
    ? filesField
    : typeof filesField === "string"
      ? [filesField]
      : readdirSync(pkgDirAbs).filter((n) => !DEFAULT_EXCLUDES.has(n));
  const positives = new Set();
  for (const raw of patterns) {
    const entry = normalizeRel(raw);
    if (entry === "") continue;
    for (const p of expandEntry(pkgDirAbs, entry)) positives.add(p);
  }
  // npm 的强制包含集不受 files 约束（实测 `!README.bin` 也挡不住 README 随包），故并集在后。
  for (const p of forcedPaths(pkgDirAbs)) positives.add(p);
  return [...positives].sort();
}

/** 全仓发布物面（packages/<包>/<相对路径>），供登记项「在不在分发面内」判定复用同一事实源。 */
export function distributionSurface(root) {
  const surface = new Set();
  for (const pkg of packageDirs(root)) {
    const pkgDirAbs = join(root, "packages", pkg);
    for (const rel of distributionPaths(pkgDirAbs)) surface.add(`packages/${pkg}/${rel}`);
  }
  return surface;
}

/** 扫出**发布物面内**内容为二进制的文件（仓库相对路径，排序）。 */
export function scanVendoredBinaries(root, { isBinary = isBinaryFileSync } = {}) {
  const hits = [];
  for (const pkg of packageDirs(root)) {
    const pkgDirAbs = join(root, "packages", pkg);
    for (const rel of distributionPaths(pkgDirAbs)) {
      const repoRel = `packages/${pkg}/${rel}`;
      if (isBinary(join(root, repoRel))) hits.push(repoRel);
    }
  }
  return hits.sort();
}

/** 校验单条登记项的字段形态，返回问题列表（空 = 合法）。 */
function checkEntryShape(e, index) {
  const problems = [];
  const where = `entries[${index}]`;
  if (e === null || typeof e !== "object" || Array.isArray(e)) return [`${where} 不是对象`];
  const missing = ENTRY_FIELDS.filter((f) => typeof e[f] !== "string" || e[f].trim() === "");
  if (missing.length > 0) {
    return [`${where}（${e.path ?? "无 path"}）字段缺失或非字符串：${missing.join(", ")}`];
  }
  if (!PKG_PATH.test(e.path))
    problems.push(`${e.path} 不在 packages/<包>/ 下（登记表只登记发布物面内的包内文件）`);
  if (!PKG_PATH.test(e.licenseFile))
    problems.push(`${e.path} 的 licenseFile 不在 packages/<包>/ 下`);
  if (!HEX64.test(e.sha256)) problems.push(`${e.path} 的 sha256 形态非法（须 64 位小写十六进制）`);
  return problems;
}

/**
 * 门禁全量判据（供 CLI 与自测共用）。
 * 双向 fail-closed：扫到未登记的 ⇒ 红；登记了但文件消失 / 哈希漂移 / 内容已不是二进制 /
 * license 文本缺失或不在分发面内 ⇒ 红（防「登记表腐坏后判据静默失效」）。
 */
export function verifyVendoredBinaries(root, { registryPath, isBinary = isBinaryFileSync } = {}) {
  // 登记表不可读 = 判据不可执行，直接抛（调用方按结构错误 exit 2）——不得退化成「零命中放行」。
  const entries = loadVendoredRegistry(registryPath ?? join(root, REGISTRY_REL));

  const problems = [];
  const seen = new Set();
  // withPath：path 可用（供「已登记」集合与存在性/license 判据）；hashable：sha256 形态
  // 合法（形态非法的条目若再比一次哈希，同一处错误会被报成两条噪声问题）。
  const withPath = [];
  const hashable = new Set();
  for (const [i, e] of entries.entries()) {
    const shape = checkEntryShape(e, i);
    if (shape.length > 0) problems.push(...shape);
    if (typeof e?.path !== "string" || e.path.trim() === "") continue;
    if (seen.has(e.path)) problems.push(`${e.path} 重复登记`);
    seen.add(e.path);
    withPath.push(e);
    if (shape.length === 0) hashable.add(e);
  }

  const surface = distributionSurface(root);
  const hits = scanVendoredBinaries(root, { isBinary });
  // 扫描面为空 = 判据前提不成立（包结构或 root 传错），不得当作「零命中」放行。
  if (surface.size === 0) problems.push(`发布物面为空（扫描根 ${root}）：判据前提不成立`);

  const registered = new Set(withPath.map((e) => e.path));
  for (const hit of hits) {
    if (!registered.has(hit)) {
      problems.push(
        `未登记的裸二进制（在发布物面内 ⇒ 随包分发）：${hit}；请登记 sha256 与随包 license 文本`,
      );
    }
  }

  for (const e of withPath) {
    const abs = join(root, e.path);
    if (!existsSync(abs)) {
      problems.push(`${e.path} 登记项文件不存在（登记表与仓库脱钩）`);
    } else {
      if (!surface.has(e.path))
        problems.push(`${e.path} 不在发布物面内（登记它不产生任何合规效果）`);
      if (!isBinary(abs))
        problems.push(`${e.path} 内容已不是二进制（嗅探未命中）：登记表与事实脱钩`);
      if (hashable.has(e)) {
        const actual = sha256File(abs);
        if (actual !== e.sha256)
          problems.push(`${e.path} sha256 漂移：登记 ${e.sha256} 实际 ${actual}`);
      }
    }
    // license 文本必须随包发布：vendored 一个副本却只把许可放在 docs/（不分发）等于没附。
    if (typeof e.licenseFile !== "string" || e.licenseFile.trim() === "") continue;
    const licAbs = join(root, e.licenseFile);
    if (!existsSync(licAbs)) {
      problems.push(`${e.path} 的 license 文本不存在：${e.licenseFile}`);
    } else {
      if (!surface.has(e.licenseFile)) {
        problems.push(`${e.licenseFile} 不在发布物面内：vendored 了副本却没随包附许可文本`);
      }
      if (readFileSync(licAbs, "utf8").trim() === "") {
        problems.push(`${e.licenseFile} 为空文件（许可文本缺收）`);
      }
    }
  }

  return { problems, scanned: surface.size, registered: withPath.length, hits: hits.length };
}

/** 取某包在登记表里的条目（消费者：collect-licenses 归集、pack-check 随包断言）。 */
export function vendoredEntriesFor(root, pkgDirRel, registryPath) {
  const prefix = `${pkgDirRel}/`;
  return loadVendoredRegistry(registryPath ?? join(root, REGISTRY_REL)).filter(
    (e) => typeof e?.path === "string" && e.path.startsWith(prefix),
  );
}

/**
 * 随包断言（pack-check 消费）：登记项若真的进了 tarball，其许可文本必须出现在随包的
 * lib/THIRD-PARTY-LICENSES 里。与源码面判据互补——源码面保证「登记与分发面一致」，
 * 这里保证「最终发布物真的带了许可」。
 */
export function checkVendoredTarball(pkgRoot, pkgDirRel, entries) {
  const problems = [];
  const prefix = `${pkgDirRel}/`;
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    if (!existsSync(join(pkgRoot, e.path.slice(prefix.length)))) {
      problems.push(`登记的分发面二进制未随包发布：${e.path}`);
      continue;
    }
    const licPath = join(pkgRoot, "lib", "THIRD-PARTY-LICENSES");
    if (!existsSync(licPath)) {
      problems.push(`随包发布了 vendored 二进制（${e.path}）但缺 lib/THIRD-PARTY-LICENSES`);
      continue;
    }
    if (!readFileSync(licPath, "utf8").includes(e.path)) {
      problems.push(`lib/THIRD-PARTY-LICENSES 未覆盖 vendored 二进制 ${e.path}`);
    }
  }
  return problems;
}
