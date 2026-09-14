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
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
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

/** vendored（第三方副本）登记项必填字段；语义判据由 verifyVendoredBinaries 逐条报 problem。 */
const ENTRY_FIELDS = ["path", "sha256", "license", "source", "licenseFile"];
/** first-party（本仓自有二进制资产）只要求哈希绑定：没有第三方许可义务可言。 */
const FIRST_PARTY_FIELDS = ["path", "sha256"];
/** 登记项类别：缺省 vendored（第三方副本）。 */
const KINDS = new Set(["vendored", "first-party"]);
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

/** 解析 files 条目：`!` 前缀为否定条目（npm 支持，实测只会打包未被否定的文件）。 */
function parseEntry(raw) {
  const trimmed = String(raw).trim();
  const negated = trimmed.startsWith("!");
  return { negated, entry: normalizeRel(negated ? trimmed.slice(1) : trimmed) };
}

/**
 * 否定条目命中判定：含通配符的走 matchesGlob（与正向展开同一个匹配器）；字面条目按
 * 「自身或整棵子树」排除——npm 的 `!dir` 排除该目录下全部文件。
 */
function matchesNegation(rel, pattern) {
  if (GLOB_CHARS.test(pattern)) return matchesGlob(rel, pattern);
  return rel === pattern || rel.startsWith(`${pattern}/`);
}

/** 内容嗅探的采样窗口：头 8 KiB 覆盖文件头特征，尾 1 KiB 覆盖「正文之后才是二进制」的形态。 */
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 1024;

/** 读文件头/尾两段采样（不整文件读入：vendored 二进制动辄数十 MB）。 */
function readHeadTail(absPath) {
  const fd = openSync(absPath, "r");
  try {
    const size = fstatSync(fd).size;
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) readSync(fd, tail, 0, tailLen, size - tailLen);
    return [head, alignUtf8Start(tail)];
  } finally {
    closeSync(fd);
  }
}

/**
 * 把采样起点挪到 UTF-8 字符边界（跳过被截断字符的续字节 10xxxxxx）。截断的多字节序列会被
 * isbinaryfile 计成可疑字节，纯中文文本（本仓生成的 `.d.ts`）因此会被判成二进制——采样窗口
 * 不能制造新的假阳性。尾部终点是 EOF，天然落在字符边界上。
 */
function alignUtf8Start(buf) {
  let cut = 0;
  while (cut < buf.length - 1 && (buf[cut] & 0xc0) === 0x80) cut++;
  return buf.subarray(cut);
}

