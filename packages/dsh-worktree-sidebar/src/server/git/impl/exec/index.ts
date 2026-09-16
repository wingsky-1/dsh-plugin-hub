/**
 * git 执行面的真实实现：`execFile` + argv，**不经 shell**。
 *
 * argv 数组是安全边界的一半——路径与分支名里的空格、`;`、`$()` 不会被任何 shell 重新解释；
 * 另一半在 argv 构造处（`impl/inspect`）。两件事分开写，是为了让「谁负责什么」在评审时看得见。
 */
import { execFile } from "node:child_process";
import type { GitExecPort, GitRunResult } from "../../deps.ts";

/** 单次 git 调用的墙钟上限。挂住的 git 会把整个文件树拖死，而这只查询在最坏情况下也远快于它。 */
const TIMEOUT_MS = 10_000;

/** stdout 上限。超限按失败处理而不是截断——截断的 `worktree list` 会解析出一个残缺的仓库结构。 */
const MAX_BUFFER = 4 * 1024 * 1024;

/** 真实的 git 执行面。它没有任何状态，故是常量而不是工厂——组合根没得选，测试换的是装配入参。 */
export const gitExec: GitExecPort = {
  run: (args) =>
    new Promise<GitRunResult>((resolve) => {
      execFile(
        "git",
        [...args],
        { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          // git 没装时 stderr 是空串，只有 error 知道原因（spawn git ENOENT）；
          // 不把它折进来，上层看到的失败原因就是一句没有信息量的「退出码非零」。
          const detail = stderr.length > 0 ? stderr : error === null ? "" : error.message;
          // 只有数字 code 才是「git 跑完了并给出退出码」；字符串 code（如 ENOENT）与 timeout 的
          // killed 都是「没跑成」，上层据此保住上一次结论而不是把它当成否定答案。
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
          resolve({ ok: error === null, stdout, stderr: detail, code });
        },
      );
    }),
};
