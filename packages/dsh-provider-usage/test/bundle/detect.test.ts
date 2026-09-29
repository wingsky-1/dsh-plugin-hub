/**
 * dsh-provider-usage — unit：provider 检测链（issue #69；#383 投影形状修正）。
 *
 * 覆盖：**当前会话判据**（rc.2 官方口径 `retainedBy.mainView > 0`；含「旧形状只有
 * `current` 无 mainView → 判不出」回归，#1028）、
 * per-session modelSelection 投影（list 行拍平 projectionValues）读取
 * provider —— 子代理会话自身投影缺失时沿 parentId 上溯父会话投影取 provider、
 * 上溯深度封顶与环防御、全链投影缺失回落 ctx.remote.session.modelCatalog().default
 * 兜底、wire 形状（projections.values）不得被误读（#383 反向断言）、
 * **next 优先于 lastUsed**（#383 追加：会话内切模型只更新 next，读 lastUsed 优先
 * 会滞留旧 provider）、
 * 全链失败保持上次检测 + 「提供商未识别」标注决策、无任何会话维持原回落行为
 * （回归防护）、ordinary 会话直连解析回归。
 *
 * 被测对象为 src/client/core.ts 真实源码：lib/client/*.js 由 bundle-host 按
 * 发布物边界清理（仅留顶层 index.js/client.js 与 .d.ts），故沿用 web-file-preview
 * 先例（该包已随 #840 退役，做法仍沿用）——用仓库 devDependency esbuild 把源码即时
 * 打成内存 ESM、经 data-URI 导入。
 * 无网络、无真实凭据、无 DOM。
 *
 * 结构：每个主题块一个 describe，每条断言一个 it；交错块在 beforeAll 内保留原动作
 * 顺序并逐点取观测快照（数组取拷贝，不存引用），it 只断言快照。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { pollUntil } from "../helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

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
  makeCatalogCache,
  defaultCatalogLoader,
  CATALOG_CACHE_TTL_MS,
} = core;

// ---------------------------------------------------------------- 构造工具

/**
 * fake sessions：**rc.2 真实快照形状** `{ids, byId, phase, projectionsBySession}`。
 *
 * rc.2 删掉了快照上的 `current` 字段——本夹具此前靠 `current` 造「当前会话」，
 * 那是一个 rc.2 根本不存在的形状，等于把同源 bug 一起锁进了测试（改对了代码测试反而判红）。
 * 现在改按**官方判据**造：`currentId` 指定的行带 `retainedBy.mainView = 1`
 * （官方 dsh-client-ui-workspace 的 retain 写入面、dsh-client-ui-session 的读取面），
 * 其余行 `retainedBy` 为空（`referenceCount: 0`，即非当前会话）。
 */
function makeSessions(byId: Record<string, unknown>, currentId?: string) {
  const rows: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(byId)) {
    const retainedBy = id === currentId ? { mainView: 1 } : {};
    rows[id] = {
      ...sessionRow(raw),
      id,
      retainedBy: { referenceCount: id === currentId ? 1 : 0, ...retainedBy },
    };
  }
  return {
    list: {
      getSnapshot: () => ({
        ids: Object.keys(rows),
        byId: rows,
        phase: "ready",
        projectionsBySession: {},
      }),
    },
  };
}

/**
 * 补齐官方 `SessionSummary` 的必填面（id / displayTitle / running / blank / updatedAt /
 * retainedBy 由 makeSessions 写），使每行都长得像 rc.2 真行而不是「只有被测字段」的空壳。
 * 用例可继续内联任意字段覆盖默认值。
 */
function sessionRow(raw: unknown): Record<string, unknown> {
  return {
    displayTitle: "session",
    running: false,
    blank: false,
    updatedAt: 0,
    ...(raw as Record<string, unknown>),
  };
}

/**
 * 旧形状快照（rc.2 已删 `current`，此形状只应出现在回归用例里）：
 * 有 `current`、无任何 mainView 引用者 → 判不出当前会话（官方口径不认 `current`）。
 */
function makeLegacyCurrentSessions(byId: Record<string, unknown>, current: string) {
  const rows: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(byId)) {
    rows[id] = { ...sessionRow(raw), id, retainedBy: { referenceCount: 0 } };
  }
  return { list: { getSnapshot: () => ({ current, ids: Object.keys(rows), byId: rows }) } };
}

