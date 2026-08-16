// dsh 插件家族共享层 — loopback 围栏（单一事实源）。
//
// 安全决策：所有 /api 路由（含写路由）强制校验 loopback-only，
// 非法一律 403（DNS 重绑定 + 跨站防御）。
//
// 历史：该函数曾在 6 个插件（commands-files/memory/notifier/hooks/
// skill-explorer/mcp-manager）逐字复制，安全边界修复不传播。
// 现在统一由本模块提供；新增插件路由一律 import 本模块。
//
// 注意：插件以 `dsh plugin add link:<本仓库路径>/<插件>` 方式安装，
// 相对路径 import 在 link 安装下保持有效；独立复制插件目录会断链。

/**
 * Loopback 围栏：请求必须来自回环地址 + 回环 Host + 非跨站，否则拒绝。
 * @param {import("node:http").IncomingMessage} request - Node http 请求对象。
 * @returns {boolean} 是否允许。
 */
export function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
