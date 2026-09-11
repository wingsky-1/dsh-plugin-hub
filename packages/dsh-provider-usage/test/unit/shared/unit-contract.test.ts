// @ts-nocheck
/**
 * dsh-provider-usage — unit：契约辅助纯函数。
 *
 * 覆盖：safeSegment（路径安全段）、sseData（SSE 序列化）、
 * parseUserAdapters（防御式解析）、summarizeTextFromWindows /
 * levelFromWindows（v1 废弃但保留的辅助函数）、esc（HTML 转义）、
 * isUsageStatsAdapter / describeUsageStatsAdapterShape（v2 契约校验全分支，
 * #150 变异驱动加固）。
 */
console.error("EVAL-ORDER-TAG: CONTRACT");
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import {
  safeSegment,
  sseData,
  parseUserAdapters,
  summarizeTextFromWindows,
  levelFromWindows,
  esc,
  isUsageStatsAdapter,
  describeUsageStatsAdapterShape,
  ADAPTER_CONTRACT_VERSION,
  ERROR_CODES,
} from "../../../src/apply/index.ts";
import { makeAdapterRegistry, sanitizeHtml, safeFetchData, safeFormat,
  runV2Pipeline, runV2PanelPipeline, HistoryStore,
  HotReloadableAdapter, readStamp, stampEqual, miniChartSvgMarkup,
  OPENCODE_GO_PROVIDER } from "../../../src/apply/index.ts";

describe("safeSegment", () => {
  it("字母数字连字符原样保留", () => {
    expect(safeSegment("hello-world")).toBe("hello-world");
  });

  it("点和下划线保留", () => {
    expect(safeSegment("a.b_c")).toBe("a.b_c");
  });

  it("路径分隔符替换为下划线", () => {
    expect(safeSegment("a/b\\c")).toBe("a_b_c");
  });

  it("空白字符替换为下划线", () => {
    expect(safeSegment("a b\tc")).toBe("a_b_c");
  });

  it("非 ASCII 字符与路径分隔符全替换为下划线", () => {
    expect(safeSegment("中文/测试")).toBe("_____");
  });

  it("空字符串回退 unknown", () => {
    expect(safeSegment("")).toBe("unknown");
  });

  it("全部特殊字符替换为下划线", () => {
    expect(safeSegment("!@#$%^")).toBe("______");
  });
});

describe("sseData", () => {
  it("JSON SSE 序列化", () => {
    expect(sseData({ a: 1 })).toBe("data: {\"a\":1}\n\n");
  });

  it("字符串 SSE 带转义", () => {
    expect(sseData("hello")).toBe("data: \"hello\"\n\n");
  });

  it("数组 SSE 序列化", () => {
    expect(sseData([1, 2, 3])).toBe("data: [1,2,3]\n\n");
  });

  it("null SSE 序列化", () => {
    expect(sseData(null)).toBe("data: null\n\n");
  });
});

// #472 收敛锚定：lib/index.js 的 sseData（re-export 自 shared/host-utils.js）
// 输出与 shared 单一事实源一致（防 re-export 链被误删/改指后导出面漂移）。
describe("sseData 与 shared 单一事实源一致（#472）", () => {
  let sharedSseData;

  beforeAll(async () => {
    ({ sseData: sharedSseData } = await import("../../../../../shared/host-utils.js"));
  });

  it("lib/index.js 可 import sseData", () => {
    expect(typeof sseData).toBe("function");
  });

  it("lib 导出与 shared 输出一致", () => {
    expect(sseData({ type: "ui-config-changed" })).toBe(sharedSseData({ type: "ui-config-changed" }));
  });
});

describe("parseUserAdapters", () => {
  it("undefined 返回空数组", () => {
    expect(parseUserAdapters(undefined)).toEqual([]);
  });

  it("空字符串返回空数组", () => {
    expect(parseUserAdapters("")).toEqual([]);
  });

  it("非法 JSON 返回空数组", () => {
    expect(parseUserAdapters("not json")).toEqual([]);
  });

  it("裸数组（非对象）返回空数组", () => {
    expect(parseUserAdapters("[]")).toEqual([]);
  });

  it("adapters 非数组返回空数组", () => {
    expect(parseUserAdapters('{"adapters": "not array"}')).toEqual([]);
  });

  it("合法条目解析", () => {
    expect(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1"],"file":"/x.mjs"}]}')).toEqual([
      { id: "a", label: "a", providers: ["p1"], file: "/x.mjs" },
    ]);
  });

  it("空 id 条目丢弃", () => {
    expect(parseUserAdapters('{"adapters": [{"id":"","providers":["p1"],"file":"/x.mjs"}]}')).toEqual([]);
  });

  it("空 providers 条目丢弃", () => {
    expect(parseUserAdapters('{"adapters": [{"id":"a","providers":[],"file":"/x.mjs"}]}')).toEqual([]);
  });

  it("空 file 条目丢弃", () => {
    expect(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1"],"file":""}]}')).toEqual([]);
  });

  it("label 保留", () => {
    expect(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1"],"file":"/x.mjs","label":"My Adp"}]}')).toEqual([
      { id: "a", label: "My Adp", providers: ["p1"], file: "/x.mjs" },
    ]);
  });

  it("空 provider 字符串过滤", () => {
    expect(parseUserAdapters('{"adapters": [{"id":"a","providers":["p1",""],"file":"/x.mjs"}]}')).toEqual([
      { id: "a", label: "a", providers: ["p1"], file: "/x.mjs" },
    ]);
  });
});

describe("summarizeTextFromWindows (deprecated)", () => {
  it("undefined 窗口返回空", () => {
    expect(summarizeTextFromWindows(undefined)).toBe("");
  });

  it("空数组返回空", () => {
    expect(summarizeTextFromWindows([])).toBe("");
  });

  it("单窗口百分比展示", () => {
    expect(summarizeTextFromWindows([{ key: "5h", name: "5h 滚动", percent: 5 }])).toBe("5h 滚动 5%");
  });

  it("整百分比无小数", () => {
    expect(summarizeTextFromWindows([{ key: "w", name: "每周", percent: 80 }])).toBe("每周 80%");
  });

  it("null 百分比显示 --", () => {
    expect(summarizeTextFromWindows([{ key: "r", name: "5h 滚动", percent: 5 }, { key: "w", name: "每周", percent: null }]))
      .toBe("5h 滚动 5% · 每周 --");
  });
});

