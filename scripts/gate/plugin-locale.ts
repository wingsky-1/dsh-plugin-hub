#!/usr/bin/env node
/**
 * plugin-locale — 包级展示文案的 locale 目录契约门禁。
 *
 * 判的是什么：dsh 宿主读插件展示文案走 Node ESM 解析器解析 `<包名>/locale/en.json`
 * （上游 dsh-app-boot/lib/index.js:1972 readPluginMeta 硬编码该路径），再扫同目录每个
 * *.json 按 LANGUAGE_ID 收进字典、逐文件硬解析不吞异常。失败一律不是崩溃：
 *   - 缺资源 / 解析不到 → missingResource（:1893）静默返回 undefined，回落到 package.json；
 *   - 文件级失败 → dictionariesOf（:1925）抛错，被 readPluginMeta 的 catch 吞成
 *     `{ error }`（:1996），设置页那一行插件显示「Plugin metadata for …」。
 * 故**漏导某个语言文件比全不导出更糟**，必须导通配。
 *
 * 上游六种失败里五种静默（exit 0、零诊断），源码面任何测试都看不见——本门把上游语义
 * 逐字复刻成判据。复刻的常量（上游一改这里必须跟着改，不得自作主张放宽）：
 *   LANGUAGE_ID  = dsh-app-boot/lib/index.js:1850
 *   宿主内置语言 = dsh-client-locale/lib/client.js:922 LOCALE_IDS = ["zh", "en"]
 *   非空字符串   = dsh-app-boot/lib/index.js:1907 textOf
 *   meta 包装层  = dsh-app-boot/lib/index.js:1936
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { failClosed } from "../lib/gate-exit.mjs";

const DEFAULT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 逐字复制上游 dsh-app-boot/lib/index.js:1850；改此行须同步核上游。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** 宿主内置语言目录（dsh-client-locale/lib/client.js:922）；不在其中的 id 永不命中。 */
const HOST_LOCALES = new Set(["zh", "en"]);

const META_KEYS = new Set(["title", "description"]);
const TOP_KEYS = new Set(["meta"]);

/** 判词收集器：门禁内所有判据共用一个出口，便于逐包归组。 */
type Fail = (message: string) => void;

/** 宽松的清单形状：门禁对未知形态 fail-closed，不假设具体类型。 */
interface LooseManifest {
  name?: unknown;
  files?: unknown;
  exports?: Record<string, unknown>;
  dsh?: { catalog?: { summary?: Record<string, unknown> } };
}

/**
 * --package 可重复（CI 切片用）；--root 只服务自测的隔离 fixture，接线判据要求生产调用
 * 不带它（本地档位计划与 ci.yml 都走全包形态）。
 */
function parseArgs(argv: string[]): { packages: string[]; root: string } {
  const packages: string[] = [];
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package") packages.push(argv[++i]);
    else if (argv[i] === "--root") root = resolvePath(argv[++i]);
  }
  return { packages, root };
}

/** 契约 1：locale/ 目录与 en.json 锚点。返回判词（字符串）或 null 表示通过。 */
function checkAnchor(pkgDir: string): string | null {
  const localeDir = join(pkgDir, "locale");
  if (!existsSync(localeDir))
    return "缺 locale/ 目录：dsh 读不到展示文案，将静默回落到 package.json";
  if (!existsSync(join(localeDir, "en.json")))
    return "缺 locale/en.json：它是上游唯一入口锚，缺则 dictionariesOf 根本不运行";
  return null;
}

/** 契约 2 + 3：files 白名单与 exports 通配。两者任一缺失都是 exit 0 的静默失效。 */
function checkManifestWiring(manifest: LooseManifest, fail: Fail): void {
  if (!Array.isArray(manifest.files) || !manifest.files.includes("locale")) {
    fail('package.json files 未含 "locale"：locale/ 不会进 tarball，dsh 读不到');
  }
  const mapped = manifest.exports?.["./locale/*"];
  if (mapped !== "./locale/*") {
    fail(
      `exports["./locale/*"] 必须是逐字 "./locale/*"（实际 ${JSON.stringify(mapped)}）：` +
        "漏了则解析抛 ERR_PACKAGE_PATH_NOT_EXPORTED 并被上游静默吞掉；逐个文件导更糟",
    );
  }
}

/**
 * 契约 4：解析器实证。**只 resolve 不够**——实测缺失文件照样 resolve 成功，
 * 故必须再核对解析结果确实落在本包 locale/ 内。
 */
function checkResolver(pkgDir: string, localeDir: string, name: string, fail: Fail): void {
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `console.log(import.meta.resolve(${JSON.stringify(name + "/locale/en.json")}))`,
    ],
    { cwd: pkgDir, encoding: "utf8" },
  );
  if (probe.status !== 0) {
    fail(`解析器实证失败：${name}/locale/en.json 在本包 cwd 下不可解析`);
    return;
  }
  const url = (probe.stdout ?? "").trim();
  if (!url.startsWith("file://")) {
    fail(`解析结果非本地文件：${url.slice(0, 100)}`);
  } else if (!resolvePath(fileURLToPath(url)).startsWith(resolvePath(localeDir) + "/")) {
    fail(`解析结果越出本包 locale/：${url.slice(0, 100)}`);
  }
}

