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
 * Loopback 围栏：请求必须来自回环地址 + 回环 Host，且满足跨站/来源约束，
 * 否则拒绝。默认拒绝一切 `sec-fetch-site: cross-site` 请求（DNS 重绑定 +
 * 跨站防御）；仅当 `options.allowCrossSiteNoCors` 为 true 时，**显式带
 * `sec-fetch-mode: no-cors` 的跨站子资源请求**放行（见 issue #549：
 * sandbox iframe 的 opaque origin 会使其相对路径子资源请求（css/js/img）
 * 一律呈 cross-site，serve 虚拟伺服需放行 no-cors 标签型加载，但 cors
 * fetch/XHR 与 navigate 仍拒绝）。
 *
 * 跨站放行是安全语义变更点，**只允许 serve 类资源伺服路由使用**；
 * 普通 /api 路由必须保持默认拒绝。
 *
 * @param {import("node:http").IncomingMessage} request - Node http 请求对象。
 * @param {{ allowCrossSiteNoCors?: boolean }} [options] - 可选判定参数。
 * @returns {boolean} 是否允许。
 */
/**
 * 对端地址是否回环（IPv4 / IPv6 / IPv4-mapped 三种写法）。fail-closed：拿不到地址即拒绝。
 *
 * 单立一函数是因为它与 Host 头是**两个不同的事实**：前者在传输层（谁连过来的），
 * 后者在应用层（他说自己是谁）。合成一条 if 时，「改 Host 白名单」会连带改到对端判定。
 */
function isLoopbackPeerAddress(request) {
  const address = request.socket?.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Host 头解析与判定：必须是 127.0.0.1 / localhost / [::1]，否则拒绝。
 * 返回解析好的 URL（同源比较要用它的 host），解析失败或不在白名单即 undefined。
 */
function loopbackHostUrlOf(request) {
  const host = request.headers.host;
  if (typeof host !== "string") return undefined;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  if (
    hostUrl.hostname !== "127.0.0.1" &&
    hostUrl.hostname !== "localhost" &&
    hostUrl.hostname !== "[::1]"
  ) {
    return undefined;
  }
  return hostUrl;
}

/**
 * 跨站判定（#549）：默认拒绝一切 cross-site；仅 serve 资源路由经 allowCrossSiteNoCors
 * 放行「显式 no-cors」的跨站子资源（标签型加载）。
 * fail-closed：cross-site 请求缺少 no-cors 标记（含头缺失的防御语义）一律拒绝，不猜测放行。
 * 同源（无 sec-fetch-site 或非 cross-site）恒放行——同源与否由 Origin 头那一段再判一次。
 */
function crossSiteRequestAllowed(request, options) {
  if (request.headers["sec-fetch-site"] !== "cross-site") return true;
  return options.allowCrossSiteNoCors === true && request.headers["sec-fetch-mode"] === "no-cors";
}

export function isLoopbackRequest(request, options = {}) {
  if (!isLoopbackPeerAddress(request)) return false;
  const hostUrl = loopbackHostUrlOf(request);
  if (hostUrl === undefined) return false;
  if (!crossSiteRequestAllowed(request, options)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}
