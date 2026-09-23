/**
 * dsh-mcp-manager — 核心服务契约独立门禁（issue #476，service-contract）。
 *
 * 背景：`ctx.mcpManager` 服务类型面（src/shared/service.ts）是单一
 * 事实源，但提供方 src/index.ts 的 provide 对象方法全是宽面签名（string /
 * Record<string, unknown>），与类型面无编译期锚点；此前「契约签名变更未同步
 * 测试」纯靠人工，改 shared 类型不触发任何检查（skipLibCheck + 消费方 import
 * 不炸即绿）。
 *
 * 本文件 = 契约锁（tsd 风格零依赖双层）：
 * 1. 编译期：测试内**自含契约签名清单**（下方类型区），与 shared 类型面逐方法 /
 *    逐字段 `Equal` 精确比对——shared 类型漂移（改参/改返/删字段/加方法）→
 *    本文件被 tsc 编译即红。本文件的类型断言在 Node 直跑（type stripping）时
 *    被擦除，因此必须由编译面执行（接线见文件头注释链：scripts/test/
 *    service-contract-wiring.test.ts spawn tsc -p test/tsconfig.json）。
 * 2. 运行时：静态读取 src/index.ts 源文本，提取 `ctx.provide("mcpManager", {...})`
 *    对象的方法名集合 + 参数个数/可选位，与契约清单比对（不多不少）——提供方
 *    删方法/改参数形状逃过 tsc 宽面签名时红。
 *
 * 红线（#476）：不改 shared 契约层、不改两包 src——本文件只锁现状。
 * 无 @ts-nocheck：编译期断言必须真实参与类型检查。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// 提供方视角（与 src/shared/interface.ts 同款相对路径）：shared 类型面单一事实源。
import type {
  ClientUiConfig,
  McpManagerServerInput,
  McpManagerService,
  McpScope,
  McpServerStatus,
  McpServerSummary,
  McpToolInfo,
} from "../../src/shared/interface.ts";
// 客户端视角：同一份 DTO 的薄 re-export（客户端不得自带副本）。
import type {
  ClientUiConfig as ClientUiConfigView,
  McpServerListEntry as ClientServerListEntry,
} from "../../src/client/core/state.ts";
import type { McpServerListEntry } from "../../src/shared/interface.ts";
// 本地最小形状（service.ts 禁非同目录 import，见 shared-leaf 判据）：与官方
// ToolDefinition 的结构子集兼容（官方对象可赋值给它），消费端只读这三字段。
import type { EncapsulatedToolDefinition } from "../../src/shared/service.ts";

// ─────────────────────────── 编译期类型断言区 ───────────────────────────
// tsd 风格零依赖类型原语（自实现，不引第三方）。
type Assert<T extends true> = T;
/** 精确相等（含可选性/联合分布）。tsd 风格；用于字面量联合与函数类型。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/**
 * 结构互含（双向子型）。interface 类型与匿名对象字面量的 tsd-Equal 存在
 * TypeScript 表示层边界（实测 TS7.0 下 interface 整体 Equal 匿名对象会误红），
 * 故对象结构断言用「双向 extends」替代：删字段/改字段类型/改联合/改方法签名
 * 任意单向漂移都会破坏某一方向的子型关系 → 红。可选性语义上等价的边缘形态
 * （`a?: T` vs `a: T | undefined`）不区分，属非破坏性漂移，可接受。
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// 类型面：6 个导出类型自含清单（与 src/shared/service.ts 逐项比对；
// 结构漂移 → 编译红）。标量/联合用 Equal 精确锁，对象结构用 Same 双向锁。
type _SvcStatus = Assert<
  Equal<
    McpServerStatus,
    "connected" | "connecting" | "reconnecting" | "disabled" | "stopped" | "failed"
  >
>;
type _SvcScope = Assert<Equal<McpScope, "global" | "project">>;
type _SvcSummary = Assert<
  Same<
    McpServerSummary,
    {
      name: string;
      transport: "stdio" | "streamable-http";
      scope: McpScope;
      status: McpServerStatus;
      error?: string;
      tools: string[];
      enabled: boolean;
    }
  >
>;
type _SvcToolInfo = Assert<Same<McpToolInfo, { name: string; description?: string }>>;
type _SvcServerInput = Assert<
  Same<
    McpManagerServerInput,
    {
      name: string;
      transport: "stdio" | "streamable-http";
      command?: string;
      args?: string[];
      url?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      cwd?: string;
      enabled?: boolean;
      toolCallTimeoutMs?: number;
      reconnect?: Record<string, unknown>;
      description?: string;
      toolDefinitions?: EncapsulatedToolDefinition[];
    }
  >
>;

// 服务面：8 方法签名的自含清单（函数类型，Equal 精确锁：改参/改返/删方法 → 红）。
type _SvcRegister = Assert<
  Equal<
    McpManagerService["registerServer"],
    (server: McpManagerServerInput) => Promise<{ name: string; existing: boolean }>
  >
>;
type _SvcUnregister = Assert<
  Equal<McpManagerService["unregisterServer"], (name: string) => Promise<void>>
>;
type _SvcConnect = Assert<
  Equal<McpManagerService["connect"], (name: string, scope?: McpScope) => Promise<void>>
>;
type _SvcDisconnect = Assert<
  Equal<McpManagerService["disconnect"], (name: string, scope?: McpScope) => Promise<void>>
>;
type _SvcReconnect = Assert<
  Equal<McpManagerService["reconnect"], (name: string, scope?: McpScope) => Promise<void>>
>;
type _SvcGetStatus = Assert<
  Equal<McpManagerService["getStatus"], (name: string) => McpServerSummary | undefined>
>;
type _SvcGetTools = Assert<Equal<McpManagerService["getTools"], (name: string) => McpToolInfo[]>>;
type _SvcList = Assert<Equal<McpManagerService["list"], () => McpServerSummary[]>>;

// 服务接口总键集（方法名不多不少，与运行时断言同一清单源）。
type _SvcKeys = Assert<
  Equal<
    keyof McpManagerService,
    | "registerServer"
    | "unregisterServer"
    | "connect"
    | "disconnect"
    | "reconnect"
    | "getStatus"
    | "getTools"
    | "list"
  >
>;
// 数据类型总键集（字段增减锁：漏加/漏删字段 → 红）。
type _ServerInputKeys = Assert<
  Equal<
    keyof McpManagerServerInput,
    | "name"
    | "transport"
    | "command"
    | "args"
    | "url"
    | "headers"
    | "env"
    | "cwd"
    | "enabled"
    | "toolCallTimeoutMs"
    | "reconnect"
    | "description"
    | "toolDefinitions"
  >
>;
type _SummaryKeys = Assert<
  Equal<
    keyof McpServerSummary,
    "name" | "transport" | "scope" | "status" | "error" | "tools" | "enabled"
  >
>;

// ────────────────── 跨端 DTO 形状一致性锁（编译期，D5/#767 B1.5b） ──────────────────
// 判据面两层：
//   A 两端互赋：客户端转出的类型与 src/shared/dto.ts 的定义必须双向可赋值
//     （任一方向子型关系破 = 某端的字段类型漂移）。
//   B 键集相同：Same 对「多一个可选字段」不敏感，故键集另锁一层——客户端自带
//     副本并增删字段时，只有 B 会红。
// 客户端今天只是薄 re-export，A/B 因此恒真；它们的价值是**漂移时的判据**：
// 任何人把 re-export 换回本地 interface，任一字段增删改都会在这里判红。
// 这 5 条锁以 export 形式声明：lint 的 warning 预算已无余量（671 上限），而
// 非导出的 type alias 每条都会记一次 no-unused-vars——断言的有效性由 tsc 编译面给出，
// 与是否导出无关（接线见 scripts/test/service-contract-wiring.test.ts）。
export type DtoListEntryMutual = Assert<Same<ClientServerListEntry, McpServerListEntry>>;
export type DtoListEntryKeys = Assert<Equal<keyof ClientServerListEntry, keyof McpServerListEntry>>;
export type DtoUiConfigMutual = Assert<Same<ClientUiConfigView, ClientUiConfig>>;
export type DtoUiConfigKeys = Assert<Equal<keyof ClientUiConfigView, keyof ClientUiConfig>>;
// DTO 抽象层不得反噬服务面：列表条目是服务摘要的**超集**（服务摘要 7 键都在列表条目里，
// 且逐键类型可赋），故服务查询面的字段在列表载荷里取得到同名同型。
export type DtoListCoversService = Assert<
  McpServerSummary extends Pick<McpServerListEntry, keyof McpServerSummary> ? true : false
>;

// ─────────────────────────── 运行时方法面断言区 ───────────────────────────
// 契约清单（方法名 + 参数个数 + 可选参数个数）。单一事实源：与上方编译期清单
// 同源同序；提供方 src/index.ts 的 provide 对象若删方法/加方法/改参数形状 → 红。
const CONTRACT_METHODS: ReadonlyArray<{ name: string; paramCount: number; optionalCount: number }> =
  [
    { name: "registerServer", paramCount: 1, optionalCount: 0 },
    { name: "unregisterServer", paramCount: 1, optionalCount: 0 },
    { name: "connect", paramCount: 2, optionalCount: 1 },
    { name: "disconnect", paramCount: 2, optionalCount: 1 },
    { name: "reconnect", paramCount: 2, optionalCount: 1 },
    { name: "getStatus", paramCount: 1, optionalCount: 0 },
    { name: "getTools", paramCount: 1, optionalCount: 0 },
    { name: "list", paramCount: 0, optionalCount: 0 },
  ];

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

// ── 顶层扫描 helpers（原 extractProvidedServiceMethods 内联体提升，零语义改动；每 helper 均 ≤10/15） ──
function skipQuoted(s: string, i: number): number {
  const c = s[i];
  const quote = c;
  i += 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipTemplateInterpolation(s: string, i: number): number {
  let depth = 1;
  i += 2;
  while (i < s.length && depth > 0) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") depth -= 1;
    i += 1;
  }
  return i;
}

function skipTemplate(s: string, i: number): number {
  i += 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === "`") return i + 1;
    if (s[i] === "$" && s[i + 1] === "{") {
      i = skipTemplateInterpolation(s, i);
      continue;
    }
    i += 1;
  }
  return i;
}

function skipLineComment(s: string, i: number): number {
  const nl = s.indexOf("\n", i);
  return nl < 0 ? s.length : nl + 1;
}

function skipBlockComment(s: string, i: number): number {
  const end = s.indexOf("*/", i + 2);
  return end < 0 ? s.length : end + 2;
}

