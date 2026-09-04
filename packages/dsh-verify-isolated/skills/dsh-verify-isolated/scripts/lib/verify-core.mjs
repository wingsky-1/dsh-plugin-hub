/**
 * verify-core.mjs — verify-isolated.mjs 的共享基础工具（零依赖，纯 Node 内置）。
 *
 * #517 C8 抽取：poll / findFreePort / jsonOut / 退出码常量给
 * verify-isolated.mjs 复用（browser-driver.mjs 的 main/parseArgs/out/poll
 * 模式；fail 由 verify-isolated.mjs 内聚为 json 感知的 errorPayload 路径，
 * 本模块不导出死函数），另内建两段纯函数语义：
 *   - readDshPort：B6 verdict 端口实际绑定双通道之 parsed 通道（解析 dsh.log）；
 *   - resolvePkgArg：C11 插件参数归一化（相对路径绝对化 / 包规格透传），随 C8
 *     内建，不依赖 C11 的 resolve-pkg-paths.mjs 文件。
 * browser-driver.mjs 保持独立 CLI 不动、不 import 本模块。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";

// --- 退出码契约（显式，verify-isolated.mjs 头部注释有对照表） ---
export const EXIT = Object.freeze({
  /** 0 正常完成：启动 + 就绪 + 前台等待 dsh 退出，清理完毕 */
  OK: 0,
  /** 1 启动或就绪失败：profile 初始化失败 / add 失败 / dsh 就绪前退出 / 15s 就绪超时 */
  FAIL: 1,
  /** 2 参数错误：未知选项 / 缺参 / 找不到 dsh 入口 / --no-build 缺产物 */
  USAGE: 2,
  /** 130 SIGINT（Ctrl+C）：终态清理后透传 */
  SIGINT: 130,
  /** 143 SIGTERM：终态清理后透传 */
  SIGTERM: 143,
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询：fn() 为 truthy 即返回 true，超时返回 false（browser-driver 同款模式）。 */
export async function poll(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** 进程存活判断（kill(pid, 0) 探测，browser-driver 同款）。 */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** 等待进程退出（超时返回是否已退出；browser-driver waitPidExit 同款）。 */
export async function waitPidExit(pid, timeoutMs) {
  await poll(() => !pidAlive(pid), timeoutMs, 200);
  return !pidAlive(pid);
}

/** 在 127.0.0.1 上探测真实空闲端口（复用 browser-driver 实现思路）。 */
export function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolvePort(port));
    });
  });
}

export function jsonOut(obj, pretty = false) {
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : 0) + "\n");
}

// --- B6：dsh 端口行解析（parsed 通道，格式已实证） ---
// dsh web 启动会打印一行 `dsh web: http://127.0.0.1:<port>/?token=...`
//（0.1.2-rc.1 实测确认，注入 web-app bundle 后约 2s 内输出）；verdict 的
// port.actual 三通道第一优先解析它。不匹配返回 null，由调用方回退
// 就绪断言端口（asserted）/ 探测端口（probed）。
// 行完整性（P2-6）：端口号后必须紧跟 `/` 或 `?`（真实 URL 形态），防 chunk
// 截断 latch（如 chunk 尾部 `:34` 被当作完整端口锁定）；范围校验（P2-7）：
// 1-65535 之外视为无匹配。
export function readDshPort(text) {
  const m = /dsh web:\s*http:\/\/\S*?:(\d+)(?=\/|\?)/.exec(text || "");
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 1 && p <= 65535 ? p : null;
}

// --- C11 内建：插件参数归一化（原 resolve-pkg-paths.mjs 语义随 C8 内建） ---
// dsh plugin add 同时接受本地路径 / npm 包名 / git URL 三种形态；相对路径必须
// 基于当前 cwd 绝对化（dsh 会把非绝对路径当 git URL 解析、报 `Repository not
// found` 迷惑错误，#517 C11），包规格（@scope/name、name@version、git URL）
// 原样透传。判定顺序敏感：
//   1. 形态类路径（`.` `..` `/` `~` 开头）→ 绝对化；
//   2. cwd 下存在该路径（目录或文件）→ 绝对化；
//   3. 其余 → 视为包规格，原样透传。
const PATH_LIKE = /^(\.{1,2}\/|\.{1,2}$|\/|~)/;

/** `~`/`~/x` 展开为 home 前缀（path.resolve 不做 `~` 展开，此处内建）。 */
export function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

/** 单个插件参数归一化：{ input, kind: "path"|"spec", abs }（abs 仅 path 时有值）。 */
export function resolvePkgArg(input) {
  const expanded = expandHome(input);
  if (PATH_LIKE.test(expanded)) return { input, kind: "path", abs: resolve(expanded) };
  if (existsSync(expanded)) return { input, kind: "path", abs: resolve(expanded) };
  return { input, kind: "spec", abs: null };
}