/**
 * 官方默认解析的等价实现：provider 尚未注册时（`lookups.get` 为 undefined）无法捕获委托对象，
 * 只能自己算一遍。
 *
 * 逐行对照 dsh-api-workspace-files/lib/index.js:378-387 写的，**包括那个最容易写错的分支**：
 * 官方在 `header` 缺失时返回 `undefined`（而非沙箱根），只有 header 存在而 `cwd` 缺失时
 * 才回落 `sandboxPolicy.workspaceRoot`。把这两个分支合并的写法会让一个本不该有文件根的会话凭空获得沙箱根。
 */
import type { DefaultScopePort, FileScope } from "../../deps.ts";

/** 造一个等价于官方默认的解析器。 */
export function createFallback(
  port: DefaultScopePort,
): (sessionId: string) => Promise<FileScope | undefined> {
  return async (sessionId) => {
    const live = port.live(sessionId);
    // 有活会话就不查持久化——与官方同序（它也是 `live === undefined` 才去 stat）。
    const stored = live === undefined ? await port.stored(sessionId) : undefined;
    const header = live ?? stored;
    if (header === undefined) return undefined;
    return { sessionId, workspaceRoot: header.cwd ?? port.sandboxRoot() ?? "" };
  };
}