describe("levelFromWindows (deprecated)", () => {
  it("undefined 窗口返回 off", () => {
    expect(levelFromWindows(undefined)).toBe("off");
  });

  it("空数组返回 off", () => {
    expect(levelFromWindows([])).toBe("off");
  });

  it("10% → ok", () => {
    expect(levelFromWindows([{ key: "r", percent: 10 }])).toBe("ok");
  });

  it("80% → warn", () => {
    expect(levelFromWindows([{ key: "r", percent: 80 }])).toBe("warn");
  });

  it("95% → err", () => {
    expect(levelFromWindows([{ key: "r", percent: 95 }])).toBe("err");
  });

  it("100% → err", () => {
    expect(levelFromWindows([{ key: "r", percent: 100 }])).toBe("err");
  });

  it("null 百分比 → off", () => {
    expect(levelFromWindows([{ key: "r", percent: null }])).toBe("off");
  });

  it("多窗口取最差（90 → warn，≥80 即为 warn）", () => {
    expect(levelFromWindows([{ key: "r", percent: 10 }, { key: "w", percent: 90 }])).toBe("warn");
  });

  it("非数组输入返回 off（#150）", () => {
    expect(levelFromWindows("not array" as unknown as Parameters<typeof levelFromWindows>[0])).toBe("off");
  });

  it("79.9 < 80 → ok 边界（#150）", () => {
    expect(levelFromWindows([{ key: "r", percent: 79.9 }])).toBe("ok");
  });

  it("94.9 < 95 → warn 边界（#150）", () => {
    expect(levelFromWindows([{ key: "r", percent: 94.9 }])).toBe("warn");
  });

  it("缺 percent 字段 → off（#150）", () => {
    expect(levelFromWindows([{ key: "r" }])).toBe("off");
  });

  it("null 混合窗口只计数值项（#150）", () => {
    expect(levelFromWindows([{ key: "r", percent: 30 }, { key: "w", percent: null }])).toBe("ok");
  });
});

