/**
 * dsh-mcp-manager — inject/impl/call-timeout/index.ts：中间层外层超时纯函数（#935）。
 *
 * 回答「`ws_mcp_call` 注册时的 `timeoutMs` 该是多少？」——取在用全量源里最大的单次调用
 * 预算，再叠一段内部尾。调用方（组合根）负责收集全量源（`mw.units` 全 root 含 `@global`
 * 的连接条目 + `manager.runtimeRegistry` 内存注入项），本函数只做纯计算，便于单测。
 *
 * 两段尾不要混淆：
 * - 内层尾 +2s：dispatch 执行器给每次调用套的 `withTimeout` 兜底预算 = 该源
 *   `toolCallTimeoutMs` + 2000（见 servers/dispatch/impl/call）；
 * - 外层尾 +25s：本函数在最大源预算上叠的内部尾 = `CONNECT_TIMEOUT_MS`(10s) +
 *   `DISCOVERY_TIMEOUT_MS`(10s) + 5000。外层恒大于任何一源的内层预算，1 分钟以上的
 *   长调用不再被外层先误杀。
 *
 * 本文件零依赖：三个字面量是 `server/shared/constants.ts` 里 `DEFAULT_TOOL_CALL_TIMEOUT_MS` /
 * `CONNECT_TIMEOUT_MS` / `DISCOVERY_TIMEOUT_MS` 与 `+ 5000` 的镜像——共享层落在 config 域的
 * 模块求值路径上只能是无 import 叶子，本函数同理保持无 import（改共享常量时同步改这里，
 * `unit-call-timeout` 的「外层公式断言」用常量现算期望值、不用字面量，会当场打红）。
 *
 * @param sources 全量源的 `toolCallTimeoutMs` 原值（含缺省缺席 `undefined`，非法值按缺省计）。
 * @returns 外层 `timeoutMs`：`max(源，缺省 15s) + 25s`；空集回落 40s（= 缺省 15s + 25s）。
 */
const DEFAULT_SOURCE_TIMEOUT_MS = 15_000;
const OUTER_TAIL_MS = 10_000 + 10_000 + 5000;

export function resolveMiddlewareCallTimeoutMs(sources: readonly (number | undefined)[]): number {
  let max = DEFAULT_SOURCE_TIMEOUT_MS;
  for (const timeout of sources) {
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > max) {
      max = timeout;
    }
  }
  return max + OUTER_TAIL_MS;
}
