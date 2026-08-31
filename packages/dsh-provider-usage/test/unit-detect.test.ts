// @ts-nocheck
/**
 * dsh-provider-usage — unit：provider 检测链（issue #69；#383 投影形状修正）。
 *
 * 覆盖：per-session modelSelection 投影（0.1.2 list 行拍平 projectionValues）读取
 * provider —— 子代理会话自身投影缺失时沿 parentId 上溯父会话投影取 provider、
 * 上溯深度封顶与环防御、全链投影缺失回落 ctx.remote.session.modelCatalog().default
 * 兜底、wire 形状（projections.values）不得被误读（#383 反向断言）、
 * 全链失败保持上次检测 + 「提供商未识别」标注决策、无任何会话维持原回落行为
 * （回归防护）、ordinary 会话直连解析回归。
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
  FALLBACK_PROVIDER,
  UNKNOWN_PROVIDER_HINT,
} = core;

// ---------------------------------------------------------------- 构造工具

/** fake sessions：list 快照 {current, byId}（0.1.2：current 来自 list 快照）。 */
function makeSessions(byId, current) {
  return { list: { getSnapshot: () => ({ current, byId }) } };
}

/**
 * 行投影小工具：构造 SessionSummary 防御式行（#383：拍平 projectionValues 形状）。
 * provider 缺省 → 行无 modelSelection 投影（模拟子代理/未解析会话）。
 */
function row(provider, opts = {}) {
  const { parentId, parentSessionId, origin, slot } = opts;
  const r = {};
  if (parentId !== undefined) r.parentId = parentId;
  if (parentSessionId !== undefined) r.parentSessionId = parentSessionId;
  if (origin !== undefined) r.origin = origin;
  if (provider !== undefined) {
    r.projectionValues = {
      modelSelection: {
        // 默认写入 lastUsed；slot:"next" 时只写 next（模拟待确认意图）
        ...(slot === "next" ? {} : { lastUsed: { provider, model: "model-x" } }),
        ...(slot === "next" ? { next: { provider, model: "model-x" } } : {}),
      },
    };
  }
  return r;
}

/** fake remote：modelCatalog 兜底；default 缺省 → 返回无 default 目录。 */
function makeRemote(providerByDefault) {
  return {
    session: {
      modelCatalog: async () => {
        if (providerByDefault === undefined) return { ok: false, error: { code: "no-catalog" } };
        return { ok: true, value: { default: { provider: providerByDefault, model: "model-d" } } };
      },
    },
  };
}

// ---------------------------------------------------------------- 1) 子代理会话（自身投影缺失）+ 父可解析 → 取父 provider

{
  // spawn 型：byId 行带 parentId（客户端 store 归一字段）；子代理无投影 → 上溯父投影
  const sessions = makeSessions(
    {
      "child-1": row(undefined, { origin: "subagent", parentId: "root-1" }),
      "root-1": row("deepseek"),
    },
    "child-1",
  );
  const got = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(got, "deepseek", "子代理无投影 → 上溯父会话投影取 provider");
}

{
  // fork / wire 原名防御：行只带 parentSessionId（旧命名）→ 兼容上溯
  const sessions = makeSessions(
    { f: row(undefined, { origin: "subagent", parentSessionId: "main" }), main: row("kimi") },
    "f",
  );
  const got = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(got, "kimi", "parentSessionId 命名兼容上溯");
}

{
  // 自身 next 槽（待确认意图）可解析：lastUsed 缺席时读 next
  const sessions = makeSessions({ own: row("prov-next", { slot: "next" }) }, "own");
  const got = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(got, "prov-next", "仅 next 槽存在 → 取 next provider");
}

{
  // lastUsed 优先于 next：两者并存时取 lastUsed（#383：拍平 projectionValues 形状）
  const sessions = makeSessions(
    {
      own: {
        projectionValues: {
          modelSelection: {
            lastUsed: { provider: "last-p", model: "a" },
            next: { provider: "next-p", model: "b" },
          },
        },
      },
    },
    "own",
  );
  const got = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(got, "last-p", "lastUsed 优先于 next");
}

{
  // #383 反向断言：wire 形状（projections.values）不得被误读——store 行只认拍平的
  // projectionValues；仅携带 wire 形状的行必须视为无投影 → 走 modelCatalog 兜底
  const sessions = makeSessions(
    {
      own: {
        projections: {
          asOfSeq: 7,
          values: { modelSelection: { lastUsed: { provider: "wire-p", model: "a" } } },
        },
      },
    },
    "own",
  );
  const got = await resolveProviderFromSession(sessions, makeRemote("catalog-fallback"));
  assert.equal(got, "catalog-fallback", "wire 形状（projections.values）不被读取 → 落兜底");
}

