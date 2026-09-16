/**
 * binding 域装配：绑定表的**唯一事实源**。
 *
 * 内存快照是刻意的：scope 域的解析器与 api 域的路由读同一个对象，两端 revision 因此不可能
 * 各说各话（降级预案 G7）。落盘只是它的持久化副本——写盘失败时内存不前移，
 * 因为「内存说已登记、磁盘说没有」在重启后会变成一次静默的换根失败。
 *
 * 状态（表快照与写盘串行链）住在实例里；域是**进程内单例**，第二次 `install` 由 `installed`
 * 守卫**显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import type { BindingRecord, BindingsFile } from "../model/type.ts";
import type { FileWrite } from "../../../shared/interface.ts";
import type { BindingDeps } from "../../deps.ts";
import { dropBinding, emptyTable, putBinding } from "../model/index.ts";
import { loadTable, saveTable } from "../store/index.ts";

/** 未装配时能力面的失败文案：读到它就说明装配守卫有洞，当场暴露而不是拿旧 deps 出结果。 */
const NOT_INSTALLED = "dsh-worktree-sidebar: binding 域尚未装配";

/** 绑定域的服务面。 */
export interface BindingApi {
  /** 当前表版本。与 api 域路由读的是同一快照，故它也是客户端能观察到的版本。 */
  revision(): number;
  /** 按会话取绑定。 */
  get(sessionId: string): BindingRecord | undefined;
  /** 落一条绑定并持久化。 */
  put(sessionId: string, record: BindingRecord): Promise<FileWrite>;
  /** 摘一条绑定并持久化（幂等：本来就没有不算失败）。 */
  drop(sessionId: string): Promise<FileWrite>;
}

/** 绑定表：唯一实例持有内存快照与写盘串行链。 */
class BindingService implements BindingApi {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  private deps: BindingDeps | undefined;
  private table: BindingsFile = emptyTable();
  /**
   * 写盘串行链：两次并发修改都基于同一份旧表时，后写的那次会静默吞掉前一次的绑定。
   * 链本身不承载结果，失败也不该断链，故 catch 掉、语义归返回值。
   */
  private writes: Promise<unknown> = Promise.resolve();
  /**
   * 装配代数。`release` 的尾部清理要 `await` 在飞的写盘，那一小段时间里**新的一个
   * `install` 可能已经装上并从磁盘读回了新表**；无脑清表会抹掉它，紧接着一次 `put`
   * 就把空表写回磁盘、丢掉所有会话的登记。
   */
  private generation = 0;

  /** 装配绑定域：把 bindings.json 读进内存（损坏回落空表，见 model 块）。重复装配是编程错误。 */
  install(deps: BindingDeps): void {
    if (this.installed) throw new Error("dsh-worktree-sidebar: binding 域只能装配一次");
    this.installed = true;
    this.generation += 1;
    this.deps = deps;
    // 每次都重新读盘：release 之后再装配必须看到磁盘的**现状**，不是上一代留下的内存快照。
    this.table = loadTable(deps.file);
  }

  /**
   * 卸载：**先等在飞的写盘链落定**，再放开入参、丢掉内存快照、复位装配标记。
   * 不等的话，同进程的下一次装配会读到比已提交内容更旧的磁盘状态——表现为「刚写的绑定在重装后消失」。
   * 重复调用无害。
   */
  async release(): Promise<void> {
    const generation = ++this.generation;
    // 只等**这一次 release 入口时**已经排队的那条链：期间新装上的一代有自己的链，不该被我们等，
    // 更不该被我们复位。
    const writes = this.writes;
    this.installed = false;
    this.deps = undefined;
    await writes;
    // 期间有新一代装配过：现在内存里那份表是它的，不是本代留下的，清掉就是把它的内容抹成空。
    if (this.generation !== generation) return;
    this.writes = Promise.resolve();
    this.table = emptyTable();
  }

  revision(): number {
    this.requireInstalled();
    return this.table.revision;
  }

  get(sessionId: string): BindingRecord | undefined {
    this.requireInstalled();
    return this.table.bindings[sessionId];
  }

  put(sessionId: string, record: BindingRecord): Promise<FileWrite> {
    this.requireInstalled();
    if (sessionId.length === 0) return Promise.resolve({ ok: false, reason: "空 sessionId" });
    return this.commit((current) => putBinding(current, sessionId, record));
  }

  drop(sessionId: string): Promise<FileWrite> {
    this.requireInstalled();
    return this.commit((current) => dropBinding(current, sessionId));
  }

  /**
   * 应用一次表变换并持久化。写盘成功才算成功——半成功的内存状态是最坏结果：
   * 内存说有、磁盘说没有，重启后就是一次静默的换根失败。
   *
   * 入参在**调用当刻**取出：在飞的写盘链要活过 `release`（它等的就是这一步落定），
   * 而那一刻 `this.deps` 已经被放开了。
   */
  private commit(reduce: (current: BindingsFile) => BindingsFile): Promise<FileWrite> {
    const deps = this.deps;
    if (deps === undefined) throw new Error(NOT_INSTALLED);
    const run = async (): Promise<FileWrite> => {
      const next = reduce(this.table);
      if (next === this.table) return { ok: true };
      const written = await saveTable(deps.file, next);
      if (written.ok) this.table = next;
      else deps.logger.warn("dsh-worktree-sidebar: 绑定表写盘失败 — " + written.reason);
      return written;
    };
    const queued = this.writes.then(run, run);
    this.writes = queued.catch(() => undefined);
    return queued;
  }

  /** 未装配时能力面当场失败，不拿旧 deps 出结果。 */
  private requireInstalled(): void {
    if (this.deps === undefined) throw new Error(NOT_INSTALLED);
  }
}

/** 本域唯一实例：类不外放，外面 `new` 不出第二份绑定表。 */
export const bindingService = new BindingService();
