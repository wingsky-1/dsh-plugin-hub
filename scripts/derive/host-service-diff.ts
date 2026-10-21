#!/usr/bin/env node
/**
 * host-service-diff — 宿主服务面方法级 diff（旧/新两棵官方 .d.ts 树）。
 *
 * 为什么需要：rc 升级的兼容性判断此前主要靠"逐包 lib 字节 diff"和版本号。lib diff 能发现
 * 导出面删除，但"同名文件里方法被删"仍可能被包装变化掩盖；而 #1163 的真实事故是
 * settings.get(ns) 在 0.1.7-rc.1 被删、插件靠鸭子类型静默回落到 no-api-key。
 * 本工具把"宿主服务面"从源码 AST 侧（verify-host-seams 的 R5）扩展到升级前后对比：
 * 旧/新两棵官方包树各自解析 Context 声明合并与方法表，输出删除/新增的方法集合。
 *
 * 输入：--from <dir> --to <dir>，每个 dir 可以是以下任一形态：
 *   - node_modules 根目录（其下有 @deepseek-ai/*）；
 *   - @deepseek-ai scope 目录（其下是各包目录）；
 *   - 单个官方包根目录（含 package.json + 声明入口）；
 *   - 一个包含若干官方包目录的普通目录。
 * 输出：默认 markdown 表；--json 输出结构化 JSON。
 * 退出码：
 *   0 = 无删除（--check 下通过；默认报告模式也返回 0）；
 *   1 = --check 且有服务/方法/事件删除（判据按设计判红）；
 *   2 = 输入/声明入口不可解析（工具故障，fail-closed；不得读成"无变化"）。
 *
 * 限制（如实声明）：
 *   - 只比成员名集合，不比签名/参数/返回类型；
 *   - 无官方 catalog 类型包的服务（credentials / attachments / loader / sessionProjections）
 *     不在类型面内，输出 untyped 观察项，必须用真实宿主探针补证；
 *   - 解析复用 upstream-contract-warn 的 .d.ts 闭包文本解析器，遇到计算键/不可解析形态
 *     会记 opaque，不猜测成员名。
 *
 * 用法：node scripts/derive/host-service-diff.ts --from <old> --to <new> [--json] [--check]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { closureMembers } from "../maintenance/upstream-contract-warn.mjs";

/** 框架/事件动词不是"宿主服务名"（与 upstream-contract-warn 同口径）。 */
const FRAMEWORK_ONLY = new Set([
  "get",
  "provide",
  "inject",
  "effect",
  "plugin",
  "on",
  "once",
  "emit",
  "parallel",
  "serial",
  "waterfall",
  "bail",
  // cordis Context 自身的框架成员（不是宿主服务）：
  "accessor",
  "constructor",
  "extend",
  "fiber",
  "filter",
  "intercept",
  "is",
  "isolate",
  "mixin",
  "set",
]);

/** 无官方 catalog 类型包、但必须在升级检查中显式观察的宿主服务。 */
const KNOWN_UNTYPED_SERVICES = ["credentials", "attachments", "loader", "sessionProjections"];

/** .d.ts 闭包里一个 interface/class 的成员面。 */
interface SurfaceIface {
  members: Set<string>;
  quoted: Set<string>;
  links: Map<string, string>;
  opaque: number;
  classKind: boolean;
}

/** 一棵树解析后的宿主服务面。 */
export interface HostServiceSurface {
  root: string;
  packages: Array<{ name: string; version: string; dir: string; entry: string; files: number }>;
  services: Set<string>;
  events: Set<string>;
  links: Map<string, string>;
  methodTables: Map<string, Set<string>>;
  opaque: number;
  files: number;
}

/** 服务面的变化项。 */
export interface ServiceChange {
  service: string;
  oldType: string | null;
  newType: string | null;
  removedMethods: string[];
  addedMethods: string[];
}

/** 包版本/存在性变化。 */
export interface PackageChange {
  name: string;
  oldVersion: string | null;
  newVersion: string | null;
  status: "added" | "removed" | "version-changed" | "same";
}

