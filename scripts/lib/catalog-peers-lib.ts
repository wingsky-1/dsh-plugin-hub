#!/usr/bin/env node
"use strict";

/**
 * catalog-peers-lib — catalog 与 DSH-facing peer 投影的校验/生成库。
 *
 * DSH 0.1.7 的插件兼容层直接读取 link 目标包的原始 peerDependencies；pnpm 的
 * `catalog:` 不是 SemVer，raw link 会因此被拒绝。为保持普通源码 link 工作流，
 * 各 active/standalone 包的官方 peer 成员由 plugins-manifest.json 登记，版本由
 * pnpm-workspace.yaml catalog 登记，package.json 的 peerDependencies 是两者
 * 投影出来的精确版本。
 *
 * 两条事实源职责严格分离：
 * - plugins-manifest.json：某包必须有哪些官方 peer（成员关系）；
 * - pnpm-workspace.yaml catalog：这些 peer 的唯一版本（且必须是 exact SemVer）。
 *
 * 生成器只改已登记成员的版本值，不自动增删成员；成员缺失/多出、catalog range、
 * 坏 package.json 都在写入前 fail-closed。
 *
 * 零新增依赖：yaml 只解析本文件自用的两个顶层段（受限子集，非通用 YAML 解析器）。
 */
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { loadManifest } from "./plugins-manifest-lib.ts";

const OFFICIAL_SCOPE = "@deepseek-ai/";
const DEP_FIELDS = ["peerDependencies", "devDependencies", "dependencies"];
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

type Manifest = Record<string, unknown>;
export type PeerContracts = Record<string, string[]>;

type CatalogPeerUpdate = {
  path: string;
  dir: string;
  before: string;
  after: string;
  changes: Array<{ name: string; from: unknown; to: string }>;
};

/** catalog 只能容纳 canonical exact SemVer；range/workspace/catalog: 一律拒绝。 */
export function isCanonicalExactVersion(value: unknown): value is string {
  return typeof value === "string" && EXACT_SEMVER.test(value);
}

/** 剥掉 YAML 标量两侧的成对引号（单/双均可）；未加引号时原样返回。 */
function unquote(scalar: string): string {
  const quote = scalar[0];
  if ((quote === "'" || quote === '"') && scalar.length >= 2 && scalar.endsWith(quote)) {
    return scalar.slice(1, -1);
  }
  return scalar;
}

/** 解析顶层 `catalog:` 段的 name → version。 */
export function parseCatalog(yamlText: string): Map<string, string> {
  const catalog = new Map<string, string>();
  let inSection = false;
  for (const line of yamlText.split("\n")) {
    if (/^catalog:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) inSection = false;
    if (!inSection) continue;
    const match = /^ {2}(\S+):\s*(\S+)\s*$/.exec(line);
    if (match) catalog.set(unquote(match[1]), unquote(match[2]));
  }
  return catalog;
}

/** 解析顶层 `minimumReleaseAgeExclude:` 段的包名 → 精确版本。 */
export function parseReleaseExcludeVersions(yamlText: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inSection = false;
  for (const line of yamlText.split("\n")) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) inSection = false;
    if (!inSection) continue;
    const match = /^ {2}- (\S+)\s*$/.exec(line);
    if (!match) continue;
    const name = unquote(match[1]);
    const at = name.lastIndexOf("@");
    if (at > 0) versions.set(name.slice(0, at), name.slice(at + 1));
  }
  return versions;
}

/** 兼容旧调用方：只返回豁免包名。 */
export function parseReleaseExclude(yamlText: string): Set<string> {
  return new Set(parseReleaseExcludeVersions(yamlText).keys());
}

function readPackageManifest(root: string, dir: string): { manifest: Manifest; text: string } {
  const path = join(root, "packages", dir, "package.json");
  const text = readFileSync(path, "utf8");
  return { manifest: JSON.parse(text) as Manifest, text };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function peerDependencyField(
  source: Manifest,
  label: string,
): { record: Record<string, unknown> | null; problems: string[] } {
  if (!Object.hasOwn(source, "peerDependencies")) return { record: null, problems: [] };
  const value = source.peerDependencies;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { record: null, problems: [`${label}: peerDependencies 存在时必须是对象`] };
  }
  const record = value as Record<string, unknown>;
  const problems = Object.entries(record)
    .filter(([, range]) => typeof range !== "string")
    .map(([name]) => `${label}: peerDependencies["${name}"] 必须是字符串`);
  return { record, problems };
}