// ---------------------------------------------------------------- 2) 全链投影缺失：保持上次检测 + 未识别标注 / modelCatalog 兜底

{
  // 全链（自身 + 祖先）投影均缺失 → 兜底 modelCatalog().default
  const sessions = makeSessions(
    { s: row(undefined, { parentId: "m" }), m: row(undefined, { parentId: "g" }), g: row(undefined) },
    "s",
  );
  const got = await resolveProviderFromSession(sessions, makeRemote("catalog-default"));
  assert.equal(got, "catalog-default", "全链投影缺失 → modelCatalog().default 兜底");

  // 无 remote / modelCatalog 失败 → undefined（兜底语义交给 decideProviderAfterDetect）
  const noRemote = await resolveProviderFromSession(sessions, undefined);
  assert.equal(noRemote, undefined, "无 remote → undefined");
  const failRemote = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(failRemote, undefined, "modelCatalog 非 ok → undefined");

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
  // 客户端源码契约：title 标注接线真实存在（unknown 态追加「提供商未识别」；
  // issue #348 i18n 后标注经字典 t("providerUnknown")，常量本体留 core 供语义引用）
  const src = readFileSync(join(here, "..", "src", "client", "index.ts"), "utf8");
  assert.ok(src.includes('t("providerUnknown")'), "index.ts 应经 i18n 字典标注未识别");
  assert.ok(src.includes("if (providerUnknown)"), "胶囊 title 渲染应按 providerUnknown 追加标注");
  assert.ok(src.includes("decideProviderAfterDetect"), "detect() 应经纯函数决策兜底");
  assert.ok(!src.includes("detected ?? FALLBACK_PROVIDER"), "已移除对 FALLBACK 的无条件回落写法");
}

// ---------------------------------------------------------------- 3) 无任何会话 → 维持原回落行为（回归防护）

{
  // 无 sessions 服务 / 无当前会话 → 解析器直接 undefined，且不触发 modelCatalog
  let catalogCalls = 0;
  const remote = {
    session: {
      modelCatalog: async () => { catalogCalls += 1; return { ok: true, value: { default: { provider: "x" } } }; },
    },
  };
  assert.equal(await resolveProviderFromSession(undefined, remote), undefined, "无 sessions → undefined");
  assert.equal(await resolveProviderFromSession(makeSessions({}, undefined), remote), undefined, "无 current → undefined");
  assert.equal(await resolveProviderFromSession(makeSessions({ a: {} }, ""), remote), undefined, "空串 current 视为无会话");
  assert.equal(catalogCalls, 0, "无会话场景不得触发 modelCatalog");

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

  // 环链下解析器有限次调用后终止（投影全缺 → 兜底也被调用一次，不无限循环）
  const remote = makeRemote("default-ok");
  const got = await resolveProviderFromSession(cyc, remote);
  assert.equal(got, "default-ok", "环链全失败 → 落 modelCatalog 兜底");
}

// ---------------------------------------------------------------- 5) currentSessionId 边界 + ordinary 会话直连回归

{
  // current 会话 id 读取：0.1.2 仅走 list 快照 current（currentProvideInfo 已移除）
  assert.equal(currentSessionId(undefined), undefined, "无 sessions → undefined");
  assert.equal(currentSessionId(makeSessions({ a: {} }, "a")), "a", "list.current 直读");
  assert.equal(currentSessionId(makeSessions({}), undefined), undefined, "无 current → undefined");
  assert.equal(currentSessionId(makeSessions({ a: {} }, "")), undefined, "空串 current 视为无会话");

  // ordinary 会话（无 parentId）→ 直接解析成功（仅自身投影，无需上溯）
  const sessions = makeSessions({ only: row("opencode-go") }, "only");
  const got = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(got, "opencode-go", "ordinary 会话直接解析");
}

// ---------------------------------------------------------------- 6) 成功解析优先于上溯（首个成功者胜）

{
  // 自身即可解析（ordinary）→ 不再向上读投影
  const sessions = makeSessions(
    { k: row("prov-k", { parentId: "up" }), up: row("prov-up") },
    "k",
  );
  const got = await resolveProviderFromSession(sessions, makeRemote());
  assert.equal(got, "prov-k", "首个解析成功者胜");
}

console.log("[unit-detect] 全部断言通过 ✓ (#69 检测链；#383 projectionValues 形状修正)");