/**
 * 双端共享契约：宿主与浏览器唯一必须一致的两件事——路由路径与绑定查询的响应形状。
 *
 * 两边各写一份的失败形态是静默的：客户端拿着对不上的键去 `__DSH_ROUTES__` 取值，
 * 只会表现成「树没换根」；响应字段名各写一份，表现成「revision 读不到、绑定永远不刷新」。
 * 两者都不会报错指向分歧点。所以它们在这里各定义一次。
 *
 * 存储形状（`bindings.json` 的版本与记录）不在这里：它只有 binding 域与它的测试读，
 * 属域内契约，物理定义在 `server/binding/impl/model/type.ts`。
 */

/** 宿主路由清单。键名即 `__DSH_ROUTES__` 的键。 */
export const ROUTES = {
  bindings: "/api/dsh-worktree-sidebar/bindings",
  health: "/api/dsh-worktree-sidebar/health",
} as const;

/**
 * 绑定查询端点的响应体：宿主 handler 写、客户端读取处读，两边都从这里取字段名。
 *
 * 字段名必须是类型而不是值常量——只有类型层才能让「某一端改回旧字面量」当场编译失败。
 */
export interface BindingResponse {
  /** 绑定表修订号；客户端以它判定「宿主侧是否已经变了」。 */
  readonly revision: number;
  /** 该会话当前生效的 worktree 根；null 表示按会话 cwd 走。 */
  readonly worktreePath: string | null;
}