/** 两棵树之间的服务面差异。 */
export interface SurfaceDiff {
  fromRoot: string;
  toRoot: string;
  removedServices: string[];
  addedServices: string[];
  changedServices: ServiceChange[];
  unchangedServices: string[];
  removedEvents: string[];
  addedEvents: string[];
  packageChanges: PackageChange[];
  untypedServices: string[];
  hasRemovals: boolean;
}

/** 可读的错误：CLI 把它打成 FAIL-CLOSED 并 exit 2。 */
class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new SurfaceError(
      "不可读：" + file + "（" + String((error as Error).message).split("\n")[0] + "）",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SurfaceError("JSON 不可解析：" + file);
  }
  if (!isRecord(parsed)) throw new SurfaceError("JSON 顶层不是对象：" + file);
  return parsed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) out.push(full);
  }
  return out.sort();
}

/** 从 package.json 的 types/typings 或常见入口定位声明文件。 */
function resolveEntry(pkgDir: string, pkgName: string): string {
  const meta = readJson(join(pkgDir, "package.json"));
  const candidates: string[] = [];
  for (const key of ["types", "typings"]) {
    const value = meta[key];
    if (typeof value === "string") candidates.push(resolve(pkgDir, value));
  }
  candidates.push(
    join(pkgDir, "lib", "types", "index.d.ts"),
    join(pkgDir, "lib", "index.d.ts"),
    join(pkgDir, "index.d.ts"),
  );
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  throw new SurfaceError(
    "包 " + pkgName + " 无声明入口：" + pkgDir + "（types 缺失且常见入口不存在）",
  );
}

/** 在给定树里发现所有 @deepseek-ai/* 包目录。 */
export function discoverPackageDirs(treeRoot: string): string[] {
  const root = resolve(treeRoot);
  if (!isDirectory(root)) throw new SurfaceError("--from/--to 不是目录：" + root);

  const ownManifest = join(root, "package.json");
  if (isFile(ownManifest)) {
    const meta = readJson(ownManifest);
    if (typeof meta.name === "string" && meta.name.startsWith("@deepseek-ai/")) return [root];
  }

  const scopes = [join(root, "node_modules", "@deepseek-ai"), join(root, "@deepseek-ai")];
  if (basename(root) === "@deepseek-ai") scopes.unshift(root);
  for (const scope of scopes) {
    if (!isDirectory(scope)) continue;
    const dirs = listDirs(scope).filter((dir) => isFile(join(dir, "package.json")));
    if (dirs.length > 0) return dirs;
  }

  const direct = listDirs(root).filter((dir) => isFile(join(dir, "package.json")));
  if (direct.length > 0) return direct;
  throw new SurfaceError("目录下没有 @deepseek-ai/* 包：" + root);
}

function mergeIface(ifaces: Map<string, SurfaceIface>, name: string, incoming: SurfaceIface): void {
  const existing = ifaces.get(name);
  if (existing === undefined) {
    ifaces.set(name, {
      members: new Set(incoming.members),
      quoted: new Set(incoming.quoted),
      links: new Map(incoming.links),
      opaque: incoming.opaque,
      classKind: incoming.classKind,
    });
    return;
  }
  for (const member of incoming.members) existing.members.add(member);
  for (const member of incoming.quoted) existing.quoted.add(member);
  for (const [key, type] of incoming.links)
    if (!existing.links.has(key)) existing.links.set(key, type);
  existing.opaque += incoming.opaque;
  // 只有所有声明都是 class 时才按 class 处理；任一 interface 声明即按 interface 看 Context。
  existing.classKind = existing.classKind && incoming.classKind;
}

interface LoadedPackages {
  ifaces: Map<string, SurfaceIface>;
  packages: HostServiceSurface["packages"];
  opaque: number;
  files: number;
}

/** 逐个包解析 .d.ts 闭包并合并 iface 表。 */
function loadPackages(pkgDirs: string[]): LoadedPackages {
  const ifaces = new Map<string, SurfaceIface>();
  const packages: HostServiceSurface["packages"] = [];
  let opaque = 0;
  let files = 0;
  for (const pkgDir of pkgDirs) {
    const meta = readJson(join(pkgDir, "package.json"));
    const name = typeof meta.name === "string" ? meta.name : pkgDir;
    const version = typeof meta.version === "string" ? meta.version : "";
    const entry = resolveEntry(pkgDir, name);
    const closed = closureMembers(entry) as unknown as {
      ifaces: Map<string, SurfaceIface>;
      opaque: number;
      files: number;
    };
    for (const [ifaceName, iface] of closed.ifaces) mergeIface(ifaces, ifaceName, iface);
    opaque += closed.opaque;
    files += closed.files;
    packages.push({ name, version, dir: pkgDir, entry, files: closed.files });
  }
  return { ifaces, packages, opaque, files };
}

