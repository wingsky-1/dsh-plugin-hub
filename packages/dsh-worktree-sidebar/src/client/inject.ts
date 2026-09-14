/**
 * 官方 entry inject 面的改写。本文件只回答一个问题：
 * **给定官方 inject 面与会话 id，产出 `hooks.sessions` 指向改写源的新面。**
 *
 * 机制（A1 实测更正）：官方 `bindInjectSources` 会把 entry inject 面里的 `hooks.<name>`
 * 经 `standardHookPropName` 变成 `use<Name>` props（`dsh-client-ui-renderer/lib/client.js:342-357`），
 * 而展开序 `{...kit, ...injected, ...}`（`:644-650` 与 `:653-658`）让 injected 覆盖框架注入——
 * 这就是把官方正文读的 `useSessions` 换成改写源的机制（计划 §4.2 第 4 条指定的形态）。
 * 作用域因此限定在**本 entry**：其它 `useSessions` 消费方仍拿真实 cwd（计划 §6 的非目标）。
 *
 * 探测官方 entry、三步注册与 teardown 在 `takeover.ts`。两块零互引（ESLint 块间隔离）：
 * 装配根把这里的产出接到那边的 `wrapInject` 依赖面上（计划 §18.2-B7 结构动作表第 2 条）。
 */
import type { SessionContribution, SourceFor, WrapInject } from "./ports.ts";

/**
 * 造一个改写器：外包官方工厂、保留它产出的一切，只把 `hooks.sessions` 换成 `sourceFor` 的读数。
 *
 * `sourceFor` 只在这里被调用，所以本块不需要认识会话存储，也不需要认识座位与类型注册表。
 */
export function createInjectWrapper(sourceFor: SourceFor): WrapInject {
  return (official) => {
    return (...args: unknown[]): Record<string, unknown> => {
      const face: Record<string, unknown> = official === undefined ? {} : official(...args);
      // 渲染器把 binding.key 作为第一个参数传进来（renderer 的 runInject）；非字符串一律原样返回。
      // 取不到会话 id 时宁可让树显示真实 cwd，也不指向一个猜出来的目录。
      const sessionId = args.find((arg): arg is string => typeof arg === "string");
      if (sessionId === undefined) return face;
      const existing = face["hooks"];
      // 官方 face 里已有的 hooks 源要保留：我们只覆盖 sessions 一项。
      const hooks =
        typeof existing === "object" && existing !== null
          ? (existing as SessionContribution["hooks"])
          : {};
      return { ...face, hooks: { ...hooks, sessions: sourceFor(sessionId) } };
    };
  };
}
