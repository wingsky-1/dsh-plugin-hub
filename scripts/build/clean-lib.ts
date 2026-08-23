#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * clean-lib — 构建前清空插件 lib/（hub 布局下 lib/ 为纯构建产物：
 * 资源文件如 toast.ps1 一律放 src/，由 bundle-host 复制进 lib/）。
 * 用法：node scripts/clean-lib.mjs   （pnpm --filter 场景 cwd=包目录）
 */
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const lib = resolve(process.cwd(), 'lib')
if (existsSync(lib)) rmSync(lib, { recursive: true, force: true })
