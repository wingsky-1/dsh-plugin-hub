#!/usr/bin/env node
/**
 * 阶段四目录化产物入口配套（包内构建步骤，供 package.json build 在 tsc 之后、bundle-host 之前执行）。
 *
 * 本文件只做 tsc 不做的事：把 src/server/adapters/*.{mjs,d.mts} 拷贝到
 * lib/server/adapters/（与 tsc 产物的相对引用结构一致）：.mjs/.d.mts 不被 tsc
 * emit，而 lib/apply/index.js 的适配器类型引用与 index.d.ts 的类型解析都需要它们在位。
 *
 * 入口转发已删除（#768 工具链最小化）：D13 起包根 src/index.ts 为 apply/index.ts 的
 * 显式具名薄转发，tsc 直接产出可用的 lib/index.js/d.ts；旧的星转发覆盖
 * （`export * from "./apply/index.js"`）与 tsc 具名产物同出面——实测两边导出名集合
 * 完全一致（64=64，src/index 具名表 vs apply/index 具名表 + name/inject 常量声明，
 * 差集为空），bundle-host 沿任一写法递归内联出同一束产物，故覆盖步骤纯冗余。
 * package.json build 链不改（仍调本脚本），build 前后导出面快照双 PASS 实证。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const srcAdapters = join(pkgDir, "src", "server", "adapters");
const libAdapters = join(pkgDir, "lib", "server", "adapters");

// 适配器产物归位（与 tsc 输出结构对齐，替代共享 bundle-host 中 src/adapters 硬编码）
if (existsSync(srcAdapters)) {
  mkdirSync(libAdapters, { recursive: true });
  for (const f of readdirSync(srcAdapters)) {
    if (/\.(mjs|d\.mts)$/.test(f)) cpSync(join(srcAdapters, f), join(libAdapters, f));
  }
}

console.log(
  "[prepare-lib-entry] 适配器产物归位 lib/server/adapters/ 完成（入口沿用 tsc 具名产物）",
);
