/**
 * 转发引擎域对外承诺：转发器工厂、句柄类型与可单测的纯判定函数。
 *
 * 纯函数与有状态引擎同住一域——它们共享同一套转发布局知识（回环 authority、压缩
 * 白名单、令牌铸造条件），拆成并列域会让每个定义都要跨域解释另一半。
 */
export {
  bridgeUpstreamHeaders,
  compressWsPath,
  createLanProxy,
  deflateAllowedByPolicy,
  formatAuthority,
  hasDshAuthCookie,
  hostnameAllowed,
  isCompressible,
  isTokenMintCandidate,
  resolveCompressionOptions,
  rewriteHeaders,
  withLaunchToken,
} from "./impl/proxy.ts";
export type { ConnStats, LanProxy, TokenProvider } from "./impl/proxy.ts";
