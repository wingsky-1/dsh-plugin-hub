/** git 域依赖声明：exec 面由组合根注入——域内不起子进程，测试才能断言 argv 而不真跑 git。 */

/**
 * 一次 git 调用的结果。非零退出不是异常：`check-ref-format` 就是靠退出码回答问题的。
 *
 * `code` 把「git 回答了 no」与「git 没答上来」分开：进程根本没起来（spawn ENOENT）或被超时杀掉时
 * 它是 null。这两件事在调用方的处置**相反**——前者是答案，后者必须保住上一次的结论。
 */
export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** 退出码；没有退出码（spawn 失败 / 超时被杀）时是 null。 */
  readonly code: number | null;
}

/** git 执行面。argv 是数组而不是命令行字符串：路径里的空格与 `-` 开头不会被 shell 重新解释。 */
export interface GitExecPort {
  run(args: readonly string[]): Promise<GitRunResult>;
}

/** 装配入参。 */
export interface GitDeps {
  readonly exec: GitExecPort;
}

/**
 * 一次「这个目录属于哪个仓库」的读数。
 *
 * `not-repo` 与 `failed` 都是「没拿到公共 git 目录」，但对**写绑定**的调用方意义不同：
 * 前者是 git 的回答（这个目录不是工作树），后者是没问出结果（spawn 失败 / 权限 / 超时）。
 */
export type CommonDirReading =
  | { readonly kind: "repo"; readonly dir: string }
  | { readonly kind: "not-repo" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * 一次归属判定的读数。**三态而不是布尔**：
 *
 * `same` 与 `different` 都要求两侧**确实**各自返回了一个公共 git 目录——只有那时才敢摘掉用户的登记。
 * 只要有一侧读不出来就归 `unknown`，调用方对它的处置是「保住已有登记 + 出声」：
 * 把权限或 IO 抖动当成「换了仓库」会**永久摘掉**用户的绑定，而同一条纪律在目录存在性判定上早已写明
 * （`scope/impl/own` 的 `directoryExists`）。
 */
export type BelongsToReading =
  | { readonly kind: "same" }
  | { readonly kind: "different" }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      /**
       * 至少有一侧**明确**回了「不是 git 工作树」（git 给了否定答案）。
       * 它不是「不同」，所以摘除判定不看它；写路径用它把失败文案说准（「不是工作树」比「验证不了」有用），
       * 而 `chmod 000` 这类权限失败在读数上与它同形，因此写路径也仍然是 fail-closed。
       */
      readonly notRepo: boolean;
    };