/**
 * 行投影小工具：构造 SessionSummary 防御式行（#383：拍平 projectionValues 形状）。
 * provider 缺省 → 行无 modelSelection 投影（模拟子代理/未解析会话）。
 * 槽位语义（宿主 wire view：next = pending ?? lastUsed）：默认只写 lastUsed；
 * slot:"next" 只写 next（模拟仅待确认意图）；两者并存场景在用例内联构造。
 */
/** 行构造选项（归一字段 + 槽位语义）。 */
interface RowOpts {
  parentId?: string;
  parentSessionId?: string;
  origin?: string;
  slot?: string;
}
function row(provider: string | undefined, opts: RowOpts = {}) {
  const { parentId, parentSessionId, origin, slot } = opts;
  const r: Record<string, unknown> = {};
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
function makeRemote(providerByDefault?: string) {
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

describe("provider 检测链：子代理 / 父会话投影上溯（#69 / #383）", () => {
  it("子代理无投影 → 上溯父会话投影取 provider", async () => {
    // spawn 型：byId 行带 parentId（客户端 store 归一字段）；子代理无投影 → 上溯父投影
    const sessions = makeSessions(
      {
        "child-1": row(undefined, { origin: "subagent", parentId: "root-1" }),
        "root-1": row("deepseek"),
      },
      "child-1",
    );
    expect(await resolveProviderFromSession(sessions, makeRemote())).toBe("deepseek");
  });

  it("parentSessionId 命名兼容上溯", async () => {
    // fork / wire 原名防御：行只带 parentSessionId（旧命名）→ 兼容上溯
    const sessions = makeSessions(
      { f: row(undefined, { origin: "subagent", parentSessionId: "main" }), main: row("kimi") },
      "f",
    );
    expect(await resolveProviderFromSession(sessions, makeRemote())).toBe("kimi");
  });

  it("仅 next 槽存在 → 取 next provider", async () => {
    // 自身 next 槽（待确认意图）可解析：lastUsed 缺席时读 next
    const sessions = makeSessions({ own: row("prov-next", { slot: "next" }) }, "own");
    expect(await resolveProviderFromSession(sessions, makeRemote())).toBe("prov-next");
  });

  it("next 优先于 lastUsed（会话内切模型紧跟当前选择）", async () => {
    // next 优先于 lastUsed：两者并存时取 next（#383 追加根因——会话内切模型只更新
    // pending 的 next，lastUsed 等真正发请求才随动，读 lastUsed 优先造成「切模型不跟随」）
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
    expect(await resolveProviderFromSession(sessions, makeRemote())).toBe("next-p");
  });

  it("wire 形状（projections.values）不被读取 → 落兜底", async () => {
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
    expect(await resolveProviderFromSession(sessions, makeRemote("catalog-fallback"))).toBe(
      "catalog-fallback",
    );
  });
});

// ---------------------------------------------------------------- 2) 全链投影缺失：保持上次检测 + 未识别标注 / modelCatalog 兜底

describe("全链投影缺失：modelCatalog 兜底 + 保持上次检测 / 未识别标注", () => {
  let got: string | undefined;
  let noRemote: string | undefined;
  let failRemote: string | undefined;
  let d1: { provider: string; unknown: boolean };
  let d2: { provider: string; unknown: boolean };

  beforeAll(async () => {
    // 全链（自身 + 祖先）投影均缺失 → 兜底 modelCatalog().default
    const sessions = makeSessions(
      {
        s: row(undefined, { parentId: "m" }),
        m: row(undefined, { parentId: "g" }),
        g: row(undefined),
      },
      "s",
    );
    got = await resolveProviderFromSession(sessions, makeRemote("catalog-default"));
    // 无 remote / modelCatalog 失败 → undefined（兜底语义交给 decideProviderAfterDetect）
    noRemote = await resolveProviderFromSession(sessions, undefined);
    failRemote = await resolveProviderFromSession(sessions, makeRemote());
    // 有历史检测 → 保持上次值且标注未识别
    d1 = decideProviderAfterDetect({
      resolved: undefined,
      hadSession: true,
      previousDetected: "deepseek",
    });
    // 从未成功检测过 → 才回落默认
    d2 = decideProviderAfterDetect({
      resolved: undefined,
      hadSession: true,
      previousDetected: undefined,
    });
  });

  it("全链投影缺失 → modelCatalog().default 兜底", () => {
    expect(got).toBe("catalog-default");
  });

  it("无 remote → undefined", () => {
    expect(noRemote).toBeUndefined();
  });

  it("modelCatalog 非 ok → undefined", () => {
    expect(failRemote).toBeUndefined();
  });

  it("全链失败且有历史检测 → 保持上次检测值", () => {
    expect(d1.provider).toBe("deepseek");
  });

  it("有会话但不可解析 → 标注未知态", () => {
    expect(d1.unknown).toBe(true);
  });

  it("标注文案含「未识别」", () => {
    expect(UNKNOWN_PROVIDER_HINT.includes("未识别")).toBeTruthy();
  });

  it("从未成功检测 → 回落默认 provider", () => {
    expect(d2.provider).toBe(FALLBACK_PROVIDER);
  });

  it("回落值即内置 opencode-go", () => {
    expect(FALLBACK_PROVIDER).toBe("opencode-go");
  });

  it("从未成功且会话在场 → 仍属未知态", () => {
    expect(d2.unknown).toBe(true);
  });
});

// ---------------------------------------------------------------- 2b) 客户端源码契约：未识别标注接线

describe("客户端源码契约：title 标注接线真实存在（issue #348 i18n）", () => {
  // title 文案推导在 #732 拆到纯视图层 float-view.ts（index.tsx 只剩编排），
  // 故两条标注断言读 float-view.ts，接线断言读 index.tsx——两侧都锁，任一处断链即红。
  let src = "";
  let view = "";
  beforeAll(() => {
    src = readFileSync(join(here, "..", "..", "src", "client", "index.tsx"), "utf8");
    view = readFileSync(join(here, "..", "..", "src", "client", "float-view.ts"), "utf8");
  });

  it("float-view.ts 应经 i18n 字典标注未识别", () => {
    expect(view.includes('t("providerUnknown")')).toBeTruthy();
  });

  it("胶囊 title 渲染应按 providerUnknown 追加标注", () => {
    expect(view.includes("if (providerUnconfirmed)")).toBeTruthy();
  });

  it("index.tsx 应把 providerUnknown 态接入 title 推导", () => {
    expect(src.includes("pillTitle(stats, currentProvider, providerUnknown)")).toBeTruthy();
  });

  it("detect() 应经纯函数决策兜底", () => {
    expect(src.includes("decideProviderAfterDetect")).toBeTruthy();
  });

  it("已移除对 FALLBACK 的无条件回落写法", () => {
    expect(src.includes("detected ?? FALLBACK_PROVIDER")).toBeFalsy();
  });
});

// ---------------------------------------------------------------- 3) 无任何会话 → 维持原回落行为（回归防护）

describe("无任何会话 → 维持原回落行为（回归防护）", () => {
  let noSessions: string | undefined;
  let noMainView: string | undefined;
  let emptyId: string | undefined;
  let catalogCalls: number;
  let d1: { provider: string; unknown: boolean };
  let d2: { provider: string; unknown: boolean };

  beforeAll(async () => {
    // 无 sessions 服务 / 无当前会话 → 解析器直接 undefined，且不触发 modelCatalog
    let calls = 0;
    const remote = {
      session: {
        modelCatalog: async () => {
          calls += 1;
          return { ok: true, value: { default: { provider: "x" } } };
        },
      },
    };
    noSessions = await resolveProviderFromSession(undefined, remote);
    noMainView = await resolveProviderFromSession(makeSessions({}, undefined), remote);
    emptyId = await resolveProviderFromSession(makeSessions({ a: {} }, ""), remote);
    catalogCalls = calls;
    // 决策层：无任何会话一律回落默认（即使有历史检测也不沿用——维持原行为）
    d1 = decideProviderAfterDetect({
      resolved: undefined,
      hadSession: false,
      previousDetected: "deepseek",
    });
    d2 = decideProviderAfterDetect({
      resolved: undefined,
      hadSession: false,
      previousDetected: undefined,
    });
  });

  it("无 sessions → undefined", () => {
    expect(noSessions).toBeUndefined();
  });

  it("有行但无 mainView 引用者 → undefined", () => {
    expect(noMainView).toBeUndefined();
  });

  it("空串 id 视为无会话", () => {
    expect(emptyId).toBeUndefined();
  });

  it("无会话场景不得触发 modelCatalog", () => {
    expect(catalogCalls).toBe(0);
  });

  it("无会话 + 有历史 → 维持原回落（不用历史值）", () => {
    expect(d1.provider).toBe(FALLBACK_PROVIDER);
  });

  it("无会话回落不算未知态（原行为无标注）", () => {
    expect(d1.unknown).toBe(false);
  });

  it("无会话 + 无历史 → 回落默认", () => {
    expect(d2.provider).toBe(FALLBACK_PROVIDER);
  });

  it("无会话回落无标注", () => {
    expect(d2.unknown).toBe(false);
  });
});

// ---------------------------------------------------------------- 4) 上溯深度封顶 / 环防御

describe("上溯深度封顶 / 环防御", () => {
  let cycResult: string[];
  let selfResult: string[];
  let deepDefault: string[];
  let deepCustom1: string[];
  let deepCustom0: string[];
  let noSessionsChain: string[];
  let noListChain: string[];
  let brokenChain: string[];
  let emptyParentChain: string[];
  let cycResolved: string | undefined;

  beforeAll(async () => {
    // 环：a → b → a（visited 防环，链终止于 [a, b]）
    const cyc = makeSessions({ a: { parentId: "b" }, b: { parentId: "a" } }, "a");
    cycResult = [...sessionAncestryChain(cyc, "a")];
    // 自环：a → a
    const self = makeSessions({ a: { parentId: "a" } }, "a");
    selfResult = [...sessionAncestryChain(self, "a")];
    // 深链封顶：d → c → b → a，默认深度 3 只取三代
    const deep = makeSessions(
      { d: { parentId: "c" }, c: { parentId: "b" }, b: { parentId: "a" }, a: {} },
      "d",
    );
    deepDefault = [...sessionAncestryChain(deep, "d")];
    deepCustom1 = [...sessionAncestryChain(deep, "d", 1)];
    deepCustom0 = [...sessionAncestryChain(deep, "d", 0)];
    // 快照缺失 / 断链 / 非字符串父 id → 单节点链
    noSessionsChain = [...sessionAncestryChain(undefined, "x")];
    noListChain = [...sessionAncestryChain({}, "x")];
    brokenChain = [...sessionAncestryChain(makeSessions({ x: {} }, "x"), "x")];
    emptyParentChain = [
      ...sessionAncestryChain(makeSessions({ x: { parentId: "" }, "": {} }, "x"), "x"),
    ];
    // 环链下解析器有限次调用后终止（投影全缺 → 兜底也被调用一次，不无限循环）
    cycResolved = await resolveProviderFromSession(cyc, makeRemote("default-ok"));
  });

  it("环链在 visited 处截断", () => {
    expect(cycResult).toEqual(["a", "b"]);
  });

  it("自环不重复探测", () => {
    expect(selfResult).toEqual(["a"]);
  });

  it("默认封顶 MAX_ANCESTRY_DEPTH=3", () => {
    expect(deepDefault).toEqual(["d", "c", "b"]);
  });

  it("封顶常量为 3（issue 方案 A）", () => {
    expect(MAX_ANCESTRY_DEPTH).toBe(3);
  });

  it("自定义深度生效", () => {
    expect(deepCustom1).toEqual(["d"]);
  });

  it("非法深度（<1）返回空链", () => {
    expect(deepCustom0).toEqual([]);
  });

  it("无 sessions → 仅自身", () => {
    expect(noSessionsChain).toEqual(["x"]);
  });

  it("无 list 快照 → 仅自身", () => {
    expect(noListChain).toEqual(["x"]);
  });

  it("断链 → 仅自身", () => {
    expect(brokenChain).toEqual(["x"]);
  });

  it("空串父 id 忽略", () => {
    expect(emptyParentChain).toEqual(["x"]);
  });

  it("环链全失败 → 落 modelCatalog 兜底", () => {
    expect(cycResolved).toBe("default-ok");
  });
});

// ---------------------------------------------------------------- 5) currentSessionId 边界 + ordinary 会话直连回归

describe("currentSessionId 边界 + ordinary 会话直连回归", () => {
  it("无 sessions → undefined", () => {
    expect(currentSessionId(undefined)).toBeUndefined();
  });

  it("官方判据：retainedBy.mainView > 0 的行即当前会话", () => {
    // 当前会话读取走官方口径：byId 里 mainView 引用计数 > 0 的那一行。
    // （rc.2 起 ISessions 没有任何「当前会话」访问器，mainView 是唯一判据。）
    const sessions = makeSessions({ a: {}, b: {} }, "b");
    expect(currentSessionId(sessions)).toBe("b");
  });

  it("无 mainView 引用者 → undefined", () => {
    // 全部行 retainedBy 为空（referenceCount 0）时没有当前会话。
    expect(currentSessionId(makeSessions({ a: {}, b: {} }))).toBeUndefined();
    expect(currentSessionId(makeSessions({}))).toBeUndefined();
  });

  it("mainView 计数为 0 不算当前会话（判据是 > 0 而非存在）", () => {
    // 官方 retainedBy 只记正计数来源，但判据本身仍按 > 0 读：显式写 0 必须判不出。
    const snapshot = makeSessions({ a: {} });
    (
      snapshot.list.getSnapshot() as {
        byId: Record<string, { retainedBy: Record<string, number> }>;
      }
    ).byId.a.retainedBy.mainView = 0;
    expect(currentSessionId(snapshot)).toBeUndefined();
  });

  it("空串 id 视为无会话", () => {
    // 防御：currentId 传空串时没有行匹配 → 无 mainView 引用者。
    expect(currentSessionId(makeSessions({ a: {} }, ""))).toBeUndefined();
  });

  it("旧形状（只有 current 无 mainView）→ 判不出当前会话（rc.2 回归）", () => {
    // #1028 回归：rc.2 删掉了快照上的 `current`。读面若仍认 `current`，宿主真实快照里
    // 这个字段不存在 → 恒 undefined → 检测半区恒回落 opencode-go。此用例把该形状钉死：
    // 快照即便带着 `current`，只要没有官方 mainView 引用者，就判不出当前会话。
    const legacy = makeLegacyCurrentSessions({ a: row("opencode-go") }, "a");
    expect(currentSessionId(legacy)).toBeUndefined();
  });

  it("ordinary 会话直接解析", async () => {
    // ordinary 会话（无 parentId）→ 直接解析成功（仅自身投影，无需上溯）
    const sessions = makeSessions({ only: row("opencode-go") }, "only");
    expect(await resolveProviderFromSession(sessions, makeRemote())).toBe("opencode-go");
  });
});

// ---------------------------------------------------------------- 6) 成功解析优先于上溯（首个成功者胜）

describe("成功解析优先于上溯（首个成功者胜）", () => {
  it("首个解析成功者胜", async () => {
    // 自身即可解析（ordinary）→ 不再向上读投影
    const sessions = makeSessions(
      { k: row("prov-k", { parentId: "up" }), up: row("prov-up") },
      "k",
    );
    expect(await resolveProviderFromSession(sessions, makeRemote())).toBe("prov-k");
  });
});

// ---------------------------------------------------------------- 7) modelCatalog 兜底缓存（#419：官方 catalog 同款）

describe("#419 modelCatalog 兜底缓存：重复 detect 命中缓存", () => {
  let a: string | undefined;
  let b: string | undefined;
  let c: string | undefined;
  let calls: number;

  beforeAll(async () => {
    // 重复 detect（全链投影缺失）→ 缓存命中，RPC 只打一次
    let n = 0;
    const remote = {
      session: {
        modelCatalog: async () => {
          n += 1;
          return { ok: true, value: { default: { provider: "cached-p" } } };
        },
      },
    };
    const cache = makeCatalogCache();
    const sessions = makeSessions({ s: row(undefined) }, "s");
    a = await resolveProviderFromSession(sessions, remote, cache.load);
    b = await resolveProviderFromSession(sessions, remote, cache.load);
    c = await resolveProviderFromSession(sessions, remote, cache.load);
    calls = n;
  });

  it("首次兜底解析成功", () => {
    expect(a).toBe("cached-p");
  });

  it("重复检测缓存命中", () => {
    expect(b).toBe("cached-p");
  });

  it("第三次仍命中", () => {
    expect(c).toBe("cached-p");
  });

  it("三次检测只打一次 modelCatalog RPC（缓存收敛）", () => {
    expect(calls).toBe(1);
  });
});

describe("#419 modelCatalog 兜底缓存：并发共享 inflight", () => {
  let results: Array<string | undefined>;
  let calls: number;

  beforeAll(async () => {
    // 并发共享 inflight：同一时刻多个检测只打一次 RPC
    let n = 0;
    const remote = {
      session: {
        modelCatalog: async () => {
          n += 1;
          return { ok: true, value: { default: { provider: "inflight-p" } } };
        },
      },
    };
    const cache = makeCatalogCache();
    const sessions = makeSessions({ s: row(undefined) }, "s");
    results = await Promise.all([
      resolveProviderFromSession(sessions, remote, cache.load),
      resolveProviderFromSession(sessions, remote, cache.load),
      resolveProviderFromSession(sessions, remote, cache.load),
    ]);
    calls = n;
  });

  it("并发检测全部解析成功", () => {
    expect(results).toEqual(["inflight-p", "inflight-p", "inflight-p"]);
  });

  it("并发检测共享同一 inflight（官方 Catalog.load 语义）", () => {
    expect(calls).toBe(1);
  });
});

describe("#419 modelCatalog 兜底缓存：失败不缓存 + reset 重拉", () => {
  let first: string | undefined;
  let second: string | undefined;
  let callsAfterRetry: number;
  let beforeReset: number;
  let callsAfterReset: number;

  beforeAll(async () => {
    // 失败不缓存：下次重试；reset 后重拉
    let calls = 0;
    const remote = {
      session: {
        modelCatalog: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, error: { code: "boom" } };
          return { ok: true, value: { default: { provider: "ok-p" } } };
        },
      },
    };
    const cache = makeCatalogCache();
    const sessions = makeSessions({ s: row(undefined) }, "s");
    first = await resolveProviderFromSession(sessions, remote, cache.load);
    second = await resolveProviderFromSession(sessions, remote, cache.load);
    callsAfterRetry = calls;
    // reset 后（provider 检测结果变化挂点）强制重拉
    beforeReset = calls;
    await resolveProviderFromSession(sessions, remote, cache.load);
    cache.reset();
    await resolveProviderFromSession(sessions, remote, cache.load);
    callsAfterReset = calls;
  });

  it("失败 → undefined", () => {
    expect(first).toBeUndefined();
  });

  it("失败不缓存 → 下次重试成功", () => {
    expect(second).toBe("ok-p");
  });

  it("失败帧不写入缓存", () => {
    expect(callsAfterRetry).toBe(2);
  });

  it("reset 后再次裸调", () => {
    expect(callsAfterReset).toBe(beforeReset + 1);
  });
});

