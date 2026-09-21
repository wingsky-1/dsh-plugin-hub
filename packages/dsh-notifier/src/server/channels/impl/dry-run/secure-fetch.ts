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
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return failed("URL 解析失败");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return failed("仅允许 http(s)，拒绝 " + url.protocol);
    }
    if (url.username !== "" || url.password !== "") {
      return failed("URL 不得内嵌 userinfo（凭据只能走请求头）");
    }
    const pinned = await pinHost(url.hostname, dns);
    if (!pinned.ok) return failed(pinned.cause);
    let outcome: PinnedOutcome;
    try {
      outcome = await transport(url, pinned.ip, pinned.family, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        timeoutMs: init.timeoutMs,
      });
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : String(cause));
    }
    if (outcome.kind !== "redirect") {
      return { ok: true, status: outcome.status, body: outcome.body };
    }
    if (hop === MAX_REDIRECTS) return failed("重定向过多（超过 " + MAX_REDIRECTS + " 跳）");
    try {
      current = new URL(outcome.location, url).toString();
    } catch {
      return failed("重定向地址非法");
    }
  }
  return failed("重定向过多（超过 " + MAX_REDIRECTS + " 跳）");
}

function failed(cause: string): SecureFetchOutcome {
  return { ok: false, cause };
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
  if (parts.length < 1 || parts.length > 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    if (part === "") return undefined;
    let base = 10;
    let digits = part;
    if (part.startsWith("0x") || part.startsWith("0X")) {
      base = 16;
      digits = part.slice(2);
    } else if (part.length > 1 && part.startsWith("0")) {
      base = 8;
      digits = part.slice(1);
    }
    if (digits === "" || !/^[0-9a-fA-F]+$/.test(digits)) return undefined;
    if (base === 10 && /[^0-9]/.test(digits)) return undefined;
    if (base === 8 && /[^0-7]/.test(digits)) return undefined;
    const value = Number.parseInt(digits, base);
    if (!Number.isSafeInteger(value)) return undefined;
    values.push(value);
  }
  const full =
    values.length === 1
      ? values[0]
      : values.length === 2
        ? values[0] * 2 ** 24 + values[1]
        : values.length === 3
          ? values[0] * 2 ** 24 + values[1] * 2 ** 16 + values[2]
          : values[0] * 2 ** 24 + values[1] * 2 ** 16 + values[2] * 2 ** 8 + values[3];
  const limits = [0xffffffff, 0xffffff, 0xffff, 0xff];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] < 0 || values[index] > (limits[index] ?? 0xff)) return undefined;
  }
  if (full < 0 || full > 0xffffffff) return undefined;
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
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  const third = octets[2] ?? 0;
  if (first === 0) return "未指定地址（0.0.0.0/8）";
  if (first === 10) return "私网地址（10.0.0.0/8）";
  if (first === 172 && second >= 16 && second <= 31) return "私网地址（172.16.0.0/12）";
  if (first === 192 && second === 168) return "私网地址（192.168.0.0/16）";
  if (first === 100 && second >= 64 && second <= 127) return "运营商级 NAT 保留段（100.64.0.0/10）";
  if (first === 127) return "回环地址（127.0.0.0/8）";
  if (first === 169 && second === 254) return "链路本地地址（169.254.0.0/16，含云元数据地址）";
  if (first === 192 && second === 0 && (third === 0 || third === 2)) {
    return "IETF 保留段（192.0.0.0/24，含文档网段）";
  }
  if (first === 192 && second === 88 && third === 99)
    return "已退役的 6to4 中继段（192.88.99.0/24）";
  if (
    (first === 192 && second === 0 && third === 113) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return "文档保留段（TEST-NET，不可路由）";
  }
  if (first === 198 && (second === 18 || second === 19)) return "基准测试保留段（198.18.0.0/15）";
  if (first >= 224 && first <= 239) return "组播地址（224.0.0.0/4）";
  if (first >= 240) return "保留地址（240.0.0.0/4，含广播地址）";
  return undefined;
}

function v6BlockCause(words: readonly number[]): string | undefined {
  if (words.length !== 8) return "IPv6 解析失败";
  if (words.every((word) => word === 0)) return "未指定地址（::）";
  const headZero7 = words.slice(0, 7).every((word) => word === 0);
  if (headZero7 && words[7] === 1) return "回环地址（::1）";
  const headZero5 = words.slice(0, 5).every((word) => word === 0);
  if (headZero5 && words[5] === 0xffff) return v4BlockCause(innerV4(words));
  if (headZero5 && words[5] === 0) return v4BlockCause(innerV4(words));
  // 6to4 的 v4 藏在第 2~3 个字（2002:V4HIGH:V4LOW::/48），与映射/兼容的末 32 位不同布局。
  if (words[0] === 0x2002) return v4BlockCause(sixToFourInner(words));
  if (((words[0] ?? 0) & 0xffc0) === 0xfe80) return "链路本地地址（fe80::/10）";
  if (((words[0] ?? 0) & 0xfe00) === 0xfc00) return "唯一本地地址（fc00::/7）";
  if (((words[0] ?? 0) & 0xff00) === 0xff00) return "组播地址（ff00::/8）";
  if (words[0] === 0x2001 && words[1] === 0x0db8) return "文档保留段（2001:db8::/32）";
  if (words[0] === 0x2001 && words[1] === 0) return "Teredo 保留段（2001::/32）";
  return undefined;
}

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
  let head = text;
  const tailWords: number[] = [];
  if (text.includes(".")) {
    const at = text.lastIndexOf(":");
    if (at === -1) return undefined;
    const v4 = parseIpv4Loose(text.slice(at + 1));
    if (v4 === undefined) return undefined;
    tailWords.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
    head = text.slice(0, at);
    if (head.endsWith(":")) head = head.slice(0, -1);
    // 兼容形的头被剥到只剩空串（::10.0.0.1 → ""）：它就是全压缩的 ::，不能按无压缩解析。
    if (head === "") head = "::";
  }
  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  if (halves.length === 1) {
    const all = parseHextets(halves[0] ?? "");
    if (all === undefined || all.length !== 8 - tailWords.length) return undefined;
    return [...all, ...tailWords];
  }
  const left = parseHextets(halves[0] ?? "");
  const right = parseHextets(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - tailWords.length - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right, ...tailWords];
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
