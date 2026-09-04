#!/usr/bin/env node
/**
 * resolve-pkg-paths.mjs — 插件参数归一化：本地路径绝对化 / 包规格透传（零依赖）。
 *
 * 背景（#517 C11）：`dsh plugin add` 同时接受本地路径、npm 包名、git URL 三种
 * 形态。verify-isolated.sh 挂载本地插件时若把**相对路径**原样传给 dsh，dsh
 * 会把它当 git URL 解析（`https://github.com/<相对路径>.git`）→ ls-remote
 * Repository not found → 脚本报迷惑错误。本模块统一做「路径 vs 包规格」判定：
 * 类路径参数绝对化（相对路径基于当前 cwd），包规格原样透传。单一事实源，
 * verify-isolated.sh 与未来 node 化版本共用；smoke 以本模块输出做行为断言
 * （不文本 grep 脚本）。
 *
 * 判定规则（顺序敏感）：
 *   1. 形态类路径（`.` `..` `/` `~` 开头）→ 绝对化；
 *   2. cwd 下存在该路径（目录或文件）→ 绝对化（如 `packages/dsh-notifier`）；
 *   3. 其余 → 视为包规格（`@scope/name`、`name@version`、git URL），原样透传。
 * 绝对化用 `path.resolve`（不展开 `~`——展开留给 shell/调用方，脚本已有先例；
 * node 版 C8 补 expandHomePath 时一并处理）。
 *
 * 用法：
 *   node resolve-pkg-paths.mjs [--json] [--] <arg>...
 *   --json    输出 JSON 数组 [{input, resolved, kind: "path"|"spec", abs?}]
 *   默认      每行一个归一化结果（path → 绝对路径；spec → 原样）
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const PATH_LIKE = /^(\.{1,2}\/|\.{1,2}$|\/|~)/;

/** `~`/`~/x` 展开为 home 前缀（`path.resolve` 不做 `~` 展开，C8 前就地处理）。 */
function expand(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

function classify(input) {
  const expanded = expand(input);
  if (PATH_LIKE.test(expanded)) return { input, kind: "path", abs: resolve(expanded) };
  if (existsSync(expanded)) return { input, kind: "path", abs: resolve(expanded) };
  return { input, kind: "spec", abs: null };
}

function main() {
  const argv = process.argv.slice(2);
  let json = false;
  let args = argv;
  if (argv[0] === "--json") { json = true; args = argv.slice(1); }
  if (args[0] === "--") args = args.slice(1);
  if (args.length === 0) {
    process.stderr.write("resolve-pkg-paths: 至少需要一个参数\n");
    process.exit(2);
  }
  const items = args.map(classify);
  if (json) {
    process.stdout.write(JSON.stringify(items) + "\n");
  } else {
    for (const it of items) process.stdout.write((it.kind === "path" ? it.abs : it.input) + "\n");
  }
  process.exit(0);
}

main();