describe("#419 modelCatalog 兜底缓存：TTL 过期重拉", () => {
  let calls: number;

  beforeAll(async () => {
    // TTL 过期 → 重拉；TTL 常量对齐宿主 stats 缓存量级（30s）
    // #629 P3：原固定 sleep(60) 改流逝时间条件等待——t0 先于首次调用采集，
    // pollUntil 等到「流逝 > TTL(50ms)+余量」才做第二次调用（条件必然出现、
    // 与时钟相位无关，慢 runner 下只会更晚、不会过早）。
    let n = 0;
    const remote = {
      session: {
        modelCatalog: async () => {
          n += 1;
          return { ok: true, value: { default: { provider: "ttl-p" } } };
        },
      },
    };
    const cache = makeCatalogCache(50); // 短 TTL 便于测试
    const sessions = makeSessions({ s: row(undefined) }, "s");
    const t0 = Date.now();
    await resolveProviderFromSession(sessions, remote, cache.load);
    await pollUntil(() => Date.now() - t0 > 100, 5000, 1); // 流逝 100ms > TTL 50ms：缓存必已过期
    await resolveProviderFromSession(sessions, remote, cache.load);
    calls = n;
  });

  it("TTL 过期后重拉", () => {
    expect(calls).toBe(2);
  });

  it("默认 TTL 30s（与宿主 stats 缓存同量级）", () => {
    expect(CATALOG_CACHE_TTL_MS).toBe(30000);
  });
});

describe("#419 默认 loader（无缓存）语义不变", () => {
  let first: string | undefined;
  let second: string | undefined;
  let calls: number;
  let noRemote: string | undefined;
  let noCatalog: string | undefined;

  beforeAll(async () => {
    // 默认 loader（无缓存）语义不变：裸调 remote
    let n = 0;
    const remote = {
      session: {
        modelCatalog: async () => {
          n += 1;
          return { ok: true, value: { default: { provider: "bare-p" } } };
        },
      },
    };
    first = await defaultCatalogLoader(remote);
    second = await defaultCatalogLoader(remote);
    calls = n;
    noRemote = await defaultCatalogLoader(undefined);
    noCatalog = await defaultCatalogLoader({ session: {} });
  });

  it("默认 loader 解析 default.provider", () => {
    expect(first).toBe("bare-p");
  });

  it("重复调用仍裸调", () => {
    expect(second).toBe("bare-p");
  });

  it("默认 loader 每次裸调（无缓存语义）", () => {
    expect(calls).toBe(2);
  });

  it("无 remote → undefined", () => {
    expect(noRemote).toBeUndefined();
  });

  it("无 modelCatalog → undefined", () => {
    expect(noCatalog).toBeUndefined();
  });
});