/** 从 Context 声明合并取服务/事件/类型链接。 */
function contextSurface(ifaces: Map<string, SurfaceIface>): {
  services: Set<string>;
  events: Set<string>;
  links: Map<string, string>;
} {
  const services = new Set<string>();
  const events = new Set<string>();
  const links = new Map<string, string>();
  const context = ifaces.get("Context");
  if (context !== undefined && !context.classKind) {
    for (const member of context.members) {
      if (member.includes("/")) events.add(member);
      else if (!FRAMEWORK_ONLY.has(member)) services.add(member);
    }
    for (const [key, type] of context.links) if (!links.has(key)) links.set(key, type);
  }
  // 无类型包的服务不在 Context 声明合并里，显式补入观察面，避免报告静默缺失。
  for (const name of KNOWN_UNTYPED_SERVICES) services.add(name);
  return { services, events, links };
}

/** 把一棵官方包树的声明面解析成服务/事件/方法表。 */
export function buildHostServiceSurface(treeRoot: string): HostServiceSurface {
  const root = resolve(treeRoot);
  const loaded = loadPackages(discoverPackageDirs(root));
  if (loaded.packages.length === 0) throw new SurfaceError("没有可解析的官方包：" + root);
  const { services, events, links } = contextSurface(loaded.ifaces);
  const methodTables = new Map<string, Set<string>>();
  for (const [ifaceName, iface] of loaded.ifaces) {
    methodTables.set(ifaceName, new Set(iface.members));
  }
  return {
    root,
    packages: loaded.packages.sort((a, b) => a.name.localeCompare(b.name)),
    services,
    events,
    links,
    methodTables,
    opaque: loaded.opaque,
    files: loaded.files,
  };
}

function headOfType(type: string | undefined): string | null {
  if (type === undefined) return null;
  const head = type.split(".")[0];
  return head.length > 0 ? head : null;
}

