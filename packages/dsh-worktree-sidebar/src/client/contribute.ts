/**
 * 把每会话的改写源贡献成**框架的会话快照源**。
 *
 * 官方 files 正文第 421 行读的是 `const cwd = useSessions((s) => s.byId[sessionId]?.cwd)`，
 * 而 `useSessions` 是渲染器按 session 作用域的 `hooks.sessions` 源合成的
 * （dsh-client-ui-renderer 的 standardKit：每个 `hooks.<name>` 源 → `use<Name>` 选择器 hook，
 * 会话作用域覆盖 root 的同名项）。所以接管的落点在这一条贡献上，而不是组件的 props。
 *
 * 名册是静态的，`resolve` 对每个绑定都必须给出 `sessions` —— 「没有绑定就不给」会被渲染器判成
 * 配置错误。未绑定的**原样透传**因此由源自己实现（`source.ts` 的第三条硬约束：那时回的就是真实快照对象本身，
 * 引用相同，所以未登记会话看到的世界与没装本插件时逐字一致）。
 */
import type {
  ObservablePort,
  SessionBindingLike,
  SessionsSnapshotLike,
  UiSessionPort,
} from "./ports.ts";

/** 名册里唯一那一项。渲染器把它拼成 `useSessions`。 */
const SESSIONS_HOOK = "sessions";

export interface SessionsContributionDeps {
  readonly uiSession: UiSessionPort;
  /** 某会话的改写源；同一个 id 必须回同一个对象，否则渲染器的按源缓存每次渲染都会重建订阅。 */
  readonly sourceFor: (sessionId: string) => ObservablePort<SessionsSnapshotLike>;
}

/** 贡献入口。返回值是撤销这次贡献的释放函数。 */
export function contributeSessions(deps: SessionsContributionDeps): () => void {
  return deps.uiSession.provide({
    hooks: [SESSIONS_HOOK],
    resolve: (binding: SessionBindingLike) => ({
      hooks: { [SESSIONS_HOOK]: deps.sourceFor(binding.sessionId) },
    }),
  });
}