function skipAtom(s: string, i: number): number {
  const c = s[i];
  if (c === '"' || c === "'") return skipQuoted(s, i);
  if (c === "`") return skipTemplate(s, i);
  if (c === "/" && s[i + 1] === "/") return skipLineComment(s, i);
  if (c === "/" && s[i + 1] === "*") return skipBlockComment(s, i);
  return i;
}

function scanBracedRange(src: string, openIndex: number): { bodyStart: number; bodyEnd: number } {
  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  let i = openIndex;
  while (i < src.length) {
    if (src[i] === "{" || src[i] === "}") {
      depth += src[i] === "{" ? 1 : -1;
      if (bodyStart < 0) bodyStart = i + 1;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
      i += 1;
      continue;
    }
    const next = skipAtom(src, i);
    i = next > i ? next : i + 1;
  }
  return { bodyStart, bodyEnd };
}

function findProvideBody(src: string): {
  markerIndex: number;
  bodyStart: number;
  bodyEnd: number;
} {
  const marker = 'provide("mcpManager", {';
  const markerIndex = src.indexOf(marker);
  if (markerIndex < 0) return { markerIndex, bodyStart: -1, bodyEnd: -1 };
  const openIndex = markerIndex + marker.length - 1;
  const { bodyStart, bodyEnd } = scanBracedRange(src, openIndex);
  return { markerIndex, bodyStart, bodyEnd };
}

