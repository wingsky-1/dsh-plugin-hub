/**
 * dsh-notifier channels 域 —— dry-run 专用 SSRF 安全 fetch（提案 B4，仅此路径）。
 *
 * 已保存路径（sendBark / sendWebhook 的默认实现）保持全局 fetch 语义，一个字不改；
 * 草稿里的 URL 未经用户保存、可指向任意内网地址，故 dry-run 的出站必须过这一道硬闸：
 * - 只认 http/https，拒绝 userinfo（凭据拼进 URL 会留在对端访问日志里）；
 * - 字面量 IP 先按 inet_aton 语义展开（十进制/十六进制/八进制/缩写，一个都不能漏——
 *   漏一种就等于给那种写法开一条直达内网的旁路），再分类；
 * - 主机名经 DNS 全部解析（all:true），逐条分类，一条不公开即整单拒绝（fail-closed）；
 * - 重定向手动跟（redirect:manual），逐跳重解析复检，上限 5 跳；
 * - 建连时把核验过的 IP 钉进 lookup（不再二次解析，关 TOCTOU），连上后验 remoteAddress，
 *   对不上即熔断；TLS 的 SNI 与证书校验仍走原始主机名（只钉地址，不替身份）；
 * - 响应体至多读 16K（与 POST /test 的 BODY_LIMIT 同界，B4「模板头体积以 BODY_LIMIT 为界」
 *   的另一半：回显反射残留也只读这么多，出口再截 200 字符）；
 * - 超时由调用方按「复用出口 clamp 再压 15s 上限」传入，逐跳生效。
 *
 * 纯判定（parseIpLiteral / ipBlockCause）与 IO（DNS / 建连）分开：前者是无 IO 的纯函数，
 * 单测矩阵逐条覆盖反例；后者经 SecureFetchPorts 注入，单测用桩断言「坏地址建连前被拦下」。）
 */
import { promises as dnsPromises } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** DNS 单条应答（getaddrinfo 的原始形态）。 */
export interface DnsAnswer {
  readonly address: string;
  readonly family: number;
}

/** DNS 解析口：默认走系统 getaddrinfo，单测注入桩。 */
export interface SecureDns {
  resolveAll(hostname: string): Promise<DnsAnswer[]>;
}

/** 单跳建连入参（超时已由调用方 clamp，逐跳生效）。 */
export interface PinnedInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
}

/** 单跳结论：响应（状态 + 至多 16K 的正文）或重定向（只带 Location，不跟）。 */
export type PinnedOutcome =
  | { readonly kind: "response"; readonly status: number; readonly body: string }
  | { readonly kind: "redirect"; readonly location: string };

/** 建连口：默认是钉死 IP 的真实建连，单测注入桩。 */
export interface PinnedTransport {
  (url: URL, ip: string, family: 4 | 6, init: PinnedInit): Promise<PinnedOutcome>;
}

/** 安全 fetch 的注入面（两口都缺省即真实 DNS + 真实建连）。 */
export interface SecureFetchPorts {
  readonly dns?: SecureDns;
  readonly transport?: PinnedTransport;
}

/** 安全 fetch 的出站入参。 */
export interface SecureFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** 单跳超时（毫秒）：调用方已按「出口 clamp ∩ 15s 上限」算好，这里只执行。 */
  readonly timeoutMs: number;
}

/** 安全 fetch 结论：成功带状态与正文，失败只带一句话（调用方按出口 code 包装进 reason.detail）。 */
export type SecureFetchOutcome =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly cause: string };

/** 解析后的 IP 字面量（v4 按 inet_aton 展开成 4 个字节，v6 展开成 8 个 16 位字）。 */
export type ParsedIp =
  | {
      readonly family: 4;
      readonly octets: readonly [number, number, number, number];
      readonly text: string;
    }
  | { readonly family: 6; readonly words: readonly number[]; readonly text: string };

/** 重定向上限：逐跳都要重过整道闸，太多跳说明对端在带我们逛。 */
const MAX_REDIRECTS = 5;

/** 响应体读取上限（字节）：与 POST /test 的 BODY_LIMIT 同界，见模块头。 */
const RESPONSE_CAP = 16 * 1024;

