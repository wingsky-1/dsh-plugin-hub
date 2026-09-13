#!/usr/bin/env node

/**
 * verify-vendored-binaries — 发布物面内 vendored 裸二进制的登记与哈希绑定门禁（#784
 * 遗留 D 项 / 批 2b）。
 *
 * 补的是 `collect-licenses` 的**盲区**：它的内联证据来自 esbuild 产物里的 node_modules
 * 路径注释，对一个随包分发的 `.exe/.node/.dll` 完全失明——「分发了一个副本却没附许可文本」
 * 因此能一路静默到用户手里。判据与理由见 scripts/lib/vendored-binaries-lib.mjs。
 *
 * 用法：node scripts/gate/verify-vendored-binaries.mjs [--root <dir>] [--registry <file>]
 *   --root     只换**扫描面**（fixture 用），默认真实仓库根
 *   --registry 登记表路径，默认真实仓库根的 scripts/data/vendored-binaries.json
 *              （治理数据不随 --root 漂移，与 forbid-* 的 --exemptions 同语义）
 * 退出码：0 = 通过；1 = 有违规；2 = 结构/环境错误（登记表不可读）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { argValue } from "../lib/exemption-gate.ts";
import { REGISTRY_REL, verifyVendoredBinaries } from "../lib/vendored-binaries-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * 取参数值：解析走 exemption-gate 的共享实现（`--flag value` / `--flag=value` 两种形态，
 * 与各 forbid-* 门禁同源），空值在本闸按结构错误 fail-closed。
 */
function requiredArg(flag, fallback) {
  const v = argValue(process.argv, flag, fallback);
  if (typeof v !== "string" || v.trim() === "") {
    console.error(`[verify-vendored-binaries] ${flag} 取值非法`);
    process.exit(2);
  }
  return v;
}

const root = requiredArg("--root", ROOT);
const registry = requiredArg("--registry", join(ROOT, REGISTRY_REL));
if (!existsSync(root)) {
  console.error(`[verify-vendored-binaries] 扫描根不存在：${root}`);
  process.exit(2);
}

let result;
try {
  result = verifyVendoredBinaries(root, { registryPath: registry });
} catch (e) {
  console.error(
    `[verify-vendored-binaries] 判定不可执行：${String(e?.message ?? e).split("\n")[0]}`,
  );
  process.exit(2);
}

const { problems, reports, scanned, registered, hits } = result;
// 报告不是判据：未构建的声明条目会让扫描面静默变小，但门禁不据此判红（判据面是源码树）。
for (const r of reports) console.log(`NOTE | ${r}`);
for (const p of problems) console.log(`FAIL | ${p}`);
if (problems.length > 0) {
  console.log(
    `\nFAIL（扫描发布物面 ${scanned} 文件，命中裸二进制 ${hits}，登记 ${registered}；违规 ${problems.length}）`,
  );
  console.log(
    "登记表：scripts/data/vendored-binaries.json（登记项漏了 license 随包 = 合规缺口，不是配置问题）",
  );
  process.exit(1);
}
console.log(
  `PASS | 发布物面内无未登记裸二进制（扫描 ${scanned} 文件，命中 ${hits}，登记 ${registered} 项全部哈希一致且许可文本随包）`,
);
