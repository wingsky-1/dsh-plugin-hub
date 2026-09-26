/**
 * dsh-mcp-manager — visibility/impl/mask/index.ts：`mcp__*` 的模型可见面隐藏机制。
 *
 * 承重设计（四条互相咬合的机制，缺一条就会自激或漏网）：
 *
 * 1. **每 agent 记忆已应用的 deny 名单**（`WeakMap<agent, {key, dispose}>`）：`key` 是名单排序后的
 *    稳定串，未变直接返回。这是**防自激循环的唯一闸门**——本包自己的 `restrict` 也会让宿主发
 *    `tools/change`，靠这次比较收敛。
 * 2. **名单以注册面为准、单元表只做分级参考**（#922 方案 B）：`restrict` 会校验目标的
 *    `restrictableNames`，名字不在册当场抛，故名单不能靠我方账本猜。口径 = 活注册面里形状良好的
 *    `mcp__` 前缀名**全部**进 deny，不再要求其 id 同刻属于连接池单元（连接翻转期两边必然错位，
 *    交集口径会在此时系统性偏向泄漏）；单元表只决定**挂法**：id 命中的走批量直挂，其余逐名挂。
 * 3. **先写 key、再改限制面**：算出新 key 后先把记忆里的 key 更新成新值，然后 `prev.dispose()`、
 *    再调用新的 `restrict`。`restrict` 会**同步**发 `tools/change`，重入的 reconcile 必须已经
 *    看到新 key 才能立即返回；另加一个 reconcile 入口的重入闸防嵌套全量 reconcile。
 * 4. **逐名挂只吞“未知名字”**：注册与挂载之间有 TOCTOU 缝（名在收集时在册、挂载时已销），该类失败
 *    跳过并 warn+计数；其余错误整单回滚（已挂的逐个 dispose、不留假记忆）后重抛。
 *
 * 三触发点（照官方 `dsh-tool-subagent` 的正解形态）：`agent/created` / `agent/disposed` /
 * `tools/change`（宿主原话：无载荷、故意不做作用域过滤），装载时先全量 reconcile 一次。
 *
 * 为什么用 `Map<id, AgentFace>` 与 WeakMap 并列：`agent/disposed` 的载荷只有 `id`（宿主事件面
 * 如此），WeakMap 无法按 id 反查；这张 id 表同时承担**对象规范化**——同 id 的两次 `liveAgents()`
 * 调用会产出不同对象，不规范化就会让 WeakMap 恒 miss、每次 reconcile 都重挂一次限制面。
 */
import type { AgentFace } from "../../../shared/interface.ts";
import type { ProjectUnit } from "../../../connection/runtime/interface.ts";
import type { StartAgentVisibilityArgs } from "../../interface.ts";

/** 注册名的前缀（与 server/shared/tool-names.ts 的唯一派生点同源，这里只读不造名）。 */
const MCP_PREFIX = "mcp__";
/** id 段与工具段之间的分隔符（`mcp__<id>__<tool>`）。 */
const ID_SEPARATOR = "__";

/** 一条已应用的 agent 限制。 */
interface Applied {
  /** deny 名单的稳定串：`undefined` 与未应用区分（本表只有已应用项）。 */
  key: string;
  /** 宿主给的限制摘除器；名单为空时保持 no-op（那一轮只撤旧限制）。 */
  dispose: () => void;
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

/** 逆序摘除一串摘除器：后挂的先撤。单个失败不阻断其余（宿主的 effect 也会兜一层）；
 *  清理路径一律不盖首因。回滚与正常摘除两条路径共用。 */
function disposeAll(disposers: readonly (() => void)[]): void {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // 清理路径不盖首因。
    }
  }
}

/**
 * 把整份 deny 名单挂到 face 上：批量层一次直挂，批量死在 TOCTOU 未知名字上时退化成逐名挂；
 *  其余错误整单回滚（已挂的逐个摘除）后重抛。返回本次挂上的摘除器。
 *
 * 挂载口径全在本函数（顺序、批量优先、TOCTOU 跳过、整单回滚），调用方只管「该不该挂、
 * 挂完记什么」——两者是两种变化原因。onUnknown 是逐名跳过时的出声口（warn + 计数）。
 */