/** 跟随的重定向状态码：只跟带 Location 的这五个，其余 3xx 按普通响应当（出口判非 2xx 失败）。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 安全 fetch：整单只做一次「解析—核验—建连—读数」的循环，重定向每跳重来一遍。
 * 302/303 也按 POST 原样重发（307/308 语义）：测试投递的 body 不能在跳转里丢，丢了等于
 * 「测的是 A、打的是 B 的空包」。上限 5 跳，超了即失败（不是静默停在最后一跳）。
 *
 * 母体只留编排：一跳之内做「URL 准入 → 主机钉死 → 建连 → 落地下一跳」四步，
 * 每步的判据各自成函数（urlGate / pinHost / dialPinned / redirectNext）。
 * 顺序即安全语义——URL 准入与主机核验都必须在建连之前完成，故四步不可调换。
 */
export async function secureFetch(
  input: string,
  init: SecureFetchInit,
  ports: SecureFetchPorts = {},
): Promise<SecureFetchOutcome> {
  const dns = ports.dns ?? defaultDns;
  const transport = ports.transport ?? realTransport;
  let current = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const admitted = urlGate(current);
    if (!admitted.ok) return failed(admitted.cause);
    const pinned = await pinHost(admitted.url.hostname, dns);
    if (!pinned.ok) return failed(pinned.cause);
    const dialed = await dialPinned(transport, admitted.url, pinned, init);
    if (!dialed.ok) return failed(dialed.cause);
    const landed = landHop(dialed.outcome, admitted.url, hop);
    if (landed.kind === "done") return landed.outcome;
    current = landed.url;
  }
  return failed(tooManyRedirects);
}

/** 一跳的落地：非重定向即终局；重定向交出下一跳地址（超限或非法即终局失败）。 */
type HopLanding =
  | { readonly kind: "done"; readonly outcome: SecureFetchOutcome }
  | { readonly kind: "next"; readonly url: string };

function landHop(outcome: PinnedOutcome, base: URL, hop: number): HopLanding {
  if (outcome.kind !== "redirect") {
    return { kind: "done", outcome: { ok: true, status: outcome.status, body: outcome.body } };
  }
  if (hop === MAX_REDIRECTS) return { kind: "done", outcome: failed(tooManyRedirects) };
  const next = redirectNext(outcome.location, base);
  return next === undefined
    ? { kind: "done", outcome: failed("重定向地址非法") }
    : { kind: "next", url: next };
}

/** 单跳 URL 准入结论：ok 侧带 URL，失败侧带一句原因。 */
type UrlGateResult =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly cause: string };

/** 单跳建连结论：ok 侧带传输层结论，失败侧带一句原因。 */
type DialResult =
  | { readonly ok: true; readonly outcome: PinnedOutcome }
  | { readonly ok: false; readonly cause: string };

/** 超限文案单点（两处出口共用，措辞不得分叉）。 */
const tooManyRedirects = "重定向过多（超过 " + MAX_REDIRECTS + " 跳）";

function failed(cause: string): SecureFetchOutcome {
  return { ok: false, cause };
}

/**
 * 单跳的 URL 硬闸：解析失败 / 非 http(s) / 内嵌 userinfo，三条各自给原文案。
 * 三条判据的先后即安全语义：协议未过就不必看 userinfo，而解析未过则后两条无从判断。
 */
function urlGate(current: string): UrlGateResult {
  let url: URL;
  try {
    url = new URL(current);
  } catch {
    return { ok: false, cause: "URL 解析失败" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, cause: "仅允许 http(s)，拒绝 " + url.protocol };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, cause: "URL 不得内嵌 userinfo（凭据只能走请求头）" };
  }
  return { ok: true, url };
}

/** 抛出的建连原因归一成一句话（非 Error 的抛值走 String）。 */
function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 单跳建连：把入参铺成 PinnedInit 再钉死建连，抛错归一成失败侧。 */
async function dialPinned(
  transport: PinnedTransport,
  url: URL,
  pinned: { readonly ip: string; readonly family: 4 | 6 },
  init: SecureFetchInit,
): Promise<DialResult> {
  try {
    const outcome = await transport(url, pinned.ip, pinned.family, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeoutMs: init.timeoutMs,
    });
    return { ok: true, outcome };
  } catch (cause) {
    return { ok: false, cause: causeText(cause) };
  }
}

