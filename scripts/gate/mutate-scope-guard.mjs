#!/usr/bin/env node
/**
 * mutate-scope-guard — Stryker mutate 面守卫（#85 v3 F5，门禁生效前置）
 *
 * 校验 stryker.conf.d/*.json 中每个 mutate 区间（"path:A-B" 形态）：
 *   1. 首行 A 必须是 "// lib/<name>.js" 分段注释行 —— 即区间起点落在
 *      self-written 段声明边界上；
 *   2. 区间 (A, B] 内允许出现后续 "// lib/*.js" 注释（一个 mutate 区间可合法地
 *      跨多个相邻自写子段），但禁止落入任何非 lib 分段（// node_modules/*、
 *      // ../../shared/* 等 vendor 与共享契约层副本）。
 *
 * 背景：lib/*.js 由 esbuild 打包生成，分段注释是唯一的"自写代码 vs 内联副本"
 * 边界标记。mutate 区间若因构建产物结构变化而漂移进 vendor/shared 段，变异计量
 * 将错误计入内联副本（多包重复计账、score 横向不可比）——本守卫 fail-loud。
 *
 * 用法：node scripts/gate/mutate-scope-guard.mjs [stryker.conf.d 目录]
 * 退出码：0 = 全部区间合法；1 = 存在越界/非法区间；2 = 配置/环境错误
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const confDir = join(repoRoot, process.argv[2] ?? 'stryker.conf.d');

if (!existsSync(confDir)) {
  console.error(`mutate-scope-guard: 配置目录不存在：${confDir}`);
  process.exit(2);
}

const SEGMENT_RE = /^\/\/ (lib\/[\w./-]+\.js)$/;
const NON_LIB_SEGMENT_RE = /^\/\/ (?!lib\/)(?:node_modules|\.\.\/\.\.\/shared|shared)[\w./-]*/;
const RANGE_RE = /^(.+?):(\d+)-(\d+)$/;

let failures = 0;
let checkedRanges = 0;

for (const name of readdirSync(confDir).sort()) {
  if (!name.endsWith('.json')) continue;
  const confPath = join(confDir, name);
  let conf;
  try {
    conf = JSON.parse(readFileSync(confPath, 'utf8'));
  } catch (err) {
    console.error(`[FAIL] ${name}: JSON 解析失败：${err.message}`);
    failures += 1;
    continue;
  }
  const mutateList = conf?.mutate;
  if (!Array.isArray(mutateList) || mutateList.length === 0) {
    console.error(`[FAIL] ${name}: mutate 缺失或为空`);
    failures += 1;
    continue;
  }

  // 以配置所在目录为基准解析 lib 路径（mutate 路径形如 packages/<pkg>/lib/index.js）
  for (const entry of mutateList) {
    const m = RANGE_RE.exec(entry);
    if (!m) {
      console.error(`[FAIL] ${name}: mutate 条目 "${entry}" 不是 "path:A-B" 区间形态`);
      failures += 1;
      continue;
    }
    const [, relPath, startStr, endStr] = m;
    const startLine = Number(startStr);
    const endLine = Number(endStr);
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) {
      console.error(`[FAIL] ${name}: ${relPath} 不存在——请先构建（pnpm build）再运行本守卫`);
      failures += 1;
      continue;
    }
    const lines = readFileSync(absPath, 'utf8').split('\n');
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      console.error(`[FAIL] ${name}: 区间 ${startLine}-${endLine} 越出文件范围（共 ${lines.length} 行）`);
      failures += 1;
      continue;
    }

    checkedRanges += 1;

    // 规则 1：首行必须是 lib 分段注释
    const headText = lines[startLine - 1];
    if (!SEGMENT_RE.test(headText)) {
      console.error(
        `[FAIL] ${name}: 区间起点 L${startLine} 不是 "// lib/*.js" 分段注释（实际："${headText.slice(0, 60)}"）` +
        ` —— mutate 面漂移或分段注释变更未同步`,
      );
      failures += 1;
      continue;
    }
    // 规则 2：区间内不得落入非 lib 分段（vendor / shared 副本）；跨多个 lib 子段合法
    let drifted = false;
    for (let ln = startLine + 1; ln <= endLine; ln += 1) {
      if (NON_LIB_SEGMENT_RE.test(lines[ln - 1])) {
        console.error(
          `[FAIL] ${name}: 区间尾段 L${ln} 落入非 lib 分段（"${lines[ln - 1].slice(0, 60)}"）` +
          ` —— 尾部漂移会误计 vendor/shared 内联副本`,
        );
        failures += 1;
        drifted = true;
        break;
      }
    }
    if (drifted) continue;
    const libSegs = [];
    for (let ln = startLine + 1; ln <= endLine; ln += 1) {
      if (SEGMENT_RE.test(lines[ln - 1])) libSegs.push(ln);
    }
    const segNote = libSegs.length === 0
      ? headText.trim()
      : `${headText.trim()} 跨 ${libSegs.length + 1} 个自写子段`;
    console.log(`[OK] ${name}: ${relPath}:${startLine}-${endLine}（${segNote}，无越界）`);
  }
}

console.log(`\nmutate-scope-guard: 校验 ${checkedRanges} 个区间，${failures} 个失败`);
process.exit(failures > 0 ? 1 : 0);