function mountDenyList(
  face: AgentFace,
  deny: readonly string[],
  batched: readonly string[],
  onUnknown: (name: string, error: unknown) => void,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  /** 逐名挂载（机制 4）：未知名字跳过并 warn+计数，其余错误上抛整单回滚。 */
  const restrictOne = (name: string): void => {
    try {
      disposers.push(face.tools.restrict({ deny: [name] }));
    } catch (error) {
      if (!isUnknownNameError(error)) throw error;
      onUnknown(name, error);
    }
  };
  try {
    if (batched.length > 0) {
      try {
        // 批量层一次直挂（稳态单调用，少一次 tools/change 自激）。
        // 宿主先校验后生效，批量失败视为零生效（见下整单回滚）。
        disposers.push(face.tools.restrict({ deny: [...batched] }));
      } catch (error) {
        // 批量只可能死在 TOCTOU 未知名字上：退化成逐名；其余错误直接走整单回滚。
        if (!isUnknownNameError(error)) throw error;
        for (const name of batched) restrictOne(name);
      }
    }
    const batchedSet = new Set(batched);
    for (const name of deny) {
      if (!batchedSet.has(name)) restrictOne(name);
    }
  } catch (error) {
    // 整单回滚：已挂的逐个摘除、不留「已应用」的假记忆，下一次 reconcile 才有机会重试。
    disposeAll(disposers);
    throw error;
  }
  return disposers;
}

/**
 * 启动模型可见面隐藏。返回域 disposer（摘监听 + 撤掉全部已应用限制）。
 *
 * @param args 组合根按调用实参递进来的全部输入（本域没有端口持有者，也没有第二处取数路径）。
 */