function officialNames(deps: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  for (const name of Object.keys(deps ?? {})) {
    if (name.startsWith(OFFICIAL_SCOPE)) names.add(name);
  }
  return names;
}

function missingNames(expected: Set<string>, actual: Set<string>): string[] {
  return [...expected].filter((name) => !actual.has(name)).sort();
}

function extraNames(expected: Set<string>, actual: Set<string>): string[] {
  return [...actual].filter((name) => !expected.has(name)).sort();
}

function catalogVersionProblems(catalog: Map<string, string>): string[] {
  return [...catalog]
    .filter(([, version]) => !isCanonicalExactVersion(version))
    .map(
      ([name, version]) =>
        `catalog["${name}"] = ${JSON.stringify(version)} —— 必须是 canonical exact SemVer（不得是 range/workspace/catalog 协议）`,
    );
}

export function checkAggregatePeerBoundary(source: Manifest): string[] {
  const field = peerDependencyField(source, "dsh-plugins-all");
  if (field.problems.length > 0) return field.problems;
  const names = [...officialNames(field.record)].sort();
  return names.length === 0
    ? []
    : [`dsh-plugins-all: 聚合包不得声明 DSH 官方 peer（发现 ${names.join(", ")}）`];
}

function contractCoverageProblems(manifest: ReturnType<typeof loadManifest>): string[] {
  const known = new Set([...manifest.active, ...manifest.standalone]);
  const problems: string[] = [];
  for (const pkg of known) {
    if (!Object.hasOwn(manifest.dshPeerContracts, pkg)) {
      problems.push(`dshPeerContracts 缺 ${pkg}`);
    }
  }
  for (const pkg of Object.keys(manifest.dshPeerContracts)) {
    if (!known.has(pkg)) problems.push(`dshPeerContracts 含非 active/standalone 包 ${pkg}`);
  }
  return problems;
}

type PackagePeerCheck = {
  problems: string[];
  officialPeerCount: number;
};