describe("esc（#150）", () => {
  it("null 转义为空串", () => {
    expect(esc(null)).toBe("");
  });

  it("undefined 转义为空串", () => {
    expect(esc(undefined)).toBe("");
  });

  it("空字符串原样", () => {
    expect(esc("")).toBe("");
  });

  it("无特殊字符原样", () => {
    expect(esc("plain")).toBe("plain");
  });

  it("尖括号转义", () => {
    expect(esc("<a>")).toBe("&lt;a&gt;");
  });

  it("双引号转义", () => {
    expect(esc('a"b')).toBe("a&quot;b");
  });

  it("单引号转义", () => {
    expect(esc("a'b")).toBe("a&#39;b");
  });

  it("与号转义", () => {
    expect(esc("a&b")).toBe("a&amp;b");
  });

  it("五类实体一次全转义", () => {
    expect(esc('<script>&"\'</script>')).toBe("&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
  });

  it("数字经 String() 后转义", () => {
    expect(esc(42)).toBe("42");
  });

  it("布尔经 String() 后转义", () => {
    expect(esc(true)).toBe("true");
  });
});

function validAdapter(): Record<string, unknown> {
  return {
    version: ADAPTER_CONTRACT_VERSION,
    name: "my-adapter",
    providers: ["p1"],
    fetchData: () => {},
    formatCapsule: () => "",
    formatPanel: () => "",
  };
}

describe("isUsageStatsAdapter 全条件穷举（#150）", () => {
  it("完整合法对象通过校验", () => {
    expect(isUsageStatsAdapter(validAdapter())).toBe(true);
  });

  // 非对象侧
  it("null 拒绝", () => {
    expect(isUsageStatsAdapter(null)).toBe(false);
  });

  it("undefined 拒绝", () => {
    expect(isUsageStatsAdapter(undefined)).toBe(false);
  });

  it("数字拒绝", () => {
    expect(isUsageStatsAdapter(42)).toBe(false);
  });

  it("字符串拒绝", () => {
    expect(isUsageStatsAdapter("str")).toBe(false);
  });

  it("数组（无 version 字段）拒绝", () => {
    expect(isUsageStatsAdapter([])).toBe(false);
  });

  // version 条件两侧
  it("version=1（旧契约版本）拒绝", () => {
    const a = validAdapter();
    a.version = 1;
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("version 为字符串严格比较拒绝", () => {
    const a = validAdapter();
    a.version = "2";
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("缺 version 拒绝", () => {
    const a = validAdapter();
    delete a.version;
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  // name 条件：类型 / 最短长度 / 正则白名单 / 最长长度
  it("name 非字符串拒绝", () => {
    const a = validAdapter();
    a.name = 123;
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("name 单字符拒绝（length>=2）", () => {
    const a = validAdapter();
    a.name = "a";
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("name 两字符通过（regex 下界）", () => {
    const a = validAdapter();
    a.name = "ab";
    expect(isUsageStatsAdapter(a)).toBe(true);
  });

  it("name 64 字符通过（regex 上界）", () => {
    const a = validAdapter();
    a.name = "a".repeat(64);
    expect(isUsageStatsAdapter(a)).toBe(true);
  });

  it("name 65 字符拒绝（regex 上界外）", () => {
    const a = validAdapter();
    a.name = "a".repeat(65);
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("name 含空格拒绝（白名单外）", () => {
    const a = validAdapter();
    a.name = "a b";
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("name 含中文拒绝（白名单外）", () => {
    const a = validAdapter();
    a.name = "适配器";
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  // providers 条件：非数组 / 空数组 / 元素类型 / 空串元素
  it("providers 非数组拒绝", () => {
    const a = validAdapter();
    a.providers = "p1";
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("providers 空数组拒绝", () => {
    const a = validAdapter();
    a.providers = [];
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("providers 元素非字符串拒绝", () => {
    const a = validAdapter();
    a.providers = [1];
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("providers 空串元素拒绝", () => {
    const a = validAdapter();
    a.providers = [""];
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  it("providers 多元素含空串拒绝", () => {
    const a = validAdapter();
    a.providers = ["p1", ""];
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  // 三函数条件
  for (const fn of ["fetchData", "formatCapsule", "formatPanel"] as const) {
    it(`缺 ${fn} 拒绝`, () => {
      const a = validAdapter();
      delete a[fn];
      expect(isUsageStatsAdapter(a)).toBe(false);
    });

    it(`${fn} 非函数拒绝`, () => {
      const b = validAdapter();
      b[fn] = "not-fn";
      expect(isUsageStatsAdapter(b)).toBe(false);
    });
  }
});

describe("describeUsageStatsAdapterShape 全分支（#150）", () => {
  it("null 描述文案", () => {
    expect(describeUsageStatsAdapterShape(null)).toBe("导出不是对象（null）");
  });

  it("undefined 描述文案", () => {
    expect(describeUsageStatsAdapterShape(undefined)).toBe("导出不是对象（undefined）");
  });

  it("number 描述文案", () => {
    expect(describeUsageStatsAdapterShape(42)).toBe("导出不是对象（number）");
  });

  it("string 描述文案", () => {
    expect(describeUsageStatsAdapterShape("s")).toBe("导出不是对象（string）");
  });

  it("合法形状返回 null", () => {
    expect(describeUsageStatsAdapterShape(validAdapter())).toBe(null);
  });

  it("全缺时六项按序合并", () => {
    expect(describeUsageStatsAdapterShape({})).toBe([
      "version 必须 === 2（实际 undefined）",
      "name（2-64 位字母数字下划线连字符）",
      "providers（非空字符串数组）",
      "fetchData（函数）",
      "formatCapsule（函数）",
      "formatPanel（函数）",
    ].join("、"));
  });

  it("version 错误含期望值与实际值", () => {
    const a = validAdapter();
    a.version = 3;
    const detail = describeUsageStatsAdapterShape(a);
    expect(detail !== null && detail.startsWith("version 必须 === 2（实际 3）")).toBeTruthy();
  });

  it("仅 version 缺陷时不报 name", () => {
    const a = validAdapter();
    a.version = 3;
    const detail = describeUsageStatsAdapterShape(a);
    expect(detail !== null && !detail.includes("name")).toBeTruthy();
  });

  it("name 白名单外的明细文案", () => {
    const a = validAdapter();
    a.name = "x!";
    expect(describeUsageStatsAdapterShape(a)?.includes("name（2-64 位字母数字下划线连字符）") === true).toBeTruthy();
  });
});

describe("ERROR_CODES 全量清单（#150 分片 2）", () => {
  it("错误码清单逐项锁定（顺序与内容均不可变）", () => {
    expect(ERROR_CODES).toEqual([
      "no-provider",
      "no-adapter",
      "no-enabled-adapter",
      "no-api-key",
      "unauthorized",
      "timeout",
      "network",
      "bad-data",
      "bad-json",
      "adapter-load-failed",
      "adapter-crash",
      "adapter-timeout",
    ]);
  });
});

describe("isUsageStatsAdapter 补充边界（#150 分片 2）", () => {
  // String 包装对象：typeof 非 string，但 .length 与 regex.test 均可通过，
  // 用于区分「typeof name 恒真」类变异（后续检查全部放行的伪装类型）
  it("name 为 String 包装对象拒绝（严格 typeof）", () => {
    const a = validAdapter();
    a.name = new String("abc");
    expect(isUsageStatsAdapter(a)).toBe(false);
  });

  // 元素为非字符串但带 length 的值：every 回调 typeof 恒真变异下会放行
  it("providers 元素为数组（length>0 非字符串）拒绝", () => {
    const a = validAdapter();
    a.providers = [[1, 2]];
    expect(isUsageStatsAdapter(a)).toBe(false);
  });
});

describe("describeUsageStatsAdapterShape 补充边界（#150 分片 2）", () => {
  // 头部非法尾部合法：regex 去 ^ 锚变异后不再报 name 缺失
  it("name 头部白名单外仍报缺失（锚点 ^ 必需）", () => {
    const a = validAdapter();
    a.name = "!!ab";
    expect(describeUsageStatsAdapterShape(a)?.includes("name（") === true).toBeTruthy();
  });

  // 头部合法尾部非法：regex 去 $ 锚变异后不再报 name 缺失
  it("name 尾部白名单外仍报缺失（锚点 $ 必需）", () => {
    const a = validAdapter();
    a.name = "ab!!";
    expect(describeUsageStatsAdapterShape(a)?.includes("name（") === true).toBeTruthy();
  });

  // 其余字段全合法、仅 providers 空数组：length===0 判定不可移除
  it("空 providers 在其余字段合法时单独报缺失", () => {
    const d = describeUsageStatsAdapterShape({
      version: ADAPTER_CONTRACT_VERSION,
      name: "ok-name",
      providers: [],
      fetchData: () => {},
      formatCapsule: () => {},
      formatPanel: () => {},
    });
    expect(d !== null && d.includes("providers（非空字符串数组）")).toBeTruthy();
  });
});

// ================================================================ #150 二阶段：registry 全分支矩阵

/** 构造合法 v2 适配器（可覆写字段）。 */
function mkAdapter(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ADAPTER_CONTRACT_VERSION,
    name: "adapter-a",
    label: "Adapter A",
    providers: ["prov-x"],
    fetchData: async () => ({}),
    formatCapsule: () => "<span>a</span>",
    formatPanel: () => "<p>a</p>",
    ...over,
  };
}

describe("registry：register 契约失败分支（带 file / 无 file 两种诊断路径）", () => {
  let builtinRejected, userFileRejected;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    builtinRejected = reg.register({ version: 1 }, "builtin");
    const withFile = makeAdapterRegistry();
    userFileRejected = withFile.register({ foo: 1 }, "user-file", "/tmp/x.mjs");
  });

  it("契约不满足拒绝注册", () => {
    expect(builtinRejected).toBe(false);
  });

  it("用户文件契约失败返回 false", () => {
    expect(userFileRejected).toBe(false);
  });
});

describe("registry：name 重复拒绝 + registeredNames 隔离", () => {
  let firstRegister, hasNameAfterFirst, secondRegister, entryProvY;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    firstRegister = reg.register(mkAdapter(), "builtin");
    hasNameAfterFirst = reg.hasName("adapter-a");
    // 同 name 不同 provider 的第二个适配器仍被拒（name 全局唯一）
    secondRegister = reg.register(mkAdapter({ providers: ["prov-y"] }), "builtin");
    entryProvY = reg.getEntry("prov-y");
  });

  it("首次注册成功", () => {
    expect(firstRegister).toBe(true);
  });

  it("hasName 注册后为真", () => {
    expect(hasNameAfterFirst).toBe(true);
  });

  it("同 name 跨 provider 也拒", () => {
    expect(secondRegister).toBe(false);
  });

  it("被拒者未进入候选", () => {
    expect(entryProvY).toBe(undefined);
  });
});

describe("registry：enabledHint=false 只入候选不启用", () => {
  let reg, registerResult, entryBeforeSelect, hasCandidates, isEnabledBeforeSelect, selectResult, isEnabledAfterSelect;

  beforeAll(() => {
    reg = makeAdapterRegistry();
    registerResult = reg.register(mkAdapter(), "user-file", "/f.mjs", false);
    entryBeforeSelect = reg.getEntry("prov-x");
    hasCandidates = reg.hasCandidates("prov-x");
    isEnabledBeforeSelect = reg.isEnabled("prov-x", "adapter-a");
    selectResult = reg.select("prov-x", "adapter-a");
    isEnabledAfterSelect = reg.isEnabled("prov-x", "adapter-a");
  });

  it("enabledHint=false 注册成功", () => {
    expect(registerResult).toBe(true);
  });

  it("未成为启用条目", () => {
    expect(entryBeforeSelect).toBe(undefined);
  });

  it("候选仍在", () => {
    expect(hasCandidates).toBe(true);
  });

  it("isEnabled false", () => {
    expect(isEnabledBeforeSelect).toBe(false);
  });

  it("手动切换成功", () => {
    expect(selectResult).toBe(true);
  });

  it("切换后启用", () => {
    expect(isEnabledAfterSelect).toBe(true);
  });
});

describe("registry：select 清空幂等 / 未知名 false / get 与 getEntry 一致性", () => {
  let clearNoop, unknownSelect, getAfterRegister, getAfterClear, enabledAfterClear;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    clearNoop = reg.select("nope", null);
    unknownSelect = reg.select("nope", "ghost");
    reg.register(mkAdapter(), "builtin");
    getAfterRegister = reg.get("prov-x") !== undefined;
    reg.select("prov-x", null);
    getAfterClear = reg.get("prov-x");
    enabledAfterClear = reg.enabledProviders();
  });

  it("清空恒成功（幂等）", () => {
    expect(clearNoop).toBe(true);
  });

  it("未知 provider+name 返回 false", () => {
    expect(unknownSelect).toBe(false);
  });

  it("get 返回适配器本体", () => {
    expect(getAfterRegister).toBe(true);
  });

  it("清空后 get undefined", () => {
    expect(getAfterClear).toBe(undefined);
  });

  it("清空后 enabledProviders 为空", () => {
    expect(enabledAfterClear).toEqual([]);
  });
});

describe("registry：snapshot 多 provider 认领去重 + errors 列表", () => {
  let snap;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ providers: ["px", "py"] }), "builtin");
    reg.recordError("k1", "load", "加载失败消息");
    reg.recordError("k2", "exec", "执行超时消息");
    snap = reg.snapshot();
  });

  it("双 provider 认领产生两个 info 行", () => {
    expect(snap.infos.length).toBe(2);
  });

  it("enabled 映射完整", () => {
    expect(snap.enabled).toEqual({ px: "adapter-a", py: "adapter-a" });
  });

  it("默认全部启用标记", () => {
    expect(snap.infos.every((i) => i.enabled === true)).toBeTruthy();
  });

  it("errors kind=load", () => {
    expect(snap.errors.find((e) => e.key === "k1")?.kind).toBe("load");
  });

  it("errors kind=exec", () => {
    expect(snap.errors.find((e) => e.key === "k2")?.kind).toBe("exec");
  });

  it("snapshot.enabledProviders 完整", () => {
    expect(snap.enabledProviders.sort()).toEqual(["px", "py"]);
  });
});

describe("registry：recordError 同 key 覆盖（只保留最近一次）", () => {
  let dupErrors;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.recordError("dup", "load", "第一次");
    reg.recordError("dup", "exec", "第二次");
    dupErrors = reg.snapshot().errors.filter((e) => e.key === "dup");
  });

  it("同 key 仅保留最近一次", () => {
    expect(dupErrors.length).toBe(1);
  });

  it("覆盖为新消息", () => {
    expect(dupErrors[0].message).toBe("第二次");
  });
});

describe("registry：removeByFile 计数 + registeredNames/enabled 引用清理", () => {
  let removed, hasNameOne, hasNameTwo, entryProvX, entryPz, enabledAfterAllRemoved, removedGhost;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ name: "f-one" }), "user-file", "/a.mjs");   // prov-x 启用 f-one
    reg.register(mkAdapter({ name: "f-two", providers: ["pz"] }), "user-file", "/b.mjs");
    removed = reg.removeByFile("/a.mjs");
    hasNameOne = reg.hasName("f-one");
    hasNameTwo = reg.hasName("f-two");
    entryProvX = reg.getEntry("prov-x");
    entryPz = reg.getEntry("pz");
    // 全移除后 enabledProviders 空
    reg.removeByFile("/b.mjs");
    enabledAfterAllRemoved = reg.enabledProviders();
    removedGhost = reg.removeByFile("/ghost.mjs");
  });

  it("removeByFile 移除计数", () => {
    expect(removed).toBe(1);
  });

  it("registeredNames 清理 f-one", () => {
    expect(hasNameOne).toBe(false);
  });

  it("f-two 不受影响", () => {
    expect(hasNameTwo).toBe(true);
  });

  it("f-one 的 enabled 引用清理", () => {
    expect(entryProvX).toBe(undefined);
  });

  it("f-two 启用不受影响", () => {
    expect(entryPz).not.toBe(undefined);
  });

  it("全部移除后无启用 provider", () => {
    expect(enabledAfterAllRemoved).toEqual([]);
  });

  it("移除不存在文件计 0", () => {
    expect(removedGhost).toBe(0);
  });
});

// ================================================================ #212：replaceByFile 热更新替换（enabled 保持 + 冲突保留旧条目）

describe("#212-A1：显式停用的适配器热更新后不得变回启用（缺陷 A 回归）", () => {
  let registerResult, selectResult, r, info, entryProvX;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    registerResult = reg.register(mkAdapter({ name: "f-one" }), "user-file", "/a.mjs");
    selectResult = reg.select("prov-x", null);
    r = reg.replaceByFile("/a.mjs", mkAdapter({ name: "f-one", label: "v2" }));
    info = reg.snapshot().infos.find((i) => i.name === "f-one");
    entryProvX = reg.getEntry("prov-x");
  });

  it("注册成功（前置）", () => {
    expect(registerResult).toBe(true);
  });

  it("用户显式停用", () => {
    expect(selectResult).toBe(true);
  });

  it("同名替换成功", () => {
    expect(r.ok).toBe(true);
  });

  it("停用的适配器热更新后保持停用（#212-A）", () => {
    expect(info?.enabled).toBe(false);
  });

  it("prov-x 保持无启用者", () => {
    expect(entryProvX).toBe(undefined);
  });
});

describe("#212-A2：启用中的适配器替换后仍是启用者（保持语义的另一侧）", () => {
  let r, enabledAfterReplace;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ name: "on-a" }), "user-file", "/a.mjs");
    r = reg.replaceByFile("/a.mjs", mkAdapter({ name: "on-a", label: "v2" }));
    enabledAfterReplace = reg.isEnabled("prov-x", "on-a");
  });

  it("替换成功", () => {
    expect(r.ok).toBe(true);
  });

  it("启用者热更新后仍启用（#212-A）", () => {
    expect(enabledAfterReplace).toBe(true);
  });
});

describe("#212-A3：多 provider 认领时逐 provider 精确恢复（部分启用部分停用）", () => {
  let selectResult, r, snap;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ name: "multi", providers: ["p1", "p2"] }), "user-file", "/m.mjs");
    selectResult = reg.select("p2", null);
    r = reg.replaceByFile("/m.mjs", mkAdapter({ name: "multi", providers: ["p1", "p2"], label: "v2" }));
    snap = reg.snapshot();
  });

  it("仅停用 p2", () => {
    expect(selectResult).toBe(true);
  });

  it("替换成功", () => {
    expect(r.ok).toBe(true);
  });

  it("p1 启用关系保持", () => {
    expect(snap.enabled.p1).toBe("multi");
  });

  it("p2 停用关系保持（不得被默认启用覆盖）", () => {
    expect(snap.enabled.p2).toBe(undefined);
  });
});

