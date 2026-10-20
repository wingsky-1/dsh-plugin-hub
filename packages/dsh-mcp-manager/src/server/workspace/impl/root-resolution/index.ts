/**
 * dsh-mcp-manager — workspace/impl/root-resolution/index.ts：项目根发现与执行路由解析。
 *
 * 阶段 4 自 src/manager.ts（findProjectRoot/normalizedProjectRoot 方法）与
 * src/apply-runtime.ts（makeResolveRoot）迁入工作空间路由域，纯函数化
 * （不再依赖 manager 实例）；B3 修复（空 cwd 回落含 runtime 源）落位
 * makeResolveRoot。引用面经 workspace/interface.ts。
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { dshHome } from "../../../../../../../shared/dsh-home.js";
import type { McpManager } from "../../../connection/interface.ts";
import type { ActiveWorkingDirectoryPort } from "../../../shared/interface.ts";
import { MIDDLEWARE_GLOBAL_ROOT } from "../../../../shared/interface.ts";

/** DSH 全局家目录（shared/dsh-home.js 语义：DSH_HOME 非空白原样采用、空白
 *  视同未设置回落 ~/.dsh；#517 收敛）。resolve 为本处 .dsh 标记排除的对比
 *  用途服务。 */
function dshHomePath() {
  return resolve(dshHome());
}

/** 项目根发现：从 cwd 向上找 .git / .dsh / .mcp.json 标记，找不到用 cwd 本身。
 *  .dsh 标记须排除 DSH 全局家目录（默认 ~/.dsh，尊重 DSH_HOME）——否则 home
 *  下任何无标记目录（如 ~/dev/leetcode）向上都会命中 ~/.dsh，把 home 误判为
 *  项目根并加载 ~/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json，导致别的会话串入不属于它的项目级 MCP。 */
