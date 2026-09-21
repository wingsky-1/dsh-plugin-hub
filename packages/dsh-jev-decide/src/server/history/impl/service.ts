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

/** 查询条目（root/sessionId 可选过滤；limit 上限 500；按 ts 倒序）。 */
export function queryEntries(
  home: string | undefined,
  query: { readonly root?: string; readonly sessionId?: string; readonly limit?: number },
  deps: HistoryDeps,
): HistoryEntry[] {
  const limit =
    query.limit === undefined ? 100 : Math.min(Math.max(1, Math.floor(query.limit)), 500);
  const rootParam = query.root === undefined || query.root === "" ? undefined : query.root;
  // root 三形态：rootHash（hex 直用）/ 完整路径（含分隔符即哈希）/ basename（按 rootDisplay 逐条匹配，解决客户端只传原文短名的情形）。
  const wantRoot =
    rootParam === undefined
      ? undefined
      : /^[0-9a-f]{16,64}$/.test(rootParam) || rootParam.includes("/") || rootParam.includes("\\")
        ? resolveRootHash(rootParam)
        : undefined;
  const wantDisplay = rootParam !== undefined && wantRoot === undefined ? rootParam : undefined;
  if (query.sessionId !== undefined && query.sessionId !== "") assertSessionId(query.sessionId);
  const files = listSessionFiles(home, deps);
  const out: HistoryEntry[] = [];
  for (const file of files) {
    const name = basename(file);
    const dirName = basename(dirname(file));
    const sid = name.endsWith(".jsonl") ? name.slice(0, -6) : name;
    if (wantRoot !== undefined && dirName !== wantRoot) continue;
    if (query.sessionId !== undefined && query.sessionId !== "" && sid !== query.sessionId)
      continue;
    const raw = deps.io.readTextSync(file);
    if (!raw.ok) continue;
    for (const line of raw.text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as HistoryEntry;
        if (wantDisplay !== undefined && parsed.rootDisplay !== wantDisplay) continue;
        out.push(parsed);
      } catch {
        // 坏行跳过（某次崩溃半截行不污染整库查询）。
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

/**
 * 删除单会话（root 与 sessionId 双必填，否则 400；仅删单文件，返回真实 deleted）。
 *
 * D2：root 走与查询对称的三形态——hex/路径直定位文件；basename 走 display 回落：
 * 扫描会话文件找 rootDisplay+sessionId 命中的那一个，0 个即 deleted:false，
 * 多个即 400 歧义（不同目录同 basename 时不猜删）。
 */
export function deleteSession(
  home: string | undefined,
  query: { readonly root?: string; readonly sessionId?: string },
  deps: HistoryDeps,
): { readonly deleted: boolean } {
  if (
    query.root === undefined ||
    query.root === "" ||
    query.sessionId === undefined ||
    query.sessionId === ""
  ) {
    throw new Error("history[400]: 仅支持单会话删除（root 与 sessionId 双必填）");
  }
  const rootParam = query.root;
  const direct =
    /^[0-9a-f]{16,64}$/.test(rootParam) || rootParam.includes("/") || rootParam.includes("\\");
  if (direct) {
    const file = historyFile(home, resolveRootHash(rootParam), query.sessionId as string);
    const prev = deps.io.readTextSync(file);
    if (!prev.ok) return { deleted: false };
    deps.io.removeFileSync(file);
    return { deleted: true };
  }
  const hits: string[] = [];
  for (const file of listSessionFiles(home, deps)) {
    const raw = deps.io.readTextSync(file);
    if (!raw.ok) continue;
    for (const line of raw.text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as HistoryEntry;
        if (parsed.rootDisplay === rootParam && parsed.sessionId === query.sessionId) {
          hits.push(file);
          break;
        }
      } catch {
        // 坏行跳过。
      }
    }
  }
  if (hits.length === 0) return { deleted: false };
  if (hits.length > 1) {
    throw new Error("history[400]: basename 命中多个会话目录，请传完整路径或 rootHash");
  }
  deps.io.removeFileSync(hits[0] as string);
  return { deleted: true };
}