// B1：改名撞内置名 → 拒绝且旧条目原样保留（缺陷 B 回归；health 报错可见性见 smoke #212-B 集成用例）
describe("#212-B1：改名撞内置名 → 拒绝且旧条目原样保留", () => {
  let builtinRegister, renamerRegister, r, infos, hasNameRenamer;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    builtinRegister = reg.register(mkAdapter({ name: "builtin-occ" }), "builtin");
    renamerRegister = reg.register(mkAdapter({ name: "renamer" }), "user-file", "/r.mjs");
    r = reg.replaceByFile("/r.mjs", mkAdapter({ name: "builtin-occ" }));
    infos = reg.snapshot().infos;
    hasNameRenamer = reg.hasName("renamer");
  });

  it("内置名注册成功（前置）", () => {
    expect(builtinRegister).toBe(true);
  });

  it("待改名条目注册成功（前置）", () => {
    expect(renamerRegister).toBe(true);
  });

  it("撞名拒绝替换", () => {
    expect(r.ok).toBe(false);
  });

  it("拒绝码为 duplicate-name", () => {
    expect(r.code).toBe("duplicate-name");
  });

  it("拒绝结果携带冲突 name 详情", () => {
    expect(r.detail.includes("builtin-occ")).toBeTruthy();
  });

  it("旧条目未被删除（#212-B）", () => {
    expect(infos.some((i) => i.name === "renamer" && i.file === "/r.mjs")).toBeTruthy();
  });

  it("旧名仍在注册表", () => {
    expect(hasNameRenamer).toBe(true);
  });
});

