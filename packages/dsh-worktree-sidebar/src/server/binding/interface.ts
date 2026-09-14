/**
 * binding 域对外契约：绑定表的**唯一事实源**。
 *
 * 内存快照是刻意的：scope 域的解析器与 api 域的路由读同一个对象，两端 revision 因此不可能
 * 各说各话（降级预案 G7）。落盘只是它的持久化副本——写盘失败时内存不前移，
 * 因为「内存说已登记、磁盘说没有」在重启后会变成一次静默的换根失败。
 */
import type { BindingRecord, BindingsFile } from "../../contract.ts";
import type { FileWrite } from "../shared/interface.ts";
import type { BindingDeps } from "./deps.ts";
import { dropBinding, pruneTable, putBinding } from "./impl/model/index.ts";
import { loadTable, saveTable } from "./impl/store/index.ts";

/** 绑定域的服务面。 */
export interface BindingApi {
  /** 当前表版本。与 api 域路由读的是同一快照，故它也是客户端能观察到的版本。 */
  revision(): number;
  /** 按会话取绑定。 */
  get(sessionId: string): BindingRecord | undefined;
  /** 当前全部绑定（只读，供剪枝与排查）。 */
  entries(): Readonly<Record<string, BindingRecord>>;
  /** 落一条绑定并持久化。 */
  put(sessionId: string, record: BindingRecord): Promise<FileWrite>;
  /** 摘一条绑定并持久化（幂等：本来就没有不算失败）。 */
  drop(sessionId: string): Promise<FileWrite>;
  /** 剪枝掉不再活跃的会话。 */
  prune(keep: (sessionId: string) => boolean): Promise<FileWrite>;
}

/** 已装配的域状态。未装配为 null——重复装配是装配错误，不是可容忍状态。 */
interface BindingState {
  readonly deps: BindingDeps;
  table: BindingsFile;
  /** 写盘串行链：两次并发修改都基于同一份旧表时，后写的那次会静默吞掉前一次的绑定。 */
  writes: Promise<unknown>;
}

let installed: BindingState | null = null;

/** 装配绑定域：把 bindings.json 读进内存（损坏回落空表，见 model 域）。 */
export function installBinding(deps: BindingDeps): BindingApi {
  if (installed !== null) throw new Error("dsh-worktree-sidebar: binding 域已装配");
  installed = { deps, table: loadTable(deps.file), writes: Promise.resolve() };
  return api();
}

/** 卸载绑定域。幂等：stale 调用安全 no-op。 */
export function releaseBinding(): void {
  installed = null;
}

function requireState(): BindingState {
  if (installed === null) throw new Error("dsh-worktree-sidebar: binding 域未装配");
  return installed;
}

/**
 * 应用一次表变换并持久化。三件事一起发生才叫「成功」：写盘成功、域仍是本次的域、
 * 期间没有被释放。写盘失败一律保留旧表并回传原因——半成功的内存状态是最坏结果。
 */
function commit(
  state: BindingState,
  reduce: (table: BindingsFile) => BindingsFile,
): Promise<FileWrite> {
  const run = async (): Promise<FileWrite> => {
    const current = requireState();
    const next = reduce(current.table);
    if (next === current.table) return { ok: true };
    const written = await saveTable(current.deps.file, next);
    if (written.ok) {
      if (installed === current) current.table = next;
    } else {
      current.deps.logger.warn("dsh-worktree-sidebar: 绑定表写盘失败 — " + written.reason);
    }
    return written;
  };
  const queued = state.writes.then(run, run);
  // 链本身不承载结果，失败也不该断链：把 rejection 在这里吃掉，语义归返回值。
  state.writes = queued.catch(() => undefined);
  return queued;
}

function api(): BindingApi {
  return {
    revision: () => requireState().table.revision,
    get: (sessionId) => requireState().table.bindings[sessionId],
    entries: () => requireState().table.bindings,
    put: (sessionId, record) => {
      if (sessionId.length === 0) return Promise.resolve({ ok: false, reason: "空 sessionId" });
      const state = requireState();
      return commit(state, (table) => putBinding(table, sessionId, record));
    },
    drop: (sessionId) => {
      const state = requireState();
      return commit(state, (table) => dropBinding(table, sessionId));
    },
    prune: (keep) => {
      const state = requireState();
      return commit(state, (table) => pruneTable(table, keep));
    },
  };
}
