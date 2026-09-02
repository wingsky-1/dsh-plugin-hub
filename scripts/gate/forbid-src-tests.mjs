#!/usr/bin/env node
/**
 * 遗留 `.src.test.ts` 禁止门禁（issue #423 方案 A，防双份回潮）。
 *
 * 背景：#423 消除 30 个 `*.src.test.ts` 双份后（stryker 复用单份 `*.test.ts`，
 * 经 mutation-lib-to-src-hook 重定向 lib→src），仓库不应再出现任何
 * `*.src.test.ts`（含未跟踪文件）——它意味着开发者又手写了双份，
 * 变异面与普通 smoke 断言将再次脱节。
 *
 * 语义：扫 packages 下全部 *.src.test.ts（含未跟踪），命中任意一个即 exit 1（fail-closed）。
 * 零依赖，被 ci.yml「Forbid legacy src tests」步骤与本地正反演练复用。
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

/** 递归收集 packages/ 下全部 *.src.test.ts 路径（含未跟踪的）。 */
function collect(root) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不存在的目录静默跳过（fail-closed 靠命中计数兜底）
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith(".src.test.ts")) {
        hits.push(p);
      }
    }
  };
  walk(join(root, "packages"));
  return hits;
}

const hits = collect(ROOT);
if (hits.length > 0) {
  console.error(`forbid-src-tests: 发现 ${hits.length} 个遗留 *.src.test.ts（#423 已消除双份，禁止回潮）：`);
  for (const h of hits) console.error(`  - ${relative(process.cwd(), h)}`);
  process.exit(1);
}
console.log("forbid-src-tests: OK（全仓无 *.src.test.ts）");