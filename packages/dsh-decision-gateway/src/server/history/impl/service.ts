/**
 * history 域实现：按 (rootHash, sessionId) 分文件 jsonl（每会话 perSession 轮转，总会话 totalSessions 上限）。
 *
 * - 文件：history/<rootHash>/<sessionId>.jsonl（一行一条目）；
 * - 轮转：追加后超 perSession 即只留末尾 N 行；
 * - 总量：会话文件超 totalSessions 即按 mtime 淘汰最旧整文件；
 * - 条目由调用方构造，本域只做落盘/查询/删除；密钥表达的字段一律不在条目类型里（见共享契约）。
 */
import { basename, dirname, join } from "node:path";
import type { HistoryDeps } from "../deps.ts";
import { historyRoot } from "./paths.ts";
import { resolveRootHash } from "./hash.ts";
import { SESSION_ID_RE } from "../../../shared/interface.ts";
import type { HistoryEntry } from "../../../shared/interface.ts";

/** 会话文件名（sessionId 形状先行校验，防路径穿越）。 */
export function historyFile(home: string | undefined, rootHash: string, sessionId: string): string {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{16,64}$/.test(rootHash)) throw new Error("history[400]: rootHash 非法");
  return join(historyRoot(home), rootHash, sessionId + ".jsonl");
}

/** sessionId 形状校验（非法即 400，不落盘）。 */
export function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error("history[400]: sessionId 非法");
  }
}

/** 列全部会话文件（绝对路径；读失败即空）。 */
function listSessionFiles(home: string | undefined, deps: HistoryDeps): string[] {
  const out: string[] = [];
  const dir = historyRoot(home);
  for (const root of deps.io.listFilesSync(dir)) {
    if (root === "" || root.startsWith(".")) continue;
    const sub = join(dir, root);
    for (const name of deps.io.listFilesSync(sub)) {
      if (!name.endsWith(".jsonl")) continue;
      out.push(join(sub, name));
    }
  }
  return out;
}

/** 追加条目并轮转（返回落盘文件）。 */
export function appendEntry(
  home: string | undefined,
  entry: HistoryEntry,
  limits: { readonly perSession: number; readonly totalSessions: number },
  deps: HistoryDeps,
): string {
  const file = historyFile(home, entry.rootHash, entry.sessionId);
  deps.io.ensureDir0700(join(historyRoot(home), entry.rootHash));
  const prev = deps.io.readTextSync(file);
  const line = JSON.stringify(entry) + "\n";
  const merged = (prev.ok ? prev.text : "") + line;
  const lines = merged.split("\n").filter((item) => item.length > 0);
  const kept = lines.slice(Math.max(0, lines.length - limits.perSession));
  deps.io.atomicWrite0600Sync(file, kept.join("\n") + "\n");
  enforceTotalSessions(home, limits.totalSessions, deps);
  return file;
}

/**
 * 总量淘汰（R1：只保“会话文件数 ≤totalSessions”语义，不钉真盘精确性——粗粒度文件系统上
 * 同毫秒 mtime 并列时淘汰并列中的哪一个未定义；调用方不得断言具体删了谁，只数总数）。
 */
function enforceTotalSessions(
  home: string | undefined,
  totalSessions: number,
  deps: HistoryDeps,
): void {
  const files = listSessionFiles(home, deps);
  if (files.length <= totalSessions) return;
  const ranked = files.map((file) => ({ file, mtime: deps.io.mtimeMs(file) }));
  ranked.sort((a, b) => a.mtime - b.mtime);
  for (const victim of ranked.slice(0, ranked.length - totalSessions)) {
    deps.io.removeFileSync(victim.file);
  }
}

/**
 * root 参数的三形态：rootHash（hex 直用）/ 完整路径（含分隔符即哈希）/ basename（按 rootDisplay 匹配）。
 *
 * 查询与删除共用同一判定，所以抽成一处：窄联合而非 boolean，调用点读 .kind 就知道该
 * 走「定位目录」还是「逐条匹配 display」——basename 形态在两处的回落语义不同但形态判定相同。
 */
type RootForm = { readonly kind: "hash" } | { readonly kind: "basename" };

function classifyRoot(rootParam: string): RootForm {
  if (/^[0-9a-f]{16,64}$/.test(rootParam) || rootParam.includes("/") || rootParam.includes("\\")) {
    return { kind: "hash" };
  }
  return { kind: "basename" };
}

