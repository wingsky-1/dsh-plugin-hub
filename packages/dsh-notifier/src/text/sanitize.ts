/**
 * dsh-notifier — 文本域：通知文本脱敏（安全模块，纯函数）。
 *
 * 安全定位：通知正文/标题进入通知与历史前必须经本文件脱敏（「文本可能内嵌
 * 命令回显/路径/凭据片段」的外泄面收敛到可读摘要）；统一时点 = 渲染后、
 * 任何落史/投递前（sanitizeNoticeContent 单点），出口级 scrub（频道凭据等）
 * 是独立固定出口、不并入本文件。
 * SANITIZE_RULES 有序表是顺序敏感的安全数据——顺序硬约束与已证伪清单的
 * why 注释整体保留（改动前必读），任何新增规则不得破坏既有顺序语义。
 */
/**
 * 脱敏规则有序表：顺序即数据（具体在前、泛化在后），消灭隐式语句序。
 * 顺序硬约束（对抗评审实测确立）：
 * - DSN 必须先于 JWT/通用长串/密钥赋值：否则 DSN 密码先被劣化为 <token>，
 *   DSN 字符类排除 <> 随即失配，用户名残留明文；
 * - 邮箱必须殿后且带双负向后行断言（词字符 + 字面 <redacted）界定：避免把
 *   DSN 掩码占位符 <redacted>@host 中的 "redacted@host" 再误判为邮箱产生
 *   <<email>>；不整体排除 <，使尖括号引用形态 <user@host> 正常打码。
 * 已证伪不收录（勿加回）：IPv4（UA 版本号 Chrome/120.0.0.0 形态不可区分，
 * 误伤高频）、手机号（订单号误伤、错误文本出现概率趋零）、信用卡
 * （13 位毫秒时间戳 100% 命中，Luhn 校验也救不了）。
 */
