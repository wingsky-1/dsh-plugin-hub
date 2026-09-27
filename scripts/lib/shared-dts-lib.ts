#!/usr/bin/env node
"use strict";

/**
 * shared-dts-lib — shared 声明副本随包断言的共享库（issue #461 L2）。
 *
 * 机制：bundle-host d.ts X1（2b 段）把仓库 shared/ 下全部 *.d.ts（递归，含
 * 子目录 client/ 等）复制进包内 shared/ 随包发布。此前 pack-check 只硬编码
 * 断言单文件，新增 shared d.ts（如 client/i18n.d.ts）
 * 漏打包时静默放行——「机制保证」没有「断言保证」兜底。
 *
 * 本库把断言升级为「仓库 shared/ 枚举清单 与 tarball 内 shared/ 副本逐一比对」：
 *   - listSharedDts(root)：枚举仓库 shared/ 下全部 .d.ts 相对路径（与
 *     bundle-host 2b 复制谓词同源，walk-files 单一事实源）；
 *   - assertSharedDtsPresent(pkgSharedDir, expected)：tarball 缺哪个文件报哪个（查缺）；
 *   - assertSharedDtsNoExtras(pkgSharedDir, expected)：报包内 shared/ 中期望清单之外
 *     的残留 .d.ts（查多，issue #478：retired 模块移除后旧副本不得残留在包内）。
 * 未来 shared 新增子目录/文件自动纳入断言，无需再改 pack-check。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkFiles } from "./walk-files.ts";

/**
 * 枚举仓库 shared/ 下全部声明文件（.d.ts，递归含子目录），返回相对路径列表。
 * 谓词与 bundle-host d.ts X1 2b 复制段完全一致（walk-files 共享实现）。
 * @param {string} root 仓库根（含 shared/ 目录）
 * @returns {string[]} 相对路径，如 ['client/i18n.d.ts', 'loopback.d.ts', ...]
 */
export function listSharedDts(root: string): string[] {
  return walkFiles(join(root, "shared"), (f) => f.endsWith(".d.ts"));
}

/**
 * 事实源非空断言：期望清单为空即判红（#1028 后续重构引入的静默绿出口）。
 *
 * 为什么必须 fail-closed：shared 的声明是 tsc 产物、不入库。此前清单恒非空，
 * shared 未构建时它是**空**的——而查缺（expected.filter）与查多（遍历包内后比对
 * expected 集合）两个出口在空清单下都返回空，于是发布面两条断言同时空转恒真。同一时刻
 * bundle-host 的复制循环也复制不到文件，但 lib/*.d.ts 里 ../shared/xxx.js 的说明符改写
 * 照跑，发布 tarball 的类型面直接断链，没有任何判据看得见。
 * 即「事实源为空时判据恒真」= 红线级静默绿，发布面判据不许在事实源为空时通过。
 *
 * 退出码口径：调用方以 **exit 1（判红）** 结案，不是 exit 2（门禁故障）。
 * 「shared 未构建」是门禁**如实读到**的仓库状态、结论可信（发布面确实不达标）；exit 2
 * 留给「门禁读不到输入 / 自身不可信」，两者语义不同、不可互相顶替。同本闸 --log-file
 * 证据缺失出口同口径（判据绿但证据缺失 → exit 1 判红）。
 *
 * @param {string[]} expected listSharedDts 结果（相对路径清单）
 * @returns {string[]} 判词列表（空 = 事实源非空，可继续逐包比对）
 */
export function assertSharedDtsInventoryNonEmpty(expected: string[]): string[] {
  if (expected.length > 0) return [];
  return [
    "仓库 shared/ 下 0 个 .d.ts，声明期望清单为空——shared 声明由 tsc 产出、不入库，" +
      "未构建时本闸查缺/查多两个出口都空转恒真，而 bundle-host 复制不到文件、" +
      "lib/*.d.ts 里 ../shared/*.js 的改写照跑，发布 tarball 类型面断链却无判据可见。" +
      "先构建 shared（pnpm --filter @wingsky-1/dsh-shared build，或 pnpm build）再跑本闸。",
  ];
}

/**
 * 断言 tarball 内 shared/ 副本覆盖期望清单。
 * @param {string} pkgSharedDir tarball 解包后的 shared/ 目录
 * @param {string[]} expected listSharedDts 结果（相对路径清单）
 * @returns {string[]} 缺失文件相对路径列表（空 = 完整）
 */
export function assertSharedDtsPresent(pkgSharedDir: string, expected: string[]): string[] {
  return expected.filter((rel: string) => !existsSync(join(pkgSharedDir, rel)));
}

/**
 * 查多：返回包内 shared/ 中「期望清单之外」的残留 .d.ts（相对路径列表，空 = 无残留）。
 *
 * retired 残留场景（issue #478）：shared 模块退休（DEPRECATED 两步走 → 移除）后，旧
 * 声明副本残留在包内 shared/——包根 shared/ 不入 git，clean-lib 只清 lib/ 不清包根
 * shared/，bundle-host 每次构建覆盖写入新副本但从不清理已移除者；files 白名单
 * shared/glob 双星 .d.ts 仍会把它带进发布 tarball（过期声明随包发布，陈旧类型面）。
 * assertSharedDtsPresent 只查「缺」不查「多」——本出口补「多」向，pack-check 接入后
 * 残留 fail-loud。
 */
export function assertSharedDtsNoExtras(pkgSharedDir: string, expected: string[]): string[] {
  const expectedSet = new Set(expected);
  const out: string[] = [];
  const visit = (cur: string): void => {
    for (const f of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, f.name);
      if (f.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!f.name.endsWith(".d.ts")) continue;
      // 包内目录相对 shared/ 根的路径（walkFiles 同款归一：relative + / 分隔）
      const rel = relative(pkgSharedDir, abs).split(sep).join("/");
      if (!expectedSet.has(rel)) out.push(rel);
    }
  };
  if (existsSync(pkgSharedDir) && statSync(pkgSharedDir).isDirectory()) visit(pkgSharedDir);
  return out;
}
