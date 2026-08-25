// @ts-nocheck
/**
 * dsh-provider-usage — unit：provider 检测链（issue #69）。
 *
 * 覆盖：子代理会话 models() 拒绝（agent-busy 抛错 / RPC 错误分支两种形态）时沿
 * parentId 上溯取父会话 provider、上溯深度封顶与环防御、全链失败保持上次检测 +
 * 「提供商未识别」标注决策、无任何会话维持原回落行为（回归防护）、
 * ordinary 会话直连解析回归。
 *
 * 被测对象为 src/client/core.ts 真实源码：lib/client/*.js 由 bundle-host 按
 * 发布物边界清理（仅留顶层 index.js/client.js 与 .d.ts），故沿用 web-file-preview
 * 先例——用仓库 devDependency esbuild 把源码即时打成内存 ESM、经 data-URI 导入。
 * 无网络、无真实凭据、无 DOM。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { assert } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

// ---- 即时打包 src/client/core.ts（真实源码直测）----
// __DSH_ROUTES__ 为宿主构建期 define 注入：测试环境定义为 undefined，
// 与生产「注入缺失走默认 URL」的回落语义一致（core.ts 顶部 ?? 兜底）。
const coreBundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/core.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
  define: { __DSH_ROUTES__: "undefined" },
});
const core = await import(
  `data:text/javascript;base64,${Buffer.from(coreBundle.outputFiles[0].text).toString("base64")}`
);
const {
  currentSessionId,
  sessionAncestryChain,
  MAX_ANCESTRY_DEPTH,
  resolveProviderFromSession,
  decideProviderAfterDetect,
  isAgentBusyError,
  FALLBACK_PROVIDER,
  UNKNOWN_PROVIDER_HINT,
} = core;

// ---------------------------------------------------------------- 构造工具

/** fake sessions：list 快照 {current, byId}（currentProvideInfo 缺席 → 走 list.current）。 */
function makeSessions(byId, current) {
  return { list: { getSnapshot: () => ({ current, byId }) } };
}

/** fake connection：models 按会话 id 分派；record 收集调用序。 */
function makeConnection(providerBySession, record, rejectSessions = []) {
  return {
    api: {
      sessions: {
        models: async (req) => {
          if (record) record.push(req.sessionId);
          if (rejectSessions.includes(req.sessionId)) {
            throw Object.assign(new Error(`session ${req.sessionId} rejects models: subagent busy`), { code: "agent-busy" });
          }
          return {
            result: { ok: true, value: { current: { provider: providerBySession[req.sessionId] ?? "prov-x" } } },
          };
        },
      },
    },
  };
}

/** 捕获 console.warn（返回恢复函数 + 记录数组）。 */
function captureWarn() {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}

// ---------------------------------------------------------------- 1) 子代理会话（models 拒绝）+ 父可解析 → 取父 provider

{
  // spawn 型：byId 行带 parentId（客户端 store 归一字段）
  const sessions = makeSessions(
    {
      "child-1": { origin: "subagent", parentId: "root-1" },
      "root-1": {},
    },
    "child-1",
  );
  const calls = [];
  const conn = makeConnection({ "root-1": "deepseek" }, calls, ["child-1"]);
  const warn = captureWarn();
  let got;
  try {
    got = await resolveProviderFromSession(sessions, conn);
  } finally {
    warn.restore();
  }
  assert.equal(got, "deepseek", "子代理 models 拒绝 → 上溯父会话取 provider");
  assert.deepEqual(calls, ["child-1", "root-1"], "先试自身再上溯父会话");
  assert.ok(
    warn.lines.some((l) => l.includes("agent-busy") && l.includes("child-1")),
    "agent-busy 抛错应记诊断日志",
  );
}

{
  // RPC 错误分支形态（{ok:false,error:{code:"agent-busy"}}，不抛错）同样诊断并上溯
  const sessions = makeSessions({ c: { parentId: "p" }, p: {} }, "c");
  const calls = [];
  const conn = {
    api: {
      sessions: {
        models: async (req) => {
          calls.push(req.sessionId);
          if (req.sessionId === "c") {
            return { result: { ok: false, error: { code: "agent-busy", message: "busy", details: { reason: "x" } } } };
          }
          return { result: { ok: true, value: { current: { provider: "openai" } } } };
        },
      },
    },
  };
  const warn = captureWarn();
  let got;
  try {
    got = await resolveProviderFromSession(sessions, conn);
  } finally {
    warn.restore();
  }
  assert.equal(got, "openai", "RPC 错误分支 agent-busy 同样继续上溯");
  assert.deepEqual(calls, ["c", "p"], "错误分支不中断上溯链");
  assert.ok(warn.lines.some((l) => l.includes("agent-busy")), "RPC 错误分支也应记诊断");
}