export function startAgentVisibility(args: StartAgentVisibilityArgs): () => void {
  const { events, units, registeredNames, logger } = args;
  const applied = new WeakMap<AgentFace, Applied>();
  /** id → 规范化的 AgentFace（disposed 按 id 定位 + 同 id 的对象身份稳定）。 */
  const live = new Map<string, AgentFace>();
  const unhook: Array<() => void> = [];
  let reconciling = false;
  let degradedWarned = false;
  /** 累计跳过的 TOCTOU 未知名字个数（闭包态；随 warn 文案可见，供抖动期观测）。 */
  let skippedUnknownTotal = 0;

  /** 降级出声：同一实例只报一次（服务缺席是持久状态，每轮 reconcile 都喊只会淹掉日志）。 */
  const warnDegraded = (message: string): void => {
    if (degradedWarned) return;
    degradedWarned = true;
    logger.warn(message);
  };

  /** 同 id 复用首次见到的对象：WeakMap 的键身份必须跨多次 `liveAgents()` 稳定。 */
  const canonical = (agent: AgentFace): AgentFace => {
    const known = live.get(agent.id);
    if (known !== undefined) return known;
    live.set(agent.id, agent);
    return agent;
  };

  /** 逐名挂载遇到 TOCTOU 未知名字时的出声口：累计计数 + warn（计数是闭包态，供抖动期观测）。 */
  const skipUnknown = (name: string, error: unknown): void => {
    skippedUnknownTotal += 1;
    logger.warn(
      `dsh-mcp-manager: 跳过挂载时已销的工具名 ${JSON.stringify(name)}（累计跳过 ${skippedUnknownTotal} 个）：${String(error)}`,
    );
  };

  const applyTo = (
    face: AgentFace,
    deny: readonly string[],
    batched: readonly string[],
    key: string,
  ): void => {
    const prev = applied.get(face);
    // 机制 1：名单未变直接返回（本包 restrict 自发的 tools/change 在这里收敛）。
    if (prev !== undefined && prev.key === key) return;
    // 机制 3：先写 key（record 先入表），再动限制面——重入的 reconcile 立刻看到新 key。
    const record: Applied = { key, dispose: () => {} };
    applied.set(face, record);
    if (prev !== undefined) prev.dispose();
    // 空 filter 会被宿主当场拒（"Empty filters ... fail"）：名单为空时只撤旧限制、不调 restrict。
    if (deny.length === 0) return;
    let disposers: Array<() => void>;
    try {
      disposers = mountDenyList(face, deny, batched, skipUnknown);
    } catch (error) {
      // 整单回滚已由 mountDenyList 做完（先摘已挂的，再上抛）；此处只去掉「已应用」的
      // 假记忆——顺序照旧：摘除发生时 record 仍在表里，与改前一致。
      applied.delete(face);
      throw error;
    }
    record.dispose = () => disposeAll(disposers);
  };

  /** 活 agent 表（服务缺席 → 空表；域不把它当错误）。 */
  const liveFaces = (): readonly AgentFace[] => {
    const read = events.liveAgents;
    if (read === undefined) return [];
    try {
      return read();
    } catch (error) {
      logger.warn(`dsh-mcp-manager: 读取活 agent 表失败：${String(error)}`);
      return [];
    }
  };

  /** 全量 reconcile；`extra` 是此刻刚创建、可能还没进 liveAgents() 的那一个。 */
  const reconcile = (extra: readonly AgentFace[] = []): void => {
    // 重入闸：restrict 同步发 tools/change，嵌套的全量 reconcile 只放行最外层一次。
    if (reconciling) return;
    reconciling = true;
    try {
      let lists: DenyLists;
      try {
        lists = collectDenyNames(units, registeredNames);
      } catch (error) {
        // 注册面读口缺席（假 ctx 的 tools 只有 register、宿主服务未合并）：降级 no-op，
        // 绝不把 apply 打断——隐藏面缺失是功能缺口，不是装配错误。
        warnDegraded(
          `dsh-mcp-manager: 读取工具注册面失败，模型可见面隐藏降级为 no-op（mcp__* 保持可见）：${String(error)}`,
        );
        return;
      }
      const key = keyOf(lists.deny);
      // 目标 = 宿主活表 ∪ 本域已见过的 agent ∪ 刚创建的那个。只信宿主活表是不够的：
      // agents 服务缺席（假 ctx）时活表恒空，而 tools/change 的重同步仍必须覆盖已知 agent。
      for (const agent of [...liveFaces(), ...live.values(), ...extra]) {
        try {
          applyTo(canonical(agent), lists.deny, lists.batched, key);
        } catch (error) {
          // 单个 agent 挂不上限制不阻断其余（例如作用域已被拆除）：出声、继续。
          logger.warn(
            `dsh-mcp-manager: 为 agent ${agent.id} 应用工具可见面限制失败：${String(error)}`,
          );
        }
      }
    } finally {
      reconciling = false;
    }
  };

  const disposeAgent = (id: string): void => {
    const face = live.get(id);
    if (face === undefined) return;
    applied.get(face)?.dispose();
    applied.delete(face);
    live.delete(id);
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
    if (onCreated !== undefined) hook(onCreated((agent) => reconcile([agent])));
    if (onDisposed !== undefined) hook(onDisposed((agent) => disposeAgent(agent.id)));
    if (onChanged !== undefined) hook(onChanged(() => reconcile()));
  } catch (error) {
    warnDegraded(
      `dsh-mcp-manager: 订阅 agent 事件面失败，模型可见面隐藏降级为 no-op：${String(error)}`,
    );
  }

  // 装载时的初始全量 reconcile：覆盖已经 live 的 agent；此后 startAll 期间的注册走 tools/change。
  reconcile();

  return () => {
    // 先摘监听再撤限制：撤限制本身也会发 tools/change，摘晚了会把卸载路径再拉进 reconcile。
    for (const stop of unhook.splice(0)) {
      try {
        stop();
      } catch {
        // 摘除失败不阻断其余清理（宿主的 effect 也会兜一层）。
      }
    }
    for (const id of [...live.keys()]) disposeAgent(id);
  };
}
