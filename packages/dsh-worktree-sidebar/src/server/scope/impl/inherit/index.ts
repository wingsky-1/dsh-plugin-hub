/**
 * 继承父会话的登记：本会话没登记时沿父链向上找。
 *
 * 子会话是**独立会话**——dsh-subagent 建它时只把父的 cwd 拷进子 header
 * （dsh-subagent/lib/index.js:504-510），而绑定记在父会话 id 上（工具是从会话上下文取 id 写登记的）。
 * 不问父链，子 agent 的文件根就永远是它自己的 cwd。
 *
 * 用户 fork 出来的会话走的是同一条判据（header.parentSession），本域**刻意不区分** fork 与子 agent：
 * fork 的 header 同样拷了父的 cwd，视图根跟着一起继承才与「文件根是会话 cwd 的改写」自洽。
 *
 * 三条边界是硬的：到顶即停（没有父就回未绑定）、父链成环时不转圈（错数据不该把请求拖死）、
 * 父会话的登记失效时按它自己的自愈逻辑摘掉并继续向上（最终仍是未命中，也就是回退自己的 cwd）。
 */
import type { BindingRecord } from "../../../binding/interface.ts";
import type { ScopeDeps } from "../../deps.ts";
import { ownRecord } from "../own/index.ts";

/**
 * 沿父链找到的第一个有效登记，连同**持有它的那个会话 id**（不是直接父）。
 *
 * `ownerSessionId` 是工具面唯一能给出的「去哪个会话解绑」的答案，所以它必须是持有登记的那个祖先，
 * 而不是只上跳一步的父——多级 fork 链上这两者并不相同。
 */
export async function inheritedOrigin(
  deps: ScopeDeps,
  sessionId: string,
): Promise<{ record: BindingRecord; ownerSessionId: string } | undefined> {
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  for (;;) {
    const parent = await parentOf(deps, current);
    if (parent === undefined || seen.has(parent)) return undefined;
    seen.add(parent);
    const inherited = await ownRecord(deps, parent);
    if (inherited !== undefined) return { record: inherited, ownerSessionId: parent };
    current = parent;
  }
}

/**
 * 上跳一步。活 header 优先；只有「不在册」才回落持久面——活着的顶层会话是**确定的到顶**，
 * 再去问持久面等于给每个普通会话白加一次 IO。
 *
 * 持久面坏了按「到顶」收口：它答不出来时正确的行为是让文件根退回会话自己的 cwd，
 * 而不是把异常抛进解析器（解析器与路由共用这条路径，抛出去等于把右栏文件树一起打掉）。
 */
async function parentOf(deps: ScopeDeps, sessionId: string): Promise<string | undefined> {
  const live = deps.sessions.liveParentOf(sessionId);
  if (live.kind === "parent") return live.id;
  if (live.kind === "root") return undefined;
  try {
    return await deps.sessions.storedParentOf(sessionId);
  } catch {
    return undefined;
  }
}
