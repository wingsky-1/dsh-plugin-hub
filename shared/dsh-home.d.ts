/**
 * DSH home 解析（单一事实源）：`DSH_HOME` 非空白原样采用；未设置或空白回落
 * `~/.dsh`（默认形态路径逐字节不变）。语义对齐官方
 * `@deepseek-ai/dsh-home-paths#resolveDshHome`（空白 env 视同未设置）。
 */
export declare function dshHome(): string;
