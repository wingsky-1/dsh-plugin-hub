#!/usr/bin/env node
"use strict";

/**
 * clean-lib — 构建前清空插件 lib/ 与 tsc 增量状态（hub 布局下 lib/ 为纯构建产物：
 * 资源文件如 toast.ps1 一律放 src/，由 bundle-host 复制进 lib/）。
 * 用法：node scripts/clean-lib.mjs   （pnpm --filter 场景 cwd=包目录）
 *
 * 为什么连带删 tsconfig.tsbuildinfo（#1028 后续重构）：包构建改用 tsc -b 后 tsc 带增量状态。
 * 若只清 lib/ 而留下陈旧 tsbuildinfo，tsc 会判「已是最新」而**跳过 emit**——于是 lib/ 是空的、
 * 构建却 exit 0，产物缺失要到下游（esbuild 内联 / d.ts X1 / pack:check）才炸，失败信号离病因很远。
 * 清产物必须连同「产物是否已生成」的判据一起清，否则 clean 与增量两个机制互相抵消。
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const lib = resolve(process.cwd(), "lib");
if (existsSync(lib)) rmSync(lib, { recursive: true, force: true });

// tsc -b 的增量状态：删它等于强制本轮全量 emit
const buildInfo = resolve(process.cwd(), "tsconfig.tsbuildinfo");
if (existsSync(buildInfo)) rmSync(buildInfo, { force: true });
