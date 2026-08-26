// @ts-nocheck
/**
 * dsh-provider-usage — unit：客户端 fetch 超时兜底外壳（issue #268 P1）。
 *
 * 行为级剧本在 client-fetch-timeout.worker.mjs 中以独立子进程执行（需替换全局
 * fetch——进程隔离理由同 client-revalidate.worker.mjs）。本外壳：
 * - 源码契约：AbortSignal.timeout 兜底接线存在、默认常量 10s、
 *   client 层裸 fetch 审计（fetch( 调用只允许出现在 core.ts 的 fetchTimeout 内，
 *   防未来调用点绕过封装退回无超时裸调）；
 * - 同步 spawn worker，校验退出码与 WORKER-PASS 标记。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assert } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// ---------------------------------------------------------------- 源码契约：超时接线存在

{
  const src = readFileSync(join(pkgDir, "src/client/core.ts"), "utf8");
  assert.ok(src.includes("export const CLIENT_FETCH_TIMEOUT_MS = 10_000"), "默认超时常量 10s（#111 先例对齐）");
  assert.ok(
    /return fetch\(url, \{ \.\.\.init, signal: AbortSignal\.timeout\(timeoutMs\) \}\);/.test(src),
    "无 caller signal 时注入 AbortSignal.timeout 兜底（#268 主接线）",
  );
  assert.ok(
    /if \(init\?\.signal !== undefined\) return fetch\(url, init\);/.test(src),
    "caller 自带 signal 时透传不兜底（#111 同款语义）",
  );
}

// ---------------------------------------------------------------- 源码契约：client 层裸 fetch 审计

{
  // 枚举 src/client 全部实现文件（未来新增文件自动入契约；.d.ts 声明与 .css 无调用面，排除）
  const clientFiles = readdirSync(join(pkgDir, "src/client"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
  assert.ok(clientFiles.includes("core.ts"), "client 目录枚举应命中 core.ts");
  for (const file of clientFiles) {
    const src = readFileSync(join(pkgDir, "src/client", file), "utf8");
    // \bfetch\( 不命中 fetchTimeout 标识符（其后跟 T 而非 "("）
    const calls = [...src.matchAll(/\bfetch\(/g)].length;
    if (file === "core.ts") {
      assert.equal(calls, 2, `core.ts 裸 fetch 恰为 fetchTimeout 内两条 return（实际 ${calls} 处）`);
    } else {
      assert.equal(calls, 0, `${file} 不得出现裸 fetch 调用（一律经 fetchTimeout 封装，#268）`);
    }
  }
}

// ---------------------------------------------------------------- 子进程行为级剧本

let stdout;
try {
  stdout = execFileSync(process.execPath, [join(pkgDir, "test/client-fetch-timeout.worker.mjs")], {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
} catch (error) {
  console.error("worker stdout:\n" + (error.stdout ?? ""));
  console.error("worker stderr:\n" + (error.stderr ?? ""));
  assert.fail(`client-fetch-timeout.worker 子进程失败（exit=${error.status}）`);
}
assert.match(stdout, /WORKER-PASS/, "worker 打印 WORKER-PASS 标记");

console.log("[unit-fetch-timeout] 全部断言通过 ✓ (#268 外壳+worker)");