function bracketDelta(ch: string): number {
  if (ch === "<" || ch === "[" || ch === "{") return 1;
  if (ch === ">" || ch === "]" || ch === "}") return -1;
  return 0;
}

function countMethodParams(raw: string): { paramCount: number; optionalCount: number } {
  const params = raw.trim();
  const optionalCount = (params.match(/\?/g) ?? []).length;
  let paramCount = 0;
  let depth = 0;
  for (const ch of params) {
    const delta = bracketDelta(ch);
    if (delta !== 0) depth += delta;
    else if (ch === "," && depth === 0) paramCount += 1;
  }
  if (params !== "") paramCount += 1;
  return { paramCount, optionalCount };
}

function parseBodyMethods(body: string): Array<{
  name: string;
  paramCount: number;
  optionalCount: number;
}> {
  const methods: Array<{ name: string; paramCount: number; optionalCount: number }> = [];
  const keyRe = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\(([^)]*)\)\s*=>/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    const { paramCount, optionalCount } = countMethodParams(m[2]);
    methods.push({ name: m[1], paramCount, optionalCount });
  }
  return methods;
}

/**
 * 从 src/index.ts 源文本提取 provide("mcpManager", {...}) 对象的方法面。
 * 说明：provide 对象字面量未导出、且 src/index.ts 导入链重（不 import 运行时），
 * 故用源文本级静态提取（v2 方案「c 兜底」层级：方法名存在性 + 参数形状即可抓
 * 删方法/改参数量；不做 AST 级双真源）。括号配对跳过字符串与注释，防方法体
 * 内大括号干扰对象边界。
 *
 * 返回提取结果而非内部断言：锚定失败与配对失败由调用方用例分别断言（fail-loud
 * 但保留每条断言的独立可见性）。
 */
