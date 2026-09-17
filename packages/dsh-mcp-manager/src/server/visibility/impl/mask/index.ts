/**
 * dsh-mcp-manager — visibility/impl/mask/index.ts：`mcp__*` 的模型可见面隐藏机制。
 *
 * 承重设计（三条互相咬合的机制，缺一条就会自激或漏网）：
 *
 * 1. **每 agent 记忆已应用的 deny 名单**（`WeakMap<agent, {key, dispose}>`）：`key` 是名单排序后的
 *    稳定串，未变直接返回。这是**防自激循环的唯一闸门**——本包自己的 `restrict` 也会让宿主发
 *    `tools/change`，靠这次比较收敛。
 * 2. **名单每次从活注册面现算**：`restrict` 会校验目标的 `restrictableNames`，名字不在册当场抛，
 *    故名单不能靠我方账本猜。口径 = 活注册面里前缀为 `mcp__` **且 id 属于我方连接池单元**的名字。
 * 3. **先写 key、再改限制面**：算出新 key 后先把记忆里的 key 更新成新值，然后 `prev.dispose()`、
 *    再调用新的 `restrict`。`restrict` 会**同步**发 `tools/change`，重入的 reconcile 必须已经
 *    看到新 key 才能立即返回；另加一个 reconcile 入口的重入闸防嵌套全量 reconcile。
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

/**
 * 从**活注册面**现算 deny 名单：注册名以 `mcp__` 开头，且其 id 段属于连接池单元表里的某个
 * `entry.id`。不属于任何单元的同前缀名字（别的插件注册的、或已拆除代际的残留）不进名单——
 * `restrict` 对不在册名字当场抛，宁可少摘也不把别人摘掉。
 */
function collectDenyNames(
  units: ReadonlyMap<string, ProjectUnit>,
  registeredNames: () => readonly string[],
): string[] {
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
    if (separator <= 0) continue;
    if (!ids.has(rest.slice(0, separator))) continue;
    deny.add(name);
  }
  return [...deny].sort();
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

  const applyTo = (face: AgentFace, deny: readonly string[], key: string): void => {
    const prev = applied.get(face);
    // 机制 1：名单未变直接返回（本包 restrict 自发的 tools/change 在这里收敛）。
    if (prev !== undefined && prev.key === key) return;
    // 机制 3：先写 key（record 先入表），再动限制面——重入的 reconcile 立刻看到新 key。
    const record: Applied = { key, dispose: () => {} };
    applied.set(face, record);
    if (prev !== undefined) prev.dispose();
    // 空 filter 会被宿主当场拒（"Empty filters ... fail"）：名单为空时只撤旧限制、不调 restrict。
    if (deny.length === 0) return;
    try {
      record.dispose = face.tools.restrict({ deny: [...deny] });
    } catch (error) {
      // 宿主校验失败（名字不在册等）：不留「已应用」的假记忆，下一次 reconcile 才有机会重试。
      applied.delete(face);
      throw error;
    }
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
      let deny: string[];
      try {
        deny = collectDenyNames(units, registeredNames);
      } catch (error) {
        // 注册面读口缺席（假 ctx 的 tools 只有 register、宿主服务未合并）：降级 no-op，
        // 绝不把 apply 打断——隐藏面缺失是功能缺口，不是装配错误。
        warnDegraded(
          `dsh-mcp-manager: 读取工具注册面失败，模型可见面隐藏降级为 no-op（mcp__* 保持可见）：${String(error)}`,
        );
        return;
      }
      const key = keyOf(deny);
      // 目标 = 宿主活表 ∪ 本域已见过的 agent ∪ 刚创建的那个。只信宿主活表是不够的：
      // agents 服务缺席（假 ctx）时活表恒空，而 tools/change 的重同步仍必须覆盖已知 agent。
      for (const agent of [...liveFaces(), ...live.values(), ...extra]) {
        try {
          applyTo(canonical(agent), deny, key);
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
