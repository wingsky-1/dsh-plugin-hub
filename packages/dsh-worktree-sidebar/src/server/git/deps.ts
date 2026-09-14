/** git 域依赖声明：exec 面由组合根注入——域内不起子进程，测试才能断言 argv 而不真跑 git。 */

/** 一次 git 调用的结果。非零退出不是异常：`check-ref-format` 就是靠退出码回答问题的。 */
export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** git 执行面。argv 是数组而不是命令行字符串：路径里的空格与 `-` 开头不会被 shell 重新解释。 */
export interface GitExecPort {
  run(args: readonly string[]): Promise<GitRunResult>;
}

/** 装配入参。 */
export interface GitDeps {
  readonly exec: GitExecPort;
}
