/**
 * 双端共享契约：路由路径与存储形状是宿主与浏览器唯一必须一致的事实。
 *
 * 两边各写一份字面量的失败形态是静默的——客户端拿着对不上的键去 `__DSH_ROUTES__` 取值，
 * 只会表现成「树没换根」，没有任何报错指向路由名。所以路由键在这里只定义一次，
 * 宿主经 `export { ROUTES }` 让构建期把它注入客户端（bundle-host.ts:132-149）。
 */

/** 宿主路由清单。键名即 `__DSH_ROUTES__` 的键。 */
export const ROUTES = {
  bindings: "/api/dsh-worktree-sidebar/bindings",
  health: "/api/dsh-worktree-sidebar/health",
} as const;

/**
 * bindings.json 的形状版本。读到更高版本按损坏处理而不是猜着往下读：
 * 未来形状的字段含义未定，猜错会静默把别人的 worktree 挂到本会话上。
 */
export const BINDINGS_VERSION = 1;

/** 一次「把某个 git worktree 登记给某个会话」。 */
export interface BindingRecord {
  /** worktree 所属主仓库根（用于校验 worktree 归属）。 */
  readonly repoRoot: string;
  /** 该会话视图根要指向的 worktree 绝对路径。 */
  readonly worktreeRoot: string;
  /** 登记时的分支名，仅用于展示与排查。 */
  readonly branch: string;
  /** ISO 时间戳。 */
  readonly createdAt: string;
}

/** bindings.json 的完整形状。 */
export interface BindingsFile {
  readonly version: number;
  readonly revision: number;
  readonly bindings: Readonly<Record<string, BindingRecord>>;
}

/**
 * 单会话绑定查询的响应体。刻意**不回 repoRoot**：客户端只需要目录根，
 * 多回一个字段就多一份「客户端不该知道主仓库位置」的暴露面。
 */
export interface BindingQueryResponse {
  readonly revision: number;
  readonly worktreePath: string | null;
}
