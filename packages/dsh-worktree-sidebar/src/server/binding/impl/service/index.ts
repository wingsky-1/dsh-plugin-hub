/**
 * binding 域装配：绑定表的**唯一事实源**。
 *
 * 内存快照是刻意的：scope 域的解析器与 api 域的路由读同一个对象，两端 revision 因此不可能
 * 各说各话（降级预案 G7）。落盘只是它的持久化副本——写盘失败时内存不前移，
 * 因为「内存说已登记、磁盘说没有」在重启后会变成一次静默的换根失败。
 *
 * **状态住在实例里，不住在模块里**（#733 宪法第 1 条）：`createBinding` 每次调用都给出一份独立的
 * 状态，所以同进程里跑两份装配（两个 profile、测试夹具）不会互相污染，也不会在第二次装配时抛「已装配」。
 * 域门禁 `forbid-module-state-src` 判的就是这件事。
 */
import type { BindingRecord, BindingsFile } from "../../../../contract.ts";
import type { FileWrite } from "../../../shared/interface.ts";
import type { BindingDeps } from "../../deps.ts";
import { dropBinding, pruneTable, putBinding } from "../model/index.ts";
import { loadTable, saveTable } from "../store/index.ts";

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

/** 装配绑定域：把 bindings.json 读进内存（损坏回落空表，见 model 块）。 */
export function createBinding(deps: BindingDeps): BindingApi {
  let table: BindingsFile = loadTable(deps.file);
  /**
   * 写盘串行链：两次并发修改都基于同一份旧表时，后写的那次会静默吞掉前一次的绑定。
   * 链本身不承载结果，失败也不该断链，故 catch 掉、语义归返回值。
   */
  let writes: Promise<unknown> = Promise.resolve();

  /**
   * 应用一次表变换并持久化。写盘成功才算成功——半成功的内存状态是最坏结果：
   * 内存说有、磁盘说没有，重启后就是一次静默的换根失败。
   */
  const commit = (reduce: (current: BindingsFile) => BindingsFile): Promise<FileWrite> => {
    const run = async (): Promise<FileWrite> => {
      const next = reduce(table);
      if (next === table) return { ok: true };
      const written = await saveTable(deps.file, next);
      if (written.ok) table = next;
      else deps.logger.warn("dsh-worktree-sidebar: 绑定表写盘失败 — " + written.reason);
      return written;
    };
    const queued = writes.then(run, run);
    writes = queued.catch(() => undefined);
    return queued;
  };

  return {
    revision: () => table.revision,
    get: (sessionId) => table.bindings[sessionId],
    entries: () => table.bindings,
    put: (sessionId, record) => {
      if (sessionId.length === 0) return Promise.resolve({ ok: false, reason: "空 sessionId" });
      return commit((current) => putBinding(current, sessionId, record));
    },
    drop: (sessionId) => commit((current) => dropBinding(current, sessionId)),
    prune: (keep) => commit((current) => pruneTable(current, keep)),
  };
}