/** 契约 5：语言文件名。合法文件名 ≠ 宿主能选中，故 HOST_LOCALES 也是判据。 */
function checkLanguageFileName(entry: string, seen: Map<string, string>, fail: Fail): void {
  const lang = entry.slice(0, -5);
  if (!LANGUAGE_ID.test(lang)) {
    fail(`locale/${entry}：文件名不是合法语言 id（LANGUAGE_ID），上游会抛错炸掉整行插件 meta`);
    return;
  }
  const id = lang.toLowerCase();
  if (id !== lang) fail(`locale/${entry}：文件名必须全小写（上游 toLowerCase 后判重，重名即抛错）`);
  if (seen.has(id)) fail(`locale/${entry}：与 locale/${seen.get(id)} 同为语言 ${id}，上游判重抛错`);
  seen.set(id, entry);
  if (!HOST_LOCALES.has(id)) {
    fail(
      `locale/${entry}：语言 ${id} 不在宿主内置目录 {zh,en} 内，永不命中（合法文件名 ≠ 宿主能选中）`,
    );
  }
}

/** 契约 6a：JSON 可解析 + 顶层是对象 + 顶层键白名单（上游只读 parsed.meta）。 */
function readTopDoc(localeDir: string, entry: string, fail: Fail): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(localeDir, entry), "utf8"));
  } catch (e) {
    fail(`locale/${entry}：JSON 解析失败（${String((e as Error).message).slice(0, 80)}）`);
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    fail(`locale/${entry}：顶层必须是对象`);
    return null;
  }
  const record = doc as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (!TOP_KEYS.has(k))
      fail(`locale/${entry}：顶层键 ${JSON.stringify(k)} 不被上游读取（只读 parsed.meta）`);
  }
  return record;
}

/** 契约 6b：meta 包装层与其键白名单（icon / error 上游静默忽略）。 */
function readMetaDoc(
  localeDir: string,
  entry: string,
  doc: Record<string, unknown>,
  fail: Fail,
): Record<string, unknown> | null {
  const meta = doc.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    fail(`locale/${entry}：缺 meta 对象（上游只读 parsed.meta.title/description）`);
    return null;
  }
  const record = meta as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (!META_KEYS.has(k)) fail(`locale/${entry}：meta.${k} 不被上游使用（icon/error 静默忽略）`);
  }
  return record;
}

/** 契约 6c：两个字段各自必须是非空字符串——缺 title 会让英文回落成裸包名且无告警。 */
function checkMetaFields(entry: string, meta: Record<string, unknown>, fail: Fail): void {
  for (const k of ["title", "description"]) {
    const v = meta[k];
    if (typeof v !== "string" || v.trim() === "") {
      fail(`locale/${entry}：meta.${k} 缺失或非非空字符串（上游 textOf 语义）`);
    }
  }
}

/** 契约 7：与 dsh.catalog.summary 的只读镜像逐字相等（catalog 是外部收录平台的采集面）。 */
function checkReadOnlyMirror(
  manifest: LooseManifest,
  id: string,
  description: unknown,
  fail: Fail,
): void {
  const mirrored = manifest.dsh?.catalog?.summary?.[id];
  if (typeof mirrored !== "string") {
    fail(`dsh.catalog.summary.${id} 不存在，镜像判据无对象`);
  } else if (description !== mirrored) {
    fail(`meta.description 与 dsh.catalog.summary.${id} 不是逐字相等（两份文案副本会漂移）`);
  }
}

/** 收集一个包的判词；数组为空表示该包通过。 */
function auditPackage(root: string, pkg: string): string[] {
  const out: string[] = [];
  const fail: Fail = (message) => out.push(message);
  const pkgDir = join(root, "packages", pkg);
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return ["缺 package.json（包目录残缺）"];
  const manifest = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as LooseManifest;
  const name = manifest.name;
  if (typeof name !== "string" || name === "") return ["package.json 缺 name"];
  const anchorProblem = checkAnchor(pkgDir);
  if (anchorProblem !== null) return [anchorProblem];
  const localeDir = join(pkgDir, "locale");
  checkManifestWiring(manifest, fail);
  checkResolver(pkgDir, localeDir, name, fail);
  const seen = new Map<string, string>();
  for (const entry of readdirSync(localeDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    checkLanguageFileName(entry, seen, fail);
    const doc = readTopDoc(localeDir, entry, fail);
    if (doc === null) continue;
    const meta = readMetaDoc(localeDir, entry, doc, fail);
    if (meta === null) continue;
    checkMetaFields(entry, meta, fail);
    checkReadOnlyMirror(manifest, entry.slice(0, -5).toLowerCase(), meta.description, fail);
  }
  return out;
}

function main(): void {
  const { packages, root } = parseArgs(process.argv.slice(2));
  const targets =
    packages.length > 0
      ? packages
      : readdirSync(join(root, "packages"), { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.startsWith("dsh-"))
          .map((e) => e.name)
          .sort();
  if (targets.length === 0)
    failClosed("未发现任何 dsh-* 包（扫描面为空 = 判据失效，不等于零违规）");
  let bad = 0;
  for (const pkg of targets) {
    const findings = auditPackage(root, pkg);
    if (findings.length > 0) {
      bad++;
      console.error(`plugin-locale: ${pkg}:`);
      for (const f of findings) console.error(`  - ${f}`);
    }
  }
  if (bad > 0) {
    console.error(`plugin-locale: ${bad}/${targets.length} 个包不满足 locale 契约`);
    process.exit(1);
  }
  console.log(`plugin-locale: ${targets.length} 个包 locale 契约通过`);
}

main();