{
  // fork / wire 原名防御：行只带 parentSessionId（旧命名）→ 兼容上溯
  const sessions = makeSessions({ f: { origin: "subagent", parentSessionId: "main" }, main: {} }, "f");
  const conn = makeConnection({ main: "kimi" }, [], ["f"]);
  const got = await resolveProviderFromSession(sessions, conn);
  assert.equal(got, "kimi", "parentSessionId 命名兼容上溯");
}

// ---------------------------------------------------------------- 2) 全链失败：保持上次检测 + 未识别标注

{
  // 全链（自身 + 祖先）均拒绝 → undefined（兜底交给 decideProviderAfterDetect）
  const sessions = makeSessions(
    { s: { parentId: "m" }, m: { parentId: "g" }, g: {} },
    "s",
  );
  const conn = makeConnection({}, [], ["s", "m", "g"]);
  const got = await resolveProviderFromSession(sessions, conn);
  assert.equal(got, undefined, "全链失败返回 undefined");

  // 有历史检测 → 保持上次值且标注未识别
  const d1 = decideProviderAfterDetect({ resolved: undefined, hadSession: true, previousDetected: "deepseek" });
  assert.equal(d1.provider, "deepseek", "全链失败且有历史检测 → 保持上次检测值");
  assert.equal(d1.unknown, true, "有会话但不可解析 → 标注未知态");
  assert.ok(UNKNOWN_PROVIDER_HINT.includes("未识别"), "标注文案含「未识别」");

  // 从未成功检测过 → 才回落默认
  const d2 = decideProviderAfterDetect({ resolved: undefined, hadSession: true, previousDetected: undefined });
  assert.equal(d2.provider, FALLBACK_PROVIDER, "从未成功检测 → 回落默认 provider");
  assert.equal(FALLBACK_PROVIDER, "opencode-go", "回落值即内置 opencode-go");
  assert.equal(d2.unknown, true, "从未成功且会话在场 → 仍属未知态");
}

{
  // 客户端源码契约：title 标注接线真实存在（unknown 态追加「提供商未识别」）
  const src = readFileSync(join(here, "..", "src", "client", "index.ts"), "utf8");
  assert.ok(src.includes("UNKNOWN_PROVIDER_HINT"), "index.ts 应引用未识别标注常量");
  assert.ok(src.includes("if (providerUnknown)"), "胶囊 title 渲染应按 providerUnknown 追加标注");
  assert.ok(src.includes("decideProviderAfterDetect"), "detect() 应经纯函数决策兜底");
  assert.ok(!src.includes("detected ?? FALLBACK_PROVIDER"), "已移除对 FALLBACK 的无条件回落写法");
}

// ---------------------------------------------------------------- 3) 无任何会话 → 维持原回落行为（回归防护）

{
  // 无 sessions 服务 / 无当前会话 → 解析器直接 undefined，且不发起任何 models 调用
  const calls = [];
  const conn = makeConnection({}, calls);
  assert.equal(await resolveProviderFromSession(undefined, conn), undefined, "无 sessions → undefined");
  assert.equal(await resolveProviderFromSession(makeSessions({}, undefined), conn), undefined, "无 current → undefined");
  assert.equal(await resolveProviderFromSession(makeSessions({ a: {} }, ""), conn), undefined, "空串 current 视为无会话");
  assert.deepEqual(calls, [], "无会话场景不得调用 models");

  // 决策层：无任何会话一律回落默认（即使有历史检测也不沿用——维持原行为）
  const d1 = decideProviderAfterDetect({ resolved: undefined, hadSession: false, previousDetected: "deepseek" });
  assert.equal(d1.provider, FALLBACK_PROVIDER, "无会话 + 有历史 → 维持原回落（不用历史值）");
  assert.equal(d1.unknown, false, "无会话回落不算未知态（原行为无标注）");
  const d2 = decideProviderAfterDetect({ resolved: undefined, hadSession: false, previousDetected: undefined });
  assert.equal(d2.provider, FALLBACK_PROVIDER, "无会话 + 无历史 → 回落默认");
  assert.equal(d2.unknown, false, "无会话回落无标注");
}

// ---------------------------------------------------------------- 4) 上溯深度封顶 / 环防御