export async function findProjectRoot(cwd: string | undefined): Promise<string> {
  const home = dshHomePath();
  let current = resolve(cwd ?? process.cwd());
  for (let depth = 0; depth < 16; depth += 1) {
    const dotDsh = join(current, ".dsh");
    // .dsh 目录存在且不是 DSH 全局家目录才算项目标记。
    const hasProjectDsh = existsSync(dotDsh) && resolve(dotDsh) !== home;
    if (
      existsSync(join(current, ".git")) ||
      hasProjectDsh ||
      existsSync(join(current, ".mcp.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(cwd ?? process.cwd());
}

/** 归一化项目根（realpath；失败回退 resolve）。中间层路由使用。 */
export async function normalizedProjectRoot(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd === null || cwd === "") return undefined;
  const root = await findProjectRoot(cwd);
  // 同一项目经符号链接进入时拼写不同，收敛到同一键防止连接池分裂。
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

type ActiveDirectoryRead =
  { readonly state: "absent" } | { readonly state: "present"; readonly value: unknown };

type UsableDirectory =
  { readonly state: "unusable" } | { readonly state: "usable"; readonly path: string };

/**
 * 服务缺席 / session 缺席 / 读取抛错，一律判「无有效活动目录」。读取面自身抛错
 * （归属未知 / 服务内部故障）不得冒泡，也不得在此静默改投 header.cwd。
 */
function readActiveDirectory(
  session: unknown,
  activeDirectory: ActiveWorkingDirectoryPort | undefined,
): ActiveDirectoryRead {
  if (session === undefined || session === null || activeDirectory === undefined) {
    return { state: "absent" };
  }
  try {
    return { state: "present", value: activeDirectory(session) };
  } catch {
    return { state: "absent" };
  }
}

/**
 * 防御性校验放在判定点而不是只放在读取面：`makeResolveRoot` 是已发布导出，
 * 任何调用方都能递入自己的读取面。空白/相对值若直接进 `normalizedProjectRoot`，
 * 会被 `resolve()` 静默解析成 process.cwd() —— 正是语义 A 禁止的隐式退路（F01）。
 */
function selectUsableDirectory(read: ActiveDirectoryRead): UsableDirectory {
  if (read.state === "absent") return { state: "unusable" };
  if (typeof read.value !== "string") return { state: "unusable" };
  if (read.value.trim() === "") return { state: "unusable" };
  if (!isAbsolute(read.value)) return { state: "unusable" };
  return { state: "usable", path: read.value };
}

/**
 * resolveRoot 路由：exec.agent → 归一化项目根（agent-less → undefined）。
 *
 * #1137 语义 A：项目级 MCP 跟随**调用 agent 在调用开始时的活动 workingDirectory**，
 * `session.header.cwd` 只是创建目录/初始项目身份，不再作为活动目录猜测值。
 *
 * 每次调用**开始时**取一次快照并在本调用内固定：切目录后的**新**调用用新 root；
 * 已开始的调用仍在旧 root 完成（或按既有取消协议取消），不在 await 之后改投。
 * `resolveRoot` 的所有调用点（ws_mcp_list/search/detail/call 与直呼守卫）都在各调用
 * 的首行各调一次，故「每次调用取快照」由结构天然满足（见 middleware-register.ts）。
 *
 * 无有效活动目录时 **fail-closed**：不回退 header.cwd / process.cwd / UI 最近 session /
 * 另一个已连接工作区。唯一例外是**显式** `@global` 可达性（既有 #767 笔 1a 语义：
 * 全局服务器没有 mcp__ 直呼面，@global 不可达即等于不可达）——它只在「确实存在
 * 全局来源服务器」时成立，且**不把未知项目名偷换成同名全局服务器**：此处只返回
 * 全局虚拟 root 本身，无 agent 的隐式项目寻址仍恒 undefined。
 *
 * @param activeDirectory 活动目录读取面（late-read thunk 的产物）。缺席 = 宿主未提供
 *   该服务，等价于「归属未知」→ 项目级操作 fail-closed。
 */
export function makeResolveRoot(
  manager: McpManager,
  activeDirectory: ActiveWorkingDirectoryPort | undefined,
): (agent: unknown) => Promise<string | undefined> {
  // 单池（#767 笔 1a）：项目根解析不出时**无条件**回落全局虚拟 root @global
  // （可达性三件套之二）。全局服务器不再有 mcp__ 直呼面，@global 不可达即等于
  // 它们不可达——这道门不再是模式分支。
  return async (agent: unknown): Promise<string | undefined> => {
    if (typeof agent !== "object" || agent === null) return undefined;
    const session = (agent as { session?: unknown }).session;
    // 服务缺席 / session 缺席 / 投影未记录 / 空白 / 相对 / 读取抛错，一律判「无有效活动目录」：
    // 不得回落 header.cwd、process.cwd、UI 最近 session 或另一个已连接工作区（语义 A 严格退路）。
    // 注意与 agent-less 的区别：agent-less 恒 undefined（无 agent 的隐式项目寻址维持拒绝）；
    // 有 agent 但无有效活动目录时仍走下面的 @global 可达性——那是**显式全局作用域**，
    // 不是项目根的隐式替代（决策表保留项，见 #767 笔 1a 与提案 §@global 规则）。
    // 读取面自身抛错（归属未知 / 服务内部故障）同样按「无有效活动目录」处理：异常不得
    // 冒泡成工具执行失败以外的形态，更不得在此静默改投 header.cwd。
    const active = readActiveDirectory(session, activeDirectory);
    // 防御性校验放在**判定点**而不是只放在读取面：`makeResolveRoot` 是已发布导出，
    // 任何调用方都能递入自己的读取面。空白/相对值若直接进 `normalizedProjectRoot`，
    // 会被 `resolve()` 静默解析成 process.cwd() —— 正是语义 A 禁止的隐式退路（F01）。
    const usable = selectUsableDirectory(active);
    const root = await normalizedProjectRoot(usable.state === "usable" ? usable.path : undefined);
    if (root !== undefined) return root;
    // B3（requirements 8.1 纠偏）：回落查 projectServersFor("@global")（含
    // runtime 注入并集，#413）而非 globalServers()（仅 store.data.servers）——
    // 否则仅 runtime 注入服务器时回落失败「无法确定工作空间」。
    const globalServers = ((await manager.projectServersFor(MIDDLEWARE_GLOBAL_ROOT)) ?? []).filter(
      (server) => server.enabled !== false,
    );
    if (globalServers.length > 0) return MIDDLEWARE_GLOBAL_ROOT;
    return undefined;
  };
}
