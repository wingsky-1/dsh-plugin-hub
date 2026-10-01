/**
 * dsh-notifier channels 域 —— 投递路径的单跳 URL 硬闸（#1016 P0）。
 *
 * 为什么要有这道闸：包 README 把「scheme 限 http/https、拒绝带凭据 URL」写成了对用户的承诺，
 * 而真实投递路径（sendBark / sendWebhook 的默认出站）此前对 URL **零校验**——配置里写什么就往
 * 哪里发。承诺与实现相反时，用户照文档建立的安全假设不成立。
 *
 * 与 dry-run 的 secure-fetch.ts 分工（措辞同源，判据同形）：
 * - secure-fetch 的 urlGate 是**草稿出站**的一部分，它在 DNS / 建连那一层还要做全量解析与地址分类；
 * - 本模块是**已保存路径**的出站准入，只做无 IO 的字面判定。它落在 deliver/ 而不并进 dry-run/：
 *   dry-run 是「未保存草稿的出站」专用域，已保存路径挂在它下面属依赖倒置——两个出口（bark /
 *   webhook）共用的准入面归投递面，域归属比「判据长得像」更重要；
 * - **不做 DNS 解析，也不按私网 / 回环 / 链路本地拦**：baseUrl 指向内网自建 bark-server 是明确
 *   支持的场景（README 明写「不做域名白名单」）。拦内网等于把本插件的主要用法关掉。
 *
 * 判据只有三条，与 secure-fetch 的 urlGate 逐条同形：解析失败 / 非 http(s) / 内嵌 userinfo。
 * 三条都是**纯拒绝、无兼容性代价**——合法配置里不会有人把 `ftp:` 或 `user:pass@` 写进投递地址。
 *
 * 为什么这里**不**判 query / hash：带 query 的地址合法且常用（`https://gateway/hook?tenant=x`）。
 * webhook 原样使用 `target.url`、不做任何拼接，它今日就能带 query 工作，拒它只是砍功能。
 * 真正有缺陷的是 bark 侧的**字符串拼接**（`baseUrl + "/push"` 会把 `/push` 掉进 query 串里，
 * base `https://host/x?t=1` 拼出来打到的是被截断的 `/x`），那是拼接的缺陷而不是地址的缺陷——
 * 故修在 bark 出口（改用 URL API 把 `/push` 拼到 pathname 上），不在这里拿拒投代替修好。
 *
 * **明示残余风险 + 登记为 follow-up（本次不做）**：本仓 v0.2.7 的包 README 曾把「去 query/hash」
 * 写成对用户的承诺，本次方向变更放弃机器强制（写面本就只校验非空串，那条承诺从未被代码兑现）。
 * 放弃之后，query 里的凭据（`?token=` / `?api_key=`）会留在对端访问日志里，**不再有任何机器拦截**，
 * 只剩包文档的「凭据只走请求头、不拼 URL」约定——按 issue #1016 的要求记为明示安全债务。
 * 补上它需要一套新的诊断展示面（属配置批次的范围），而写面按关键字拦又可能误伤用户自建网关的
 * 正常 `?api_key=`，风险收益比不合适。两侧都不做，只在此与 README 安全模型节登记。
 */

/** 单跳 URL 准入结论：拒时带一句可直接进 reason.detail 的原因。 */
export type UrlGateVerdict = { readonly ok: true } | { readonly ok: false; readonly cause: string };

/**
 * 拒绝前缀单点：客户端主文案是「Bark 请求失败（网络或超时）」，原因里必须自带「没发出去」，
 * 否则一次配置问题会被读成一次网络抖动。两个出口共用这一句，故单点。
 */
const REJECTED = "已拒绝投递：";

/**
 * 单跳 URL 准入：解析失败 / 非 http(s) / 内嵌 userinfo，三条各自给原文案。
 *
 * 判据的顺序与措辞对齐 secure-fetch.ts 的 urlGate：协议未过就不必看 userinfo，解析未过则后两条
 * 无从判断。判据对象是**真正发出去的那个地址**——bark 传的是拼好 /push 之后的串，不是用户写的
 * baseUrl 本身。
 */
export function admitDeliveryUrl(raw: string): UrlGateVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, cause: REJECTED + "URL 解析失败" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, cause: REJECTED + "仅允许 http(s)，拒绝 " + url.protocol };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, cause: REJECTED + "URL 不得内嵌 userinfo（凭据只能走请求头）" };
  }
  return { ok: true };
}