function tableOf(surface: HostServiceSurface, type: string | undefined): Set<string> | null {
  const head = headOfType(type);
  if (head === null) return null;
  return surface.methodTables.get(head) ?? null;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function packageChanges(
  oldSurface: HostServiceSurface,
  newSurface: HostServiceSurface,
): PackageChange[] {
  const oldMap = new Map(oldSurface.packages.map((pkg) => [pkg.name, pkg.version]));
  const newMap = new Map(newSurface.packages.map((pkg) => [pkg.name, pkg.version]));
  const names = sorted(new Set([...oldMap.keys(), ...newMap.keys()]));
  const changes: PackageChange[] = [];
  for (const name of names) {
    const oldVersion = oldMap.get(name) ?? null;
    const newVersion = newMap.get(name) ?? null;
    let status: PackageChange["status"] = "same";
    if (oldVersion === null) status = "added";
    else if (newVersion === null) status = "removed";
    else if (oldVersion !== newVersion) status = "version-changed";
    changes.push({ name, oldVersion, newVersion, status });
  }
  return changes;
}

type ServiceComparison =
  { kind: "changed"; change: ServiceChange } | { kind: "unchanged" } | { kind: "untyped" };

interface TypeFace {
  oldType: string;
  newType: string;
  oldTable: Set<string>;
  newTable: Set<string>;
}

function typeFaceOf(
  oldType: string | null,
  newType: string | null,
  oldTable: Set<string> | null,
  newTable: Set<string> | null,
): TypeFace | null {
  if (oldType === null || newType === null || oldTable === null || newTable === null) return null;
  return { oldType, newType, oldTable, newTable };
}

function methodDelta(
  oldTable: Set<string>,
  newTable: Set<string>,
): {
  removedMethods: string[];
  addedMethods: string[];
} {
  return {
    removedMethods: sorted([...oldTable].filter((method) => !newTable.has(method))),
    addedMethods: sorted([...newTable].filter((method) => !oldTable.has(method))),
  };
}

/** 比较单个同名服务：类型链接/方法集合缺一侧即 untyped，不猜。 */
function compareService(
  oldSurface: HostServiceSurface,
  newSurface: HostServiceSurface,
  service: string,
): ServiceComparison {
  const oldType = oldSurface.links.get(service) ?? null;
  const newType = newSurface.links.get(service) ?? null;
  const face = typeFaceOf(
    oldType,
    newType,
    tableOf(oldSurface, oldType ?? undefined),
    tableOf(newSurface, newType ?? undefined),
  );
  if (face === null) return { kind: "untyped" };
  const { removedMethods, addedMethods } = methodDelta(face.oldTable, face.newTable);
  if (face.oldType === face.newType && removedMethods.length === 0 && addedMethods.length === 0) {
    return { kind: "unchanged" };
  }
  return {
    kind: "changed",
    change: {
      service,
      oldType: face.oldType,
      newType: face.newType,
      removedMethods,
      addedMethods,
    },
  };
}

function compareCommonServices(
  oldSurface: HostServiceSurface,
  newSurface: HostServiceSurface,
): {
  changedServices: ServiceChange[];
  unchangedServices: string[];
  untypedServices: string[];
} {
  const changedServices: ServiceChange[] = [];
  const unchangedServices: string[] = [];
  const untypedServices: string[] = [];
  for (const service of sorted(
    [...oldSurface.services].filter((name) => newSurface.services.has(name)),
  )) {
    const result = compareService(oldSurface, newSurface, service);
    if (result.kind === "changed") changedServices.push(result.change);
    else if (result.kind === "untyped") untypedServices.push(service);
    else unchangedServices.push(service);
  }
  return { changedServices, unchangedServices, untypedServices };
}

/** 比较两棵服务面：只把"删除"作为破坏性信号。 */
export function diffHostServiceSurfaces(
  oldSurface: HostServiceSurface,
  newSurface: HostServiceSurface,
): SurfaceDiff {
  const removedServices = sorted(
    [...oldSurface.services].filter((service) => !newSurface.services.has(service)),
  );
  const addedServices = sorted(
    [...newSurface.services].filter((service) => !oldSurface.services.has(service)),
  );
  const { changedServices, unchangedServices, untypedServices } = compareCommonServices(
    oldSurface,
    newSurface,
  );
  const removedEvents = sorted(
    [...oldSurface.events].filter((event) => !newSurface.events.has(event)),
  );
  const addedEvents = sorted(
    [...newSurface.events].filter((event) => !oldSurface.events.has(event)),
  );
  return {
    fromRoot: oldSurface.root,
    toRoot: newSurface.root,
    removedServices,
    addedServices,
    changedServices,
    unchangedServices,
    removedEvents,
    addedEvents,
    packageChanges: packageChanges(oldSurface, newSurface),
    untypedServices,
    hasRemovals:
      removedServices.length > 0 ||
      removedEvents.length > 0 ||
      changedServices.some((change) => change.removedMethods.length > 0),
  };
}

function tableText(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

function changedTable(changes: ServiceChange[]): string[] {
  const lines = [
    "| 服务 | 旧类型 | 新类型 | 移除方法 | 新增方法 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const change of changes) {
    lines.push(
      "| " +
        change.service +
        " | " +
        (change.oldType ?? "-") +
        " | " +
        (change.newType ?? "-") +
        " | " +
        tableText(change.removedMethods) +
        " | " +
        tableText(change.addedMethods) +
        " |",
    );
  }
  return lines;
}

/** 有内容才输出的小节（标题 + 列表 + 空行）。 */
function listSection(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [title, ...items.map((item) => "- " + item), ""];
}

function packageChangeSection(changes: PackageChange[]): string[] {
  const rows = changes.filter((change) => change.status !== "same");
  if (rows.length === 0) return [];
  return [
    "## 包版本/存在性变化",
    ...rows.map(
      (change) =>
        "- " +
        change.name +
        "：" +
        (change.oldVersion ?? "-") +
        " → " +
        (change.newVersion ?? "-") +
        "（" +
        change.status +
        "）",
    ),
    "",
  ];
}

/** markdown 报告（人类读；判词与退出码由 CLI 决定）。 */
export function formatSurfaceDiff(diff: SurfaceDiff): string {
  const lines: string[] = [
    "# 宿主服务面 diff",
    "",
    "- from: " + diff.fromRoot,
    "- to:   " + diff.toRoot,
    "",
  ];
  if (diff.changedServices.length > 0) {
    lines.push(...changedTable(diff.changedServices), "");
  } else {
    lines.push("（无服务类型/方法变化）", "");
  }
  const addedItems = [
    ...diff.addedServices.map((service) => "服务 " + service),
    ...diff.addedEvents.map((event) => "事件 " + event),
  ];
  lines.push(...listSection("## 删除的服务", diff.removedServices));
  lines.push(...listSection("## 删除的事件", diff.removedEvents));
  lines.push(...listSection("## 新增项（非破坏性，供观察）", addedItems));
  lines.push(...listSection("## 无类型服务（不在类型面内，需运行时探针）", diff.untypedServices));
  lines.push(...packageChangeSection(diff.packageChanges));
  lines.push("## 限制");
  lines.push("- 只比成员名集合，不比签名/参数/返回类型。");
  lines.push("- 无官方类型包的服务不在面内，untyped 项必须用真实宿主探针补证。");
  lines.push("");
  lines.push("RESULT: " + (diff.hasRemovals ? "FAIL（存在删除项）" : "PASS（无删除项）"));
  return lines.join("\n");
}

const USAGE = [
  "用法: node scripts/derive/host-service-diff.ts --from <old> --to <new> [--json] [--check]",
  "",
  "  --from <dir>  旧官方包树（node_modules 根 / @deepseek-ai scope / 单包根 / 含包目录）",
  "  --to <dir>    新官方包树（同上）",
  "  --json        输出结构化 JSON（stdout）",
  "  --check       有服务/方法/事件删除时 exit 1；0 = 无删除；2 = 工具故障",
  "  --help        显示本帮助",
  "",
].join("\n");

type Option = { key: "from" | "to"; value?: string } | { key: "json" | "check" | "help" };

function splitOption(arg: string): Option {
  if (arg === "-h") return { key: "help" };
  if (arg === "--json" || arg === "--check" || arg === "--help")
    return { key: arg.slice(2) as "json" | "check" | "help" };
  for (const key of ["from", "to"] as const) {
    if (arg === "--" + key) return { key };
    if (arg.startsWith("--" + key + "=")) {
      return { key, value: arg.slice(key.length + 3) };
    }
  }
  throw new SurfaceError("未知参数：" + arg);
}

function parseArgs(argv: string[]): {
  from: string;
  to: string;
  json: boolean;
  check: boolean;
  help: boolean;
} {
  const out = { from: "", to: "", json: false, check: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const option = splitOption(argv[i]);
    if (option.key === "from" || option.key === "to") {
      const next = option.value ?? argv[i + 1];
      if (next === undefined) throw new SurfaceError("--" + option.key + " 缺参数");
      out[option.key] = next;
      if (option.value === undefined) i += 1;
      continue;
    }
    out[option.key] = true;
  }
  if (!out.help && (out.from === "" || out.to === "")) {
    throw new SurfaceError("--from 与 --to 必填（--help 查看用法）");
  }
  return out;
}

/** CLI 入口；返回退出码（测试可直接调用）。 */
export function runHostServiceDiff(argv: string[]): number {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error("host-service-diff: FAIL-CLOSED " + (error as Error).message);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const oldSurface = buildHostServiceSurface(options.from);
    const newSurface = buildHostServiceSurface(options.to);
    const diff = diffHostServiceSurfaces(oldSurface, newSurface);
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ...diff,
            from: { root: oldSurface.root, packages: oldSurface.packages, files: oldSurface.files },
            to: { root: newSurface.root, packages: newSurface.packages, files: newSurface.files },
            opaque: { from: oldSurface.opaque, to: newSurface.opaque },
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(formatSurfaceDiff(diff) + "\n");
    }
    if (options.check && diff.hasRemovals) return 1;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("host-service-diff: FAIL-CLOSED " + message);
    return 2;
  }
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = runHostServiceDiff(process.argv.slice(2));
}