/** 下一跳地址：相对 Location 按本跳 URL 解析，解析不了即 undefined。 */
function redirectNext(location: string, base: URL): string | undefined {
  try {
    return new URL(location, base).toString();
  } catch {
    return undefined;
  }
}

/** 默认 DNS：系统 getaddrinfo 全量解析（只取地址，不做任何过滤——过滤是分类器的事）。 */
const defaultDns: SecureDns = {
  resolveAll: (hostname) => dnsPromises.lookup(hostname, { all: true }),
};

/**
 * 主机名 → 可建连的 IP（已核验）：字面量直接分类，主机名全量解析后逐条分类。
 * 任一条不公开即整单拒绝——「有一条能连」不等于「连的 assault 那条公开」，解析与建连之间
 * 没有复检窗口：返回的 ip 即建连钉死的地址（见 realTransport 的 lookup）。
 */
async function pinHost(
  hostname: string,
  dns: SecureDns,
): Promise<{ ok: true; ip: string; family: 4 | 6 } | { ok: false; cause: string }> {
  const literal = parseIpLiteral(hostname);
  if (literal !== undefined) {
    const cause = ipBlockCause(literal);
    return cause === undefined
      ? { ok: true, ip: literal.text, family: literal.family }
      : { ok: false, cause };
  }
  let answers: DnsAnswer[];
  try {
    answers = await dns.resolveAll(hostname);
  } catch {
    return { ok: false, cause: "DNS 解析失败：" + hostname };
  }
  if (answers.length === 0) return { ok: false, cause: "DNS 无解析结果：" + hostname };
  for (const answer of answers) {
    const parsed = parseIpLiteral(answer.address);
    const cause =
      parsed === undefined ? "DNS 返回非法地址：" + answer.address : ipBlockCause(parsed);
    if (cause !== undefined) {
      return { ok: false, cause: "DNS 命中非公开地址（" + cause + "），整单拒绝" };
    }
  }
  const first = answers[0];
  return { ok: true, ip: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * IP 字面量解析：先按 inet_aton 语义试 v4（十进制/八进制/十六进制/1~4 段缩写全认——
 * getaddrinfo 全认，少认一种就等于给那种写法开旁路），再试标准 v6。都不是即不是字面量
 * （调用方走 DNS）。FQDN 尾点先剥掉：解析器认它，分类器不能因为多个点就认不出回环。
 */
export function parseIpLiteral(text: string): ParsedIp | undefined {
  const stripped = text.trim().replace(/\.$/, "");
  const v4 = parseIpv4Loose(stripped);
  if (v4 !== undefined) return { family: 4, octets: v4, text: v4.join(".") };
  const noBracket =
    stripped.startsWith("[") && stripped.endsWith("]") ? stripped.slice(1, -1) : stripped;
  if (isIP(noBracket) !== 6) return undefined;
  const words = expandIpv6(noBracket.toLowerCase());
  if (words === undefined) return undefined;
  return { family: 6, words, text: noBracket.toLowerCase() };
}

/**
 * inet_aton 语义的 v4 解析：每段按前缀定基数（0x 十六、首 0 八进制、其余十进制），
 * 段数决定拼法（1 段 32 位、2 段 8+24、3 段 8+8+16、4 段逐字节），越界即非法。
 * 与系统解析器同语义是安全要求，不是兼容癖好：两边对「2130706433 是不是 127.0.0.1」
 * 给出不同答案的那一刻，分类器就被绕过了。
 */
function parseIpv4Loose(text: string): [number, number, number, number] | undefined {
  if (text === "" || text.includes(":")) return undefined;
  const parts = text.split(".");
  if (parts.length < 1 || parts.length > IPV4_MAX_PARTS) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    const value = decodeIpv4Part(part);
    if (value === undefined) return undefined;
    values.push(value);
  }
  if (ipV4PartOverflows(values)) return undefined;
  const full = assembleIpv4(values);
  if (full < 0 || full > 0xffffffff) return undefined;
  return ipv4Bytes(full);
}

/** v4 段数上限（inet_aton 最多四段）。 */
const IPV4_MAX_PARTS = 4;

/** 基数：inet_aton 的三种前缀写法。 */
type Ipv4Base = 8 | 10 | 16;

/**
 * 各基数的合法字符集：十六进制收全部十六进制数字，十进制/八进制各收窄到自己的数字。
 * 键即基数（Ipv4Base），故查表不需兜底分支——新增基数会在这里编译期报错。
 */
const IPV4_BASE_PATTERNS: { readonly [base in Ipv4Base]: RegExp } = {
  8: /^[0-7]+$/,
  10: /^[0-9]+$/,
  16: /^[0-9a-fA-F]+$/,
};

/** 各段上限（1 段 32 位、2 段 24 位、3 段 16 位、4 段 8 位），按段序索引。 */
const IPV4_PART_LIMITS: readonly number[] = [0xffffffff, 0xffffff, 0xffff, 0xff];

/** 段序 → 该段（末段除外）占的位宽：末段吃掉剩余全部位，故不进表。 */
const IPV4_LEADING_SHIFTS: readonly number[] = [24, 16, 8];

/** 段的前缀定基数：0x 十六进制、首 0 八进制、其余十进制，并剥掉前缀。 */
function ipv4PartBase(part: string): { readonly base: Ipv4Base; readonly digits: string } {
  if (part.startsWith("0x") || part.startsWith("0X")) {
    return { base: 16, digits: part.slice(2) };
  }
  if (part.length > 1 && part.startsWith("0")) {
    return { base: 8, digits: part.slice(1) };
  }
  return { base: 10, digits: part };
}

/** 单段解码：空段、字符集越出该基数、数字超出安全整数，三者任一即非法。 */
function decodeIpv4Part(part: string): number | undefined {
  if (part === "") return undefined;
  const { base, digits } = ipv4PartBase(part);
  if (digits === "") return undefined;
  if (!IPV4_BASE_PATTERNS[base].test(digits)) return undefined;
  const value = Number.parseInt(digits, base);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** 逐段越界：第 i 段不得为负、不得越过 IPV4_PART_LIMITS[i]。 */
function ipV4PartOverflows(values: readonly number[]): boolean {
  return values.some((value, index) => value < 0 || value > (IPV4_PART_LIMITS[index] ?? 0xff));
}

/** 按段数拼成 32 位值：前 n-1 段各占 IPV4_LEADING_SHIFTS[i] 位，末段吃掉剩余全部位。 */
function assembleIpv4(values: readonly number[]): number {
  const last = values.length - 1;
  let full = 0;
  for (let index = 0; index < last; index += 1) {
    full += (values[index] ?? 0) * 2 ** (IPV4_LEADING_SHIFTS[index] ?? 0);
  }
  return full + (values[last] ?? 0);
}

/** 32 位值拆成四个字节（各取 8 位，取模去掉进位余量）。 */
function ipv4Bytes(full: number): [number, number, number, number] {
  return [
    Math.floor(full / 2 ** 24) % 256,
    Math.floor(full / 2 ** 16) % 256,
    Math.floor(full / 2 ** 8) % 256,
    full % 256,
  ];
}

/**
 * IP 分类：返回阻断原因，是 undefined 即公开可连。v4 按字节判，v6 按 16 位字判
 * （三类内嵌 v4——映射/兼容/6to4——拆包后按内层判：外层全球可达不代表内层也是）。
 *
 * 未逐项注释「为什么是这个前缀」：前缀与掩码即判据本身，注释复述一遍只是第二份事实源；
 * 每个分支的文案带前缀写法，改前缀时文案与判据在同一行一起改。
 */
export function ipBlockCause(parsed: ParsedIp): string | undefined {
  if (parsed.family === 4) return v4BlockCause(parsed.octets);
  return v6BlockCause(parsed.words);
}

function v4BlockCause(octets: readonly [number, number, number, number]): string | undefined {
  return V4_BLOCK_RULES.find((rule) => covers(rule, ipv4Value(octets)))?.cause;
}

/** 一条 v4 阻断规则：CIDR 的 prefix 与 mask，加阻断文案。 */
interface V4BlockRule {
  readonly prefix: number;
  readonly mask: number;
  readonly cause: string;
}

/**
 * v4 阻断规则表，**表序即原判据的 if 顺序**，逐条照搬不得重排：顺序变了，命中哪条文案
 * 就变了。**192.0.0.0/24 与 192.0.2.0/24 是两段、共用同一条 IETF 文案**——原判据写的是
 * `first === 192 && second === 0 && (third === 0 || third === 2)`，只比较前三个字节，
 * 故 third===2 命中的是 192.0.2.0/24 整段（不是 192.0.0.2/32）。第一次改写时误读成
 * /32，被 secure-fetch.test.ts 的 `192.0.2.1 → IETF 保留段` 抓出。**改这张表前先看这句。**
 * 写成前缀/掩码而不是逐字节的 if 链，是因为前缀与掩码就是判据本身；写成 if 链时
 * 「同文案的几条规则挤在一个条件里」，加一条保留段就得回去数「哪个字节参与比较」。
 */
const V4_BLOCK_RULES: readonly V4BlockRule[] = [
  { prefix: 0x00000000, mask: 0xff000000, cause: "未指定地址（0.0.0.0/8）" },
  { prefix: 0x0a000000, mask: 0xff000000, cause: "私网地址（10.0.0.0/8）" },
  { prefix: 0xac100000, mask: 0xfff00000, cause: "私网地址（172.16.0.0/12）" },
  { prefix: 0xc0a80000, mask: 0xffff0000, cause: "私网地址（192.168.0.0/16）" },
  { prefix: 0x64400000, mask: 0xffc00000, cause: "运营商级 NAT 保留段（100.64.0.0/10）" },
  { prefix: 0x7f000000, mask: 0xff000000, cause: "回环地址（127.0.0.0/8）" },
  {
    prefix: 0xa9fe0000,
    mask: 0xffff0000,
    cause: "链路本地地址（169.254.0.0/16，含云元数据地址）",
  },
  {
    prefix: 0xc0000000,
    mask: 0xffffff00,
    cause: "IETF 保留段（192.0.0.0/24，含文档网段）",
  },
  { prefix: 0xc0000200, mask: 0xffffff00, cause: "IETF 保留段（192.0.0.0/24，含文档网段）" },
  { prefix: 0xc0586300, mask: 0xffffff00, cause: "已退役的 6to4 中继段（192.88.99.0/24）" },
  { prefix: 0xc0007100, mask: 0xffffff00, cause: "文档保留段（TEST-NET，不可路由）" },
  { prefix: 0xc6336400, mask: 0xffffff00, cause: "文档保留段（TEST-NET，不可路由）" },
  { prefix: 0xcb007100, mask: 0xffffff00, cause: "文档保留段（TEST-NET，不可路由）" },
  { prefix: 0xc6120000, mask: 0xfffe0000, cause: "基准测试保留段（198.18.0.0/15）" },
  { prefix: 0xe0000000, mask: 0xf0000000, cause: "组播地址（224.0.0.0/4）" },
  { prefix: 0xf0000000, mask: 0xf0000000, cause: "保留地址（240.0.0.0/4，含广播地址）" },
];

/** 一条前缀规则是否覆盖给定 32 位值（mask 两侧都归一到无符号再比）。 */
function covers(rule: { readonly prefix: number; readonly mask: number }, value: number): boolean {
  return (value & rule.mask) >>> 0 === rule.prefix >>> 0;
}

/** 四个字节拼成 32 位值（各字节 0~255，恒非负，无符号归一即可）。 */
function ipv4Value(octets: readonly [number, number, number, number]): number {
  const [first = 0, second = 0, third = 0, fourth = 0] = octets;
  return first * 2 ** 24 + second * 2 ** 16 + third * 2 ** 8 + fourth;
}

function v6BlockCause(words: readonly number[]): string | undefined {
  if (words.length !== 8) return "IPv6 解析失败";
  return v6WholeAddressCause(words) ?? v6EmbeddedV4Cause(words) ?? v6PrefixCause(words);
}

/** 整地址就两个特殊值（:: 与 ::1）：八个字逐字比对。 */
function v6WholeAddressCause(words: readonly number[]): string | undefined {
  return V6_WHOLE_ADDRESS_CAUSES.find((entry) =>
    words.every((word, index) => word === entry.words[index]),
  )?.cause;
}

/**
 * 内嵌 v4 的三种布局：命中即把内层 v4 交 v4 判据（外层全球可达不代表内层也是）；
 * 内层 v4 若公开，此处返回 undefined 放行，继续问前缀段。
 */
function v6EmbeddedV4Cause(words: readonly number[]): string | undefined {
  const headZero5 = words.slice(0, 5).every((word) => word === 0);
  if (headZero5 && (words[5] === 0xffff || words[5] === 0)) return v4BlockCause(innerV4(words));
  // 6to4 的 v4 藏在第 2~3 个字（2002:V4HIGH:V4LOW::/48），与映射/兼容的末 32 位不同布局。
  if (words[0] === 0x2002) return v4BlockCause(sixToFourInner(words));
  return undefined;
}

/** 首 32 位的前缀段：按表序取首条命中。 */
function v6PrefixCause(words: readonly number[]): string | undefined {
  const head32 = ((words[0] ?? 0) * 2 ** 16 + (words[1] ?? 0)) >>> 0;
  return V6_PREFIX_RULES.find((rule) => covers(rule, head32))?.cause;
}

/** 整地址特殊值：八个字逐字比对，命中即给文案。 */
interface V6WholeAddress {
  readonly words: readonly [number, number, number, number, number, number, number, number];
  readonly cause: string;
}

/** 整地址特殊值表（表序即 :: 先于 ::1）。 */
const V6_WHOLE_ADDRESS_CAUSES: readonly V6WholeAddress[] = [
  { words: [0, 0, 0, 0, 0, 0, 0, 0], cause: "未指定地址（::）" },
  { words: [0, 0, 0, 0, 0, 0, 0, 1], cause: "回环地址（::1）" },
];

/** 一条 v6 首 32 位前缀规则：prefix 与 mask 加阻断文案。 */
interface V6PrefixRule {
  readonly prefix: number;
  readonly mask: number;
  readonly cause: string;
}

/**
 * v6 首 32 位前缀段表，**表序即原判据的 if 顺序**（fe80 → fc00 → ff00 → 2001:db8 → 2001）。
 * 末两条在原文案里比的是 (words[0], words[1]) 两个字，等价于 32 位整比。
 */
const V6_PREFIX_RULES: readonly V6PrefixRule[] = [
  { prefix: 0xfe800000, mask: 0xffc00000, cause: "链路本地地址（fe80::/10）" },
  { prefix: 0xfc000000, mask: 0xfe000000, cause: "唯一本地地址（fc00::/7）" },
  { prefix: 0xff000000, mask: 0xff000000, cause: "组播地址（ff00::/8）" },
  { prefix: 0x20010db8, mask: 0xffffffff, cause: "文档保留段（2001:db8::/32）" },
  { prefix: 0x20010000, mask: 0xffffffff, cause: "Teredo 保留段（2001::/32）" },
];

/** 内嵌 v4 的末 32 位：映射/兼容两支共用，调用前已确认布局。 */
function sixToFourInner(words: readonly number[]): [number, number, number, number] {
  const high = words[1] ?? 0;
  const low = words[2] ?? 0;
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
}

/** 内嵌 v4 的末 32 位：映射/兼容两支共用，调用前已确认布局。 */
function innerV4(words: readonly number[]): [number, number, number, number] {
  const high = words[6] ?? 0;
  const low = words[7] ?? 0;
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
}

/**
 * v6 文本展开成 8 个字：点分十进制尾（::ffff:1.2.3.4）先按 v4 收成两个字，
 * 剩下的头按 :: 切开补零。非法即 undefined（调用方按「不是字面量」走 DNS）。
 */
function expandIpv6(text: string): number[] | undefined {
  const split = splitIpv6Tail(text);
  if (split === undefined) return undefined;
  const halves = split.head.split("::");
  if (halves.length > 2) return undefined;
  return halves.length === 1
    ? expandIpv6Full(halves[0] ?? "", split.tailWords)
    : expandIpv6Compressed(halves[0] ?? "", halves[1] ?? "", split.tailWords);
}

/** 点分十进制尾（::ffff:1.2.3.4）：收成两个字并交回剥好的头；无点分即原样返回。 */
function splitIpv6Tail(text: string): { head: string; tailWords: number[] } | undefined {
  if (!text.includes(".")) return { head: text, tailWords: [] };
  const at = text.lastIndexOf(":");
  if (at === -1) return undefined;
  const v4 = parseIpv4Loose(text.slice(at + 1));
  if (v4 === undefined) return undefined;
  let head = text.slice(0, at);
  if (head.endsWith(":")) head = head.slice(0, -1);
  // 兼容形的头被剥到只剩空串（::10.0.0.1 → ""）：它就是全压缩的 ::，不能按无压缩解析。
  if (head === "") head = "::";
  return { head, tailWords: [v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]] };
}

/** 无压缩形：必须有 :: 且总字数恰好补齐 8 个字。 */
function expandIpv6Full(group: string, tailWords: readonly number[]): number[] | undefined {
  const all = parseHextets(group);
  if (all === undefined || all.length !== 8 - tailWords.length) return undefined;
  return [...all, ...tailWords];
}

/** 压缩形：:: 至少要吃掉一个字（missing < 1 即两侧已写满或超满）。 */
function expandIpv6Compressed(
  left: string,
  right: string,
  tailWords: readonly number[],
): number[] | undefined {
  const head = parseHextets(left);
  const tail = parseHextets(right);
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - tailWords.length - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail, ...tailWords];
}