describe("#212-B2：改名撞另一 user-file 名 → 同样拒绝且两文件条目均保留", () => {
  let r, infos;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ name: "u-first", providers: ["pq"] }), "user-file", "/u1.mjs");
    reg.register(mkAdapter({ name: "u-second", providers: ["pr"] }), "user-file", "/u2.mjs");
    r = reg.replaceByFile("/u2.mjs", mkAdapter({ name: "u-first", providers: ["pr"] }));
    infos = reg.snapshot().infos;
  });

  it("撞 user-file 名拒绝", () => {
    expect(r.ok).toBe(false);
  });

  it("拒绝码为 duplicate-name", () => {
    expect(r.code).toBe("duplicate-name");
  });

  it("u2 旧条目保留", () => {
    expect(infos.some((i) => i.name === "u-second" && i.file === "/u2.mjs")).toBeTruthy();
  });

  it("u1 条目不受牵连", () => {
    expect(infos.some((i) => i.name === "u-first" && i.file === "/u1.mjs")).toBeTruthy();
  });
});

describe("#212-B3：改名不冲突 → 替换成功，旧名清理，启用关系跟随文件语义", () => {
  let r, hasNameOld, enabledNew;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ name: "old-name" }), "user-file", "/c.mjs"); // 默认启用 prov-x
    r = reg.replaceByFile("/c.mjs", mkAdapter({ name: "new-name" }));
    hasNameOld = reg.hasName("old-name");
    enabledNew = reg.isEnabled("prov-x", "new-name");
  });

  it("改名不冲突替换成功", () => {
    expect(r.ok).toBe(true);
  });

  it("旧名已清理", () => {
    expect(hasNameOld).toBe(false);
  });

  it("该文件原为启用者，新版沿用启用", () => {
    expect(enabledNew).toBe(true);
  });
});

describe("#212-B4：契约失败的新版同样拒绝且保留旧条目", () => {
  let r, keptOrig;

  beforeAll(() => {
    const reg = makeAdapterRegistry();
    reg.register(mkAdapter({ name: "orig" }), "user-file", "/o.mjs");
    r = reg.replaceByFile("/o.mjs", { foo: 1 });
    keptOrig = reg.snapshot().infos.some((i) => i.name === "orig");
  });

  it("替换被拒", () => {
    expect(r.ok).toBe(false);
  });

  it("拒绝码为 invalid-adapter", () => {
    expect(r.code).toBe("invalid-adapter");
  });

  it("非法新版不破坏旧条目", () => {
    expect(keptOrig).toBeTruthy();
  });
});

// ================================================================ #212：sanitizeHtml 白名单矩阵

