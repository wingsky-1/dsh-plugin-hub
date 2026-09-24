#!/usr/bin/env node
"use strict";
/**
 * upstream-contract-warn — 上游消解 warn-job（只 warn 不阻塞，独立 job 步骤）。
 *
 * 动因：本仓消费的上游宿主面随 dsh rc 升级漂移，漂移的失败形态是静默的，故每轮把
 * A 侧派生（本仓实际用了什么）与 B 侧基线（上游实际给了什么）对账，只打印 warn，
 * 不以退出码阻塞合并。不并入 contract，不进本地档位；执行点是 ci.yml 的独立
 * upstream-warn job（repo-gate 不聚合它）。
 *
 * A 侧 AST 派生（esbuild 剥类型加 acorn 加 sourcemap 回映原文行；注释不计数）：
 * 范围为各包 src 与仓库根 shared（含 .js，排除 .d.ts 与 .test.；test、docs、
 * archive 不进范围）。A2 取 ctx.get、ctx.inject 数组元、ctx.provide 第一参的字面量
 * 加同文件 const 单跳（多跳、跨文件、重赋值不跟）；sdkApi 命名空间成员为祝福常量
 * （自家定义，不对 B 断言；其余参数透传等记 forwarding，不进 S1）。A3 取事件动词
 * 第一参的字面量加单跳，非字面非单跳记 S1 动态。A4 取 ctx.svc.method 直接调用
 * （service 已定型才断言方法）。每条带 site。export const inject 数组只记 inventory。
 * B 侧 .d.ts 闭包（文本结构解析）：resolved 基线须与 catalog 锁版一致（B 恒 lock；
 * 同名多版本、版本漂移、cordis 不可解析即 exit 2；同名同版本多 peer 取并集）；自 types
 * 入口沿相对引用 BFS（export 星展开、循环截断、.ts 后缀归一、裸 side-effect import、计算键不透明），收成员名
 * （不比签名）与 declare module 块；另收仓内 src 的 declare module 字面量键。
 * 跳过计数：S1 超 DYN_BASE 即 FAIL；S2 超 UNTRACKED_BASE 或出新名即 FAIL；S3 须为零。
 * 断言（warn 注记）：R1 服务、R2-cordis 事件、R4-lite 方法存在性。
 * R2-cordis 之名是简称，实为 B 侧全集（cordis 骨架加全部上游声明加仓内 declare module 增补）
 * 上的事件存在性断言，非仅 cordis 单包。
 * 基线更新规则：改数须先更新 KNOWN_TRACKING 源码注释指针并连续三轮 runs 顺延稳定才可上调；
 * 跟踪以注释指针为唯一载体，不开 issue。
 * DYN_BASE 为 1，UNTRACKED_BASE 为 7（首轮实测校准：v2 估计为 1，实测 7 名逐项核过
 * peers 无类型声明，见 KNOWN_TRACKING；超 7 或出新名即 FAIL），KNOWN 为 7 名。
 * C1：ctx.on 字面量实得 20（19 + lan-proxy apply.ts:443 document-updated 显式订阅，
 * #1011 热更新面），v2 称 18 系行扫描漏计 provider 多行调用的 internal/service。
 * 出口：通过或 FAIL 一律 exit 0；范围、管线、基线三处结构与环境异常经 gate-exit failClosed。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import * as acorn from "acorn";
import { SourceMap } from "node:module";
import { failClosed } from "../lib/gate-exit.mjs";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DYN_BASE = 1;
const UNTRACKED_BASE = 7;
const KNOWN_UNTRACKED = [
  "attachments",
  "configForms",
  "connection",
  "loader",
  "locale",
  "sessionPersistence",
  "slots",
];
const TRACKING_ANCHOR = "首轮实测校准（7 名逐名跟踪见 KNOWN_TRACKING；超 7 或出新名即 FAIL）";
const KNOWN_TRACKING = {
  loader:
    "packages/dsh-mcp-manager/src/server/shared/compose.ts 注释：loader 类型不进 catalog，只认运行时 import 方法",
  attachments:
    "packages/dsh-mcp-manager/src/server/shared/host-faces.ts 注释：附件库晚读，服务可能缺席，peers 无类型声明",
  configForms:
    "packages/dsh-lan-proxy/src/client/index.ts、packages/dsh-mcp-manager/src/client/index.ts：客户端 settings configForms 可选注入面，peers 无类型声明",
  connection:
    "packages/dsh-lan-proxy/src/server/apply.ts 注释：官方 connection 服务，对等包未安装，typeof 守卫可选注入",
  locale: "客户端可选服务（宿主核心提供，if 守卫，peers 无类型声明）：3 处客户端消费点",
  slots: "客户端可选服务（宿主核心提供，if 守卫，peers 无类型声明）：4 包 client/index 共 4 处",
  sessionPersistence:
    "packages/dsh-worktree-sidebar/src/index.ts 注释：官方持久会话面可选，未提供回 undefined，peers 无类型声明",
};
const EVENT_VERBS = ["on", "once", "emit", "parallel", "serial", "waterfall", "bail"];
const FRAMEWORK_ONLY = new Set(["get", "provide", "inject", "effect", "plugin"]);

function toPosix(p) {
  return p.split(sep).join("/");
}

function relPosix(root, abs) {
  return toPosix(relative(root, abs));
}

function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? "").join("");
  }
  return null;
}

function staticProp(member) {
  if (member.computed) {
    if (member.property.type === "Literal" && typeof member.property.value === "string") {
      return member.property.value;
    }
    return null;
  }
  return member.property.name ?? null;
}

function blessedShape(node) {
  if (!node || node.type !== "MemberExpression") return null;
  const parts = [];
  let cur = node;
  while (cur.type === "MemberExpression") {
    const p = staticProp(cur);
    if (p === null) return null;
    parts.unshift(p);
    cur = cur.object;
  }
  if (cur.type !== "Identifier" || cur.name !== "sdkApi") return null;
  return "sdkApi." + parts.join(".");
}

function discoverASources(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(f);
      } else if (
        /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) &&
        !e.name.endsWith(".d.ts") &&
        !e.name.includes(".test.")
      ) {
        out.push(f);
      }
    }
  };
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) return null;
  for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const src = join(packagesDir, e.name, "src");
    if (existsSync(src) && statSync(src).isDirectory()) walk(src);
  }
  const shared = join(root, "shared");
  if (existsSync(shared) && statSync(shared).isDirectory()) walk(shared);
  return out.sort();
}

export function collectFileConsts(ast) {
  const inits = new Map();
  const dirtied = new Set();
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier") continue;
        if (!inits.has(d.id.name)) inits.set(d.id.name, []);
        inits.get(d.id.name).push(staticString(d.init));
      }
    }
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier")
      dirtied.add(node.left.name);
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier")
      dirtied.add(node.argument.name);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === "string") walk(c);
      } else if (child && typeof child.type === "string") walk(child);
    }
  })(ast);
  const clean = new Map();
  const nonliteral = new Set();
  for (const [name, list] of inits) {
    if (list.length === 1 && list[0] !== null && !dirtied.has(name)) clean.set(name, list[0]);
    else if (list.length > 0) nonliteral.add(name);
  }
  return { clean, nonliteral };
}

function atNode(node) {
  return {
    generatedLine: node.loc.start.line - 1,
    generatedColumn: node.loc.start.column,
  };
}

function hopServiceOf(node, clean, nonliteral) {
  const lit = staticString(node);
  if (lit !== null) return { kind: "literal", name: lit };
  if (node.type === "Identifier" && clean.has(node.name))
    return { kind: "hop", name: clean.get(node.name) };
  if (node.type === "Identifier" && nonliteral.has(node.name)) return { kind: "cascade" };
  const b = blessedShape(node);
  if (b !== null) return { kind: "blessed", name: b };
  if (node.type === "Identifier") return { kind: "forwarding", why: "parameter-or-dynamic" };
  return { kind: "dynamic", why: node.type };
}

function pushServiceInto(acc, node, verb, r) {
  if (r.kind === "literal" || r.kind === "hop")
    acc.services.push({ ...atNode(node), verb, name: r.name, via: r.kind });
  else if (r.kind === "blessed") acc.blessed.push({ ...atNode(node), verb, name: r.name });
  else if (r.kind === "cascade") acc.cascades.push({ ...atNode(node), verb });
  else acc.forwarding.push({ ...atNode(node), verb, why: r.why ?? r.kind });
}

function visitAConst(node, acc, hop) {
  if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
  for (const d of node.declarations) {
    if (d.id.type !== "Identifier") continue;
    if (/SERVICE/.test(d.id.name)) {
      const v = staticString(d.init);
      if (v !== null) acc.blessedValues.add(v);
    }
    if (d.id.name === "inject" && d.init && d.init.type === "ArrayExpression") {
      const names = [];
      for (const el of d.init.elements) {
        if (!el) continue;
        const r = hop(el);
        if (r.kind === "literal" || r.kind === "hop") names.push(r.name);
      }
      acc.injectArrays.push({ ...atNode(d.id), names });
    }
  }
}

function visitAService(node, acc, cx) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return false;
  const recv = node.callee.object;
  const prop = staticProp(node.callee);
  if (recv.type !== "Identifier" || recv.name !== "ctx" || prop === null) return false;
  if (prop !== "get" && prop !== "provide" && prop !== "inject") return false;
  if (prop === "inject" && (!node.arguments[0] || node.arguments[0].type !== "ArrayExpression"))
    return true;
  if (prop === "get" || prop === "provide") {
    const r = cx.hop(node.arguments[0]);
    pushServiceInto(acc, node, prop, r);
    if (prop === "provide" && (r.kind === "literal" || r.kind === "hop")) {
      acc.provides.push({ ...atNode(node), name: r.name, via: r.kind });
    }
    return true;
  }
  for (const el of node.arguments[0].elements) {
    if (!el || el.type === "SpreadElement") {
      acc.forwarding.push({ ...atNode(node), verb: "inject", why: "spread" });
      continue;
    }
    pushServiceInto(acc, node, "inject", cx.hop(el));
  }
  return true;
}

function visitAEvent(node, acc, cx) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
  const recv = node.callee.object;
  const prop = staticProp(node.callee);
  if (recv.type !== "Identifier" || recv.name !== "ctx" || prop === null) return;
  if (!EVENT_VERBS.includes(prop)) return;
  const first = node.arguments[0];
  const lit = staticString(first);
  if (lit !== null) acc.events.push({ ...atNode(node), verb: prop, name: lit, via: "literal" });
  else if (first && first.type === "Identifier" && cx.clean.has(first.name)) {
    acc.events.push({ ...atNode(node), verb: prop, name: cx.clean.get(first.name), via: "hop" });
  } else if (first && first.type === "Identifier" && cx.nonliteral.has(first.name)) {
    acc.cascades.push({ ...atNode(node), verb: prop });
  } else acc.dynamics.push({ ...atNode(node), verb: prop });
}

function visitACall(node, parent, acc) {
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const recv = node.callee.object;
    const prop = staticProp(node.callee);
    if (recv.type === "Identifier" && recv.name === "ctx" && prop !== null) {
      if (!FRAMEWORK_ONLY.has(prop) && !EVENT_VERBS.includes(prop)) {
        acc.svcCalls.push({ ...atNode(node), svc: prop, method: null });
      }
    } else if (
      recv.type === "MemberExpression" &&
      recv.object.type === "Identifier" &&
      recv.object.name === "ctx" &&
      prop !== null
    ) {
      const svc = staticProp(recv);
      if (svc !== null && !FRAMEWORK_ONLY.has(svc))
        acc.calls.push({ ...atNode(node), svc, method: prop });
    }
    return;
  }
  if (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "ctx" &&
    parent &&
    !(parent.type === "CallExpression" && parent.callee === node) &&
    !(parent.type === "MemberExpression" && parent.object === node)
  ) {
    const svc = staticProp(node);
    if (svc !== null && !FRAMEWORK_ONLY.has(svc) && !EVENT_VERBS.includes(svc))
      acc.svcRefs.push({ ...atNode(node), svc });
  }
}

export function analyzeAFile(ast) {
  const { clean, nonliteral } = collectFileConsts(ast);
  const acc = {
    services: [],
    provides: [],
    events: [],
    calls: [],
    svcCalls: [],
    svcRefs: [],
    dynamics: [],
    forwarding: [],
    blessed: [],
    cascades: [],
    injectArrays: [],
    blessedValues: new Set(),
  };
  const cx = { clean, nonliteral, hop: (n) => hopServiceOf(n, clean, nonliteral) };
  (function walk(node, parent) {
    if (!node || typeof node.type !== "string") return;
    visitAConst(node, acc, cx.hop);
    visitAService(node, acc, cx);
    visitAEvent(node, acc, cx);
    visitACall(node, parent, acc);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "range") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === "string") walk(c, node);
      } else if (child && typeof child.type === "string") walk(child, node);
    }
  })(ast, null);
  return {
    services: acc.services,
    provides: acc.provides,
    events: acc.events,
    calls: acc.calls,
    svcCalls: acc.svcCalls,
    svcRefs: acc.svcRefs,
    dynamics: acc.dynamics,
    forwarding: acc.forwarding,
    blessed: acc.blessed,
    cascades: acc.cascades,
    injectArrays: acc.injectArrays,
    blessedValues: [...acc.blessedValues],
  };
}

function isIdStart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdPart(ch) {
  const c = ch.charCodeAt(0);
  return isIdStart(ch) || (c >= 48 && c <= 57);
}

export function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1] ?? "";
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "\u0027" || ch === "\u0060") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = src.indexOf("\n", i + 2);
      i = end === -1 ? src.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function skipSpaces(s, i) {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

function matchWord(s, i, word) {
  if (!s.startsWith(word, i)) return false;
  const after = s[i + word.length] ?? "";
  if (after !== "" && isIdPart(after)) return false;
  const before = i > 0 ? s[i - 1] : "";
  if (before !== "" && isIdPart(before)) return false;
  return true;
}

function readString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === q) return { value: s.slice(i + 1, j), end: j + 1 };
    j += 1;
  }
  return null;
}

function matchBrace(s, openIdx) {
  let depth = 0;
  let j = openIdx;
  let q = null;
  while (j < s.length) {
    const ch = s[j];
    if (q !== null) {
      if (ch === "\\") j += 1;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "\u0027" || ch === "\u0060") q = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: s.slice(openIdx + 1, j), end: j + 1 };
    }
    j += 1;
  }
  return null;
}

export function findBlocks(code) {
  const blocks = [];
  let i = 0;
  while (i < code.length) {
    let hit = null;
    for (const kind of ["interface", "class", "enum", "namespace", "module"]) {
      if (matchWord(code, i, kind)) {
        hit = kind;
        break;
      }
    }
    if (hit === null) {
      i += 1;
      continue;
    }
    let j = skipSpaces(code, i + hit.length);
    let name = null;
    if (code[j] === '"' || code[j] === "\u0027") {
      const r = readString(code, j);
      if (r === null) {
        i = j + 1;
        continue;
      }
      name = r.value;
      j = r.end;
    } else if (j < code.length && isIdStart(code[j])) {
      let k = j;
      while (k < code.length && isIdPart(code[k])) k += 1;
      name = code.slice(j, k);
      j = k;
    } else {
      i = j + 1;
      continue;
    }
    let angle = 0;
    let brace = -1;
    let k = j;
    while (k < code.length) {
      const ch = code[k];
      if (ch === "<") angle += 1;
      else if (ch === ">") angle = Math.max(0, angle - 1);
      else if (ch === "{" && angle === 0) {
        brace = k;
        break;
      } else if (ch === ";" && angle === 0) break;
      k += 1;
    }
    if (brace === -1) {
      i = k + 1;
      continue;
    }
    const m = matchBrace(code, brace);
    if (m === null) {
      i = brace + 1;
      continue;
    }
    blocks.push({ kind: hit, name, body: m.body });
    i = m.end;
  }
  return blocks;
}

function skipBalancedAt(body, i, open, close) {
  let d = 0;
  let q = null;
  while (i < body.length) {
    const ch = body[i];
    if (q !== null) {
      if (ch === "\\") i += 1;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === open) d += 1;
    else if (ch === close) {
      d -= 1;
      if (d === 0) {
        i += 1;
        return i;
      }
    }
    i += 1;
  }
  return i;
}

function skipTerminatorAt(body, i) {
  let dBrace = 0;
  let dParen = 0;
  let dBracket = 0;
  let q = null;
  while (i < body.length) {
    const ch = body[i];
    if (q !== null) {
      if (ch === "\\") i += 1;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === "{") dBrace += 1;
    else if (ch === "}") {
      if (dBrace === 0 && dParen === 0 && dBracket === 0) return i;
      dBrace -= 1;
    } else if (ch === "(") dParen += 1;
    else if (ch === ")") dParen -= 1;
    else if (ch === "[") dBracket += 1;
    else if (ch === "]") dBracket -= 1;
    else if ((ch === ";" || ch === ",") && dBrace === 0 && dParen === 0 && dBracket === 0) {
      i += 1;
      return i;
    }
    i += 1;
  }
  return i;
}

function skipModifiersAt(body, i) {
  for (;;) {
    const start = i;
    for (const w of [
      "readonly",
      "static",
      "declare",
      "abstract",
      "override",
      "public",
      "private",
      "protected",
    ]) {
      if (matchWord(body, i, w)) {
        i = skipSpaces(body, i + w.length);
        break;
      }
    }
    if (i === start) return i;
  }
}

function typeHeadAt(body, i) {
  let k = i;
  while (k < body.length && (isIdPart(body[k]) || body[k] === ".")) k += 1;
  return { full: body.slice(i, k), next: k };
}

function headBracketAt(st) {
  const { body } = st;
  let j = st.i + 1;
  let q = null;
  while (j < body.length) {
    const c = body[j];
    if (q !== null) {
      if (c === "\\") j += 1;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "]") break;
    j += 1;
  }
  const t = body.slice(st.i + 1, j).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const nm = t.slice(1, -1);
    st.members.add(nm);
    st.quoted.add(nm);
  } else {
    st.opaque += 1;
  }
  st.i = skipTerminatorAt(body, j + 1);
}

function headQuotedAt(st) {
  const { body } = st;
  const r = readString(body, st.i);
  if (r === null) {
    st.i += 1;
    return;
  }
  st.members.add(r.value);
  st.quoted.add(r.value);
  let i = skipSpaces(body, r.end);
  if (body[i] === "?" || body[i] === "!") i += 1;
  i = skipSpaces(body, i);
  if (body[i] === "(") i = skipBalancedAt(body, i, "(", ")");
  else if (body[i] === ":") {
    i = skipSpaces(body, i + 1);
    const t = typeHeadAt(body, i);
    if (t.full.split(".")[0] !== "") st.links.set(r.value, t.full);
    i = t.next;
  }
  st.i = skipTerminatorAt(body, i);
}

function headIdentAt(st) {
  const { body } = st;
  let k = st.i;
  while (k < body.length && isIdPart(body[k])) k += 1;
  const nm = body.slice(st.i, k);
  let i = k;
  if (nm === "new" && body[skipSpaces(body, i)] === "(") {
    i = skipBalancedAt(body, i, "(", ")");
    st.i = skipTerminatorAt(body, i);
    return;
  }
  st.members.add(nm);
  i = skipSpaces(body, i);
  if (body[i] === "?" || body[i] === "!") i += 1;
  i = skipSpaces(body, i);
  if (body[i] === "<") {
    let d = 0;
    while (i < body.length) {
      if (body[i] === "<") d += 1;
      else if (body[i] === ">") {
        d -= 1;
        if (d === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    i = skipSpaces(body, i);
  }
  if (body[i] === "(") i = skipBalancedAt(body, i, "(", ")");
  else if (body[i] === ":") {
    i = skipSpaces(body, i + 1);
    const t = typeHeadAt(body, i);
    if (t.full !== "") st.links.set(nm, t.full);
    i = t.next;
  } else if (body[i] === "=") {
    i = skipTerminatorAt(body, i + 1);
    st.i = i;
    return;
  }
  st.i = skipTerminatorAt(body, i);
}

export function extractMembers(body) {
  const st = { body, i: 0, members: new Set(), quoted: new Set(), links: new Map(), opaque: 0 };
  while (st.i < body.length) {
    st.i = skipSpaces(body, st.i);
    if (st.i >= body.length) break;
    const ch = body[st.i];
    if (ch === ";" || ch === ",") {
      st.i += 1;
      continue;
    }
    if (ch === "(") {
      st.i = skipTerminatorAt(body, skipBalancedAt(body, st.i, "(", ")"));
      continue;
    }
    if (ch === "[") {
      headBracketAt(st);
      continue;
    }
    if (ch === '"' || ch === "'") {
      headQuotedAt(st);
      continue;
    }
    if (isIdStart(ch)) {
      headIdentAt(st);
      continue;
    }
    st.i = skipModifiersAt(body, st.i);
    if (body[st.i] === ch) st.i += 1;
  }
  return { members: st.members, quoted: st.quoted, links: st.links, opaque: st.opaque };
}

export function parseDtsMembers(text) {
  const code = stripComments(text);
  const ifaces = new Map();
  const classes = new Map();
  const modules = [];
  for (const b of findBlocks(code)) {
    if (b.kind === "module" || b.kind === "namespace") {
      const inner = parseDtsMembers(b.body);
      modules.push({ name: b.name, ifaces: inner.ifaces });
      for (const [n, v] of inner.ifaces) {
        if (!ifaces.has(n)) ifaces.set(n, v);
      }
    } else if (b.kind === "class") {
      classes.set(b.name, extractMembers(b.body));
    } else {
      ifaces.set(b.name, extractMembers(b.body));
    }
  }
  return { ifaces, classes, modules };
}

export function extractDeclareModules(srcText) {
  const out = [];
  const code = stripComments(srcText);
  for (const b of findBlocks(code)) {
    if (b.kind === "module") out.push({ name: b.name, parsed: parseDtsMembers(b.body) });
  }
  return out;
}

export function readCatalog(root) {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) throw new Error("catalog 不可读：pnpm-workspace.yaml 缺失");
  const text = readFileSync(file, "utf8");
  const versions = new Map();
  let inCatalog = false;
  for (const line of text.split("\n")) {
    if (/^catalog:\s*$/.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && /^\S/.test(line)) break;
    if (!inCatalog) continue;
    const m = /^\s*["']?(@deepseek-ai\/[^"'\s:]+)["']?\s*:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (m) versions.set(m[1], m[2]);
  }
  if (versions.size === 0)
    throw new Error("catalog 为空：pnpm-workspace.yaml 无 @deepseek-ai 条目");
  return versions;
}

export function resolvePeers(root) {
  const found = [];
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir) || !statSync(packagesDir).isDirectory()) {
    throw new Error("packages 目录不可读");
  }
  for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const scope = join(packagesDir, e.name, "node_modules", "@deepseek-ai");
    if (!existsSync(scope) || !statSync(scope).isDirectory()) continue;
    for (const d of readdirSync(scope, { withFileTypes: true })) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const dir = join(scope, d.name);
      const pkgFile = join(dir, "package.json");
      if (!existsSync(pkgFile)) continue;
      let meta = null;
      try {
        meta = JSON.parse(readFileSync(pkgFile, "utf8"));
      } catch {
        throw new Error(`上游包元数据不可解析：${relPosix(root, pkgFile)}`);
      }
      found.push({
        pkg: e.name,
        name: `@deepseek-ai/${d.name}`,
        dir,
        version: String(meta.version ?? ""),
      });
    }
  }
  return found;
}

export function checkPeerVersions(peers, catalog) {
  const byName = new Map();
  for (const p of peers) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  const versions = new Map();
  for (const [name, list] of byName) {
    const vers = [...new Set(list.map((p) => p.version))].sort();
    if (vers.length > 1) {
      throw new Error(
        `同名多版本（须锁单版）：${name} -> ${vers.join(" / ")}（${list.map((p) => p.pkg).join(", ")}）`,
      );
    }
    const locked = catalog.get(name);
    if (locked === undefined || vers[0] !== locked) {
      throw new Error(`版本漂移（B 恒 lock）：${name} 实 ${vers[0]}，锁 ${locked ?? "无登记"}`);
    }
    versions.set(name, {
      version: vers[0],
      dirs: [...new Set(list.map((p) => p.dir))],
      pkgs: list.map((p) => p.pkg),
    });
  }
  if (!versions.has("@deepseek-ai/cordis"))
    throw new Error("cordis 不可解析：无任何包装载 @deepseek-ai/cordis");
  return versions;
}

function dtsEntryPoint(peerDir) {
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(peerDir, "package.json"), "utf8"));
  } catch {
    throw new Error(`上游包元数据不可解析：${peerDir}`);
  }
  for (const key of ["types", "typings"]) {
    if (typeof meta[key] === "string") {
      const f = resolve(peerDir, meta[key]);
      if (existsSync(f) && statSync(f).isFile()) return f;
    }
  }
  const fallback = join(peerDir, "lib", "index.d.ts");
  if (existsSync(fallback)) return fallback;
  throw new Error(`上游包无声明入口：${peerDir}（types 缺失且 lib/index.d.ts 不存在）`);
}

export function resolveRelativeSpec(fromFile, spec) {
  const base = dirname(fromFile);
  const cands = [];
  if (spec.endsWith(".ts")) {
    cands.push(spec.slice(0, -3) + ".d.ts", spec, spec + ".d.ts");
  } else {
    cands.push(spec, spec + ".d.ts", spec + ".ts", join(spec, "index.d.ts"));
  }
  for (const c of cands) {
    const f = resolve(base, c);
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

export function closureMembers(entryAbs) {
  const ifaces = new Map();
  const modules = [];
  const seen = new Set();
  const queue = [entryAbs];
  let opaque = 0;
  let files = 0;
  while (queue.length > 0) {
    const f = queue.shift();
    let real = f;
    try {
      real = realpathSync(f);
    } catch {
      throw new Error(`闭包文件不可读：${f}`);
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let text = null;
    try {
      text = readFileSync(real, "utf8");
    } catch {
      throw new Error(`闭包文件不可读：${f}`);
    }
    files += 1;
    const parsed = parseDtsMembers(text);
    const tables = new Map([...parsed.ifaces, ...parsed.classes]);
    for (const [n, v] of tables) {
      if (!ifaces.has(n)) {
        ifaces.set(n, {
          members: new Set(),
          quoted: new Set(),
          links: new Map(),
          opaque: 0,
          classKind: parsed.classes.has(n),
        });
      }
      const acc = ifaces.get(n);
      for (const m of v.members) acc.members.add(m);
      for (const q of v.quoted) acc.quoted.add(q);
      for (const [k, t] of v.links) if (!acc.links.has(k)) acc.links.set(k, t);
      acc.opaque += v.opaque;
      opaque += v.opaque;
    }
    for (const m of parsed.modules) modules.push({ file: real, name: m.name });
    const code = stripComments(text);
    const specs = new Set();
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(["\u0027])(\.[^"\u0027]*)\1/g;
    let mt = null;
    while ((mt = re.exec(code)) !== null) specs.add(mt[2]);
    // 裸 side-effect import（如 context 链的 import "./fiber"）：无 from/import(/require( 前缀，上式收不到。
    const bareRe = /(^|[;{}()\s])import\s*(["\u0027])(\.[^"\u0027]*)\2/g;
    while ((mt = bareRe.exec(code)) !== null) specs.add(mt[3]);
    for (const s of specs) {
      const r = resolveRelativeSpec(real, s);
      if (r !== null && !seen.has(realpathSync(r))) queue.push(r);
    }
  }
  return { ifaces, modules, opaque, files };
}

export function buildB(root) {
  const catalog = readCatalog(root);
  const peers = resolvePeers(root);
  const versions = checkPeerVersions(peers, catalog);
  const services = new Set();
  const events = new Set();
  const methodTables = new Map();
  const links = new Map();
  const moduleNames = [];
  let opaque = 0;
  let files = 0;
  const peerList = [];
  for (const [name, info] of [...versions.entries()].sort()) {
    const entry = dtsEntryPoint(info.dirs[0]);
    const closed = closureMembers(entry);
    files += closed.files;
    opaque += closed.opaque;
    for (const m of closed.modules) moduleNames.push(`${name} :: ${m.name}`);
    const ctx = closed.ifaces.get("Context");
    if (ctx && !ctx.classKind) {
      for (const m of ctx.members) {
        if (m.includes("/")) events.add(m);
        else services.add(m);
      }
      for (const [k, t] of ctx.links) if (!links.has(k)) links.set(k, t);
    }
    for (const [iname, v] of closed.ifaces) {
      if (!methodTables.has(iname)) methodTables.set(iname, new Set());
      const acc = methodTables.get(iname);
      for (const m of v.members) acc.add(m);
      for (const q of v.quoted) {
        acc.add(q);
        if (q.includes("/")) events.add(q);
      }
    }
    peerList.push({
      name,
      version: info.version,
      pkgs: [...new Set(info.pkgs)].sort(),
      files: closed.files,
    });
  }
  return {
    services,
    events,
    methodTables,
    links,
    moduleNames,
    opaque,
    files,
    peers: peerList,
    versions,
  };
}

export function evaluate(A, B) {
  const consumeNames = new Map();
  for (const s of A.services) {
    if (s.verb === "provide") continue;
    if (!consumeNames.has(s.name)) consumeNames.set(s.name, []);
    consumeNames.get(s.name).push(s);
  }
  const blessedValues = new Set(A.blessedValues);
  const untracked = [];
  for (const [name, sites] of [...consumeNames.entries()].sort()) {
    if (B.services.has(name) || blessedValues.has(name)) continue;
    untracked.push({
      name,
      sites: sites.map((s) => `${s.rel}:${s.line}`).sort(),
      count: sites.length,
    });
  }
  const s2fail =
    untracked.length > UNTRACKED_BASE || untracked.some((u) => !KNOWN_UNTRACKED.includes(u.name));
  const missingEvents = [...new Set(A.events.map((e) => e.name))]
    .sort()
    .filter((n) => !B.events.has(n));
  const r2fail = missingEvents.length > 0;
  const missingMethods = [];
  const untypedSvcs = new Map();
  for (const c of A.calls) {
    const full = B.links.get(c.svc);
    const head = full ? full.split(".")[0] : null;
    const table = head ? B.methodTables.get(head) : null;
    if (!table) {
      if (!untypedSvcs.has(c.svc)) untypedSvcs.set(c.svc, []);
      untypedSvcs.get(c.svc).push(`${c.rel}:${c.line}.${c.method}`);
      continue;
    }
    if (!table.has(c.method)) missingMethods.push({ ...c });
  }
  const r4fail = missingMethods.length > 0;
  const s1fail = A.dynamics.length > DYN_BASE;
  const s3fail = A.cascades.length > 0;
  const accounted =
    A.services.length +
    A.provides.length +
    A.events.length +
    A.calls.length +
    A.svcCalls.length +
    A.svcRefs.length +
    A.dynamics.length +
    A.forwarding.length +
    A.blessed.length +
    A.cascades.length +
    A.injectArrays.length;
  return {
    untracked,
    s2fail,
    missingEvents,
    r2fail,
    missingMethods,
    untypedSvcs: [...untypedSvcs.entries()],
    r4fail,
    s1fail,
    s3fail,
    accounted,
    r1fail: s2fail,
    counts: {
      services: A.services.length,
      provides: A.provides.length,
      events: A.events.length,
      calls: A.calls.length,
      svcCalls: A.svcCalls.length,
      svcRefs: A.svcRefs.length,
      dynamics: A.dynamics.length,
      forwarding: A.forwarding.length,
      blessed: A.blessed.length,
      cascades: A.cascades.length,
      injectArrays: A.injectArrays.length,
      bServices: B.services.size,
      bEvents: B.events.size,
      bFiles: B.files,
      bOpaque: B.opaque,
    },
  };
}

export function formatReport(A, B, R) {
  const L = [];
  L.push(
    `upstream-contract-warn: A 侧派生（字面量加单跳；动态 ${A.dynamics.length}，透传 ${A.forwarding.length}，祝福 ${A.blessed.length}，级联 ${A.cascades.length}）`,
  );
  L.push(
    `upstream-contract-warn: B 侧基线（${B.peers.length} 上游包锁定 ${[...B.versions.values()].map((v) => v.version).join(",")}，${B.files} 声明文件，服务 ${B.services.size}，事件 ${B.events.size}，不透明 ${B.opaque}）`,
  );
  for (const f of [...A.forwarding].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    L.push(`upstream-contract-warn: 透传 ${f.verb}（${f.rel}:${f.line}，${f.why}，只列示）`);
  }
  for (const b of [...A.blessed].sort((a, b2) => (a.rel < b2.rel ? -1 : 1))) {
    L.push(`upstream-contract-warn: 祝福 ${b.verb}（${b.rel}:${b.line}，${b.name}，不对 B 断言）`);
  }
  const dynSites = A.dynamics.map((d) => `${d.rel}:${d.line}`).sort();
  L.push(
    `upstream-contract-warn: S1 动态 ${A.dynamics.length}（基线 ${DYN_BASE}）${R.s1fail ? "FAIL" : "OK"}：${dynSites.join("，") || "无"}`,
  );
  L.push(
    `upstream-contract-warn: S2 无类型服务 ${R.untracked.length}（基线 ${UNTRACKED_BASE}，跟踪锚：${TRACKING_ANCHOR}）${R.s2fail ? "FAIL" : "OK"}`,
  );
  for (const u of R.untracked) {
    const methods = [
      ...A.calls.filter((c) => c.svc === u.name).map((c) => c.method),
      ...A.svcCalls.filter((c) => c.svc === u.name).map(() => "(直接调用)"),
    ];
    const uniq = [...new Set(methods)].sort();
    const tracking = KNOWN_TRACKING[u.name] ?? "无登记（新名，FAIL 依据）";
    L.push(
      `upstream-contract-warn:   - ${u.name}｜${u.sites.join("，")}｜${u.count} 处｜R4-lite 归属：${uniq.length > 0 ? uniq.join("、") : "无直接调用"}｜跟踪：${tracking}`,
    );
  }
  L.push(`upstream-contract-warn: S3 级联 ${A.cascades.length}（须零）${R.s3fail ? "FAIL" : "OK"}`);
  L.push(
    `upstream-contract-warn: R1 服务 ${R.r1fail ? "FAIL" : "OK"}（消费 ${A.services.filter((s) => s.verb !== "provide").length} 名，未命中 ${R.untracked.length}）`,
  );
  L.push(
    `upstream-contract-warn: R2-cordis 事件 ${R.r2fail ? "FAIL" : "OK"}（派生 ${A.events.length} 名，未命中 ${R.missingEvents.length}${R.missingEvents.length > 0 ? "：" + R.missingEvents.join("，") : ""}）`,
  );
  L.push(
    `upstream-contract-warn: R4-lite 方法 ${R.r4fail ? "FAIL" : "OK"}（调用 ${A.calls.length + A.svcCalls.length} 处，未命中 ${R.missingMethods.length}，无类型服务 ${R.untypedSvcs.length}）`,
  );
  for (const m of R.missingMethods)
    L.push(`upstream-contract-warn:   - 缺方法 ${m.svc}.${m.method}（${m.rel}:${m.line}）`);
  for (const [svc, sites] of R.untypedSvcs)
    L.push(`upstream-contract-warn:   - 未定型服务 ${svc}（${sites.join("，")}）`);
  L.push(
    `upstream-contract-warn: 全覆盖（A 侧 ${R.accounted} 条全部分类：断言、跳过具名、透传、祝福、inventory，零静默丢弃）`,
  );
  return L;
}

function loaderOfFile(file) {
  if (file.endsWith(".tsx")) return "tsx";
  if (/\.(mts|cts)$/.test(file)) return "ts";
  if (/\.(js|mjs|cjs)$/.test(file)) return null;
  return "ts";
}

async function scanAFile(root, file) {
  const rel = relPosix(root, file);
  const content = readFileSync(file, "utf8");
  const loader = loaderOfFile(file);
  let js = content;
  let map = null;
  if (loader !== null) {
    const t = await transform(content, { loader, sourcemap: true, sourcefile: rel });
    js = t.code;
    try {
      map = new SourceMap(JSON.parse(t.map));
    } catch {
      map = null;
    }
  }
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const found = analyzeAFile(ast);
  const lineOf = (h) => {
    if (map) {
      try {
        const entry = map.findEntry(h.generatedLine, h.generatedColumn);
        if (entry && entry.originalLine !== undefined) return entry.originalLine + 1;
      } catch {}
    }
    return h.generatedLine + 1;
  };
  const withLine = (arr) => arr.map((h) => ({ ...h, rel, line: lineOf(h) }));
  const withPkg = (arr) =>
    withLine(arr).map((h) => ({
      ...h,
      pkg: rel.startsWith("packages/") ? rel.split("/")[1] : "shared",
    }));
  return {
    rel,
    services: withPkg(found.services),
    provides: withPkg(found.provides),
    events: withPkg(found.events),
    calls: withPkg(found.calls),
    svcCalls: withPkg(found.svcCalls),
    svcRefs: withPkg(found.svcRefs),
    dynamics: withPkg(found.dynamics),
    forwarding: withPkg(found.forwarding),
    blessed: withPkg(found.blessed),
    cascades: withPkg(found.cascades),
    injectArrays: withPkg(found.injectArrays),
    blessedValues: found.blessedValues,
    repoModules: extractDeclareModules(content),
  };
}

function assertARoot(root) {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`--root 不是目录：${root}`);
}
function establishScope(argv) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 && argv[rootIdx + 1] !== undefined ? argv[rootIdx + 1] : DEFAULT_ROOT;
  let files = null;
  let scopeWhy = null;
  try {
    assertARoot(root);
    files = discoverASources(root);
    if (files === null || files.length === 0) throw new Error("未发现 A 侧扫描目标");
    readCatalog(root);
    resolvePeers(root);
  } catch (e) {
    scopeWhy = String(e?.message ?? e).slice(0, 200);
  }
  if (scopeWhy !== null) {
    failClosed(`upstream-contract-warn: 范围或基线不可建立（fail-closed）：${scopeWhy}`);
  }
  return { root: root, files: files };
}
function extractAFile(s) {
  const out = {};
  for (const k of [
    "services",
    "provides",
    "events",
    "calls",
    "svcCalls",
    "svcRefs",
    "dynamics",
    "forwarding",
    "blessed",
    "cascades",
    "injectArrays",
  ]) {
    out[k] = [...s[k]];
  }
  out.blessedValues = [...s.blessedValues];
  out.repoModules = s.repoModules.map((m) => ({ rel: s.rel, ...m }));
  return out;
}
async function scanOneAFile(root, file) {
  const s = await scanAFile(root, file);
  return extractAFile(s);
}
function emptyAPart() {
  return {
    services: [],
    provides: [],
    events: [],
    calls: [],
    svcCalls: [],
    svcRefs: [],
    dynamics: [],
    forwarding: [],
    blessed: [],
    cascades: [],
    injectArrays: [],
    blessedValues: [],
    repoModules: [],
  };
}
async function scanFilePart(root, file) {
  try {
    const part = await scanOneAFile(root, file);
    return { part: part, failure: null };
  } catch (e) {
    return {
      part: emptyAPart(),
      failure: `${relPosix(root, file)}: ${String(e?.message ?? e).slice(0, 140)}`,
    };
  }
}
function failAClosed(pipelineFailures) {
  failClosed(
    `upstream-contract-warn: A 侧管线失败（fail-closed）：${pipelineFailures.slice(0, 8).join("；").slice(0, 600)}`,
  );
}
async function scanAllA(root, files) {
  const A = {
    services: [],
    provides: [],
    events: [],
    calls: [],
    svcCalls: [],
    svcRefs: [],
    dynamics: [],
    forwarding: [],
    blessed: [],
    cascades: [],
    injectArrays: [],
    blessedValues: new Set(),
    repoModules: [],
  };
  const pipelineFailures = [];
  try {
    for (const file of files) {
      const r = await scanFilePart(root, file);
      if (r.failure !== null) pipelineFailures.push(r.failure);
      for (const k of [
        "services",
        "provides",
        "events",
        "calls",
        "svcCalls",
        "svcRefs",
        "dynamics",
        "forwarding",
        "blessed",
        "cascades",
        "injectArrays",
      ])
        A[k].push(...r.part[k]);
      for (const v of r.part.blessedValues) A.blessedValues.add(v);
      A.repoModules.push(...r.part.repoModules);
    }
    if (pipelineFailures.length > 0) throw new Error("pipe");
  } catch (e) {
    if (pipelineFailures.length === 0) pipelineFailures.push(String(e?.message ?? e).slice(0, 200));
    failAClosed(pipelineFailures);
  }
  return A;
}
function loadBOrExit(root) {
  let B = null;

  try {
    B = buildB(root);
  } catch (e) {
    failClosed(
      `upstream-contract-warn: B 侧基线不可建立（fail-closed）：${String(e?.message ?? e).slice(0, 300)}`,
    );
  }
  return B;
}
function findCordisServices(A) {
  const found = [];
  const events = [];
  for (const m of A.repoModules) {
    if (m.name !== "@deepseek-ai/cordis") continue;
    const ctx = m.parsed.ifaces.get("Context");
    if (!ctx) continue;
    for (const name of ctx.members) {
      if (!name.includes("/")) found.push(name);
      else events.push(name);
    }
  }
  return { services: found, events: events };
}
function printReportLines(lines, fails) {
  for (const line of lines) {
    if (fails.some((f) => line.includes(f)) && line.includes("FAIL"))
      console.warn(`::warning::${line}`);
    else console.log(line);
  }
}
async function main(argv) {
  const scope = establishScope(argv);
  const root = scope.root;
  const files = scope.files;
  const A = await scanAllA(root, files);
  const B = loadBOrExit(root);
  const cordisFound = findCordisServices(A);
  B.services = new Set([...B.services, ...cordisFound.services]);
  B.events = new Set([...B.events, ...cordisFound.events]);
  const R = evaluate({ ...A, blessedValues: A.blessedValues }, B);
  const lines = formatReport(A, B, R);
  const fails = [
    R.s1fail && "S1",
    R.s2fail && "S2",
    R.s3fail && "S3",
    R.r2fail && "R2",
    R.r4fail && "R4-lite",
  ].filter(Boolean);
  printReportLines(lines, fails);
  const onSites = A.events
    .filter((e) => e.verb === "on")
    .map((e) => `${e.rel}:${e.line} ${e.name}`)
    .sort();
  console.log(
    `upstream-contract-warn: C1 ctx.on 字面量 ${onSites.length} 处（v2 称 18，差 2 为多行调用 + lan-proxy document-updated 显式订阅，见下）`,
  );
  for (const s of onSites) console.log(`upstream-contract-warn:   - ${s}`);
  console.log(
    "upstream-contract-warn: C1 差数交代：行扫描逐行匹配 ctx.on( 加同行字面量会漏计 provider apply.ts:455 起多行书写的 internal/service 注册；AST 按调用收齐得 19，另 lan-proxy apply.ts:443 document-updated 显式订阅（#1011 热更新面）计 1，共 20。",
  );
  console.log(
    `upstream-contract-warn: 结束（只 warn 不阻塞，exit 0；FAIL 项：${fails.join("、") || "无"}）`,
  );
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exit(await main(process.argv));