function checkPackagePeerContract(
  dir: string,
  source: Manifest,
  expected: string[],
  catalog: Map<string, string>,
): PackagePeerCheck {
  const field = peerDependencyField(source, dir);
  const problems: string[] = [...field.problems];
  const peers = field.record;
  const actual = officialNames(peers);
  const expectedSet = new Set(expected);
  const missing = missingNames(expectedSet, actual);
  const extra = extraNames(expectedSet, actual);
  if (missing.length > 0) {
    problems.push(`${dir}: peerDependencies 缺少 manifest 合同成员 ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    problems.push(`${dir}: peerDependencies 多出 manifest 未登记官方成员 ${extra.join(", ")}`);
  }
  for (const name of expected) {
    const version = catalog.get(name);
    if (version === undefined) {
      problems.push(`${dir}: peerDependencies["${name}"] 无对应 pnpm-workspace.yaml catalog 条目`);
    } else if (!isCanonicalExactVersion(version)) {
      problems.push(`${dir}: catalog["${name}"] 不是 canonical exact SemVer`);
    }
    const spec = peers?.[name];
    if (spec !== version) {
      problems.push(
        `${dir}: peerDependencies["${name}"] = ${JSON.stringify(spec)} —— 必须与 catalog 精确版本 ${JSON.stringify(version)} 一致`,
      );
    }
  }
  return { problems, officialPeerCount: expected.length };
}

function collectPackageProblems(
  root: string,
  manifest: ReturnType<typeof loadManifest>,
  catalog: Map<string, string>,
): PackagePeerCheck {
  const problems: string[] = [...contractCoverageProblems(manifest)];
  try {
    const aggregate = readPackageManifest(root, "dsh-plugins-all");
    problems.push(...checkAggregatePeerBoundary(aggregate.manifest));
  } catch (error) {
    problems.push(`dsh-plugins-all: package.json 读取或解析失败 —— ${String(error)}`);
  }
  let officialPeerCount = 0;
  for (const [dir, expected] of Object.entries(manifest.dshPeerContracts)) {
    let source: { manifest: Manifest; text: string };
    try {
      source = readPackageManifest(root, dir);
    } catch (error) {
      problems.push(`${dir}: package.json 读取或解析失败 —— ${String(error)}`);
      continue;
    }
    const checked = checkPackagePeerContract(dir, source.manifest, expected, catalog);
    problems.push(...checked.problems);
    officialPeerCount += checked.officialPeerCount;
  }
  const managedDirs = [...new Set([...manifest.active, ...manifest.standalone, "dsh-plugins-all"])];
  for (const field of DEP_FIELDS.slice(1)) {
    for (const dir of managedDirs) {
      let source: { manifest: Manifest; text: string };
      try {
        source = readPackageManifest(root, dir);
      } catch (error) {
        problems.push(`${dir}: package.json 读取或解析失败 —— ${String(error)}`);
        continue;
      }
      const deps = recordOf(source.manifest[field]);
      if (deps === null) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith(OFFICIAL_SCOPE)) continue;
        if (spec !== "catalog:") {
          problems.push(
            `${dir}: ${field}["${name}"] = ${JSON.stringify(spec)} —— 官方包一律写 catalog:`,
          );
        } else if (!catalog.has(name)) {
          problems.push(
            `${dir}: ${field}["${name}"] 用了 catalog: 但 pnpm-workspace.yaml 无此 catalog 条目`,
          );
        }
      }
    }
  }
  return { problems, officialPeerCount };
}

/** 全仓源清单校验：成员关系来自 manifest，版本关系来自 catalog。 */
export function checkCatalogPeers(root: string): {
  lines: string[];
  problems: string[];
  catalogSize: number;
  officialPeerCount: number;
} {
  const yamlText = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const catalog = parseCatalog(yamlText);
  const excluded = parseReleaseExcludeVersions(yamlText);
  const problems = catalogVersionProblems(catalog);
  let manifest: ReturnType<typeof loadManifest>;
  try {
    manifest = loadManifest(root);
  } catch (error) {
    problems.push(`plugins-manifest: ${String(error)}`);
    return {
      lines: [`catalog ${catalog.size} 键 | 官方 peer 合同不可读`],
      problems,
      catalogSize: catalog.size,
      officialPeerCount: 0,
    };
  }
  const checked = collectPackageProblems(root, manifest, catalog);
  problems.push(...checked.problems);
  problems.push(...collectCatalogExemptionProblems(catalog, excluded));
  return {
    lines: [
      `catalog ${catalog.size} 键 | 官方 peer 合同 ${checked.officialPeerCount} 处 | 豁免清单 ${excluded.size} 条`,
    ],
    problems,
    catalogSize: catalog.size,
    officialPeerCount: checked.officialPeerCount,
  };
}

/** 先计算所有值投影差异；成员或版本事实不完整时整批零写入。 */
function collectCatalogPeerUpdates(
  root: string,
  manifest: ReturnType<typeof loadManifest>,
  catalog: Map<string, string>,
): { updates: CatalogPeerUpdate[]; problems: string[] } {
  const updates: CatalogPeerUpdate[] = [];
  const problems = [...contractCoverageProblems(manifest), ...catalogVersionProblems(catalog)];
  for (const [dir, expected] of Object.entries(manifest.dshPeerContracts)) {
    let source: { manifest: Manifest; text: string };
    try {
      source = readPackageManifest(root, dir);
    } catch (error) {
      problems.push(`${dir}: package.json 读取或解析失败 —— ${String(error)}`);
      continue;
    }
    const field = peerDependencyField(source.manifest, dir);
    if (field.problems.length > 0) {
      problems.push(...field.problems);
      continue;
    }
    const peers = field.record;
    const actual = officialNames(peers);
    const expectedSet = new Set(expected);
    const missing = missingNames(expectedSet, actual);
    const extra = extraNames(expectedSet, actual);
    if (missing.length > 0 || extra.length > 0) {
      problems.push(
        `${dir}: peer 成员合同漂移（缺少 ${missing.join(", ") || "无"}；多出 ${extra.join(", ") || "无"}）`,
      );
      continue;
    }
    const changes: CatalogPeerUpdate["changes"] = [];
    for (const name of expected) {
      const to = catalog.get(name);
      if (to === undefined || !isCanonicalExactVersion(to)) {
        problems.push(`${dir}: peer "${name}" 缺少 canonical exact catalog 版本`);
        continue;
      }
      const from = peers?.[name];
      if (from !== to) changes.push({ name, from, to });
    }
    if (changes.length === 0) continue;
    const next = structuredClone(source.manifest);
    const nextPeers = recordOf(next.peerDependencies);
    if (nextPeers === null) {
      problems.push(`${dir}: peerDependencies 不是对象`);
      continue;
    }
    for (const change of changes) nextPeers[change.name] = change.to;
    updates.push({
      path: join(root, "packages", dir, "package.json"),
      dir,
      before: source.text,
      after: `${JSON.stringify(next, null, 2)}\n`,
      changes,
    });
  }
  return { updates, problems };
}

/** 清理上次异常中断遗留的本生成器临时文件；只匹配本脚本的精确命名。 */
function cleanupStaleSyncTemps(root: string, manifest: ReturnType<typeof loadManifest>): void {
  for (const dir of new Set([...manifest.active, ...manifest.standalone])) {
    const packageDir = join(root, "packages", dir);
    for (const name of readdirSync(packageDir)) {
      if (/^package\.json\.catalog-sync-\d+\.tmp$/.test(name)) {
        rmSync(join(packageDir, name), { force: true });
      }
    }
  }
}

/**
 * 把 catalog 的精确版本投影到 manifest 合同成员。任一事实问题都会零写入；
 * 单文件临时 + rename，跨文件失败时回滚先前写入。
 */
export type SyncCatalogPeersOptions = {
  /** 测试/维护工具可在写前改变事实源，用来验证 CAS；生产调用不传。 */
  beforeWrite?: () => void;
};

export function syncCatalogPeers(
  root: string,
  options: SyncCatalogPeersOptions = {},
): { changed: string[]; problems: string[] } {
  const lock = acquireSyncLock(root);
  if ("problem" in lock) return { changed: [], problems: [lock.problem] };
  try {
    const yamlPath = join(root, "pnpm-workspace.yaml");
    const manifestPath = join(root, "scripts", "data", "plugins-manifest.json");
    const yamlText = readFileSync(yamlPath, "utf8");
    const manifestText = readFileSync(manifestPath, "utf8");
    const catalog = parseCatalog(yamlText);
    let manifest: ReturnType<typeof loadManifest>;
    try {
      manifest = loadManifest(root);
    } catch (error) {
      return { changed: [], problems: [`plugins-manifest: ${String(error)}`] };
    }
    const assertPeerInputsUnchanged = (): void => {
      if (readFileSync(yamlPath, "utf8") !== yamlText) {
        throw new Error("pnpm-workspace.yaml 在生成期间被其它进程修改，拒绝使用旧 catalog 快照");
      }
      if (readFileSync(manifestPath, "utf8") !== manifestText) {
        throw new Error("plugins-manifest.json 在生成期间被其它进程修改，拒绝使用旧成员合同快照");
      }
    };
    cleanupStaleSyncTemps(root, manifest);
    const { updates, problems } = collectCatalogPeerUpdates(root, manifest, catalog);
    if (problems.length > 0) return { changed: [], problems };

    const written: CatalogPeerUpdate[] = [];
    try {
      for (const update of updates) {
        options.beforeWrite?.();
        assertPeerInputsUnchanged();
        const current = readFileSync(update.path, "utf8");
        if (current !== update.before) {
          throw new Error(`${update.dir}: package.json 在生成期间被其它进程修改，拒绝覆盖`);
        }
        atomicWriteText(update.path, update.after);
        written.push(update);
      }
      assertPeerInputsUnchanged();
    } catch (error) {
      const rollbackProblems: string[] = [];
      for (const update of [...written].reverse()) {
        try {
          const current = readFileSync(update.path, "utf8");
          if (current !== update.after) {
            rollbackProblems.push(`${update.dir}: 回滚时内容已被外部修改，未覆盖`);
            continue;
          }
          atomicWriteText(update.path, update.before);
        } catch (rollbackError) {
          rollbackProblems.push(`${update.dir}: ${String(rollbackError)}`);
        }
      }
      const rollback =
        rollbackProblems.length === 0
          ? "已回滚全部先前写入"
          : `回滚失败: ${rollbackProblems.join("; ")}`;
      throw new Error(`生成 peer 投影失败: ${String(error)}; ${rollback}`);
    }
    return {
      changed: updates.map((update) => `packages/${update.dir}/package.json`),
      problems: [],
    };
  } finally {
    lock.release();
  }
}

/**
 * 进程级独占锁；已有锁一律 fail-closed。
 * 不自动回收“死亡 PID”锁：多个进程同时回收同一路径会互相删除新锁，破坏互斥。
 * 崩溃后由维护者确认无生成进程后手动删除 .catalog-peers.lock。
 */
function acquireSyncLock(root: string): { release: () => void } | { problem: string } {
  const lockPath = join(root, ".catalog-peers.lock");
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "wx");
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    fd = undefined;
    return {
      release: () => {
        try {
          const owner = Number(readFileSync(lockPath, "utf8").trim());
          if (owner === process.pid) unlinkSync(lockPath);
        } catch {
          // 锁已由外部清理或替换；不覆盖其它进程的锁。
        }
      },
    };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return { problem: `catalog peer 生成锁创建失败：${String(error)}` };
    }
    let ownerPid: number | undefined;
    try {
      ownerPid = Number(readFileSync(lockPath, "utf8").trim());
    } catch {
      ownerPid = undefined;
    }
    const owner =
      ownerPid !== undefined && Number.isInteger(ownerPid) && ownerPid > 0
        ? `PID ${ownerPid}`
        : "未知/无效 owner";
    return {
      problem: `catalog peer 生成锁已存在（${owner}）；为避免竞态不自动回收，请确认无生成进程后手动清理 .catalog-peers.lock`,
    };
  }
}

/** 同目录临时文件 + rename，避免中断留下半个 package.json。 */
function atomicWriteText(path: string, text: string): void {
  const temp = `${path}.catalog-sync-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 发布边界校验：源/产物官方 peer 成员必须等于 manifest 合同，值必须是 catalog exact version。
 */
export function checkMaterializedCatalogPeers(
  source: Manifest,
  packed: Manifest,
  catalog: Map<string, string>,
  label: string,
  expectedPeers: readonly string[],
): string[] {
  const problems: string[] = [...catalogVersionProblems(catalog)];
  const sourceField = peerDependencyField(source, `${label} 源清单`);
  const packedField = peerDependencyField(packed, `${label} tarball`);
  problems.push(...sourceField.problems, ...packedField.problems);
  const sourcePeers = sourceField.record;
  const packedPeers = packedField.record;
  const sourceNames = officialNames(sourcePeers);
  const packedNames = officialNames(packedPeers);
  const expected = new Set(expectedPeers);
  const sourceMissing = missingNames(expected, sourceNames);
  const sourceExtra = extraNames(expected, sourceNames);
  const packedMissing = missingNames(expected, packedNames);
  const packedExtra = extraNames(expected, packedNames);
  if (sourceMissing.length > 0 || sourceExtra.length > 0) {
    problems.push(
      `${label}: 源 peer 成员不匹配合同（缺少 ${sourceMissing.join(", ") || "无"}；多出 ${sourceExtra.join(", ") || "无"}）`,
    );
  }
  if (packedMissing.length > 0 || packedExtra.length > 0) {
    problems.push(
      `${label}: tarball peer 成员不匹配合同（缺少 ${packedMissing.join(", ") || "无"}；多出 ${packedExtra.join(", ") || "无"}）`,
    );
  }
  for (const name of expected) {
    const version = catalog.get(name);
    if (version === undefined || !isCanonicalExactVersion(version)) {
      problems.push(`${label}: peer "${name}" 缺少 canonical exact catalog 版本`);
      continue;
    }
    if (sourcePeers?.[name] !== version) {
      problems.push(`${label}: 源 peerDependencies["${name}"] 不是 catalog exact version`);
    }
    if (packedPeers?.[name] !== version) {
      problems.push(`${label}: tarball peerDependencies["${name}"] 不是 catalog exact version`);
    }
  }
  return problems;
}

/** catalog 键必须在供应链豁免清单中登记同一精确版本。 */
function collectCatalogExemptionProblems(
  catalog: Map<string, string>,
  excluded: Map<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [name, version] of catalog) {
    const excludedVersion = excluded.get(name);
    if (excludedVersion === undefined) {
      problems.push(
        `catalog["${name}"] 未登记进 minimumReleaseAgeExclude（供应链豁免清单与事实源漂移）`,
      );
    } else if (excludedVersion !== version) {
      problems.push(
        `catalog["${name}"] 版本 ${version} 与 minimumReleaseAgeExclude 版本 ${excludedVersion} 不一致`,
      );
    }
  }
  return problems;
}