{
  // 环：a → b → a（visited 防环，链终止于 [a, b]）
  const cyc = makeSessions({ a: { parentId: "b" }, b: { parentId: "a" } }, "a");
  assert.deepEqual(sessionAncestryChain(cyc, "a"), ["a", "b"], "环链在 visited 处截断");
  // 自环：a → a
  const self = makeSessions({ a: { parentId: "a" } }, "a");
  assert.deepEqual(sessionAncestryChain(self, "a"), ["a"], "自环不重复探测");
  // 深链封顶：d → c → b → a，默认深度 3 只取三代
  const deep = makeSessions({ d: { parentId: "c" }, c: { parentId: "b" }, b: { parentId: "a" }, a: {} }, "d");
  assert.deepEqual(sessionAncestryChain(deep, "d"), ["d", "c", "b"], "默认封顶 MAX_ANCESTRY_DEPTH=3");
  assert.equal(MAX_ANCESTRY_DEPTH, 3, "封顶常量为 3（issue 方案 A）");
  assert.deepEqual(sessionAncestryChain(deep, "d", 1), ["d"], "自定义深度生效");
  assert.deepEqual(sessionAncestryChain(deep, "d", 0), [], "非法深度（<1）返回空链");
  // 快照缺失 / 断链 / 非字符串父 id → 单节点链
  assert.deepEqual(sessionAncestryChain(undefined, "x"), ["x"], "无 sessions → 仅自身");
  assert.deepEqual(sessionAncestryChain({}, "x"), ["x"], "无 list 快照 → 仅自身");
  assert.deepEqual(sessionAncestryChain(makeSessions({ x: {} }, "x"), "x"), ["x"], "断链 → 仅自身");
  assert.deepEqual(sessionAncestryChain(makeSessions({ x: { parentId: "" }, "": {} }, "x"), "x"), ["x"], "空串父 id 忽略");

  // 环链下解析器有限次调用后终止
  const calls = [];
  const conn = makeConnection({}, calls, ["a", "b"]);
  const got = await resolveProviderFromSession(cyc, conn);
  assert.equal(got, undefined, "环链全失败 → undefined");
  assert.ok(calls.length <= MAX_ANCESTRY_DEPTH, `环链探测次数被封顶（实际 ${calls.length}）`);
}

// ---------------------------------------------------------------- 5) ordinary 会话直连回归 + 边界

{
  // ordinary 会话（无 parentId）→ 直接解析成功，仅一次调用
  const sessions = makeSessions({ only: { origin: "user" } }, "only");
  const calls = [];
  const conn = makeConnection({ only: "opencode-go" }, calls);
  const got = await resolveProviderFromSession(sessions, conn);
  assert.equal(got, "opencode-go", "ordinary 会话直接解析");
  assert.deepEqual(calls, ["only"], "ordinary 不触发上溯（单次调用）");

  // currentProvideInfo 优先路径照旧生效
  const viaInfo = {
    currentProvideInfo: { getSnapshot: () => ({ sessionId: "info-sid" }) },
    list: { getSnapshot: () => ({ current: "list-sid", byId: {} }) },
  };
  assert.equal(currentSessionId(viaInfo), "info-sid", "currentProvideInfo 优先级不变");

  // models 缺失 / 非 ok 且非 agent-busy 错误码：不上溯报错、静默 undefined
  assert.equal(await resolveProviderFromSession(sessions, {} as never), undefined, "connection 无 models → undefined");
  const otherErr = {
    api: { sessions: { models: async () => { throw Object.assign(new Error("boom"), { code: "no-api-key" }); } } },
  };
  const warn = captureWarn();
  try {
    assert.equal(await resolveProviderFromSession(sessions, otherErr), undefined, "非 agent-busy 抛错 → undefined");
    assert.ok(!warn.lines.some((l) => l.includes("agent-busy")), "非 agent-busy 不记忙会话诊断");
  } finally {
    warn.restore();
  }

  // isAgentBusyError 形状覆盖
  assert.equal(isAgentBusyError(Object.assign(new Error("x"), { code: "agent-busy" })), true, "code 形态命中");
  assert.equal(isAgentBusyError(new Error("rejected: agent-busy here")), true, "message 内嵌命中");
  assert.equal(isAgentBusyError({ code: "agent-busy" }), true, "裸对象 code 命中");
  assert.equal(isAgentBusyError(new Error("other")), false, "普通错误不命中");
  assert.equal(isAgentBusyError(null), false, "null 不命中");
  assert.equal(isAgentBusyError("agent-busy"), false, "字符串不命中");
}

// ---------------------------------------------------------------- 6) 成功解析优先于上溯（首个成功者胜）

{
  // 自身即可解析（ordinary）→ 不再向上多打一次 models
  const sessions = makeSessions({ k: { parentId: "up" }, up: {} }, "k");
  const calls = [];
  const conn = makeConnection({ k: "prov-k" }, calls);
  const got = await resolveProviderFromSession(sessions, conn);
  assert.equal(got, "prov-k", "首个解析成功者胜");
  assert.deepEqual(calls, ["k"], "自身成功后不再上溯");
}

console.log("[unit-detect] 全部断言通过 ✓ (#69 provider 检测链)");