describe("sanitizeHtml 白名单矩阵", () => {
  it("空串直通", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("无害 HTML 原样", () => {
    expect(sanitizeHtml("<p>plain</p>")).toBe("<p>plain</p>");
  });

  // 元素级移除（含成对标签与自闭合形态）
  it("script 成对移除", () => {
    expect(sanitizeHtml('<script>alert(1)</script>ok')).toBe("ok");
  });

  it("iframe 移除", () => {
    expect(sanitizeHtml('<iframe src="x"></iframe>ok')).toBe("ok");
  });

  it("frame 移除", () => {
    expect(sanitizeHtml('<frame src="x"></frame>ok')).toBe("ok");
  });

  it("object 移除", () => {
    expect(sanitizeHtml('<object data="x"></object>ok')).toBe("ok");
  });

  it("embed 成对移除（正则要求闭合标签，自闭合形态不在净化范围——现状行为）", () => {
    expect(sanitizeHtml('<embed src="x"></embed>ok')).toBe("ok");
  });

  it("meta 移除", () => {
    expect(sanitizeHtml('<meta charset="utf-8">ok')).toBe("ok");
  });

  it("link 移除", () => {
    expect(sanitizeHtml('<link rel="stylesheet" href="x">ok')).toBe("ok");
  });

  it("base 移除", () => {
    expect(sanitizeHtml('<base href="x">ok')).toBe("ok");
  });

  it("大写 SCRIPT 大小写不敏感", () => {
    expect(sanitizeHtml("<div>keep</div><SCRIPT>x</SCRIPT>tail")).toBe("<div>keep</div>tail");
  });

  // on* 事件属性三种引号形态
  it("onclick 双引号移除", () => {
    expect(sanitizeHtml('<img src="a.png" onclick="evil()">')).toBe('<img src="a.png">');
  });

  it("onload 单引号移除", () => {
    expect(sanitizeHtml("<img src='a.png' onload='evil()'>")).toBe("<img src='a.png'>");
  });

  it("onerror 无引号移除", () => {
    expect(sanitizeHtml("<img src=a.png onerror=evil()>")).toBe("<img src=a.png>");
  });

  // 危险协议与 CSS 表达式
  it("javascript: 协议剥除", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">c</a>')).toBe('<a href="alert(1)">c</a>');
  });

  it("协议大小写变体剥除", () => {
    expect(sanitizeHtml('<a href="JaVaScRiPt:x">c</a>')).toBe('<a href="x">c</a>');
  });

  it("data:text/html 剥除", () => {
    expect(sanitizeHtml('<a href="data:text/html;base64,x">c</a>')).toBe('<a href=";base64,x">c</a>');
  });

  it("expression( 剥除", () => {
    expect(sanitizeHtml('<div style="width: expression(alert(1))">x</div>')).toBe('<div style="width: alert(1))">x</div>');
  });

  // 实体编码变体封闭（#105③）——解码副本仅用于定位，输出恒为原文子序列
  it("hex 实体 javascript: 剥除", () => {
    expect(sanitizeHtml('<a href="jav&#x61;script:alert(1)">c</a>')).toBe('<a href="alert(1)">c</a>');
  });

  it("具名冒号实体协议剥除（data&colon; 同路径，见 smoke-pure A7）", () => {
    expect(sanitizeHtml('<a href="javascript&colon;x">c</a>')).toBe('<a href="x">c</a>');
  });

  it("事件属性名部分实体编码剥除（保守封堵）", () => {
    expect(sanitizeHtml('<img src=x o&#110;click="evil()">')).toBe("<img src=x>");
  });

  it("expression 数字实体变体剥除", () => {
    expect(sanitizeHtml('<div style="width:expression&#40;alert(1))">x</div>')).toBe('<div style="width:alert(1))">x</div>');
  });

  it("双重编码安全文本零损伤（不得误解码升级为新载体）", () => {
    expect(sanitizeHtml('<a href="&amp;#106;avascript:x">c</a>')).toBe('<a href="&amp;#106;avascript:x">c</a>');
  });

  it("无害实体文本原样（解码副本绝不回写为输出）", () => {
    expect(sanitizeHtml("&lt;b&gt;text&lt;/b&gt;")).toBe("&lt;b&gt;text&lt;/b&gt;");
  });
});

// ================================================================ #150 二阶段：guards 边界

describe("safeFetchData：序列化校验（数组/标量/null 拒绝）", () => {
  it("数组返回被拒", async () => {
    const arr = await safeFetchData(async () => [1, 2]);
    expect(arr.error).toMatch(/必须返回对象/);
  });

  it("null 返回被拒", async () => {
    const nul = await safeFetchData(async () => null);
    expect(nul.error).toMatch(/必须返回对象/);
  });

  it("字符串返回被拒", async () => {
    const str = await safeFetchData(async () => "text");
    expect(str.error).toMatch(/必须返回对象/);
  });

  it("对象正常透传", async () => {
    const ok = await safeFetchData(async () => ({ v: 1 }));
    expect(ok.data).toEqual({ v: 1 });
  });

  it("fetchData 抛错隔离为 error 字段", async () => {
    const thrown = await safeFetchData(async () => { throw new Error("boom"); });
    expect(thrown.error).toBe("boom");
  });

  it("非 Error 抛出物 String() 化", async () => {
    const thrownStr = await safeFetchData(async () => { throw "raw-str"; });
    expect(thrownStr.error).toBe("raw-str");
  });

  // 超时：timeoutMs 最小化 + 永不 resolve 的 promise
  it("慢 fetchData 超时中断", async () => {
    const slow = await safeFetchData(() => new Promise(() => {}), 30);
    expect(slow.error).toMatch(/超时/);
  });
});

describe("safeFormat：非字符串返回 / 抛错 / 超时", () => {
  it("非字符串 HTML 拒绝", async () => {
    const badType = await safeFormat(() => 42 as unknown as string, "formatCapsule");
    expect(badType.error).toMatch(/必须返回字符串/);
  });

  it("format 抛错隔离", async () => {
    const thrown = await safeFormat(() => { throw new Error("fmt-boom"); }, "formatCapsule");
    expect(thrown.error).toBe("fmt-boom");
  });

  it("异步 format 超时带函数名", async () => {
    const slow = await safeFormat(() => new Promise<string>(() => {}) as unknown as string, "formatPanel", 30);
    expect(slow.error).toMatch(/formatPanel 超时/);
  });

  it("同步 format 正常返回", async () => {
    const ok = await safeFormat(() => "<b>hi</b>", "formatCapsule");
    expect(ok.html).toBe("<b>hi</b>");
  });
});

// ================================================================ #150 二阶段：pipeline v2 分支

function mkV2Adapter(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: ADAPTER_CONTRACT_VERSION,
    name: "pipe-a",
    providers: ["pv"],
    fetchData: async () => ({ used: 1 }),
    formatCapsule: () => "<span>capsule</span>",
    formatPanel: () => "<p>panel</p>",
    ...over,
  };
}

describe("pipeline v2：成功路径：fresh + rawData + capsule 净化", () => {
  let r;

  beforeAll(async () => {
    r = await runV2Pipeline({
      adapter: mkV2Adapter() as never,
      provider: "pv",
      config: { apiEndpoint: "http://127.0.0.1:9", apiKey: "sk" },
      staticPath: "",
      timeoutMs: 1000,
    });
  });

  it("管道成功 ok", () => {
    expect(r.ok).toBe(true);
  });

  it("管道状态 fresh", () => {
    expect(r.status).toBe("fresh");
  });

  it("rawData 透传", () => {
    expect(r.rawData).toEqual({ used: 1 });
  });

  it("胶囊经净化输出", () => {
    expect(r.capsuleHtml).toBe("<span>capsule</span>");
  });
});

