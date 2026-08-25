/**
 * dsh-provider-usage — HTML 结构化净化（XSS 兜底）。
 *
 * 信任模型：用户自己的 format 函数返回的 HTML 是信任域，但流入其中的
 * 外部 API 数据不可信。本模块在宿主端渲染前做白名单式净化，作为结构性兜底
 * （用户 format 函数还应使用 esc() 助手进行自家数据的转义）。
 *
 * #105③ 实体感知双层净化：
 * - 第一层：既有明文形态黑名单（行为不变）；
 * - 第二层：对第一层输出做**一轮** HTML 实体解码得到「检测副本」，在副本上
 *   定位危险载体模式，命中后只从**原文**删除对应字节区间。
 *   安全不变量（结构性保证）：
 *   1. 输出恒为输入的子序列（纯删除）——解码副本绝不回写为输出，
 *      因此 `&amp;#106;avascript:` / `&lt;script&gt;` 等本已安全的实体文本
 *      不可能被"误解码"升级为危险明文；
 *   2. 第二层迭代至不动点（每轮要么无匹配终止、要么长度严格递减必终止，
 *      上限仅作防御），不动点谓词 = 解码一轮后不含任何危险载体模式，
 *      该谓词同时蕴含第一层模式不再命中 ⇒
 *      `sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x)` 幂等成立。
 */

// ---------------------------------------------------------------- 第一层：明文形态黑名单

const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/giu;
const EVENT_HANDLER_RE = /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;
const IFRAME_RE = /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/giu;
const FRAME_RE = /<frame\b[^>]*>[\s\S]*?<\/frame\s*>/giu;
const OBJECT_RE = /<object\b[^>]*>[\s\S]*?<\/object\s*>/giu;
const EMBED_RE = /<embed\b[^>]*>[\s\S]*?<\/embed\s*>/giu;
const META_RE = /<meta\b[^>]*>/giu;
const LINK_RE = /<link\b[^>]*>/giu;
const BASE_RE = /<base\b[^>]*>/giu;
const STYLE_ON_SCRIPT_RE = /expression\s*\(/giu;
const JAVASCRIPT_URI_RE = /\bjavascript\s*:/giu;
const DATA_TEXT_HTML_RE = /\bdata\s*:\s*text\/html/giu;

// ---------------------------------------------------------------- 第二层：实体感知

/**
 * 危险载体 token 级模式（在解码副本上匹配）。开/闭标签分开成对出现：
 * 实体化标签对（如 `&lt;script&gt;...&lt;/script&gt;`，浏览器渲染为纯文本）
 * 移除标签 token 后保留其间文本；真标签已在第一层整段移除。
 */
const DECODED_DANGER_RES: RegExp[] = [
  /<script\b[^>]*>/giu,
  /<\/script\s*>/giu,
  /<iframe\b[^>]*>/giu,
  /<\/iframe\s*>/giu,
  /<frame\b[^>]*>/giu,
  /<\/frame\s*>/giu,
  /<object\b[^>]*>/giu,
  /<\/object\s*>/giu,
  /<embed\b[^>]*>/giu,
  /<\/embed\s*>/giu,
  /<meta\b[^>]*>/giu,
  /<link\b[^>]*>/giu,
  /<base\b[^>]*>/giu,
  EVENT_HANDLER_RE,
  JAVASCRIPT_URI_RE,
  DATA_TEXT_HTML_RE,
  STYLE_ON_SCRIPT_RE,
];

/**
 * 具名实体表：只收编「解码产物为 ASCII 且可能参与危险载体构造」的条目。
 * 匹配大小写不敏感、分号可选——比 HTML5 更宽松属保守封堵方向；
 * 因解码副本只用于检测、不影响输出字节，宽松不会误伤合法内容。
 * （HTML5 无产出单个 ASCII 字母的具名实体，字母拼接变体由数字实体路径覆盖。）
 */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  colon: ":",
  semi: ";",
  equals: "=",
  sol: "/",
  bsol: "\\",
  num: "#",
  percnt: "%",
  quest: "?",
  excl: "!",
  commat: "@",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  lbrack: "[",
  rsqb: "]",
  rbrack: "]",
  lcub: "{",
  lbrace: "{",
  rcub: "}",
  rbrace: "}",
  lowbar: "_",
  underbar: "_",
  vert: "|",
  verbar: "|",
  verticalline: "|",
  period: ".",
  comma: ",",
  plus: "+",
  ast: "*",
  midast: "*",
  hat: "^",
  grave: "`",
  nbsp: "\u00a0",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  tab: "\t",
  newline: "\n",
};

const isDigit = (c: string) => c >= "0" && c <= "9";
const isHexDigit = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c: string) => isAlpha(c) || isDigit(c);

