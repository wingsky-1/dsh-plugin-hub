/**
 * dsh-mcp-manager — workspace/impl/server-id/index.ts：(scope, name) → 注册名 id 的内存表。
 *
 * 为什么需要这层映射：官方 dsh-mcp-client 的 serverName 在 `scopeOf(ctx) ?? ctx.root` 这个**整个
 * 应用根**上活体预留，同 owner 重名当场抛（spike3 实测）；而「同一 bare 名在全局与某项目都配」是
 * 常见写法——照现状语义（先到先得、后到跳过）就等于跨 root 的同名服务器只能有一个生效，按 root 给
 * 名字加后缀又会把项目路径摘要进模型可见的工具名。折中是给每个 (scope, name) 分配一个与用户配置
 * 解耦的随机短串：官方侧不再有重名，`mcp__<id>__<tool>` 也不泄漏路径（767-v6-STAGED-PLAN §2.6
 * 裁定 B、S1-ENGINE-SWAP-DESIGN §1.7）。
 *
 * scope 是**装载作用域标识**，本包传 root（项目根绝对路径或 @global）。为什么不是 global/project
 * 词表：判重面按 root 分开，跨 root 同名各自成条正是本表要提供的改进，用词表会把两个项目的同名
 * 服务器又并成一条。
 *
 * 稳定性语义：同一 (scope, name) 在一次进程内恒得同一个 id；跨进程不承诺稳定。表是纯内存态，
 * 不落盘、不进任何持久化键——正因如此，id 可以随时重生成而不牵动用户配置与 last-good 缓存。
 *
 * 生成器经工厂入参注入：测试要能造确定性 id，也要能造出可控的冲突序列。映射与已占用面都是**实例
 * 字段**——模块级可变计数器被 gate:module-state 明禁，且模块级表会让同进程的两次装配共享状态。
 */
import { randomBytes } from "node:crypto";
import { SERVER_NAME_PATTERN } from "../../../shared/interface.ts";

/** id 生成器：每次调用产出一个候选 id。注入点只为可测（确定性 id / 冲突序列）。 */
export type ServerIdFactory = () => string;

/** 分配入参。`idFactory` 省略时用默认随机实现。 */
export interface ServerIdTableOptions {
  idFactory?: ServerIdFactory;
}

/** (scope, name) → id 的查询面；id 在首次查询时分配并自此固定。 */
export interface ServerIdTable {
  /** 取该 (scope, name) 的 id；未分配则生成并记住。同参恒同值。 */
  idFor(scope: string, name: string): string;
  /** 该 (scope, name) 是否已分配 id（只读查询，不触发分配）。 */
  has(scope: string, name: string): boolean;
}

/**
 * 冲突重试上界。默认生成器每次独立取 72 bit 随机量，真实碰撞可忽略不计；上界的意义是让**注入的**
 * 恒定生成器变成一条诚实的报错，而不是把装配卡死在死循环里。
 */
const ATTEMPT_LIMIT = 64;

/** 默认 id 生成器：9 字节随机量 → base64url 12 字符，落在官方字符集内且无填充。 */
function defaultServerIdFactory(): string {
  return randomBytes(9).toString("base64url");
}

/** 候选值准入：官方 Config 的 serverName 会同时进 `mcp__<id>__` 前缀与插件注册面，字符集与长度只能
 *  照 SERVER_NAME_PATTERN（与官方同源的单一物理定义，见 server/shared/constants.ts）。非字符串必须
 *  先挡：正则对入参做隐式字符串化，`undefined` 恰好匹配该字符集，不挡就静默放行一个非法 id。 */
function isUsableId(candidate: unknown): candidate is string {
  return typeof candidate === "string" && SERVER_NAME_PATTERN.test(candidate);
}

/**
 * 建一张独立的 id 表。每次调用得到互不相通的映射与已占用面（I9：同进程两次装配不得共享状态）。
 */
export function makeServerIdTable(options: ServerIdTableOptions = {}): ServerIdTable {
  const idFactory = options.idFactory ?? defaultServerIdFactory;
  // 按 scope 分表而非拼成一个键：name 是用户输入，任何分隔符都可能被它自己撞出歧义。
  const idByScope = new Map<string, Map<string, string>>();
  // 已分配 id 面：官方按注册名预留，同表内必须唯一。
  const assigned = new Set<string>();
  return {
    idFor(scope: string, name: string): string {
      let scopeTable = idByScope.get(scope);
      if (scopeTable === undefined) {
        scopeTable = new Map<string, string>();
        idByScope.set(scope, scopeTable);
      }
      const assignedId = scopeTable.get(name);
      if (assignedId !== undefined) return assignedId;
      for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt += 1) {
        const candidate = idFactory();
        if (!isUsableId(candidate)) {
          throw new Error(
            `server id 生成器产出不满足 SERVER_NAME_PATTERN 的候选值：${JSON.stringify(candidate)}`,
          );
        }
        if (assigned.has(candidate)) continue;
        assigned.add(candidate);
        scopeTable.set(name, candidate);
        return candidate;
      }
      throw new Error(
        `server id 分配失败：${ATTEMPT_LIMIT} 次候选值均与已分配 id 冲突（scope=${scope}，name=${name}）`,
      );
    },
    has(scope: string, name: string): boolean {
      return idByScope.get(scope)?.has(name) ?? false;
    },
  };
}