describe("pipeline v2：fetchData 失败 → fetch-failed stale", () => {
  let r;

  beforeAll(async () => {
    r = await runV2Pipeline({
      adapter: mkV2Adapter({ fetchData: async () => { throw new Error("net-down"); } }) as never,
      provider: "pv",
      config: {},
      staticPath: "",
      timeoutMs: 500,
    });
  });

  it("fetch 失败 ok=false", () => {
    expect(r.ok).toBe(false);
  });

  it("reason=fetch-failed", () => {
    expect(r.reason).toBe("fetch-failed");
  });

  it("错误信息透传", () => {
    expect(r.error).toBe("net-down");
  });

  it("fetch 失败状态 stale", () => {
    expect(r.status).toBe("stale");
  });
});

describe("pipeline v2：formatCapsule 注入脚本 → 净化兜底", () => {
  let r;

  beforeAll(async () => {
    r = await runV2Pipeline({
      adapter: mkV2Adapter({ formatCapsule: () => '<span onclick="x()">t</span>' }) as never,
      provider: "pv",
      config: {},
      staticPath: "",
      timeoutMs: 500,
    });
  });

  it("胶囊 XSS 属性被净化", () => {
    expect(r.capsuleHtml).toBe("<span>t</span>");
  });
});

describe("pipeline v2：面板管道：正常 / formatPanel 抛错 / 空历史", () => {
  let okP, badP, emptyP;

  beforeAll(async () => {
    const store = new HistoryStore({ root: mkdtempSync(join(tmpdir(), "dou-pipe-")) });
    const day = new Date().setHours(12, 0, 0, 0);
    await store.append("pv", "pipe-a", { time: day, data: { v: 1 } });

    okP = await runV2PanelPipeline({
      adapter: mkV2Adapter() as never,
      provider: "pv",
      history: store,
      range: { start: day - 1000, end: day + 1000 },
    });

    badP = await runV2PanelPipeline({
      adapter: mkV2Adapter({ formatPanel: () => { throw new Error("panel-boom"); } }) as never,
      provider: "pv",
      history: store,
      range: { start: day - 1000, end: day + 1000 },
    });

    // 空历史 → entries 空，formatPanel 收到空列表
    emptyP = await runV2PanelPipeline({
      adapter: mkV2Adapter({ formatPanel: (i: { entries: unknown[] }) => `n=${i.entries.length}` }) as never,
      provider: "zz",
      history: store,
      range: { start: day - 1000, end: day + 1000 },
    });
  });

  it("面板 HTML 输出", () => {
    expect(okP.panelHtml).toBe("<p>panel</p>");
  });

  it("formatPanel 抛错进 error 字段", () => {
    expect(badP.error).toMatch(/panel-boom/);
  });

  it("空历史 entries 为 0", () => {
    expect(emptyP.panelHtml).toBe("n=0");
  });
});

// ================================================================ #150 二阶段：hotreload 纯函数与轮询

describe("stampEqual 四象限", () => {
  it("双 null 相等", () => {
    expect(stampEqual(null, null)).toBe(true);
  });

  it("null vs 值不等", () => {
    expect(stampEqual(null, { mtimeMs: 1, size: 1 })).toBe(false);
  });

  it("值 vs null 不等", () => {
    expect(stampEqual({ mtimeMs: 1, size: 1 }, null)).toBe(false);
  });

  it("size 差异不等", () => {
    expect(stampEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 })).toBe(false);
  });

  it("全等通过", () => {
    expect(stampEqual({ mtimeMs: 5, size: 5 }, { mtimeMs: 5, size: 5 })).toBe(true);
  });
});

describe("readStamp：不存在 null、存在取值", () => {
  it("readStamp 缺失返回 null", async () => {
    expect(await readStamp("/nonexistent/path/x")).toBe(null);
  });

  it("readStamp 取到 mtime+size", async () => {
    const tmpF = join(mkdtempSync(join(tmpdir(), "dou-hr-stamp-")), "f.mjs");
    writeFileSync(tmpF, "x", "utf8");
    const st = await readStamp(tmpF);
    expect(st !== null && typeof st.mtimeMs === "number" && st.size === 1).toBeTruthy();
  });
});

describe("hotreload：start 文件缺失失败回调；pollOnce 文件删除保留 current", () => {
  // 该段走 Node 子进程（test/hotreload-probe.mjs）：回放的是原生 Node 的 ESM 语义
  // （生产运行态），与测试运行器的模块图隔离。历史上此处还用于规避旧版本戳
  // `import(url + "?t=" + mtimeMs)` 被 vite 系运行器按 `/\bt=\d{13}&?\b/` 剥离毫秒整数位、
  // 只剩亚毫秒小数位参与模块标识而撞进同一模块缓存的缺陷（#722 实证，版本戳现已改为
  // `?mtime=<mtimeMs>&size=<size>`；确定性驱动覆盖见 test/unit/registry/unit-hotreload.test.ts）。
  let startedMissing, startedMissingError, eventsLength;
  let startedOk, currentAfterStart, polledOk, currentAfterPoll;
  let badReloadOk, badReloadError, delPollOk, currentAfterDelete;

  beforeAll(() => {
    const probe = fileURLToPath(new URL("../../hotreload-probe.mjs", import.meta.url));
    const raw = execFileSync(process.execPath, [probe], { encoding: "utf8" });
    const line = raw.trimEnd().split("\n").filter((l) => l.trimStart().startsWith("{")).pop();
    const out = JSON.parse(line);
    startedMissing = { ok: out.startedMissingOk };
    startedMissingError = out.startedMissingError;
    eventsLength = out.eventsLength;
    startedOk = { ok: out.startedOk };
    currentAfterStart = out.currentAfterStart;
    polledOk = { ok: out.polledOk };
    currentAfterPoll = out.currentAfterPoll;
    badReloadOk = { ok: out.badReloadOk };
    badReloadError = out.badReloadError;
    delPollOk = { ok: out.delPollOk };
    currentAfterDelete = out.currentAfterDelete;
  });

  it("start 文件缺失失败", () => {
    expect(startedMissing.ok).toBe(false);
  });

  it("start 错误信息", () => {
    expect(startedMissingError).toMatch(/不存在或不可读/);
  });

  it("onReload 收到失败事件", () => {
    expect(eventsLength).toBe(1);
  });

  it("合法文件启动成功", () => {
    expect(startedOk.ok).toBe(true);
  });

  it("current 已装载", () => {
    expect(currentAfterStart).toBe(true);
  });

  it("变更后 poll 成功", () => {
    expect(polledOk?.ok).toBe(true);
  });

  it("变更后 current 保持装载", () => {
    expect(currentAfterPoll).toBe(true);
  });

  it("非法新版本 poll 失败", () => {
    expect(badReloadOk?.ok).toBe(false);
  });

  it("reload 错误信息", () => {
    expect(badReloadError ?? "").toMatch(/契约校验失败/);
  });

  it("删除场景 poll 恒 ok", () => {
    expect(delPollOk.ok).toBe(true);
  });

  it("删除后 current 保留旧版", () => {
    expect(currentAfterDelete).toBe(true);
  });
});

