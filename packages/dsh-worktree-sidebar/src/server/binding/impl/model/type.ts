/**
 * binding 域的存储形状：`bindings.json` 的版本与记录。
 *
 * 它是域内契约而不是双端契约——宿主与客户端都不直接读这个文件，客户端只经 api 域的
 * 路由读 `revision` 与 `worktreePath`（见 `src/shared/contract.ts` 的 `BindingResponse`）。
 * 物理定义放在这里，域外经 `binding/interface.ts` 取用。
 */

/**
 * bindings.json 的形状版本。读到其它版本按损坏处理而不是猜着往下读：
 * 别的版本的字段含义未定，猜错会静默把别人的 worktree 挂到本会话上。
 *
 * v2 加了 `sessionCreatedAt`。**没有迁移路径**：本包尚未发布，磁盘上不存在合法的 v1 文件，
 * 而按 v1 读意味着把「会话 id 可能会被复用」这个洞原样留着。
 */
export const BINDINGS_VERSION = 2;

/** 一次「把某个 git worktree 登记给某个会话」。 */
export interface BindingRecord {
  /** worktree 所属主仓库根（用于校验 worktree 归属）。 */
  readonly repoRoot: string;
  /** 该会话视图根要指向的 worktree 绝对路径。 */
  readonly worktreeRoot: string;
  /** 登记时的分支名，仅用于展示与排查。 */
  readonly branch: string;
  /** 登记时刻的 ISO 时间戳（人读用）。 */
  readonly createdAt: string;
  /**
   * 登记时会话 header 的 `createdAt`（epoch 毫秒）。会话 id 是**进程内计数器**，
   * 重启后新会话会重新拿到 `session-1`；这一项是「这条登记属于哪个会话」的唯一凭据。
   */
  readonly sessionCreatedAt: number;
}

/** bindings.json 的完整形状。 */
export interface BindingsFile {
  readonly version: number;
  readonly revision: number;
  readonly bindings: Readonly<Record<string, BindingRecord>>;
}
