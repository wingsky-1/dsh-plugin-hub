/**
 * dsh-mcp-manager — workspace/impl/root-resolution/index.ts：项目根发现与执行路由解析。
 *
 * 阶段 4 自 src/manager.ts（findProjectRoot/normalizedProjectRoot 方法）与
 * src/apply-runtime.ts（makeResolveRoot）迁入工作空间路由域，纯函数化
 * （不再依赖 manager 实例）；B3 修复（空 cwd 回落含 runtime 源）落位
 * makeResolveRoot。引用面经 workspace/interface.ts。
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dshHome } from "../../../../../../../shared/dsh-home.js";
import type { McpManager } from "../../../connection/interface.ts";
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

/** resolveRoot 路由：exec.agent → 归一化项目根（agent-less → undefined）。 */
export function makeResolveRoot(
  manager: McpManager,
): (agent: unknown) => Promise<string | undefined> {
  // 路由输入：exec.agent 当前 cwd = agent.session.header.cwd（实证已闭合）。
  // 单池（#767 笔 1a）：项目根解析不出时**无条件**回落全局虚拟 root @global
  // （可达性三件套之二）。全局服务器不再有 mcp__ 直呼面，@global 不可达即等于
  // 它们不可达——这道门不再是模式分支。
  return async (agent: unknown): Promise<string | undefined> => {
    if (typeof agent !== "object" || agent === null) return undefined;
    const session = (agent as { session?: { header?: { cwd?: unknown } } }).session;
    const cwd = session?.header?.cwd;
    const root = await normalizedProjectRoot(typeof cwd === "string" ? cwd : undefined);
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
