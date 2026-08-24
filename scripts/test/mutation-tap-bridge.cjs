"use strict";
/**
 * Stryker tap-runner 桥接钩子（issue #151 打样产物）。
 *
 * 背景：本仓插件包的测试文件为顶层 assert 直跑形态（node:assert、无 TAP 输出）。
 * 断言失败时进程以未捕获异常非零退出，stdout 无任何 TAP "not ok" 行；
 * tap-runner 的 captureTapResult 将「exitCode != 0 且 TAP 流无 failedTests」
 * 抛为 runner 错误——mutant 被记为 RuntimeError 而非 Killed
 * （dsh-notifier 试点的 211/295 RuntimeError 即源于此），
 * mutation score 恒趋近 0%，失去指示意义。
 *
 * 本钩子经 stryker 配置的 tap.nodeArgs 以 `-r` 注入每个被测进程：
 * 把未捕获异常 / 未处理拒绝转写为一行 TAP not ok 后以非零码退出。
 * tap-runner 解析到 not ok 即判定测试失败 -> mutant Killed；
 * tap-runner 自身 hook.cjs 的 process.on('exit') 为同步落盘，
 * process.exit() 不会丢失 perTest coverage 与 hitCount。
 *
 * dryRun（无 mutant 注入）时测试应全绿，本钩子零输出；
 * 若确有断言失败则该次 run 记为 Failed（而非 Error），语义更准确。
 */
process.on("uncaughtException", (err) => {
  process.stdout.write(`1..1\nnot ok 1 - uncaughtException: ${(err && err.message) || err}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stdout.write(`1..1\nnot ok 1 - unhandledRejection: ${(reason && reason.message) || reason}\n`);
  process.exit(1);
});