function extractProvidedServiceMethods(): {
  markerIndex: number;
  bodyStart: number;
  bodyEnd: number;
  methods: Array<{ name: string; paramCount: number; optionalCount: number }>;
} {
  const src = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
  // 薄组装：边界定位与方法解析分别委托顶层 helper（零语义改动，原内联体已删）。
  const { markerIndex, bodyStart, bodyEnd } = findProvideBody(src);
  if (markerIndex < 0 || !(bodyStart >= 0 && bodyEnd > bodyStart)) {
    return { markerIndex, bodyStart, bodyEnd, methods: [] };
  }
  const body = src.slice(bodyStart, bodyEnd);
  const methods = parseBodyMethods(body);
  return { markerIndex, bodyStart, bodyEnd, methods };
}

describe("service-contract：src/index.ts provide 方法面与契约清单一致", () => {
  const extracted = extractProvidedServiceMethods();

  it('src/index.ts 应包含 ctx.provide("mcpManager", {...}) 服务注入', () => {
    expect(extracted.markerIndex >= 0).toBe(true);
  });

  it("provide 对象区间应可完整配对", () => {
    expect(extracted.bodyStart >= 0 && extracted.bodyEnd > extracted.bodyStart).toBe(true);
  });

  it('provide("mcpManager") 方法名集合应与契约清单一致（不多不少）', () => {
    const contractNames = CONTRACT_METHODS.map((x) => x.name);
    const providedNames = extracted.methods.map((x) => x.name);
    expect([...providedNames].sort()).toEqual([...contractNames].sort());
  });

  it.each(CONTRACT_METHODS.map((x) => x.name))("provide 对象应含契约方法 %s", (name) => {
    expect(extracted.methods.find((x) => x.name === name)).toBeTruthy();
  });

  it.each(CONTRACT_METHODS.map((x) => [x.name, x.paramCount]))(
    "provide.%s 参数个数应与契约一致",
    (name, paramCount) => {
      const actual = extracted.methods.find((x) => x.name === name);
      expect(actual?.paramCount).toBe(paramCount);
    },
  );

  it.each(CONTRACT_METHODS.map((x) => [x.name, x.optionalCount]))(
    "provide.%s 可选参数个数应与契约一致",
    (name, optionalCount) => {
      const actual = extracted.methods.find((x) => x.name === name);
      expect(actual?.optionalCount).toBe(optionalCount);
    },
  );
});

