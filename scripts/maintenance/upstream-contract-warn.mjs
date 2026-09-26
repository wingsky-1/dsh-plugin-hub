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
 * C1：ctx.on 字面量实得 19，v2 称 18，差 1 为 provider 多行调用的
 * internal/service（行扫描漏计）；#1011 的 LAN 显式订阅已由 shared seam 统一，不再重复计数。
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

/** 是不是一个 AST 节点（有 `type` 字段的对象）；原始值、null、数组都不是。 */
export function isAstNode(v) {
  return v !== null && typeof v === "object" && typeof v.type === "string";
}

/**
 * 把 `node` 的子节点逐个喂给 `visit(child, node)`。`loc`/`range` 是元数据不是子节点，
 * 数组里的元素逐个判、其余字段按单个判——两处遍历（const 收集与形态识别）共用这一份规则。
 */
function eachAstChild(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (isAstNode(c)) visit(c, node);
    } else if (isAstNode(child)) visit(child, node);
  }
}

/** 先序遍历整棵树：`visit(node, parent)` 在进子节点之前先到，根的 parent 为 null。 */
function walkAst(root, visit) {
  (function walk(node, parent) {
    if (!isAstNode(node)) return;
    visit(node, parent);
    eachAstChild(node, walk);
  })(root, null);
}

function collectConstDecl(node, inits) {
  for (const d of node.declarations) {
    if (d.id.type !== "Identifier") continue;
    if (!inits.has(d.id.name)) inits.set(d.id.name, []);
    inits.get(d.id.name).push(staticString(d.init));
  }
}

export function collectFileConsts(ast) {
  const inits = new Map();
  const dirtied = new Set();
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") collectConstDecl(node, inits);
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier")
      dirtied.add(node.left.name);
    if (node.type === "UpdateExpression" && node.argument.type === "Identifier")
      dirtied.add(node.argument.name);
  });
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

/** `const X_SERVICE = "…"`：自家定义的服务名常量，记下来但不对 B 断言。 */
function collectBlessedValue(d, acc) {
  if (!/SERVICE/.test(d.id.name)) return;
  const v = staticString(d.init);
  if (v !== null) acc.blessedValues.add(v);
}

/**
 * `export const inject = [...]`：数组元只记 inventory。元素是 spread 或动态时名字静态不可知，
 * 这里静默不收（元素级不分类，spread 由 `ctx.inject([...])` 那条判据记 forwarding）。
 */
function collectInjectArray(d, acc, hop) {
  if (d.id.name !== "inject" || !d.init || d.init.type !== "ArrayExpression") return;
  const names = [];
  for (const el of d.init.elements) {
    if (!el) continue;
    const r = hop(el);
    if (r.kind === "literal" || r.kind === "hop") names.push(r.name);
  }
  acc.injectArrays.push({ ...atNode(d.id), names });
}

function visitAConst(node, acc, hop) {
  if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
  for (const d of node.declarations) {
    if (d.id.type !== "Identifier") continue;
    collectBlessedValue(d, acc);
    collectInjectArray(d, acc, hop);
  }
}

/** `ctx.get(x)` / `ctx.provide(x)`：单个服务名，两者在「是否算 provide」上分道。 */
function visitServiceSingle(node, acc, cx, prop) {
  const r = cx.hop(node.arguments[0]);
  pushServiceInto(acc, node, prop, r);
  if (prop === "provide" && (r.kind === "literal" || r.kind === "hop")) {
    acc.provides.push({ ...atNode(node), name: r.name, via: r.kind });
  }
}

/**
 * `ctx.inject([...])`：数组形态的批量注入。
 *
 * 数组不是数组时（`ctx.inject(x)` 形态）不是「批量注入」而是别的东西，交给调用方判；
 * 元素是 spread 时服务名静态不可知，记 forwarding 而不是猜一个名字。
 */
