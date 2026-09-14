/**
 * typert 适配层：官方类型只在这里出现，scope 域只认自己的窄接口。
 *
 * 两处**刻意**的窄化，各自的依据都写在这里：
 * 1. `lookups.get()` 的返回类型是**无参数**的 `TypertLookupProvider`（`unknown/unknown`），
 *    参数只出现在 `register` / `configure` 的重载上（dsh-typert-protocol/lib/types/types.d.ts:389）。
 *    运行时它确实是该键的描述符，所以这里按键的类型断言回来。
 * 2. 我们的 `FileScope.sessionId` 是 `string`，官方 wire 是品牌化的 `SessionId`——
 *    品牌只在边界上有意义，域内带着它只会让五个域都得认识官方类型。
 */
import type { WorkspaceFileScope } from "@deepseek-ai/dsh-api-workspace-files";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { TypertLookupRegistry } from "@deepseek-ai/dsh-typert-protocol";
import type { FileScope, TypertPort } from "../scope/deps.ts";

/**
 * 查找表窄面：本插件只读当前描述符、配置自己那一个键、并订阅变化，其余能力（register/definitions）不开。
 *
 * `subscribe` 是「等 provider」那条路径的唯一叫醒源：官方 `register`/`withdraw` 都会 emit
 * `{kind:"lookup", key}`（dsh-typert-registry/lib/index.js:238-251 与 :211-224），
 * 监听器不关心事件载荷，只把「再看一眼」这件事做一次。
 */
export type TypertLookupsPort = Pick<TypertLookupRegistry, "get" | "configure" | "subscribe">;

export function bindTypert(lookups: TypertLookupsPort): TypertPort {
  return {
    current: () => {
      const descriptor = lookups.get("workspaceFileScope") as
        | {
            resolve: (
              id: SessionId,
            ) => WorkspaceFileScope | undefined | Promise<WorkspaceFileScope | undefined>;
          }
        | undefined;
      if (descriptor === undefined) return undefined;
      const resolve = descriptor.resolve.bind(descriptor);
      return {
        resolve: async (sessionId: string): Promise<FileScope | undefined> => {
          const scope = await resolve(sessionId as SessionId);
          if (scope === undefined) return undefined;
          return { sessionId: scope.sessionId, workspaceRoot: scope.workspaceRoot };
        },
      };
    },
    subscribe: (listener) => lookups.subscribe(() => listener()),
    configure: (resolver) =>
      lookups.configure("workspaceFileScope", async (sessionId) => {
        const scope = await resolver(sessionId);
        if (scope === undefined) return undefined;
        // sessionId 用官方那一个（已品牌化），而不是我们回传的字符串。
        return { sessionId, workspaceRoot: scope.workspaceRoot };
      }),
  };
}
