#!/usr/bin/env node
// @ts-nocheck
"use strict";

/**
 * scripts 编译面接线器（issue #474 起，issue #776 批 3 改为程序覆盖断言）。
 *
 * 为什么存在：scripts/tsconfig.json 是 scripts/ 唯一的 strict 编译面，但 pnpm typecheck 是
 * `pnpm -r --if-present run typecheck`（只进各包，不进根 scripts/），pnpm build/test 也编
 * 译不到它——若只靠直跑（Node type-stripping 擦除类型断言），strict 类型面是「假锁」。
 * 本接线器 spawn 仓库 tsc 真实编译 scripts/tsconfig.json，tsc 非 0 → 本测试红，随
 * `pnpm test:scripts` 执行。
 *
 * 为什么断言程序集而不是 tsconfig 文本（#776 批 3）：include 由逐项枚举改为 glob 后，
 * 「文本里有某个条目」不再等价于「该文件真在编译面内」；且 tsc 对 include/exclude 漏掉
 * 具体文件静默绿（只有 include 全空才配置级报错），文本正则既漏检又易假绿。程序集口径
 * 直接来自 tsc --listFiles，是「真被检查的文件」的权威答案，不需要另读、另解析配置文本。
 *
 * 两条互补判据：
 * 1. 磁盘上 scripts/ 下的 .ts/.mts/.cts 减去程序集，每一项都必须落在 scripts/test/ 之下
 *    ——非 test 的 .ts/.mts/.cts 漏面即红（把 lib/** 之类写进 exclude，文件离开程序集同样命中）。
 * 2. 磁盘枚举非空：拦住「磁盘枚举失效」这类让判据 1 恒真的退化（空程序集由上面的
 *    program.size 断言拦住，不再靠差值非空间接判定）。
 *
 * 不用「逐条登记面外文件」的清单：那会让每个新增的 scripts/test/*.test.ts 都打红
 * test:scripts，与并行往 test/ 加用例的分支互斥；前缀断言保护力等价而维护成本为零。
 *
 * 只 spawn 一次 tsc（--noEmit 与 --listFiles 同时给出），exit code 即 tsc 的真实退出码；
 * 编译结果与程序集一次取全，不做第二次全量编译。
 *
 * 为何自身仍带 @ts-nocheck（#474 R4 预防性声明）：本文件只 spawn tsc 子进程并读它的输出，
 * 不 import 被测物的类型（walk-files.ts 仅作运行时遍历工具），纳入 strict 面无检查增量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkFiles } from "../lib/walk-files.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPTS = join(ROOT, "scripts");
// tsc 真实 JS 入口：严禁 spawn node_modules/.bin/tsc（shell shim，经 node
// 执行报 ERR_UNKNOWN_FILE_EXTENSION；#476 接线器同款先例注释）。
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const TSCONFIG = join(SCRIPTS, "tsconfig.json");

/**
 * scripts/ 下唯一允许暂时留在编译面外的前缀（test 侧 @ts-nocheck 属后续批次）。
 * 粒度是整棵子树：scripts/test/ 下的任何文件都会被放行，包括误放进去的生产脚本——
 * 这是既定口径边界，守卫只防「test/ 之外漏面」。
 */
const TEMPORARY_EXCLUSION_PREFIX = "scripts/test/";

const isTypeScript = (name) => /\.(ts|mts|cts)$/.test(name);
const toPosix = (p) => p.split(sep).join("/");

test("scripts 编译面接线：非 test 的 .ts/.mts/.cts 全树入面，程序集与磁盘集合对账（#474/#776）", () => {
  assert.ok(existsSync(TSC), `仓库 tsc 应存在（${TSC}）——pnpm install 后才有`);
  assert.ok(existsSync(TSCONFIG), `scripts/tsconfig.json 应存在（${TSCONFIG}）`);

  const result = spawnSync(process.execPath, [TSC, "-p", TSCONFIG, "--noEmit", "--listFiles"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.strictEqual(
    result.status,
    0,
    `tsc 编译 scripts/tsconfig.json 失败（exit=${result.status}）——编译面类型漂移？\n${result.stdout}\n${result.stderr}`,
  );

  // --listFiles 逐行输出程序文件的绝对路径；只取 scripts/ 下的 TS 源文件。
  const program = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(SCRIPTS + sep) && isTypeScript(line))
      .map((line) => toPosix(relative(ROOT, line))),
  );
  assert.ok(
    program.size > 0,
    `tsc --listFiles 未解析出任何 scripts/ 程序文件——输出格式变了？\n${result.stdout}`,
  );

  // 判据 1：磁盘侧不做任何排除，程序集的补集即「被漏在面外」的文件；非 test 脚本漏面即红。
  const onDisk = walkFiles(SCRIPTS, isTypeScript).map((rel) => `scripts/${rel}`);
  const outOfFace = onDisk.filter((rel) => !program.has(rel)).sort();
  for (const rel of outOfFace) {
    assert.ok(
      rel.startsWith(TEMPORARY_EXCLUSION_PREFIX),
      `${rel} 不在 tsc 程序集内，且不在 scripts/test/ 之下——非 test 的 .ts/.mts/.cts 必须入编译面（该文件被静默移出覆盖？）`,
    );
  }

  // 判据 2：磁盘枚举非空，防「磁盘枚举失效」让判据 1 退化为恒真。
  assert.ok(onDisk.length > 0, "磁盘枚举为空（walkFiles 失效）：面外前缀判据退化为恒真（假绿）");
});
