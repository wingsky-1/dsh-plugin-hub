/**
 * dsh-mcp-manager — 核心服务契约独立门禁（issue #476，service-contract）。
 *
 * 背景：`ctx.mcpManager` 服务类型面（shared/mcp-manager-service.d.ts）是单一
 * 事实源，但提供方 apply.ts 的 provide 对象方法全是宽面签名（string /
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
 * 2. 运行时：静态读取 apply.ts 源文本，提取 `ctx.provide("mcpManager", {...})`
 *    对象的方法名集合 + 参数个数/可选位，与契约清单比对（不多不少）——提供方
 *    删方法/改参数形状逃过 tsc 宽面签名时红。本文件被 test/smoke.ts import，
 *    随 `pnpm test` 执行。
 *
 * 红线（#476）：不改 shared 契约层、不改两包 src——本文件只锁现状。
 * 无 @ts-nocheck：编译期断言必须真实参与类型检查。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 提供方视角（与 src/service.ts 同款相对路径）：shared 类型面单一事实源。
import type {
  McpManagerServerInput,
  McpManagerService,
  McpScope,
  McpServerStatus,
  McpServerSummary,
  McpToolInfo,
} from "../../../shared/mcp-manager-service.js";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

// ─────────────────────────── 编译期类型断言区 ───────────────────────────
// tsd 风格零依赖类型原语（自实现，不引第三方）。
type Assert<T extends true> = T;
/** 精确相等（含可选性/联合分布）。tsd 风格；用于字面量联合与函数类型。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
/**
 * 结构互含（双向子型）。interface 类型与匿名对象字面量的 tsd-Equal 存在
 * TypeScript 表示层边界（实测 TS7.0 下 interface 整体 Equal 匿名对象会误红），
 * 故对象结构断言用「双向 extends」替代：删字段/改字段类型/改联合/改方法签名
 * 任意单向漂移都会破坏某一方向的子型关系 → 红。可选性语义上等价的边缘形态
 * （`a?: T` vs `a: T | undefined`）不区分，属非破坏性漂移，可接受。
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// 类型面：6 个导出类型自含清单（与 shared/mcp-manager-service.d.ts 逐项比对；
// 结构漂移 → 编译红）。标量/联合用 Equal 精确锁，对象结构用 Same 双向锁。
type _SvcStatus = Assert<Equal<McpServerStatus, "connected" | "connecting" | "reconnecting" | "disabled" | "stopped" | "failed">>;
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
      toolDefinitions?: ToolDefinition[];
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
type _SvcUnregister = Assert<Equal<McpManagerService["unregisterServer"], (name: string) => Promise<void>>>;
type _SvcConnect = Assert<Equal<McpManagerService["connect"], (name: string, scope?: McpScope) => Promise<void>>>;
type _SvcDisconnect = Assert<Equal<McpManagerService["disconnect"], (name: string, scope?: McpScope) => Promise<void>>>;
type _SvcReconnect = Assert<Equal<McpManagerService["reconnect"], (name: string, scope?: McpScope) => Promise<void>>>;
type _SvcGetStatus = Assert<Equal<McpManagerService["getStatus"], (name: string) => McpServerSummary | undefined>>;
type _SvcGetTools = Assert<Equal<McpManagerService["getTools"], (name: string) => McpToolInfo[]>>;
type _SvcList = Assert<Equal<McpManagerService["list"], () => McpServerSummary[]>>;

// 服务接口总键集（方法名不多不少，与运行时断言同一清单源）。
type _SvcKeys = Assert<Equal<keyof McpManagerService, "registerServer" | "unregisterServer" | "connect" | "disconnect" | "reconnect" | "getStatus" | "getTools" | "list">>;
// 数据类型总键集（字段增减锁：漏加/漏删字段 → 红）。
type _ServerInputKeys = Assert<
  Equal<
    keyof McpManagerServerInput,
    "name" | "transport" | "command" | "args" | "url" | "headers" | "env" | "cwd" | "enabled" | "toolCallTimeoutMs" | "reconnect" | "description" | "toolDefinitions"
  >
>;
type _SummaryKeys = Assert<Equal<keyof McpServerSummary, "name" | "transport" | "scope" | "status" | "error" | "tools" | "enabled">>;

// ─────────────────────────── 运行时方法面断言区 ───────────────────────────
// 契约清单（方法名 + 参数个数 + 可选参数个数）。单一事实源：与上方编译期清单
// 同源同序；提供方 apply.ts 的 provide 对象若删方法/加方法/改参数形状 → 红。
const CONTRACT_METHODS: ReadonlyArray<{ name: string; paramCount: number; optionalCount: number }> = [
  { name: "registerServer", paramCount: 1, optionalCount: 0 },
  { name: "unregisterServer", paramCount: 1, optionalCount: 0 },
  { name: "connect", paramCount: 2, optionalCount: 1 },
  { name: "disconnect", paramCount: 2, optionalCount: 1 },
  { name: "reconnect", paramCount: 2, optionalCount: 1 },
  { name: "getStatus", paramCount: 1, optionalCount: 0 },
  { name: "getTools", paramCount: 1, optionalCount: 0 },
  { name: "list", paramCount: 0, optionalCount: 0 },
];

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 从 apply.ts 源文本提取 provide("mcpManager", {...}) 对象的方法面。
 * 说明：provide 对象字面量未导出、且 apply.ts 导入链重（不 import 运行时），
 * 故用源文本级静态提取（v2 方案「c 兜底」层级：方法名存在性 + 参数形状即可抓
 * 删方法/改参数量；不做 AST 级双真源）。括号配对跳过字符串与注释，防方法体
 * 内大括号干扰对象边界。
 */
