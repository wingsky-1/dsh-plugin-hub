/**
 * 按当前 agent 生命周期记忆限制；新层挂好后撤旧层。
 * 普通事件同步对账，只有 session 发布重入可在栈后重试一次。
 */
import type { AgentFace } from "../../../shared/interface.ts";
import type { ProjectUnit } from "../../../connection/runtime/interface.ts";
import type { StartAgentVisibilityArgs } from "../../interface.ts";

/** 注册名的前缀（与 server/shared/tool-names.ts 的唯一派生点同源，这里只读不造名）。 */
const MCP_PREFIX = "mcp__";
/** id 段与工具段之间的分隔符（`mcp__<id>__<tool>`）。 */
const ID_SEPARATOR = "__";

interface AgentRecord {
  face: AgentFace;
  key?: string;
  disposers: Array<() => void>;
  cleanup: Array<() => void>;
  disposed: boolean;
}

/** deny 名单的稳定串：排序后 join（名单同集合不同顺序视为同一份）。 */
function keyOf(names: readonly string[]): string {
  return [...names].sort().join("\n");
}

/** deny 双层名单：全名单是记忆 key 与收敛判据的来源，批量层是其中 id 命中单元的子集。 */
interface DenyLists {
  /** 注册面全部形状良好的 `mcp__` 前缀名（排序后；`ws_mcp_*` 与畸形名已排除）。 */
  deny: string[];
  /** 其中 id 段属于连接池单元表的名字（排序后；批量直挂层）。 */
  batched: string[];
}

/** 取注册名的 id 段（调用方已保证 `mcp__<id>__<tool>` 形状且三段非空，此处不做校验）。 */
function idOf(name: string): string {
  const rest = name.slice(MCP_PREFIX.length);
  return rest.slice(0, rest.indexOf(ID_SEPARATOR));
}

/**
 * 宿主 `restrict` 的“未知名字”类错误判定：挂载与收集之间的 TOCTOU 缝里，名在收集时在册、
 * 挂载时已销是常态，只跳过、不阻断整单。判定耦合宿主报错文案（`names unknown global tool`），
 * 由单测用宿主原文案锁定；其余错误（作用域拆除、保留名、四原子误入等）一律重抛。
 */
function isUnknownNameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("tools.restrict()") && message.toLowerCase().includes("unknown");
}

/**
 * 从**活注册面**现算 deny 名单（#922 方案 B：注册表优先）：注册名以 `mcp__` 开头且形状良好
 * （`mcp__<id>__<tool>` 三段非空）即进名单，不再要求其 id 同刻属于连接池单元——连接翻转期
 * （先销工具后清账本，或先注册工具后回填 id）两边必然错位，交集口径会在此时系统性偏向泄漏
 * （`mcp__*` 进 SDK 文本，见 #922）。单元表只做分级参考：id 命中的进批量层直挂，其余走逐名
 * 挂载（挂载时已销的逐名跳过）。`ws_mcp_*` 四原子不是 `mcp__` 前缀，天然不在名单里。
 */
function collectDenyNames(
  units: ReadonlyMap<string, ProjectUnit>,
  registeredNames: () => readonly string[],
): DenyLists {
  const ids = new Set<string>();
  for (const unit of units.values()) {
    for (const entry of unit.connections.values()) {
      // 虚拟连接单元（toolDefinitions）没有宿主注册名，entry.id 恒 undefined。
      if (typeof entry.id === "string" && entry.id !== "") ids.add(entry.id);
    }
  }
  const deny = new Set<string>();
  for (const name of registeredNames()) {
    if (typeof name !== "string" || !name.startsWith(MCP_PREFIX)) continue;
    const rest = name.slice(MCP_PREFIX.length);
    const separator = rest.indexOf(ID_SEPARATOR);
    if (separator <= 0 || separator + ID_SEPARATOR.length >= rest.length) continue;
    deny.add(name);
  }
  const sorted = [...deny].sort();
  return {
    deny: sorted,
    batched: sorted.filter((name) => ids.has(idOf(name))),
  };
}

/** 逆序清理；失败的句柄留下，兼容先 undo 再 notify 抛错的幂等摘除器。 */
function disposeAll(disposers: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      disposers.unshift(dispose);
      errors.push(error);
    }
  }
  return errors;
}

function isSessionReentry(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "session append cannot reenter while another append is being published"
  );
}