describe("service-contract 拆分目标：findProvideBody 定位 provide 块边界", () => {
  it("真实 src 应与原函数同边界（等价）", () => {
    const src = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
    const top = findProvideBody(src);
    const orig = extractProvidedServiceMethods();
    expect(top.markerIndex).toBe(orig.markerIndex);
    expect(top.bodyStart).toBe(orig.bodyStart);
    expect(top.bodyEnd).toBe(orig.bodyEnd);
    expect(top.markerIndex >= 0).toBe(true);
    expect(top.bodyStart >= 0 && top.bodyEnd > top.bodyStart).toBe(true);
  });

  it("缺失 marker 应返回 -1（fail-loud 同语义）", () => {
    const top = findProvideBody("const x = 1; // no provide");
    expect(top.markerIndex).toBe(-1);
    expect(top.bodyStart).toBe(-1);
    expect(top.bodyEnd).toBe(-1);
  });

  it("字符串内大括号不应干扰对象边界", () => {
    const src =
      'provide("mcpManager", {\n' +
      '  a: (x: string) => "{ not a brace }",\n' +
      "  b: () => 1,\n" +
      "});";
    const top = findProvideBody(src);
    expect(top.markerIndex >= 0).toBe(true);
    const body = src.slice(top.bodyStart, top.bodyEnd);
    expect(body).toContain("not a brace");
    expect(top.bodyEnd).toBe(src.lastIndexOf("}"));
  });

  it("行注释与块注释内大括号不应干扰边界", () => {
    const src =
      'provide("mcpManager", {\n' +
      "  // comment { \n" +
      "  /* block } { */\n" +
      "  a: () => 1,\n" +
      "});";
    const top = findProvideBody(src);
    expect(top.bodyStart >= 0 && top.bodyEnd > top.bodyStart).toBe(true);
    expect(src.slice(top.bodyStart, top.bodyEnd)).toContain("a: () => 1");
  });

  it("模板插值内大括号应被跳过", () => {
    const src =
      'provide("mcpManager", {\n' +
      "  a: (x: string) => `hi ${ { v: 1 } }`,\n" +
      "  b: () => 1,\n" +
      "});";
    const top = findProvideBody(src);
    expect(top.bodyStart >= 0 && top.bodyEnd > top.bodyStart).toBe(true);
    expect(top.bodyEnd).toBe(src.lastIndexOf("}"));
  });
});

describe("service-contract 拆分目标：parseBodyMethods 块内方法条目解析", () => {
  it("真实 body 应与原函数同方法面（等价，含现有用例行为）", () => {
    const src = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
    const { bodyStart, bodyEnd } = findProvideBody(src);
    const body = src.slice(bodyStart, bodyEnd);
    const top = parseBodyMethods(body);
    const orig = extractProvidedServiceMethods();
    expect(top).toEqual(orig.methods);
    expect([...top.map((x) => x.name)].sort()).toEqual(
      [...CONTRACT_METHODS.map((x) => x.name)].sort(),
    );
  });

  it("泛型逗号不应计入参数个数（Record<string, unknown>）", () => {
    const top = parseBodyMethods("  registerServer: (server: Record<string, unknown>) => 1,");
    expect(top).toEqual([{ name: "registerServer", paramCount: 1, optionalCount: 0 }]);
  });

  it("可选参数 ? 应计数且参数个数正确", () => {
    const top = parseBodyMethods("  connect: (name: string, scope?: string) => 1,");
    expect(top).toEqual([{ name: "connect", paramCount: 2, optionalCount: 1 }]);
  });

  it("空参 list 应为 0/0", () => {
    const top = parseBodyMethods("  list: () => 1,");
    expect(top).toEqual([{ name: "list", paramCount: 0, optionalCount: 0 }]);
  });

  it("注释行不应命中、空 body 应为空数组", () => {
    const top = parseBodyMethods("  // connect: (x) => 1\n  list: () => 1,");
    expect(top.map((x) => x.name)).toEqual(["list"]);
    expect(parseBodyMethods("")).toEqual([]);
  });

  it("countMethodParams 顶层逗号语义：对象字面量逗号不计", () => {
    expect(countMethodParams("a: { x: 1, y: 2 }, b: string").paramCount).toBe(2);
    expect(countMethodParams("").paramCount).toBe(0);
  });
});
