/**
 * 用户 home 目录（`~` 的展开目标）：`HOME` 非空白原样采用，未设置或空白回落
 * `os.homedir()`；Windows 以 `USERPROFILE` 优先（对齐 libuv）。显式读 env 而非
 * 直接 `os.homedir()`，是因为后者读进程级 environ，在 worker_threads（Stryker
 * 的 vitest-runner 强制 `pool: 'threads'`）下无法被测试的 `process.env.HOME` 隔离；
 * 取值次序与 libuv 一致，默认形态逐字节不变。
 */
export declare function userHome(): string;

/**
 * DSH home 解析（单一事实源）：`DSH_HOME` 非空白原样采用；未设置或空白回落
 * `~/.dsh`（默认形态路径逐字节不变）。语义对齐官方
 * `@deepseek-ai/dsh-home-paths#resolveDshHome`（空白 env 视同未设置）。
 */
export declare function dshHome(): string;
