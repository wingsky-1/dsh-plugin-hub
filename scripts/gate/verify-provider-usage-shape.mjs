#!/usr/bin/env node
"use strict";

/**
 * verify-provider-usage-shape — provider-usage 三处源码形态锁（#768 干跑红修复）。
 *
 * 为什么只进 gate 层、不进 vitest：Stryker 在沙箱运行插桩后副本——插桩头含 process.env
 * 字面、变异包装给对象字面量引入额外逗号冒号。读源码文本做结构断言的三处在干跑必红
 * （本地 stryker --dryRunOnly 已复现），故源码文本断言只在 pristine 树求值（本门禁），
 * 不在 vitest 内求值。三检查逻辑从测试原样搬运（moved-not-deleted）：
 *   a) apply.ts 内 new ReportConfigService 实参键集 == [initial,onUpdate,root]
 *     （D1③；多递 scheduler 实例等即红）；
 *   b) server/history/history.ts 不含 dshHome/process.env/homedir
 *     （D5；落盘根只经构造注入，模块求值期不读环境）；
 *   c) server/aggregate/store.ts 含 deletePromises 具名注解 Array<Promise<void>>
 *     （D8；tmp 清理行为锁，注解丢失即红）。
 *
 * 用法：node scripts/gate/verify-provider-usage-shape.mjs [--root <dir>]
 *   --root 只换扫描面（fixture 用），默认真实仓库根。
 * 退出码：0 = 通过；1 = 违例（判红可信）；2 = 门禁故障（缺文件 fail-closed，经 failClosed 出口，禁止合并）。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue } from "../lib/exemption-gate.ts";
import { failClosed } from "../lib/gate-exit.mjs";

const DEFAULT_ROOT = join(import.meta.dirname, "..", "..");
const APPLY_REL = "packages/dsh-provider-usage/src/apply/apply.ts";
const HISTORY_REL = "packages/dsh-provider-usage/src/server/history/history.ts";
const STORE_REL = "packages/dsh-provider-usage/src/server/aggregate/store.ts";
const STORE_ANNOTATION = "const deletePromises: Array<Promise<void>> = [];";
const EXPECTED_CTOR_KEYS = ["initial", "onUpdate", "root"];

/**
 * 抽取组合根 new ReportConfigService({ ... }) 的实参键集（非对象字面量返回 null）。
 * 与 config/composition-root.test.ts 的同名函数逐字同形（moved-not-deleted）。
 */
export function serviceCtorKeys(src) {
  const m = /new ReportConfigService\(\{([^}]*)\}\)/.exec(src);
  if (m === null) return null;
  return m[1]
    .split(",")
    .map((p) => p.split(":")[0].trim())
    .filter((k) => k.length > 0)
    .sort();
}

/** 三形态各自的违例判据句（中文；调用方原样打印）。 */
export function checkApply(src) {
  const keys = serviceCtorKeys(src);
  const ok =
    keys !== null &&
    keys.length === EXPECTED_CTOR_KEYS.length &&
    keys.every((k, i) => k === EXPECTED_CTOR_KEYS[i]);
  if (ok) return null;
  return "组合根构造实参键集须恰为 [initial,onUpdate,root]（多递 scheduler 实例等即红）";
}

export function checkHistory(src) {
  if (src.includes("dshHome") || src.includes("process.env") || src.includes("homedir")) {
    return "历史实现模块求值期不得读环境（含 dshHome/process.env/homedir 即红，落盘根只经构造注入）";
  }
  return null;
}

export function checkStore(src) {
  if (!src.includes(STORE_ANNOTATION)) {
    return "聚合存储须含 deletePromises 具名注解 Array<Promise<void>>（注解丢失即红，tmp 清理行为锁）";
  }
  return null;
}

/** 读单个被测文件：缺失/不可读一律 fail-closed（判据失去依据，不读成通过/不达标）。 */
function readShapeFile(root, rel) {
  const abs = join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    failClosed(
      `verify-provider-usage-shape | 缺被测文件（${rel}）：${String(e?.message ?? e).split("\n")[0]}`,
    );
  }
  return text;
}

export function evaluateShape(root) {
  const applySrc = readShapeFile(root, APPLY_REL);
  const historySrc = readShapeFile(root, HISTORY_REL);
  const storeSrc = readShapeFile(root, STORE_REL);
  const problems = [];
  const hit = checkApply(applySrc);
  if (hit !== null) problems.push(`FAIL | ${APPLY_REL}：${hit}`);
  const hitHistory = checkHistory(historySrc);
  if (hitHistory !== null) problems.push(`FAIL | ${HISTORY_REL}：${hitHistory}`);
  const hitStore = checkStore(storeSrc);
  if (hitStore !== null) problems.push(`FAIL | ${STORE_REL}：${hitStore}`);
  return { problems };
}

function main(argv) {
  const root = argValue(argv, "--root", DEFAULT_ROOT);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    failClosed(`verify-provider-usage-shape | --root 不是目录：${root}`);
  }
  const { problems } = evaluateShape(root);
  if (problems.length > 0) {
    for (const p of problems) console.log(p);
    console.log(`verify-provider-usage-shape: FAIL（3 项形态中违规 ${problems.length} 项）`);
    return 1;
  }
  console.log(
    "verify-provider-usage-shape: OK（3 项形态全通过：构造键集/历史无环境直连/聚合注解在位）",
  );
  return 0;
}

/** 仅直接执行时跑 main（被自测 import 时只取纯函数，与仓内其他门禁同口径）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(main(process.argv));
