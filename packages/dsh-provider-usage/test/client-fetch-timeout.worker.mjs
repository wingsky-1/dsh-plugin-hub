// @ts-nocheck
/**
 * dsh-provider-usage — 行为级 worker：客户端 fetch 超时兜底（issue #268 P1）。
 *
 * 对 src/client/core.ts 真实源码做行为级断言（esbuild 内存打包 + mock fetch，
 * 无网络无 DOM 依赖）：
 * - 慢响应（永不 settle、仅响应 abort）：fetchTimeout 在注入的短超时窗内 reject，
 *   reason 为 TimeoutError，且耗时远小于默认窗——「超时窗内 abort 不悬挂」
 *   （#268 主断言；模拟移动端切后台半开连接下请求挂到 TCP 重传超时的场景）；
 * - 默认超时常量 CLIENT_FETCH_TIMEOUT_MS === 10_000（与 mcp-manager api() #111 对齐）；
 * - 快响应正常透传返回 Response，注入的超时信号未被误触发；
 * - init.signal 存在时不注入兜底信号（调用方信号优先，#111 同款语义）。
 *
 * 运行形态：由 unit-fetch-timeout.test.ts 以子进程执行（需替换全局 fetch，
 * 进程隔离理由同 client-revalidate.worker.mjs：TLA 并发求值语义下同进程必与
 * smoke 模块图内其他文件的 fetch 替换交错冲突）。全部断言通过打印 WORKER-PASS。
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// ---------------------------------------------------------------- 打包 core.ts（纯逻辑，无需 DOM stub）

const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/core.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
  define: { __DSH_ROUTES__: "undefined" },
});
const client = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

// ---------------------------------------------------------------- 剧本

async function main() {
  // 常量契约
  assert.equal(client.CLIENT_FETCH_TIMEOUT_MS, 10_000, "客户端 fetch 默认超时 = 10s（#111 先例对齐）");
  console.log("[client-fetch-timeout.worker] 常量契约 ✓");

  // 场景1（#268 主断言）：慢响应在超时窗内 abort 不悬挂
  {
    let seenSignal;
    globalThis.fetch = (url, init) => {
      seenSignal = init?.signal;
      // 半开连接模拟：请求永不 settle，仅在 signal abort 时以 abort reason reject
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    };
    // 守护 timer：Node 的 AbortSignal.timeout 内部 timer 是 unref 的（不保持事件循环），
    // 本 worker 无其他活跃 handle 时会整体静默退出——挂一个 ref 定时器撑住循环，
    // abort 正常发生即清除；若实现回归为悬挂则由它触发失败（防 flake：轮询替代固定 sleep 同理）。
    let guardTimer;
    const guard = new Promise((_, reject) => {
      guardTimer = setTimeout(() => reject(new Error("fetchTimeout 未在守护窗（2s）内 abort——疑似悬挂")), 2000);
    });
    const t0 = Date.now();
    try {
      await Promise.race([
        assert.rejects(
          () => client.fetchTimeout("/api/dsh-provider-usage/stats", undefined, 50),
          (error) => error?.name === "TimeoutError",
          "慢响应应在超时窗内以 TimeoutError reject",
        ),
        guard,
      ]);
    } finally {
      clearTimeout(guardTimer);
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `abort 应发生在注入的短窗内而非悬挂（实际 ${elapsed}ms）`);
    assert.ok(seenSignal?.aborted === true, "底层 fetch 收到的 signal 已 aborted（接线生效）");
    console.log(`[client-fetch-timeout.worker] 场景1 慢响应 ${elapsed}ms 内 TimeoutError abort ✓`);
  }

  // 场景2：快响应正常透传（不误杀）
  {
    const resp = { ok: true, status: 200, json: async () => ({ ok: true }) };
    let seenInit;
    globalThis.fetch = async (url, init) => {
      seenInit = init;
      return resp;
    };
    const out = await client.fetchTimeout("/api/dsh-provider-usage/ui-config", { cache: "no-store" });
    assert.equal(out, resp, "快响应原样透传返回");
    assert.equal(seenInit.cache, "no-store", "RequestInit 其余字段保留");
    assert.equal(seenInit.signal?.aborted, false, "正常路径信号未触发");
    console.log("[client-fetch-timeout.worker] 场景2 快响应透传不误杀 ✓");
  }

  // 场景3：caller 自带 signal 时优先透传（#111 同款语义）
  {
    const controller = new AbortController();
    controller.abort(new Error("caller-cancel"));
    let seenInit;
    globalThis.fetch = (url, init) => {
      seenInit = init;
      return Promise.reject(init.signal.reason);
    };
    await assert.rejects(
      () => client.fetchTimeout("/api/x", { signal: controller.signal }),
      (error) => error?.message === "caller-cancel",
      "自带已取消 signal 时直接透传其取消原因",
    );
    assert.equal(seenInit.signal, controller.signal, "自带 signal 时透传原信号（不注入兜底信号）");
    console.log("[client-fetch-timeout.worker] 场景3 caller signal 优先不双取消竞争 ✓");
  }
}

main()
  .then(() => {
    console.log("WORKER-PASS [client-fetch-timeout.worker] 全部断言通过 ✓ (#268 P1)");
  })
  .catch((error) => {
    console.error("[client-fetch-timeout.worker] 断言失败：", error?.message ?? error);
    process.exit(1);
  });