function extractProvidedServiceMethods(): Array<{ name: string; paramCount: number; optionalCount: number }> {
  const src = readFileSync(join(pkgDir, "src", "apply.ts"), "utf8");
  const marker = 'provide("mcpManager", {';
  const markerIndex = src.indexOf(marker);
  assert.ok(markerIndex >= 0, "apply.ts 应包含 ctx.provide(\"mcpManager\", {...}) 服务注入");

  // 括号配对扫描：找到 provide 对象的完整区间（跳过字符串字面量与注释）。
  const skip = (s: string, i: number): number => {
    const c = s[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === quote) return i + 1;
        i += 1;
      }
      return i;
    }
    if (c === "`") {
      i += 1;
      while (i < s.length) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === "`") return i + 1;
        if (s[i] === "$" && s[i + 1] === "{") {
          // 模板插值内可能含括号——保守跳过到配对的 }（简单计数，测试源无嵌套插值）
          let depth = 1;
          i += 2;
          while (i < s.length && depth > 0) {
            if (s[i] === "{") depth += 1;
            else if (s[i] === "}") depth -= 1;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      return i;
    }
    if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      return nl < 0 ? s.length : nl + 1;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      return end < 0 ? s.length : end + 2;
    }
    return i;
  };

  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  let i = markerIndex + marker.length - 1; // 指向 '{'
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
    const next = skip(src, i);
    i = next > i ? next : i + 1;
  }
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "provide 对象区间应可完整配对");
  const body = src.slice(bodyStart, bodyEnd);

  const methods: Array<{ name: string; paramCount: number; optionalCount: number }> = [];
  // 顶层方法键行：`<key>: (<params>) => ...`（注释行以 / 开头天然不命中）。
  const keyRe = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\(([^)]*)\)\s*=>/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    const params = m[2].trim();
    const optionalCount = (params.match(/\?/g) ?? []).length;
    // 参数按「顶层逗号」分割：类型标注里的泛型/对象字面量逗号（如
    // `Record<string, unknown>`）不计入参数个数。
    let paramCount = 0;
    let depth = 0;
    for (const ch of params) {
      if (ch === "<" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ">" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) paramCount += 1;
    }
    if (params !== "") paramCount += 1;
    methods.push({ name: m[1], paramCount, optionalCount });
  }
  return methods;
}

// 顶层立即执行（被 smoke.ts import 即运行；不依赖 node:test runner——
// 与同目录 unit-*.test.ts 的执行形态一致）。失败置 exitCode 并打印 FAIL，
// 不中断 smoke 其余检查，但 `pnpm test` 最终退出码红。
try {
  const provided = extractProvidedServiceMethods();
  const contractNames = CONTRACT_METHODS.map((x) => x.name);
  const providedNames = provided.map((x) => x.name);
  assert.deepEqual(
    [...providedNames].sort(),
    [...contractNames].sort(),
    "apply.ts provide(\"mcpManager\") 方法名集合应与契约清单一致（不多不少）",
  );
  for (const expected of CONTRACT_METHODS) {
    const actual = provided.find((x) => x.name === expected.name);
    assert.ok(actual, `provide 对象应含契约方法 ${expected.name}`);
    assert.equal(
      actual.paramCount,
      expected.paramCount,
      `provide.${expected.name} 参数个数应与契约一致（契约=${expected.paramCount}）`,
    );
    assert.equal(
      actual.optionalCount,
      expected.optionalCount,
      `provide.${expected.name} 可选参数个数应与契约一致（契约=${expected.optionalCount}）`,
    );
  }
  console.log("  ok   service-contract: apply.ts provide 方法面与契约清单一致（8 方法/参数形状）");
} catch (error) {
  console.error(`  FAIL service-contract: ${(error as Error).message}`);
  process.exitCode = 1;
}