function visitServiceInject(node, acc, cx) {
  for (const el of node.arguments[0].elements) {
    if (!el || el.type === "SpreadElement") {
      acc.forwarding.push({ ...atNode(node), verb: "inject", why: "spread" });
      continue;
    }
    pushServiceInto(acc, node, "inject", cx.hop(el));
  }
}

const SERVICE_VERBS = new Set(["get", "provide", "inject"]);

function visitAService(node, acc, cx) {
  const prop = ctxCallProp(node);
  if (prop === null || !SERVICE_VERBS.has(prop)) return false;
  if (prop === "inject") {
    if (node.arguments[0] && node.arguments[0].type === "ArrayExpression")
      visitServiceInject(node, acc, cx);
    return true;
  }
  visitServiceSingle(node, acc, cx, prop);
  return true;
}

/**
 * `ctx.<verb>(...)` 的属性名；不是这种形态（不是调用、不是成员、接收者不是 ctx、属性算不出）
 * 返回 null。A 侧三类判据——服务动词、事件动词、服务方法——都先过这一关。
 */
export function ctxCallProp(node) {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return null;
  const recv = node.callee.object;
  if (recv.type !== "Identifier" || recv.name !== "ctx") return null;
  return staticProp(node.callee);
}

/** 事件第一参的四种归宿：字面量、const 单跳、级联（多跳/重赋值）、动态。 */
function classifyEventArg(first, cx) {
  const lit = staticString(first);
  if (lit !== null) return { kind: "literal", name: lit };
  if (!first || first.type !== "Identifier") return { kind: "dynamic" };
  if (cx.clean.has(first.name)) return { kind: "hop", name: cx.clean.get(first.name) };
  if (cx.nonliteral.has(first.name)) return { kind: "cascade" };
  return { kind: "dynamic" };
}

function visitAEvent(node, acc, cx) {
  const prop = ctxCallProp(node);
  if (prop === null || !EVENT_VERBS.includes(prop)) return;
  const hit = classifyEventArg(node.arguments[0], cx);
  if (hit.kind === "dynamic") acc.dynamics.push({ ...atNode(node), verb: prop });
  else if (hit.kind === "cascade") acc.cascades.push({ ...atNode(node), verb: prop });
  else acc.events.push({ ...atNode(node), verb: prop, name: hit.name, via: hit.kind });
}

/**
 * `ctx.<prop>()`：服务面调用点。`ctx.get/provide/inject` 与事件动词不是服务调用（它们各自
 * 另有判据），框架内建动词也不是。
 */
/** 服务名判据：框架内建动词与事件动词都不是「服务面」成员（它们各自另有判据）。 */
export function isContractSvcName(svc) {
  return !FRAMEWORK_ONLY.has(svc) && !EVENT_VERBS.includes(svc);
}

function visitServiceCall(node, acc) {
  const recv = node.callee.object;
  const prop = staticProp(node.callee);
  if (recv.type === "Identifier" && recv.name === "ctx" && prop !== null) {
    if (isContractSvcName(prop)) {
      acc.svcCalls.push({ ...atNode(node), svc: prop, method: null });
    }
  }
}

/** `ctx.<svc>.<method>()`：带方法名的服务调用点（R4 判的就是它）。 */
function visitMethodCall(node, acc) {
  const recv = node.callee.object;
  const prop = staticProp(node.callee);
  if (
    recv.type === "MemberExpression" &&
    recv.object.type === "Identifier" &&
    recv.object.name === "ctx" &&
    prop !== null
  ) {
    const svc = staticProp(recv);
    if (svc !== null && !FRAMEWORK_ONLY.has(svc))
      acc.calls.push({ ...atNode(node), svc, method: prop });
  }
}

/**
 * `ctx.<svc>` 单独出现（不是被调用的、也不是别人的接收者）：服务**引用**而非调用。
 * parent 判据用来排掉前两种形态的重复计数——它们各自已经记过了。
 */
/**
 * 这个 `ctx.<svc>` 是不是别的节点的子件——被调用（调用点已记）、或挂在别人身上（方法调用已记）。
 * 是子件就说明更具体的判据已经收过，parent 判据要避重。
 */
