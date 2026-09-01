// @ts-nocheck
/**
 * dsh-provider-usage — unit：refreshStats 取数前 provider 复检外壳（issue #71 方案 A1）。
 *
 * 行为级剧本在 client-revalidate.worker.mjs 中以独立子进程执行（其需替换
 * document/fetch/setInterval 全局对象——TLA 并发求值语义下同进程必与 smoke
 * 模块图内其他文件的 fetch 替换/恢复交错冲突，故进程隔离）。本外壳：
 * - 源码契约：A1 接线存在且被 refreshStats/detect 正确调用；
 * - 同步 spawn worker，校验退出码与 WORKER-PASS 标记。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assert } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// ---------------------------------------------------------------- 源码契约：A1 接线存在

{
  const src = readFileSync(join(pkgDir, "src/client/index.ts"), "utf8");
  assert.ok(src.includes("async function revalidateProvider"), "A1 检测半区函数已抽出");
  assert.ok(
    /async function refreshStats[\s\S]*?await revalidateProvider\(\)/.test(src),
    "refreshStats 取数前先复检 provider（A1 主接线）",
  );
  // detect 变化分支 → onProviderChanged 立即重拉；未变分支 → renderPill 后仅 current
  // 会话切换时补刷（#419 diff 语义：投影/运行态噪声帧不刷，收敛高频 /stats 调用）
  assert.ok(/const changed = await revalidateProvider\(\);[\s\S]*?onProviderChanged\(\)/.test(src),
    "detect 复检变化 → 立即重拉（切换会话即时跟随）");
  assert.ok(/renderPill\(\);[\s\S]*?currentSessionId\(sessions\)[\s\S]*?lastDetectCurrent/.test(src),
    "detect 未变分支按 current diff 判定是否补刷（#419 去高频）");
  // #419：modelCatalog 兜底走缓存 loader（官方 catalog 同款），不再裸调跟随帧频率
  assert.ok(src.includes("makeCatalogCache()"), "客户端持有 catalog 缓存实例");
  assert.ok(src.includes("catalogCache.load"), "resolveProviderFromSession 注入缓存 loader");
  assert.ok(src.includes("catalogCache.reset()"), "卸载时失效目录缓存");
}

// ---------------------------------------------------------------- 子进程行为级剧本

let stdout;
try {
  stdout = execFileSync(process.execPath, [join(pkgDir, "test/client-revalidate.worker.mjs")], {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
} catch (error) {
  console.error("worker stdout:\n" + (error.stdout ?? ""));
  console.error("worker stderr:\n" + (error.stderr ?? ""));
  assert.fail(`client-revalidate.worker 子进程失败（exit=${error.status}）`);
}
assert.match(stdout, /WORKER-PASS/, "worker 打印 WORKER-PASS 标记");

console.log("[unit-refresh-revalidate] 全部断言通过 ✓ (#71 A1 外壳+worker)");