/** 逐步收集句柄，失败时由调用方回滚；回滚失败的句柄也不能丢。 */
function mountDenyList(
  face: AgentFace,
  lists: DenyLists,
  disposers: Array<() => void>,
  active: () => boolean,
  onUnknown: (name: string, error: unknown) => void,
): void {
  const restrictOne = (name: string): void => {
    if (!active()) return;
    try {
      disposers.push(face.tools.restrict({ deny: [name] }));
    } catch (error) {
      if (!isUnknownNameError(error)) throw error;
      onUnknown(name, error);
    }
  };
  if (lists.batched.length > 0 && active()) {
    try {
      disposers.push(face.tools.restrict({ deny: [...lists.batched] }));
    } catch (error) {
      if (!isUnknownNameError(error)) throw error;
      for (const name of lists.batched) restrictOne(name);
    }
  }
  const batched = new Set(lists.batched);
  for (const name of lists.deny) {
    if (!batched.has(name)) restrictOne(name);
  }
}

/**
 * 启动模型可见面隐藏。返回域 disposer（摘监听 + 撤掉全部已应用限制）。
 *
 * @param args 组合根按调用实参递进来的全部输入（本域没有端口持有者，也没有第二处取数路径）。
 */
export function startAgentVisibility(args: StartAgentVisibilityArgs): () => void {
  const { events, units, registeredNames, logger } = args;
  const live = new Map<string, AgentRecord>();
  const retired = new Set<AgentRecord>();
  // true 允许重新挂载；false 只补清理，不把普通挂载失败变成自动重试。
  const pending = new Map<AgentRecord, { retryMount: boolean; key: string }>();
  const queued = new Set<AgentRecord>();
  const unhook: Array<() => void> = [];
  let reconciling = false;
  let changed = false;
  let stopped = false;
  let degradedWarned = false;
  let skippedUnknownTotal = 0;

  const warnDegraded = (message: string): void => {
    if (degradedWarned) return;
    degradedWarned = true;
    logger.warn(message);
  };

  // 活表可能每次返回新 wrapper；仅在当前生命周期内按 id 规范化。
  const canonical = (face: AgentFace): AgentRecord => {
    let record = live.get(face.id);
    if (record === undefined) {
      record = { face, disposers: [], cleanup: [], disposed: false };
      live.set(face.id, record);
    }
    return record;
  };

  const skipUnknown = (name: string, error: unknown): void => {
    skippedUnknownTotal += 1;
    logger.warn(
      `dsh-mcp-manager: 跳过挂载时已销的工具名 ${JSON.stringify(name)}（累计跳过 ${skippedUnknownTotal} 个）：${String(error)}`,
    );
  };

  const readLists = (): DenyLists | undefined => {
    try {
      return collectDenyNames(units, registeredNames);
    } catch (error) {
      warnDegraded(
        `dsh-mcp-manager: 读取工具注册面失败，模型可见面隐藏降级为 no-op（mcp__* 保持可见）：${String(error)}`,
      );
      return undefined;
    }
  };

  const failed = (
    record: AgentRecord,
    error: unknown,
    allowRetry: boolean,
    key: string,
    cleanup = false,
  ): void => {
    // 普通挂载异常立即出声；清理失败保留句柄并至多补一次清理。
    if (!isSessionReentry(error) || !allowRetry)
      logger.warn(
        `dsh-mcp-manager: 为 agent ${record.face.id} 应用工具可见面限制失败：${String(error)}`,
      );
    if (allowRetry && (isSessionReentry(error) || cleanup)) {
      if (pending.has(record)) return;
      pending.set(record, { retryMount: !cleanup, key });
      queueMicrotask(() => {
        const retry = pending.get(record);
        if (!pending.delete(record)) return;
        // 已退役的记录只清理自己的句柄，绝不重新挂载或按 id 找新生命周期。
        reconcile(record, false, !retry?.retryMount);
      });
      return;
    }
  };

  const replace = (record: AgentRecord, lists: DenyLists, allowRetry: boolean): void => {
    const active = (): boolean => !stopped && !record.disposed;
    const next: Array<() => void> = [];
    try {
      mountDenyList(record.face, lists, next, active, skipUnknown);
      if (active()) {
        // 先成功挂新层，才把旧层转入待撤队列。
        record.cleanup.push(...record.disposers);
        record.disposers = next;
        record.key = keyOf(lists.deny);
      } else {
        record.cleanup.push(...next);
      }
    } catch (error) {
      record.cleanup.push(...next);
      failed(record, error, allowRetry, keyOf(lists.deny));
    }
  };

  const applyTo = (
    record: AgentRecord,
    lists: DenyLists | undefined,
    allowRetry: boolean,
  ): void => {
    const key = keyOf(lists?.deny ?? []);
    if (!stopped && !record.disposed && lists !== undefined && record.key !== key)
      replace(record, lists, allowRetry);
    for (const error of disposeAll(record.cleanup)) failed(record, error, allowRetry, key, true);
    if (record.disposed && record.cleanup.length === 0) retired.delete(record);
  };

  const discover = (): void => {
    try {
      for (const face of events.liveAgents?.() ?? []) canonical(face);
    } catch (error) {
      logger.warn(`dsh-mcp-manager: 读取活 agent 表失败：${String(error)}`);
    }
  };

  const applyQueued = (
    record: AgentRecord,
    lists: DenyLists | undefined,
    attempted: Map<AgentRecord, Set<string>>,
    allowRetry: boolean,
    cleanupOnly: boolean,
  ): void => {
    const target = keyOf(lists?.deny ?? []);
    const retry = pending.get(record);
    if (retry !== undefined) {
      // 与失败那轮的目标比较：同名单的清理通知不会触发普通挂载自动重试。
      if (lists !== undefined && retry.key !== target) retry.retryMount = true;
      return;
    }
    const key = record.disposed ? "disposed" : target;
    const keys = attempted.get(record) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    attempted.set(record, keys);
    applyTo(record, cleanupOnly ? undefined : lists, allowRetry);
  };

  const refreshLists = (lists: DenyLists | undefined): DenyLists | undefined => {
    if (!changed || stopped) return lists;
    const latest = readLists();
    if (latest !== undefined && keyOf(latest.deny) !== keyOf(lists?.deny ?? [])) {
      for (const record of live.values()) queued.add(record);
    }
    return latest;
  };

  const queueAll = (): void => {
    if (!stopped) discover();
    for (const record of [...live.values(), ...retired]) queued.add(record);
  };

  /** 重入只登记任务；相同 record/名单每轮至多尝试一次，失败通知不自激。 */
  const reconcile = (only?: AgentRecord, allowRetry = true, cleanupOnly = false): void => {
    if (only !== undefined) queued.add(only);
    if (reconciling) {
      changed = true;
      return;
    }
    if (only === undefined) queueAll();
    reconciling = true;
    const attempted = new Map<AgentRecord, Set<string>>();
    try {
      let lists = stopped ? undefined : readLists();
      do {
        changed = false;
        const batch = [...queued];
        queued.clear();
        for (const record of batch)
          applyQueued(record, lists, attempted, allowRetry, cleanupOnly && record === only);
        lists = refreshLists(lists);
      } while (queued.size > 0);
    } finally {
      reconciling = false;
    }
  };

  const disposeAgent = (id: string): void => {
    const record = live.get(id);
    if (record === undefined) return;
    live.delete(id);
    pending.delete(record);
    record.disposed = true;
    record.cleanup.push(...record.disposers);
    record.disposers = [];
    retired.add(record);
    reconcile(record);
  };

  const onCreated = events.onAgentCreated;
  const onDisposed = events.onAgentDisposed;
  const onChanged = events.onToolsChange;

  if (onCreated === undefined && onDisposed === undefined && onChanged === undefined) {
    warnDegraded(
      "dsh-mcp-manager: agent 事件面不可用，模型可见面隐藏降级为 no-op（mcp__* 保持可见）",
    );
    return () => {};
  }
  // 监听挂载本身也可能抛（事件名未合并进宿主类型面时 cordis 会拒）：降级成 no-op 而不是把
  // apply 打断——隐藏面缺失是功能缺口，不是装配错误。
  const hook = (subscribe: (() => void) | undefined): void => {
    if (subscribe !== undefined) unhook.push(subscribe);
  };
  try {
    if (onCreated !== undefined)
      hook(
        onCreated((agent) => {
          if (!stopped) {
            queued.add(canonical(agent));
            reconcile();
          }
        }),
      );
    if (onDisposed !== undefined) hook(onDisposed((agent) => disposeAgent(agent.id)));
    if (onChanged !== undefined)
      hook(
        onChanged(() => {
          if (!stopped) reconcile();
        }),
      );
  } catch (error) {
    warnDegraded(
      `dsh-mcp-manager: 订阅 agent 事件面失败，模型可见面隐藏降级为 no-op：${String(error)}`,
    );
  }

  // 装载时的初始全量 reconcile：覆盖已经 live 的 agent；此后 startAll 期间的注册走 tools/change。
  reconcile();

  return () => {
    stopped = true;
    pending.clear();
    // 先摘监听再撤限制：撤限制本身也会发 tools/change，摘晚了会把卸载路径再拉进 reconcile。
    for (const stop of unhook.splice(0)) {
      try {
        stop();
      } catch {
        // 摘除失败不阻断其余清理（宿主的 effect 也会兜一层）。
      }
    }
    for (const id of [...live.keys()]) disposeAgent(id);
    // 也重试此前失败、已从活表移出的清理句柄。
    reconcile();
  };
}