// ================================================================ #150 二阶段：图表纯函数结构断言（miniChartSvgMarkup）

describe("miniChartSvgMarkup 图表纯函数结构断言", () => {
  // 样本不足 2 点 → 空 SVG
  it("样本 <2 返回空串", () => {
    expect(miniChartSvgMarkup({
      samples: [{ x: 1, y: 50 }],
      color: "#fff", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
    })).toBe("");
  });

  // 基本结构：svg 包裹 + 平滑曲线 + 终点圆点 + 网格线
  describe("基本结构：svg 包裹 + 平滑曲线 + 终点圆点 + 网格线", () => {
    let svg, gridLines;

    beforeAll(() => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0);
      svg = miniChartSvgMarkup({
        samples: [
          { x: t0, y: 10 },
          { x: t0 + 3600000, y: 40 },
          { x: t0 + 7200000, y: 70 },
        ],
        color: "#123456", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      });
      // 网格线恰为 lo/mid/hi 三条（stroke-dasharray:3 3）；重置线(2 3)与 100% 参考
      // 线(4 3)用不同 dash 值不会混入计数——精确计数而非 includes 存在性
      gridLines = svg.split('stroke-dasharray:3 3').length - 1;
    });

    it("SVG 开头", () => {
      expect(svg.startsWith("<svg")).toBeTruthy();
    });

    it("视口尺寸固定", () => {
      expect(svg.includes('viewBox="0 0 320 100"')).toBeTruthy();
    });

    it("曲线使用传入色", () => {
      expect(svg.includes("stroke:#123456")).toBeTruthy();
    });

    it("终点圆点存在", () => {
      expect(svg.includes("<circle")).toBeTruthy();
    });

    it("网格虚线恰三条（lo/中位/hi 各一）", () => {
      expect(gridLines).toBe(3);
    });

    it("lo=0/hi=100 满足 lo<=100<=hi 且域宽>0.01 → 参考线存在", () => {
      expect(svg.includes("100%")).toBeTruthy();
    });
  });

  describe("domain 含 100% 参考线", () => {
    let noRefLine, withRefLine;

    beforeAll(() => {
      // hi=80 时 100% 线不可见；hi<100 且 dmax>=90 强制抬到 100 的行为经 niceDomain 间接生效
      const t0 = Date.UTC(2026, 0, 1, 0, 0);
      noRefLine = miniChartSvgMarkup({
        samples: [{ x: t0, y: 10 }, { x: t0 + 60000, y: 60 }],
        color: "#000", lo: 0, hi: 50, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
      });
      withRefLine = miniChartSvgMarkup({
        samples: [{ x: t0, y: 10 }, { x: t0 + 60000, y: 95 }],
        color: "#000", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
      });
    });

    it("hi=50 < 100 时无 100% 参考线", () => {
      expect(noRefLine.includes("100%") === false).toBeTruthy();
    });

    it("hi=100 且域宽 >0.01 时有 100% 参考线", () => {
      expect(withRefLine.includes("100%")).toBeTruthy();
    });
  });

  describe("重置标记线", () => {
    let marks;

    beforeAll(() => {
      // resetsAt 落在窗口内 → title「窗口重置点」出现；周期外推的历史点也在
      const t0 = Date.UTC(2026, 0, 1, 0, 0);
      const resetAt = new Date(t0 + 3600000).toISOString();
      const svg = miniChartSvgMarkup({
        samples: [{ x: t0, y: 10 }, { x: t0 + 7200000, y: 30 }],
        color: "#000", lo: 0, hi: 100,
        resetsAt: resetAt, resetPeriodMs: 3600000, dateOnly: false,
      });
      marks = svg.split("窗口重置点").length - 1;
    });

    it("重置点标记含当期与外推历史", () => {
      expect(marks >= 2, `重置点标记含当期与外推历史（实际 ${marks} 个）`).toBeTruthy();
    });
  });

  describe("resetsAt 无效值 → 无标记", () => {
    let svgNone;

    beforeAll(() => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0);
      svgNone = miniChartSvgMarkup({
        samples: [{ x: t0, y: 10 }, { x: t0 + 60000, y: 20 }],
        color: "#000", lo: 0, hi: 100, resetsAt: "garbage", resetPeriodMs: 0, dateOnly: false,
      });
    });

    it("非法 resetsAt 无标记", () => {
      expect(!svgNone.includes("窗口重置点")).toBeTruthy();
    });
  });

  // downsample：>300 点降采样后仍 ≤301 点且保留末点
  describe("downsample：>300 点降采样", () => {
    let circles, svg;

    beforeAll(() => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0);
      const many = Array.from({ length: 700 }, (_, i) => ({ x: t0 + i * 1000, y: i % 97 }));
      svg = miniChartSvgMarkup({
        samples: many, color: "#000", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: true,
      });
      circles = svg.split("<circle").length - 1;
    });

    it("降采样后仍只有一个终点圆点（渲染未崩）", () => {
      expect(circles).toBe(1);
    });

    // 仅作退化护栏（防止降采样失效导致体积爆炸的非线性增长），非精确口径：
    // 700 点降采样到 ≤301 点的 SVG 实际远小于该上限
    it("降采样控制了输出体积", () => {
      expect(svg.length < 100000).toBeTruthy();
    });
  });

  // smoothPath：单点返回空串（pts<2 分支）
  // （smoothPath 未导出，经由 samples<2 已覆盖；此处补两点的 path 形状断言）
  describe("smoothPath：两点 path 形状", () => {
    let svg;

    beforeAll(() => {
      const t0 = Date.UTC(2026, 0, 1, 0, 0);
      svg = miniChartSvgMarkup({
        samples: [{ x: t0, y: 0 }, { x: t0 + 60000, y: 100 }],
        color: "#000", lo: 0, hi: 100, resetsAt: undefined, resetPeriodMs: 0, dateOnly: false,
      });
    });

    it("两点曲线走三次贝塞尔（平滑）", () => {
      expect(svg.includes("C ")).toBeTruthy();
    });

    it("面积图填充透明度存在", () => {
      expect(svg.includes("fill-opacity:.13")).toBeTruthy();
    });
  });
});
