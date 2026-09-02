import { register } from "node:module";

/**
 * Stryker 测试宿主 lib→src 重定向入口（issue #423 方案 A）。
 *
 * 经 stryker 配置 tap.nodeArgs 的 `--import` 注入每个被测进程；
 * 这里把真正的 resolve hook（mutation-lib-to-src-loader.mjs）注册进 Node
 * ESM 解析链，使 `import("../lib/index.js")` / `await import("../lib/index.js")`
 * 解析到同包 `src/index.ts`——变异在源码上执行，测试断言仍复用单份 *.test.ts。
 */
register("./mutation-lib-to-src-loader.mjs", import.meta.url);