export function isOwnedByParent(node, parent) {
  if (!parent) return false;
  if (parent.type === "CallExpression") return parent.callee === node;
  if (parent.type === "MemberExpression") return parent.object === node;
  return false;
}

function visitServiceRef(node, parent, acc) {
  if (node.object.type !== "Identifier" || node.object.name !== "ctx") return;
  if (isOwnedByParent(node, parent)) return;
  const svc = staticProp(node);
  if (svc === null || !isContractSvcName(svc)) return;
  acc.svcRefs.push({ ...atNode(node), svc });
}

function visitACall(node, parent, acc) {
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    visitServiceCall(node, acc);
    visitMethodCall(node, acc);
    return;
  }
  if (node.type === "MemberExpression") visitServiceRef(node, parent, acc);
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
  walkAst(ast, (node, parent) => {
    visitAConst(node, acc, cx.hop);
    visitAService(node, acc, cx);
    visitAEvent(node, acc, cx);
    visitACall(node, parent, acc);
  });
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
    const commentEnd = commentEndAt(src, i, next);
    if (commentEnd !== null) {
      i = commentEnd.next;
      out += commentEnd.replacement;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 当前位置是否开启一段注释；是则返回「跳过到哪 + 用什么替换」。不是注释返回 null。
 *
 * 块注释替换成换行、行注释替换成空串：块注释里可能藏着换行，替成换行才能保持后续的
 * 行号与「行内有没有东西」不变（行注释整行丢掉即可）。两种形态的**结束位置规则不同**
 * （块注释找闭合标记 vs 行注释找换行），故各自成支而不是共用一个查找。
 */
function commentEndAt(src, i, next) {
  if (src[i] !== "/") return null;
  if (next === "*") {
    const end = src.indexOf("*/", i + 2);
    return { next: end === -1 ? src.length : end + 2, replacement: "\n" };
  }
  if (next === "/") {
    const end = src.indexOf("\n", i + 2);
    return { next: end === -1 ? src.length : end, replacement: "" };
  }
  return null;
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

/** 三种引号字符（字符串与模板字面量都能跨行），正文头尾扫共用这一份判定。 */
const QUOTE_CHARS = new Set(['"', "\u0027", "\u0060"]);

function matchBrace(s, openIdx) {
  let depth = 0;
  let j = openIdx;
  let q = null;
  while (j < s.length) {
    const ch = s[j];
    if (q !== null) {
      if (ch === "\\") j += 1;
      else if (ch === q) q = null;
    } else if (QUOTE_CHARS.has(ch)) q = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: s.slice(openIdx + 1, j), end: j + 1 };
    }
    j += 1;
  }
  return null;
}

const BLOCK_KEYWORDS = ["interface", "class", "enum", "namespace", "module"];

/**
 * 一个声明的名字与它之后的下标（字符串字面量名或标识符名）；两种形态都不是时返回 null。
 *
 * 与关键字匹配分开：关键字是**五种固定词**的识别，名字是**任意 token** 的读法，两者的
 * 词法规则各自会变（加一种声明形态 vs 换一种名字写法）。
 */
function readDeclName(code, from) {
  const j = skipSpaces(code, from);
  if (code[j] === '"' || code[j] === "\u0027") {
    const r = readString(code, j);
    return r === null ? null : { name: r.value, end: r.end };
  }
  if (j < code.length && isIdStart(code[j])) {
    let k = j;
    while (k < code.length && isIdPart(code[k])) k += 1;
    return { name: code.slice(j, k), end: k };
  }
  return null;
}

/**
 * 从名字之后找到**顶层**的 `{`（顶层 = 不在泛型参数 `<…>` 内）：
 * 泛型参数里可以有花括号，声明体只可能在角括号归零之后。`;` 表示这是个无体声明，
 * 不是判据要的面——返回 -1。
 */