/** 一轮实体解码视图：decoded 每个 code unit 在原文中的 [start, end) 区间。 */
interface DecodedView {
  text: string;
  starts: number[];
  ends: number[];
}

/**
 * 对 html 做**恰好一轮**实体解码（模拟浏览器解析期行为），并记录每个
 * decoded code unit 的原文区间。解析规则刻意宽于 HTML5（保守封堵方向）：
 * - 数字实体：十进制/十六进制（x/X 前缀均可）、有无分号均解、前导零容忍；
 * - 具名实体：大小写不敏感、有无分号均解（qa 判据同款宽松语义）；
 * - 非法/未知形态按字面保留，不影响后续位置的独立解析。
 */
function decodeEntitiesOnce(html: string): DecodedView {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const pushCu = (cu: string, s: number, e: number) => {
    chars.push(cu);
    starts.push(s);
    ends.push(e);
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html[i] !== "&") {
      pushCu(html[i], i, i + 1);
      i++;
      continue;
    }
    const j = i + 1;
    // 数字实体 &#123; / &#x1F; / &#X1F;（分号可选）
    if (html[j] === "#") {
      const hex = html[j + 1] === "x" || html[j + 1] === "X";
      let k = j + (hex ? 2 : 1);
      const dStart = k;
      while (k < n && (hex ? isHexDigit(html[k]) : isDigit(html[k]))) k++;
      if (k > dStart) {
        const cp = parseInt(html.slice(dStart, k), hex ? 16 : 10);
        // HTML5 数值语义：0 / 代理区 / 超界映射 U+FFFD
        const safe =
          cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? cp : 0xfffd;
        let end = k;
        if (html[end] === ";") end++;
        for (const cu of String.fromCodePoint(safe)) pushCu(cu, i, end);
        i = end;
        continue;
      }
      pushCu("&", i, i + 1);
      i++;
      continue;
    }
    // 具名实体 &[a-zA-Z][a-zA-Z0-9]*（分号可选、大小写不敏感）
    if (isAlpha(html[j])) {
      let k = j + 1;
      while (k < n && isAlnum(html[k])) k++;
      const mapped = NAMED_ENTITIES[html.slice(j, k).toLowerCase()];
      if (mapped !== undefined) {
        let end = k;
        if (html[end] === ";") end++;
        pushCu(mapped, i, end);
        i = end;
        continue;
      }
    }
    pushCu("&", i, i + 1);
    i++;
  }
  return { text: chars.join(""), starts, ends };
}

/** 区间合并（按起点排序后吸收重叠/相邻）。 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r[0] <= last[1]) {
      if (r[1] > last[1]) last[1] = r[1];
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

/** 单轮实体感知封闭：解码副本上收集全部危险 match，映射回原文一次性删除。 */
function stripDecodedDanger(html: string): string {
  const view = decodeEntitiesOnce(html);
  const ranges: Array<[number, number]> = [];
  for (const re of DECODED_DANGER_RES) {
    re.lastIndex = 0;
    for (const m of view.text.matchAll(re)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (ranges.length === 0) return html;
  const cuts = mergeRanges(
    mergeRanges(ranges).map(([s, e]) => [view.starts[s], view.ends[e - 1]] as [number, number]),
  );
  let out = "";
  let pos = 0;
  for (const [s, e] of cuts) {
    out += html.slice(pos, s);
    pos = e;
  }
  return out + html.slice(pos);
}

/**
 * 白名单净化：移除脚本/事件处理器/危险元素，防御性净化用户 format HTML。
 *
 * 保持简单可靠（正则级）：我们的目标是移除 XSS 载体，而非完美 HTML 解析。
 * 后续如需更严格可换 DOMPurify（构建期 jsdom 不适用，保留正则方案）。
 */
export function sanitizeHtml(html: string): string {
  if (html === '') return '';
  // 1. 移除 script/frame/object/embed/meta/link/base 标签
  let out = html
    .replace(SCRIPT_TAG_RE, '')
    .replace(IFRAME_RE, '')
    .replace(FRAME_RE, '')
    .replace(OBJECT_RE, '')
    .replace(EMBED_RE, '')
    .replace(META_RE, '')
    .replace(LINK_RE, '')
    .replace(BASE_RE, '');
  // 2. 移除 on* 事件属性
  out = out.replace(EVENT_HANDLER_RE, '');
  // 3. 移除危险 URI 协议
  out = out
    .replace(JAVASCRIPT_URI_RE, '')
    .replace(DATA_TEXT_HTML_RE, '')
    .replace(STYLE_ON_SCRIPT_RE, '');
  // 4. 实体编码变体封闭（#105③）：迭代至不动点（上限纯防御；
  //    每轮要么无匹配终止、要么长度严格递减，正常输入 1-2 轮收敛）
  for (let round = 0; round < 16; round++) {
    const next = stripDecodedDanger(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
