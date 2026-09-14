/**
 * 子 agent 继承父会话的登记：本会话没登记时沿父链向上找。
 *
 * 子会话是**独立会话**——dsh-subagent 建它时只把父的 cwd 拷进子 header
 * （dsh-subagent/lib/index.js:504-510），而绑定记在父会话 id 上（工具是从会话上下文取 id 写登记的）。
 * 不问父链，子 agent 的文件根就永远是它自己的 cwd。
 *
 * 三条边界是硬的：到顶即停（没有父就回未绑定）、父链成环时不转圈（错数据不该把请求拖死）、
 * 父会话的登记失效时按它自己的自愈逻辑摘掉并继续向上（最终仍是 null，也就是回退自己的 cwd）。
 */
import type { ScopeDeps } from "../../deps.ts";
import { ownWorktree } from "../own/index.ts";

/** 沿父链找到的第一个有效登记；一条都没有就回 null。 */
export async function inheritedWorktree(
  deps: ScopeDeps,
  sessionId: string,
): Promise<string | null> {
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  for (;;) {
    const parent = deps.sessions.parentOf(current);
    if (parent === undefined || seen.has(parent)) return null;
    seen.add(parent);
    const inherited = await ownWorktree(deps, parent);
    if (inherited !== null) return inherited;
    current = parent;
  }
}