/** 文本编码 BOM：带 BOM 的 UTF-16/32 文本自身含 NUL，与 isbinaryfile 的豁免口径保持一致。 */
function hasTextBom(buf) {
  return (
    (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ||
    (buf[0] === 0xff && buf[1] === 0xfe) ||
    (buf[0] === 0xfe && buf[1] === 0xff) ||
    (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff)
  );
}

/**
 * 内容嗅探：头尾各采一段，任一判为二进制即真。
 *
 * 为什么不直接 `isBinaryFileSync(路径)`：它只看文件前 512 字节（isbinaryfile 的 MAX_BYTES），
 * 「前 512 字节纯 ASCII、二进制在其后」会被判成文本，真分发出去的副本因此不登记、不附许可
 * 文本。采样段还要整段过一遍 NUL——喂进 isbinaryfile 的缓冲同样只扫前 512 字节，尾段开头与
 * 头部重叠的字节会被再扫一次，边界之后的 NUL 依旧落在窗口外；NUL 检测本就是它的核心判据，
 * 这里只是把窗口放大到整段采样。其余启发式（PNG / UTF-16 / 高字节）仍交给 isbinaryfile。
 */
function sniffBinary(absPath, isBinary = isBinaryFileSync) {
  return readHeadTail(absPath).some((buf) => sniffSample(buf, isBinary));
}

function sniffSample(buf, isBinary) {
  return isBinary(buf) || (!hasTextBom(buf) && buf.includes(0));
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
    for (const p of expandEntry(pkgDirAbs, `node_modules/${dep}`) ?? []) out.add(p);
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
 * 返回 null = 该条目在磁盘上不存在（未构建的 `lib/` 等），交给调用方报告，不当成空集吞掉。
 */
function expandEntry(pkgDirAbs, entry) {
  const globAt = entry.search(GLOB_CHARS);
  if (globAt === -1) {
    const abs = join(pkgDirAbs, entry);
    if (!existsSync(abs)) return null;
    if (!statSync(abs).isDirectory()) return [entry];
    return walkFiles(abs, () => true).map((r) => `${entry}/${r}`);
  }
  const head = entry.slice(0, globAt);
  const slash = head.lastIndexOf("/");
  const baseDir = slash === -1 ? "" : head.slice(0, slash);
  const absBase = baseDir ? join(pkgDirAbs, baseDir) : pkgDirAbs;
  if (!existsSync(absBase)) return null;
  return walkFiles(absBase, () => true)
    .map((r) => (baseDir ? `${baseDir}/${r}` : r))
    .filter((p) => matchesGlob(p, entry));
}

/**
 * 某包发布物面的展开结果：files 白名单（含 `!` 否定）∪ npm 强制包含集，去重排序。
 *
 * 否定条目按 npm 语义处理：先展开正向集合，再滤掉命中否定模式的相对路径。原先把 `!x`
 * 当字面路径、等于不解释否定，`files:["assets","!assets/secret.bin"]` 会把 npm 明确排除的
 * 文件判成随包分发（多报），逼用户登记一个根本不发布的副本。
 *
 * 否定只作用于 files 展开出的路径：npm 的强制包含集不受否定约束（实测 `!README.bin`
 * 挡不住 README 随包），故先过滤再并集。
 *
 * `missing` = files 里声明了、磁盘上却没有的条目：未构建的工作副本扫描面会静默变小
 * （实测 `--root` 副本 30 文件 vs 源码树 371 文件），不装作没发生，但也不判红——判据面是
 * 源码树，构建产物由 pack-check 的 tarball 断言覆盖。
 */
export function distributionReport(pkgDirAbs, filesField = readFilesField(pkgDirAbs)) {
  const patterns = Array.isArray(filesField)
    ? filesField
    : typeof filesField === "string"
      ? [filesField]
      : readdirSync(pkgDirAbs).filter((n) => !DEFAULT_EXCLUDES.has(n));
  const positives = new Set();
  const negatives = [];
  const missing = [];
  for (const raw of patterns) {
    const { negated, entry } = parseEntry(raw);
    if (entry === "") continue;
    if (negated) {
      negatives.push(entry);
      continue;
    }
    const expanded = expandEntry(pkgDirAbs, entry);
    if (expanded === null) missing.push(entry);
    else for (const p of expanded) positives.add(p);
  }
  const kept = [...positives].filter((p) => !negatives.some((n) => matchesNegation(p, n)));
  for (const p of forcedPaths(pkgDirAbs)) kept.push(p);
  return { paths: [...new Set(kept)].sort(), missing: missing.sort() };
}

/** 某包发布物面的包内相对路径全集（distributionReport 的路径视图）。 */
export function distributionPaths(pkgDirAbs, filesField) {
  return distributionReport(pkgDirAbs, filesField).paths;
}

/** 全仓发布物面 + 「files 声明了但磁盘上不存在」的条目（后者只报告，不判红）。 */
function distributionSurfaceReport(root) {
  const surface = new Set();
  const missing = [];
  for (const pkg of packageDirs(root)) {
    const report = distributionReport(join(root, "packages", pkg));
    for (const rel of report.paths) surface.add(`packages/${pkg}/${rel}`);
    for (const rel of report.missing) missing.push(`packages/${pkg}/${rel}`);
  }
  return { surface, missing: missing.sort() };
}

/** 全仓发布物面（packages/<包>/<相对路径>），供登记项「在不在分发面内」判定复用同一事实源。 */
export function distributionSurface(root) {
  return distributionSurfaceReport(root).surface;
}

/**
 * 扫出**发布物面内**内容为二进制的文件（仓库相对路径，排序）。
 * `isBinary` 是内容嗅探器：接收**采样缓冲**、返回是否二进制（缺省 isbinaryfile，见 sniffBinary）。
 *
 * @param {string} root 仓库根。
 * @param {{ isBinary?: (sample: Buffer) => boolean }} [options] 见上：嗅探器接收采样缓冲，缺省 isbinaryfile。
 */
export function scanVendoredBinaries(root, { isBinary = isBinaryFileSync } = {}) {
  const hits = [];
  for (const pkg of packageDirs(root)) {
    const pkgDirAbs = join(root, "packages", pkg);
    for (const rel of distributionPaths(pkgDirAbs)) {
      const repoRel = `packages/${pkg}/${rel}`;
      const abs = join(root, repoRel);
      // 软链目录会被 walkFiles 当文件收进面内，而嗅探器对目录抛错（Path provided was not a
      // file!）——整条判据因此退化成 exit 2 的「环境错误」。它不是随包分发的普通文件
      // （npm 不跟随软链目录），跳过嗅探；报告由 verify 用可读文案给出。
      if (!isRegularFile(abs)) continue;
      if (sniffBinary(abs, isBinary)) hits.push(repoRel);
    }
  }
  return hits.sort();
}

/**
 * 登记项类别。缺省 vendored（第三方副本，有许可随包义务）；first-party = 本仓自有的
 * 二进制资产（随包图标这类），它没有第三方许可义务——不给这个形态，第一方资产出现时只能
 * 伪造 source/license 才能消红，还会被写进第三方许可段。
 */
export function kindOf(entry) {
  return entry?.kind === "first-party" ? "first-party" : "vendored";
}

/** 校验单条登记项的字段形态，返回问题列表（空 = 合法）。 */
function checkEntryShape(e, index) {
  const problems = [];
  const where = `entries[${index}]`;
  if (e === null || typeof e !== "object" || Array.isArray(e)) return [`${where} 不是对象`];
  if (e.kind !== undefined && !KINDS.has(e.kind)) {
    problems.push(
      `${where}（${e.path ?? "无 path"}）kind 非法：${String(e.kind)}（可选 ${[...KINDS].join(" / ")}）`,
    );
  }
  const required = kindOf(e) === "first-party" ? FIRST_PARTY_FIELDS : ENTRY_FIELDS;
  const missing = required.filter((f) => typeof e[f] !== "string" || e[f].trim() === "");
  if (missing.length > 0) {
    return [
      ...problems,
      `${where}（${e.path ?? "无 path"}）字段缺失或非字符串：${missing.join(", ")}`,
    ];
  }
  if (!PKG_PATH.test(e.path))
    problems.push(`${e.path} 不在 packages/<包>/ 下（登记表只登记发布物面内的包内文件）`);
  if (kindOf(e) !== "first-party" && !PKG_PATH.test(e.licenseFile))
    problems.push(`${e.path} 的 licenseFile 不在 packages/<包>/ 下`);
  if (!HEX64.test(e.sha256)) problems.push(`${e.path} 的 sha256 形态非法（须 64 位小写十六进制）`);
  return problems;
}

/**
 * 门禁全量判据（供 CLI 与自测共用）。
 * 双向 fail-closed：扫到未登记的 ⇒ 红；登记了但文件消失 / 哈希漂移 / 内容已不是二进制 /
 * license 文本缺失或不在分发面内 ⇒ 红（防「登记表腐坏后判据静默失效」）。
 * `reports` 是不判红的诚实报告（未构建的声明条目等），CLI 打印但不影响退出码。
 *
 * @param {string} root 仓库根（登记表缺省位置与分发面都相对它解析）。
 * @param {{ registryPath?: string, isBinary?: (sample: Buffer) => boolean }} [options]
 *   registryPath：登记表路径（缺省 scripts/data/vendored-binaries.json）；
 *   isBinary：内容嗅探器，接收采样缓冲（缺省 isbinaryfile）。
 */
export function verifyVendoredBinaries(root, { registryPath, isBinary = isBinaryFileSync } = {}) {
  // 登记表不可读 = 判据不可执行，直接抛（调用方按结构错误 exit 2）——不得退化成「零命中放行」。
  const entries = loadVendoredRegistry(registryPath ?? join(root, REGISTRY_REL));

  const problems = [];
  const reports = [];
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

  const { surface, missing } = distributionSurfaceReport(root);
  const hits = scanVendoredBinaries(root, { isBinary });
  // 扫描面为空 = 判据前提不成立（包结构或 root 传错），不得当作「零命中」放行。
  if (surface.size === 0) problems.push(`发布物面为空（扫描根 ${root}）：判据前提不成立`);
  // 扫描面静默变小是事实，但拿文件数下限去判红只会制造脆弱判据；报告出来让人看见即可。
  for (const rel of missing) {
    reports.push(
      `${rel} 在 files 白名单里声明但磁盘上不存在（未构建的工作副本扫描面会静默变小）；` +
        `本闸判据面是源码树，构建产物由 pack-check 的 tarball 断言覆盖`,
    );
  }
  // 非普通文件（软链目录/悬空软链）：内容嗅探对它抛错，而 npm 发布物也不跟随软链目录。
  // 不判红（方向是「多报」时才安全，这里是面里混进了非分发物），但必须给出可读文案，
  // 否则整条判据只会以 exit 2 的「Path provided was not a file!」收场。
  for (const rel of surface) {
    if (isRegularFile(join(root, rel))) continue;
    reports.push(
      `${rel} 是发布物面内的非普通文件（软链目录/悬空软链），不做内容嗅探——` +
        `npm 发布物不跟随软链目录；若它本应随包发布，请改成真实文件`,
    );
  }

  const registered = new Set(withPath.map((e) => e.path));
  for (const hit of hits) {
    if (registered.has(hit)) continue;
    // 哈希直接打在问题里：登记表 note 要求「先跑门禁取 sha256」，而只说不合规的话用户取不到
    // 这个值，只能自己另算一遍（note 与实现不符）。
    problems.push(
      `未登记的裸二进制（在发布物面内 ⇒ 随包分发）：${hit}（sha256 ${sha256File(join(root, hit))}）；` +
        `请以该哈希登记并附随包 license 文本`,
    );
  }

  for (const e of withPath) {
    const abs = join(root, e.path);
    if (!existsSync(abs)) {
      problems.push(`${e.path} 登记项文件不存在（登记表与仓库脱钩）`);
    } else if (!isRegularFile(abs)) {
      // 登记项必须指向真实文件：软链目录读不了哈希、也无法嗅探，登记它不产生任何合规效果。
      problems.push(`${e.path} 登记项不是普通文件（软链目录/悬空软链无法做内容嗅探与哈希）`);
    } else {
      if (!surface.has(e.path))
        problems.push(`${e.path} 不在发布物面内（登记它不产生任何合规效果）`);
      if (!sniffBinary(abs, isBinary))
        problems.push(`${e.path} 内容已不是二进制（嗅探未命中）：登记表与事实脱钩`);
      if (hashable.has(e)) {
        const actual = sha256File(abs);
        if (actual !== e.sha256)
          problems.push(`${e.path} sha256 漂移：登记 ${e.sha256} 实际 ${actual}`);
      }
    }
    // license 文本必须随包发布：vendored 一个副本却只把许可放在 docs/（不分发）等于没附。
    // first-party 资产没有第三方许可义务，不该被要求附一段「来源 + 许可」。
    if (kindOf(e) === "first-party") continue;
    if (typeof e.licenseFile !== "string" || e.licenseFile.trim() === "") continue;
    const licAbs = join(root, e.licenseFile);
    if (!existsSync(licAbs) || !isRegularFile(licAbs)) {
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

  return {
    problems,
    reports,
    scanned: surface.size,
    registered: withPath.length,
    hits: hits.length,
  };
}

/** 取某包在登记表里的条目（消费者：collect-licenses 归集、pack-check 随包断言）。 */
export function vendoredEntriesFor(root, pkgDirRel, registryPath) {
  const prefix = `${pkgDirRel}/`;
  return loadVendoredRegistry(registryPath ?? join(root, REGISTRY_REL)).filter(
    (e) => typeof e?.path === "string" && e.path.startsWith(prefix),
  );
}

/**
 * 取许可清单里某 vendored 段的正文。段格式由 collect-licenses 的 vendoredSection 定义：
 * 两行 `=` 夹住段头（path + 许可名 + 来源），许可正文在其后、直到下一个段头。
 * 返回 null = 没有该段。
 *
 * 为什么不能只用 `lic.includes(path)`：段头字符串自己就能满足它——把许可正文删空、只留
 * `vendored 二进制：<path>` 一行，覆盖断言照样通过，等于没断言「最终发布物带了许可」。
 */
function vendoredSectionBody(text, path) {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.trim() === `vendored 二进制：${path}`);
  if (head === -1) return null;
  const close = lines.findIndex((l, i) => i > head && /^={5,}\s*$/.test(l));
  if (close === -1) return null;
  const body = [];
  for (let i = close + 1; i < lines.length; i++) {
    if (/^={5,}\s*$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

/**
 * 随包断言（pack-check 消费）：登记项若真的进了 tarball，其许可文本必须出现在随包的
 * lib/THIRD-PARTY-LICENSES 里，且**该段的许可正文非空**。与源码面判据互补——源码面保证
 * 「登记与分发面一致」，这里保证「最终发布物真的带了许可」。
 */
export function checkVendoredTarball(pkgRoot, pkgDirRel, entries) {
  const problems = [];
  const prefix = `${pkgDirRel}/`;
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    // first-party 资产不进第三方许可段，也就没有「tarball 里许可是否覆盖」可断言。
    if (kindOf(e) === "first-party") continue;
    if (!existsSync(join(pkgRoot, e.path.slice(prefix.length)))) {
      problems.push(`登记的分发面二进制未随包发布：${e.path}`);
      continue;
    }
    const licPath = join(pkgRoot, "lib", "THIRD-PARTY-LICENSES");
    if (!existsSync(licPath)) {
      problems.push(`随包发布了 vendored 二进制（${e.path}）但缺 lib/THIRD-PARTY-LICENSES`);
      continue;
    }
    const body = vendoredSectionBody(readFileSync(licPath, "utf8"), e.path);
    if (body === null) {
      problems.push(
        `lib/THIRD-PARTY-LICENSES 未覆盖 vendored 二进制 ${e.path}（缺 vendored 段头）`,
      );
    } else if (body.trim() === "") {
      problems.push(
        `lib/THIRD-PARTY-LICENSES 的 vendored 段 ${e.path} 正文为空（段头字符串不等于附了许可文本）`,
      );
    }
  }
  return problems;
}