const SANITIZE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 用户路径（/home/xx、/Users/xx、/root/xx、/etc/xx、C:\Users\xx）→ <path>
  // （排除冒号/分号等后缀分隔符，避免吞掉紧随其后的文本：`/home/x: EACCES` 应保留冒号）
  [/(?:\/home\/[^\s"'`<>:;]+|\/Users\/[^\s"'`<>:;]+|\/root\/[^\s"'`<>:;]+|\/etc\/[^\s"'`<>:;]+|C:\\Users\\[^\s"'`<>:;]+)/giu, "<path>"],
  // PEM 私钥完整块（RSA/EC/OPENSSH/ENCRYPTED…）→ <private-key>
  // 窗口上限 {0,4096}：真实私钥块 ≤ 数 KB；无窗口时每个 BEGIN 起点都会惰性扫到
  // 文本尾找 END，k 个 BEGIN 即 O(k·n)，1MB 高密度输入可阻塞宿主事件循环数秒
  // （评审实测）。超窗视为无 END，交由下一条孤立 BEGIN 兜底规则接住。
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z ]*PRIVATE KEY-----/g, "<private-key>"],
  // PEM 孤立 BEGIN 兜底：错误消息常只贴出头几行就被截断，无 END 行；
  // 吃到文本尾即可（尾部反正受 maxLen 截断）
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "<private-key>"],
  // 数据库/消息队列连接串凭据 → 只留 scheme://<redacted>@host
  // 用户名允许为空（redis://:pass@host 是最常见带密码形态）；i flag 兼容大写 scheme；
  // amqps?：AMQPS 同端口语义，漏收会产生「密码被邮箱规则侥幸掩掉、用户名明文残留」
  // 的半脱敏误导形态；jdbc 不收录：JDBC 凭据在 query 参数（?password=），密钥赋值规则已覆盖。
  // 已知局限（评审记录）：密码含 <>/引号等 URL 应编码字符时整条失配、明文残留——
  // 错误消息中的未编码形态不罕见，但放宽字符类会引入占位符/引号边界歧义，暂记录不改。
  [/\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql):\/\/([^\s:@\/"'`<>]*):([^\s@\/"'`<>]+)@/giu, "$1://<redacted>@"],
  // GitHub PAT classic（ghp/gho/ghu/ghs/ghr + 36 位字母数字；业界共识写死长度）
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/gu, "<token>"],
  // GitHub fine-grained PAT（github_pat_ 强前缀锚定，长度取区间吸收未来调整）
  [/\bgithub_pat_[A-Za-z0-9]{20,30}_[A-Za-z0-9]{50,80}\b/gu, "<token>"],
  // JWT（eyJ JWT：header.payload.signature 三段，base64url 字符集含 - _）→ <token>
  // 精确匹配三段（每段 ≥1 字符，含 - _），避免误伤普通长串（对抗评审建议：勿盲目放宽
  // 通用 base64 正则到 base64url，那会误伤 URL/长串）。
  [/\beyJ[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2}\b/gu, "<token>"],
  // AWS 访问密钥前缀（AKIA 20 字符，不满足通用 ≥24hex/≥32base64 阈值）→ <token>
  [/\bAKIA[A-Z0-9]{16}\b/gu, "<token>"],
  // 长令牌/密钥串（≥24 hex 或 ≥32 base64）→ <token>
  [/\b(?:[0-9a-fA-F]{24,}|[A-Za-z0-9+/]{32,}={0,2})\b/gu, "<token>"],
  // 密钥字段赋值（password=/token=/api_key=…）→ 只留键名+掩码
  // 分隔符 [=:] 必须显式：可选版会把 "token expired"/"password policy" 等自然语言
  // 高频误伤成 token=<redacted>（审批理由/提问文本接入后误伤面被放大，评审实测）
  [/\b(password|passwd|token|api[_-]?key|secret|authorization)\b\s*[=:]\s*["']?[^\s"'`,;<>]{3,}/giu, "$1=<redacted>"],
  // 邮箱（严格版：域名首标签须字母开头，排除 image@2x.png / pkg@1.2.3 误伤）→ <email>
  // 双负向后行断言：① 词字符——防止从占位符/单词中间起配；② 字面 <redacted
  // ——防止把 DSN 掩码占位符 <redacted>@host 再误判为邮箱产生 <<email>>。
  // 不整体排除 <：否则尖括号引用形态 <user@host> 整体漏网明文泄漏；
  // 占位符顺序约束由断言②单独保住。
  [/(?<![A-Za-z0-9._%+-])(?<!<redacted)[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}/gu, "<email>"],
];

/** SANITIZE_RULES 有序表循环——sanitizeErrorText 与 sanitizeNoticeContent 的
 *  唯一实现（两条出口脱敏结果同源，测试锁同样本输出一致）。 */
function sanitizeRules(text: string): string {
  let s = text;
  for (const [pattern, replacement] of SANITIZE_RULES) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

/**
 * 错误文本脱敏：按 SANITIZE_RULES 有序表掩蔽常见敏感特征（用户路径、私钥、
 * 连接串凭据、各类令牌、密钥赋值、邮箱），再截断。
 * 用于 agent/error 与审批理由/提问文本进入通知与历史前的处理，把「文本可能
 * 内嵌命令回显/路径/凭据片段」的外泄面收敛到可读的摘要。
 * @returns 脱敏并截断（默认 300 字符）后的错误文本。
 */
export function sanitizeErrorText(text: unknown, maxLen = 300): string {
  return sanitizeRules(String(text)).slice(0, maxLen);
}

/**
 * 通知脱敏统一入口（渲染完成后、任何落史/投递前调用一次，供 sendKind /
 * send 两入口复用；suppressed/merged 落史与投递三路径全部消费其结果）。
 * enabled=false（sanitizeContent=false）时标题与正文均原样 String 返回——
 * 通知与历史均明文；缺省/undefined 视同开启（开关容错：旧配置或未接线调用方
 * 不因缺键而静默明文，故参数类型含 undefined）。
 * title 走 sanitizeErrorText 显式短上限 64（模板拼接产物的展示语义上限；
 * 沿用既有 UTF-16 单元截断，码点安全切分留待复核）；body 只打码不截断——
 * 长度权威唯一 = 投递频道的 capabilities.maxBodyLen（deliver 视频道截断），
 * 此处截断会造成历史明文超长片段与双截断交错。
 * @returns { title, body } 均脱敏（enabled=false 时原样）后的字符串。
 */
export function sanitizeNoticeContent(
  notice: { title: unknown; body: unknown },
  enabled: boolean | undefined,
): { title: string; body: string } {
  if (enabled === false) {
    return { title: String(notice.title), body: String(notice.body) };
  }
  return { title: sanitizeErrorText(notice.title, 64), body: sanitizeRules(String(notice.body)) };
}