function parseHextets(group: string): number[] | undefined {
  if (group === "") return [];
  const out: number[] = [];
  for (const part of group.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

/**
 * 钉死建连：lookup 回调直接交出核验过的 IP（不再二次解析，关 TOCTOU），连上后验
 * remoteAddress（防 lookup 与建连之间地址被换），TLS 的 SNI 与证书校验仍走原始主机名
 * （只钉地址，不替身份——钉身份等于自签信任）。响应体按 RESPONSE_CAP 截流，3xx 只读
 * Location 不跟（跟不跟由外层循环逐跳复检后决定）。
 */
/**
 * 真实钉死建连（realTransport 的本体）：导出给单测直测传输层——对回环起真实建连，
 * 全程离线（不断言公网）。生产路径经 SecureFetchPorts.transport 默认值走同一条。
 */
export function realTransport(
  url: URL,
  ip: string,
  family: 4 | 6,
  init: PinnedInit,
): Promise<PinnedOutcome> {
  return new Promise<PinnedOutcome>((resolve, reject) => {
    let settled = false;
    const settleResolve = (outcome: PinnedOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const settleReject = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        lookup: (_host, _options, callback) => callback(null, ip, family),
      },
      (res) => {
        const location = res.headers.location;
        if (
          typeof res.statusCode === "number" &&
          REDIRECT_STATUS.has(res.statusCode) &&
          typeof location === "string"
        ) {
          res.resume();
          settleResolve({ kind: "redirect", location });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size >= RESPONSE_CAP) return;
          // 超界的块只留前 room 个字节：整块丢弃会让一次大响应读成空串（32K 单块实测）。
          const room = RESPONSE_CAP - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += chunk.length;
          if (size >= RESPONSE_CAP) {
            // 到界即按已有前缀结算并掐流：不再等 end（destroy 后它不会来）。
            settleResolve({
              kind: "response",
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            req.destroy();
          }
        });
        res.on("end", () =>
          settleResolve({
            kind: "response",
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", settleReject);
      },
    );
    // socket 事件只代表「套接字已分配」，remoteAddress 在连上之前是空串——空串即熔断会把
    // 每一次建连都误杀。空时挂一次 connect 再验（单线程内无竞态：事件不可能插在本次
    // handler 中间触发）；https 另挂 secureConnect，哪个先到都只做同一件事（verify 幂等）。
    req.on("socket", (socket) => {
      const verify = (): void => {
        const remote = socket.remoteAddress ?? "";
        if (remote === "") return;
        if (!sameEndpoint(remote, ip)) {
          settleReject(
            new Error("对端地址与核验地址不一致，已熔断（remoteAddress=" + remote + "）"),
          );
          req.destroy();
        }
      };
      if ((socket.remoteAddress ?? "") === "") {
        socket.once("connect", verify);
        socket.once("secureConnect", verify);
      } else {
        verify();
      }
    });
    req.on("timeout", () => {
      settleReject(new Error("请求超时（" + init.timeoutMs + "ms）"));
      req.destroy();
    });
    req.on("error", settleReject);
    req.setTimeout(init.timeoutMs);
    req.end(init.body);
  });
}

/** 建连端点比对：大小写/括号归一，v4 映射（::ffff:1.2.3.4）视同其内层 v4。 */
function sameEndpoint(remote: string, expected: string): boolean {
  const left = remote
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const right = expected
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (left === right) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(left);
  return mapped !== null && mapped[1] === right;
}
