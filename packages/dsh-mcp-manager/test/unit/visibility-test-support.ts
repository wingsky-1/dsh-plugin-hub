import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
import type { VisibilityEventsPort } from "../../src/server/visibility/interface.ts";
import type { AgentFace } from "../../src/server/shared/interface.ts";
import type { ProjectUnit } from "../../src/server/connection/runtime/interface.ts";

/** 假 agent：restrict 记一笔，返回的摘除器也记一笔（带句柄号，供顺序断言）。 */
export function fakeAgent(id: string, log: string[], onChange?: () => (() => void)[]): AgentFace {
  let seq = 0;
  return {
    // 夹具按可读字符串造 id；官方 Agent.id 是品牌化的 SessionId，测试侧显式收窄。
    id: id as AgentFace["id"],
    tools: {
      restrict(filter: ToolRestriction) {
        seq += 1;
        const handle = `${id}#${seq}`;
        log.push(`restrict:${id}[${[...(filter.deny ?? [])].join("|")}]`);
        // 宿主 restrict 会**同步**发 tools/change：夹具照做，才测得到重入闸。
        if (onChange) for (const hook of onChange()) hook();
        return () => log.push(`dispose:${handle}`);
      },
    },
  };
}

/** 可抛错的假 agent：shouldThrow 按单次 deny 名（含批量 join 形）决定是否抛，抛错不记 seq。 */
export function flakyAgent(
  id: string,
  log: string[],
  shouldThrow: (joined: string) => Error | undefined,
): AgentFace {
  let seq = 0;
  return {
    // 同上：夹具 id 用可读字符串，官方品牌类型在此显式收窄。
    id: id as AgentFace["id"],
    tools: {
      restrict(filter: ToolRestriction) {
        const joined = [...(filter.deny ?? [])].join("|");
        const error = shouldThrow(joined);
        if (error !== undefined) throw error;
        seq += 1;
        const handle = `${id}#${seq}`;
        log.push(`restrict:${id}[${joined}]`);
        return () => log.push(`dispose:${handle}`);
      },
    },
  };
}

/** 假事件面：三个监听各自可注入、摘除器可观测；`liveAgents` 由调用方给。 */
export function makeEvents(liveAgents: () => readonly AgentFace[] = () => []) {
  const handlers: {
    created: ((agent: AgentFace) => void)[];
    disposed: ((agent: { id: string }) => void)[];
    changed: (() => void)[];
  } = { created: [], disposed: [], changed: [] };
  const unhooked: string[] = [];
  const port: VisibilityEventsPort = {
    onAgentCreated: (handler) => {
      handlers.created.push(handler);
      return () => {
        unhooked.push("created");
      };
    },
    onAgentDisposed: (handler) => {
      handlers.disposed.push(handler);
      return () => {
        unhooked.push("disposed");
      };
    },
    onToolsChange: (handler) => {
      handlers.changed.push(handler);
      return () => {
        unhooked.push("changed");
      };
    },
    liveAgents,
  };
  return {
    handlers,
    unhooked,
    port,
  };
}

/**
 * 单元表夹具：本域只读 `unit.connections[*].id`（注册名 `mcp__<id>__` 的前缀来源，见
 * `visibility/impl/mask/index.ts` 的装配循环）——其余 ProjectUnit/ConnectionEntry 字段（ServerConfig、
 * 六态、句柄等）与本域无关，全量构造会把 visibility 测试耦合到无关形状上，故按本仓既有惯例
 * （unit-lifecycle 的 `as unknown as LoaderPort`）做收窄断言，而不用 any。
 */
export function unitsWith(...ids: string[]): ReadonlyMap<string, ProjectUnit> {
  return new Map([
    ["/proj", { connections: new Map(ids.map((id) => [`srv-${id}`, { id }])) }],
  ]) as unknown as ReadonlyMap<string, ProjectUnit>;
}

export function makeLogger(): { warns: string[]; warn: (message: string) => void } {
  const warns: string[] = [];
  return {
    warns,
    warn: (message: string) => {
      warns.push(message);
    },
  };
}