/** 缺省/空串归一为「不过滤」（两个可选查询参数同此语义）。 */
function optParam(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

/** limit 归一：缺省 100，夹到 1..500 并向下取整（500 是查询面硬边界）。 */
function clampLimit(raw: number | undefined): number {
  return raw === undefined ? 100 : Math.min(Math.max(1, Math.floor(raw)), 500);
}

/** 会话文件名 → sessionId（去 .jsonl 后缀；无后缀则原样）。 */
function sessionIdOf(file: string): string {
  const name = basename(file);
  return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}

/**
 * 逐行读一个会话文件，命中即回调。
 *
 * 坏行跳过（某次崩溃半截行不污染整库查询）；回调回 false 表示命中收工、不再扫本文件。
 */
function forEachEntry(
  file: string,
  deps: HistoryDeps,
  visit: (entry: HistoryEntry) => boolean,
): void {
  const raw = deps.io.readTextSync(file);
  if (!raw.ok) return;
  for (const line of raw.text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as HistoryEntry;
      if (!visit(parsed)) return;
    } catch {
      // 坏行跳过。
    }
  }
}

/** 查询侧的 root 解析：hash/路径形态解根哈希，basename 形态回 undefined 改走 display 匹配。 */
function resolveQueryRoot(rootParam: string | undefined): {
  readonly rootHash: string | undefined;
  readonly display: string | undefined;
} {
  if (rootParam === undefined) return { rootHash: undefined, display: undefined };
  if (classifyRoot(rootParam).kind === "hash") {
    return { rootHash: resolveRootHash(rootParam), display: undefined };
  }
  return { rootHash: undefined, display: rootParam };
}

/** 文件级过滤：目录名对根哈希、文件名对 sessionId；未给的一律不筛。 */
function fileMatches(
  file: string,
  wantRoot: string | undefined,
  wantSession: string | undefined,
): boolean {
  if (wantRoot !== undefined && basename(dirname(file)) !== wantRoot) return false;
  if (wantSession !== undefined && sessionIdOf(file) !== wantSession) return false;
  return true;
}

/** 查询条目（root/sessionId 可选过滤；limit 上限 500；按 ts 倒序）。 */
export function queryEntries(
  home: string | undefined,
  query: { readonly root?: string; readonly sessionId?: string; readonly limit?: number },
  deps: HistoryDeps,
): HistoryEntry[] {
  const limit = clampLimit(query.limit);
  const want = resolveQueryRoot(optParam(query.root));
  const wantSession = optParam(query.sessionId);
  if (wantSession !== undefined) assertSessionId(wantSession);
  const out: HistoryEntry[] = [];
  for (const file of listSessionFiles(home, deps)) {
    if (!fileMatches(file, want.rootHash, wantSession)) continue;
    forEachEntry(file, deps, (entry) => {
      if (want.display !== undefined && entry.rootDisplay !== want.display) return true;
      out.push(entry);
      return true;
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

/** hex/路径形态：直接定位单文件删除（文件读不到即 deleted:false）。 */
function deleteDirect(
  home: string | undefined,
  rootParam: string,
  sessionId: string,
  deps: HistoryDeps,
): { readonly deleted: boolean } {
  const file = historyFile(home, resolveRootHash(rootParam), sessionId);
  const prev = deps.io.readTextSync(file);
  if (!prev.ok) return { deleted: false };
  deps.io.removeFileSync(file);
  return { deleted: true };
}

/**
 * basename 形态：扫会话文件找 rootDisplay+sessionId 命中的那一个。
 *
 * 0 个即 deleted:false；多个即 400 歧义（不同目录同 basename 时不猜删）。
 */
function deleteByDisplay(
  home: string | undefined,
  rootParam: string,
  sessionId: string,
  deps: HistoryDeps,
): { readonly deleted: boolean } {
  const hits: string[] = [];
  for (const file of listSessionFiles(home, deps)) {
    forEachEntry(file, deps, (entry) => {
      if (entry.rootDisplay !== rootParam || entry.sessionId !== sessionId) return true;
      hits.push(file);
      return false;
    });
  }
  if (hits.length === 0) return { deleted: false };
  if (hits.length > 1) {
    throw new Error("history[400]: basename 命中多个会话目录，请传完整路径或 rootHash");
  }
  const [first] = hits;
  if (first === undefined) return { deleted: false };
  deps.io.removeFileSync(first);
  return { deleted: true };
}

/**
 * 删除单会话（root 与 sessionId 双必填，否则 400；仅删单文件，返回真实 deleted）。
 *
 * root 走与查询对称的三形态——hex/路径直定位文件；basename 走 display 回落。
 */
export function deleteSession(
  home: string | undefined,
  query: { readonly root?: string; readonly sessionId?: string },
  deps: HistoryDeps,
): { readonly deleted: boolean } {
  const rootParam = optParam(query.root);
  const sessionId = optParam(query.sessionId);
  if (rootParam === undefined || sessionId === undefined) {
    throw new Error("history[400]: 仅支持单会话删除（root 与 sessionId 双必填）");
  }
  if (classifyRoot(rootParam).kind === "hash") {
    return deleteDirect(home, rootParam, sessionId, deps);
  }
  return deleteByDisplay(home, rootParam, sessionId, deps);
}