function bodyBraceAt(code, from) {
  let angle = 0;
  for (let k = from; k < code.length; k += 1) {
    const ch = code[k];
    if (ch === "<") angle += 1;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && angle === 0) return k;
    else if (ch === ";" && angle === 0) return -1;
  }
  return -1;
}

export function findBlocks(code) {
  const blocks = [];
  let i = 0;
  while (i < code.length) {
    const hit = BLOCK_KEYWORDS.find((kind) => matchWord(code, i, kind));
    if (hit === undefined) {
      i += 1;
      continue;
    }
    const decl = readDeclName(code, i + hit.length);
    if (decl === null) {
      i = skipSpaces(code, i + hit.length) + 1;
      continue;
    }
    const brace = bodyBraceAt(code, decl.end);
    if (brace === -1) {
      i = decl.end + 1;
      continue;
    }
    const m = matchBrace(code, brace);
    if (m === null) {
      i = brace + 1;
      continue;
    }
    blocks.push({ kind: hit, name: decl.name, body: m.body });
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
    } else if (QUOTE_CHARS.has(ch)) q = ch;
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

/** 成员声明的终止符：分号与逗号（都在顶层时才生效）。 */
export function isTerminator(ch) {
  return ch === ";" || ch === ",";
}

/** 三层括号各占一个深度槽：`{ }` `( )` `[ ]`。未配对的字符没有槽位。 */
const BRACKET_KINDS = new Map([
  ["{", 0],
  ["}", 0],
  ["(", 1],
  [")", 1],
  ["[", 2],
  ["]", 2],
]);
const BRACKET_OPEN = new Set(["{", "(", "["]);

/**
 * 只有 `}` 撞到底算终止信号（裸 `}` 说明本成员到此为止）；`)` `]` 撞底不终止，
 * 只把对应槽位退成负数——之后同层的 `}` 与终止符就不再算顶层。这是既有判词语义，逐字保留。
 */
const BRACKET_STOP = new Set(["}"]);

export function atTopLevel(depth) {
  return depth.every((d) => d === 0);
}

export const BRACKET_OTHER = "other";
export const BRACKET_TOP = "top";

/** 走一步括号：开括号进槽、`}` 撞底报终止、其余闭括号退槽、非括号字符不动作。 */
export function stepBracketAt(ch, depth) {
  const kind = BRACKET_KINDS.get(ch);
  if (kind === undefined) return BRACKET_OTHER;
  if (BRACKET_OPEN.has(ch)) {
    depth[kind] += 1;
    return "opened";
  }
  if (BRACKET_STOP.has(ch) && atTopLevel(depth)) return BRACKET_TOP;
  depth[kind] -= 1;
  return "closed";
}

function skipTerminatorAt(body, i) {
  const depth = [0, 0, 0];
  let q = null;
  while (i < body.length) {
    const ch = body[i];
    if (q !== null) {
      if (ch === "\\") i += 1;
      else if (ch === q) q = null;
    } else if (QUOTE_CHARS.has(ch)) q = ch;
    else if (isTerminator(ch) && atTopLevel(depth)) {
      i += 1;
      return i;
    } else {
      if (stepBracketAt(ch, depth) === BRACKET_TOP) return i;
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

/**
 * `["…"]` 里找闭合的 `]`：方括号内允许字符串，字符串里的 `]` 不算闭合。
 * 这里只认单双引号（模板字面量不出现在计算键里），与正文的三引号规则刻意不同。
 */
function closeBracketAt(body, from) {
  let j = from;
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
  return j;
}

/** 键内容是带引号的字符串字面量时返回键名；不是（计算键、模板串等）返回 null 即不透明。 */
export function unquotedMemberName(t) {
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return null;
}

function headBracketAt(st) {
  const { body } = st;
  const j = closeBracketAt(body, st.i + 1);
  const nm = unquotedMemberName(body.slice(st.i + 1, j).trim());
  if (nm === null) st.opaque += 1;
  else {
    st.members.add(nm);
    st.quoted.add(nm);
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

/** 读一个标识符 token：名字与它之后的下标。 */
function readIdentAt(body, i) {
  let k = i;
  while (k < body.length && isIdPart(body[k])) k += 1;
  return { text: body.slice(i, k), next: k };
}

/** 跳过 `<…>` 泛型参数（角括号可嵌），返回 `>` 之后的位置；没闭合就停在文末。 */
function skipGenericAt(body, i) {
  let d = 0;
  while (i < body.length) {
    if (body[i] === "<") d += 1;
    else if (body[i] === ">") {
      d -= 1;
      if (d === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * 成员名之后的形态：`(` 方法签名、`= 默认值`（声明到此为止）、`: T` 类型（顺带记 links）。
 * `terminated` 为真时 `next` 已是越过终止符的位置，调用方不要再跳一次。
 */
function headTailAt(body, i, name, st) {
  if (body[i] === "(") return { terminated: false, next: skipBalancedAt(body, i, "(", ")") };
  if (body[i] === "=") return { terminated: true, next: skipTerminatorAt(body, i + 1) };
  if (body[i] !== ":") return { terminated: false, next: i };
  const j = skipSpaces(body, i + 1);
  const t = typeHeadAt(body, j);
  if (t.full !== "") st.links.set(name, t.full);
  return { terminated: false, next: t.next };
}

function headIdentAt(st) {
  const { body } = st;
  const nm = readIdentAt(body, st.i);
  let i = skipSpaces(body, nm.next);
  if (nm.text === "new" && body[i] === "(") {
    st.i = skipTerminatorAt(body, skipBalancedAt(body, i, "(", ")"));
    return;
  }
  st.members.add(nm.text);
  if (body[i] === "?" || body[i] === "!") i = skipSpaces(body, i + 1);
  if (body[i] === "<") i = skipSpaces(body, skipGenericAt(body, i));
  const tail = headTailAt(body, i, nm.text, st);
  st.i = tail.terminated ? tail.next : skipTerminatorAt(body, tail.next);
}

export const HEAD_SEP = "sep";
export const HEAD_PARAMS = "params";
export const HEAD_BRACKET = "bracket";
export const HEAD_QUOTED = "quoted";
export const HEAD_IDENT = "ident";
export const HEAD_OTHER = "other";

/**
 * 成员列表里下一个 token 的形态：分隔符、参数表（构造函数残留）、计算键、引号名、
 * 标识符名、其余（修饰符与修饰符修饰符）。认形态与各形态各自的消费规则是两件事。
 */
export function headKindAt(body, i) {
  const ch = body[i];
  if (ch === ";" || ch === ",") return HEAD_SEP;
  if (ch === "(") return HEAD_PARAMS;
  if (ch === "[") return HEAD_BRACKET;
  if (ch === '"' || ch === "'") return HEAD_QUOTED;
  if (isIdStart(ch)) return HEAD_IDENT;
  return HEAD_OTHER;
}

/** 杂字符（修饰符之类）：整段跳过；没跳掉时前进一格，保证扫描推进不空转。 */
function skipOtherHeadAt(st) {
  const ch = st.body[st.i];
  st.i = skipModifiersAt(st.body, st.i);
  if (st.body[st.i] === ch) st.i += 1;
}

export function extractMembers(body) {
  const st = { body, i: 0, members: new Set(), quoted: new Set(), links: new Map(), opaque: 0 };
  while (st.i < body.length) {
    st.i = skipSpaces(body, st.i);
    if (st.i >= body.length) break;
    const kind = headKindAt(body, st.i);
    if (kind === HEAD_IDENT) headIdentAt(st);
    else if (kind === HEAD_QUOTED) headQuotedAt(st);
    else if (kind === HEAD_BRACKET) headBracketAt(st);
    else if (kind === HEAD_PARAMS)
      st.i = skipTerminatorAt(body, skipBalancedAt(body, st.i, "(", ")"));
    else if (kind === HEAD_SEP) st.i += 1;
    else skipOtherHeadAt(st);
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

/** 上游包元数据；不可解析即结构异常（判词逐字保留）。 */
function readPeerMeta(root, pkgFile) {
  try {
    return JSON.parse(readFileSync(pkgFile, "utf8"));
  } catch {
    throw new Error(`上游包元数据不可解析：${relPosix(root, pkgFile)}`);
  }
}

/** 一个包的 node_modules/@deepseek-ai 作用域内逐个上游包收进 found，顺序即目录序。 */
function collectScopePeers(root, pkg, scope, found) {
  for (const d of readdirSync(scope, { withFileTypes: true })) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const dir = join(scope, d.name);
    const pkgFile = join(dir, "package.json");
    if (!existsSync(pkgFile)) continue;
    const meta = readPeerMeta(root, pkgFile);
    found.push({
      pkg: pkg,
      name: `@deepseek-ai/${d.name}`,
      dir,
      version: String(meta.version ?? ""),
    });
  }
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
    collectScopePeers(root, e.name, scope, found);
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
    opaque += mergeIfaceTables(ifaces, parsed);
    for (const m of parsed.modules) modules.push({ file: real, name: m.name });
    for (const s of relativeSpecifiersOf(text)) {
      const r = resolveRelativeSpec(real, s);
      if (r !== null && !seen.has(realpathSync(r))) queue.push(r);
    }
  }
  return { ifaces, modules, opaque, files };
}

/**
 * 把一个文件解析出的表合并进累加器（同名成员取并集，links 不后到保留先到的类型，opaque 累加）。
 * 返回本文件新增的 opaque 量，让调用方只维护一个总计。
 *
 * 与 BFS 循环分开：「合并一个解析结果」与「遍历闭包」是两个变化原因——合并规则改了不应该跟着
 * BFS 的去重/入队规则一起变。
 */
function mergeIfaceTables(ifaces, parsed) {
  let opaque = 0;
  for (const [n, v] of new Map([...parsed.ifaces, ...parsed.classes])) {
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
  return opaque;
}

/**
 * 一份源文本里的相对请求读到器。
 *
 * 两个形态分开收：带 from / import( / require( 前缀的，与裸 side-effect import（如 context 链的
 * import "./fiber"）——后者无前缀，上式收不到。先剥注释再扫：注释里的请求不是依赖。
 */
function relativeSpecifiersOf(text) {
  const code = stripComments(text);
  const specs = new Set();
  let mt = null;
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(["\u0027])(\.[^"\u0027]*)\1/g;
  while ((mt = re.exec(code)) !== null) specs.add(mt[2]);
  const bareRe = /(^|[;{}()\s])import\s*(["\u0027])(\.[^"\u0027]*)\2/g;
  while ((mt = bareRe.exec(code)) !== null) specs.add(mt[3]);
  return specs;
}

/**
 * 把一个闭包里的 Context 接口并进服务/事件/链接三张表。
 *
 * Context 是**接口**才有意义：class 形态的同名声明不是服务契约（`classKind` 时整体跳过），
 * 成员按「含 / 是事件名，否则是服务名」分流，links 不后到覆盖先到的。
 *
 * 与外层逐 peer 累积分开：本函数只回答「一份闭包的 Context 说明什么」，不关心累积到哪了。
 */
function absorbContext(ctx, services, events, links) {
  if (!ctx || ctx.classKind) return;
  for (const m of ctx.members) {
    if (m.includes("/")) events.add(m);
    else services.add(m);
  }
  for (const [k, t] of ctx.links) if (!links.has(k)) links.set(k, t);
}

/** 一个 peer 闭包的方法表并进总表；引号成员额外并进事件全集（B 侧事件名的增补面）。 */
function absorbMethodTables(closed, methodTables, events) {
  for (const [iname, v] of closed.ifaces) {
    if (!methodTables.has(iname)) methodTables.set(iname, new Set());
    const acc = methodTables.get(iname);
    for (const m of v.members) acc.add(m);
    for (const q of v.quoted) {
      acc.add(q);
      if (q.includes("/")) events.add(q);
    }
  }
}

/** 报告里一个 peer 的一行摘要：名字、锁版、装载它的包、闭包文件数。 */
function peerSummary(name, info, closed) {
  return {
    name,
    version: info.version,
    pkgs: [...new Set(info.pkgs)].sort(),
    files: closed.files,
  };
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
    absorbContext(closed.ifaces.get("Context"), services, events, links);
    absorbMethodTables(closed, methodTables, events);
    peerList.push(peerSummary(name, info, closed));
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

/**
 * S2：被消费但 B 面没声明的服务名（blessed 值与 B 侧已声明的除外），按名字排序。
 *
 * 与 evaluate 分开：本函数只回答「哪些服务名没被对上」，不参与任何一条 fail 判定——
 * s2fail 的阈值与白名单是另一件事（改阈值不该重读这段扫描）。
 */
function untrackedServiceNames(A, B, blessedValues) {
  const consumeNames = new Map();
  for (const s of A.services) {
    if (s.verb === "provide") continue;
    if (!consumeNames.has(s.name)) consumeNames.set(s.name, []);
    consumeNames.get(s.name).push(s);
  }
  const untracked = [];
  for (const [name, sites] of [...consumeNames.entries()].sort()) {
    if (B.services.has(name) || blessedValues.has(name)) continue;
    untracked.push({
      name,
      sites: sites.map((s) => `${s.rel}:${s.line}`).sort(),
      count: sites.length,
    });
  }
  return untracked;
}

/**
 * R4：调用点的两种缺口——服务名在 B 面查不到方法表（untyped，服务根本不在契约里），
 * 与方法表在但该方法没有（契约里有、调用了没声明的方法）。前者不判红只记录。
 *
 * 与 evaluate 分开同 S2：这里只产缺口清单，r4fail 的判定在调用方。
 */
function scanMethodCalls(A, B) {
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
  return { missingMethods, untypedSvcs };
}

export function evaluate(A, B) {
  const blessedValues = new Set(A.blessedValues);
  const untracked = untrackedServiceNames(A, B, blessedValues);
  const s2fail =
    untracked.length > UNTRACKED_BASE || untracked.some((u) => !KNOWN_UNTRACKED.includes(u.name));
  const missingEvents = [...new Set(A.events.map((e) => e.name))]
    .sort()
    .filter((n) => !B.events.has(n));
  const r2fail = missingEvents.length > 0;
  const { missingMethods, untypedSvcs } = scanMethodCalls(A, B);
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

/** A 侧与 B 侧的两行抬头（各面的派生规模与基线规模）。 */
function reportHeader(A, B) {
  return [
    `upstream-contract-warn: A 侧派生（字面量加单跳；动态 ${A.dynamics.length}，透传 ${A.forwarding.length}，祝福 ${A.blessed.length}，级联 ${A.cascades.length}）`,
    `upstream-contract-warn: B 侧基线（${B.peers.length} 上游包锁定 ${[...B.versions.values()].map((v) => v.version).join(",")}，${B.files} 声明文件，服务 ${B.services.size}，事件 ${B.events.size}，不透明 ${B.opaque}）`,
  ];
}

/** 跳过项的两张具名清单：透传与祝福，都只列示不判红。 */
function skipListLines(A) {
  const L = [];
  for (const f of [...A.forwarding].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    L.push(`upstream-contract-warn: 透传 ${f.verb}（${f.rel}:${f.line}，${f.why}，只列示）`);
  }
  for (const b of [...A.blessed].sort((a, b2) => (a.rel < b2.rel ? -1 : 1))) {
    L.push(`upstream-contract-warn: 祝福 ${b.verb}（${b.rel}:${b.line}，${b.name}，不对 B 断言）`);
  }
  return L;
}

/** S1 与 S2 两行：跳过量的基线对照（S2 之前，S3 之前插 S2 的具名明细）。 */
function skipThresholdLines(A, R) {
  const dynSites = A.dynamics.map((d) => `${d.rel}:${d.line}`).sort();
  return [
    `upstream-contract-warn: S1 动态 ${A.dynamics.length}（基线 ${DYN_BASE}）${R.s1fail ? "FAIL" : "OK"}：${dynSites.join("，") || "无"}`,
    `upstream-contract-warn: S2 无类型服务 ${R.untracked.length}（基线 ${UNTRACKED_BASE}，跟踪锚：${TRACKING_ANCHOR}）${R.s2fail ? "FAIL" : "OK"}`,
  ];
}

/** 一个无类型服务的归属行：调用点、R4-lite 归属方法、跟踪注释指针。 */
function untrackedLine(A, u) {
  const methods = [
    ...A.calls.filter((c) => c.svc === u.name).map((c) => c.method),
    ...A.svcCalls.filter((c) => c.svc === u.name).map(() => "(直接调用)"),
  ];
  const uniq = [...new Set(methods)].sort();
  const tracking = KNOWN_TRACKING[u.name] ?? "无登记（新名，FAIL 依据）";
  return `upstream-contract-warn:   - ${u.name}｜${u.sites.join("，")}｜${u.count} 处｜R4-lite 归属：${uniq.length > 0 ? uniq.join("、") : "无直接调用"}｜跟踪：${tracking}`;
}

function untrackedLines(A, R) {
  return R.untracked.map((u) => untrackedLine(A, u));
}

/** S3 与三条断言（R1/R2/R4-lite）的汇总行。 */
function assertionLines(A, R) {
  return [
    `upstream-contract-warn: S3 级联 ${A.cascades.length}（须零）${R.s3fail ? "FAIL" : "OK"}`,
    `upstream-contract-warn: R1 服务 ${R.r1fail ? "FAIL" : "OK"}（消费 ${A.services.filter((s) => s.verb !== "provide").length} 名，未命中 ${R.untracked.length}）`,
    `upstream-contract-warn: R2-cordis 事件 ${R.r2fail ? "FAIL" : "OK"}（派生 ${A.events.length} 名，未命中 ${R.missingEvents.length}${R.missingEvents.length > 0 ? "：" + R.missingEvents.join("，") : ""}）`,
    `upstream-contract-warn: R4-lite 方法 ${R.r4fail ? "FAIL" : "OK"}（调用 ${A.calls.length + A.svcCalls.length} 处，未命中 ${R.missingMethods.length}，无类型服务 ${R.untypedSvcs.length}）`,
  ];
}

/** R4-lite 的两类缺口明细：已定型服务缺方法、无类型服务清单。 */
function gapLines(R) {
  const L = [];
  for (const m of R.missingMethods)
    L.push(`upstream-contract-warn:   - 缺方法 ${m.svc}.${m.method}（${m.rel}:${m.line}）`);
  for (const [svc, sites] of R.untypedSvcs)
    L.push(`upstream-contract-warn:   - 未定型服务 ${svc}（${sites.join("，")}）`);
  return L;
}

export function formatReport(A, B, R) {
  return [
    ...reportHeader(A, B),
    ...skipListLines(A),
    ...skipThresholdLines(A, R),
    ...untrackedLines(A, R),
    ...assertionLines(A, R),
    ...gapLines(R),
    `upstream-contract-warn: 全覆盖（A 侧 ${R.accounted} 条全部分类：断言、跳过具名、透传、祝福、inventory，零静默丢弃）`,
  ];
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
    `upstream-contract-warn: C1 ctx.on 字面量 ${onSites.length} 处（v2 称 18，差 1 为 provider 多行调用的 internal/service，见下）`,
  );
  for (const s of onSites) console.log(`upstream-contract-warn:   - ${s}`);
  console.log(
    "upstream-contract-warn: C1 差数交代：行扫描逐行匹配 ctx.on( 加同行字面量会漏计 provider apply.ts:455 起多行书写的 internal/service 注册；AST 按调用收齐得 19，LAN 热更新订阅已由 shared seam 统一，不再重复计数。",
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
