/**
 * dsh-codegraph — mcp-manager 服务消费方契约测试（issue #476，service-consumer）。
 *
 * 消费方合规锁（codegraph 经 mcp-manager **公开入口**消费 ctx.mcpManager 服务）：
 * 1. 编译期：经 `@wingsky-1/dsh-mcp-manager` 公开入口（exports["./types"] →
 *    lib/index.d.ts → service.d.ts → shared 单一事实源）强类型 import
 *    `McpManagerService`/`McpManagerServerInput`，对 mock 服务做**类型化调用**
 *    （registerServer 携带 toolDefinitions + description、getStatus 收窄、
 *    unregisterServer）——消费面类型演进不同步（方法被删/签名变更）→ 本文件
 *    被 tsc 编译即红。类型断言在 Node 直跑时擦除，须由编译面执行（接线：
 *    scripts/test/service-contract-wiring.test.ts spawn tsc -p test/tsconfig.json）。
 * 2. 静态锁：src 无直连 `shared/` 引用（消费入口合规）；依赖解析链
 *    （devDep workspace:* + 公开入口 types 指向 lib/index.d.ts）存在。
 * 3. 运行时：mock 服务记录类型化调用并回放契约返回——注册/注销路径的
 *    「调用形状」在 smoke 运行时同样被执行（本文件被 test/smoke.ts import）。
 *
 * 红线（#476）：不改 shared 契约层、不改两包 src——本文件只锁消费现状。
 * 无 @ts-nocheck：编译期断言必须真实参与类型检查。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// 消费方视角：与 src/index.ts 同款公开入口（真实依赖解析链：workspace devDep +
// exports["./types"]）。共享类型不在此入口导出（仅 ServerInput/Service 两型），
// 结构经 McpManagerService 的方法签名闭包可达。
import type { McpManagerServerInput, McpManagerService } from "@wingsky-1/dsh-mcp-manager";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

// ─────────────────────── 编译期消费面类型断言区 ───────────────────────
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

// 公开入口导出的两个类型存在（解析失败/入口断链 → import 即编译红，此处显式锚定）。
type _HasServerInput = Assert<Equal<McpManagerServerInput["transport"], "stdio" | "streamable-http">>;
type _HasService = Assert<McpManagerService extends { list(): readonly unknown[] } ? true : false>;
// 消费用方法面锚定（registerServer 返回结构 / getStatus 可空 / 注销 void）。
// 注：查询面返回类型（McpServerSummary/McpToolInfo）不在公开入口具名导出——消费
// 方只经方法签名闭包感知其结构；此处用结构锚（ReturnType 形状）断言，不具名引用。
type _HasRegisterReturn = Assert<Equal<Awaited<ReturnType<McpManagerService["registerServer"]>>, { name: string; existing: boolean }>>;
type _HasGetStatus = Assert<
  ReturnType<McpManagerService["getStatus"]> extends { name: string; status: string; tools: string[] } | undefined
    ? true
    : false
>;
type _HasUnregister = Assert<Equal<ReturnType<McpManagerService["unregisterServer"]>, Promise<void>>>;

// 消费侧类型化调用编译锚（mock 服务 + 真实输入结构；调用面不同步 → 编译红）。
declare const mock: McpManagerService;
const serverInput: McpManagerServerInput = {
  name: "codegraph",
  transport: "stdio",
  description: "codegraph 本地代码图谱",
  command: "codegraph",
  args: ["serve", "--mcp"],
  toolCallTimeoutMs: 60000,
  reconnect: {},
  // toolDefinitions 形状与消费侧一致：封装工具定义数组（name/description/…）。
  toolDefinitions: [] as ToolDefinition[],
};
async function consumeLikeCodegraph(): Promise<void> {
  const { existing } = await mock.registerServer(serverInput);
  const status = mock.getStatus("codegraph");
  if (status !== undefined && status.status === "failed") {
    void status.error;
  }
  await mock.unregisterServer("codegraph");
  void existing;
}

// ─────────────────────── 运行时调用形状断言区 ───────────────────────
// 构造可记录调用的 mock McpManagerService（结构上满足公开入口类型）。
type RecordingService = McpManagerService & { __calls: string[] };
function makeRecordingService(): RecordingService {
  const calls: string[] = [];
  const service: McpManagerService = {
    registerServer: async (server) => {
      calls.push(`registerServer(${server.name}, transport=${server.transport}, toolDefinitions=${server.toolDefinitions?.length ?? 0})`);
      return { name: server.name, existing: false };
    },
    unregisterServer: async (name) => {
      calls.push(`unregisterServer(${name})`);
    },
    connect: async (name) => {
      calls.push(`connect(${name})`);
    },
    disconnect: async (name) => {
      calls.push(`disconnect(${name})`);
    },
    reconnect: async (name) => {
      calls.push(`reconnect(${name})`);
    },
    getStatus: (name) => {
      calls.push(`getStatus(${name})`);
      return undefined;
    },
    getTools: (name) => {
      calls.push(`getTools(${name})`);
      return [];
    },
    list: () => {
      calls.push("list()");
      return [];
    },
  };
  return Object.assign(service, { __calls: calls }) as RecordingService;
}

// 顶层立即执行（被 smoke.ts import 即运行；与 mcp-manager 契约测试同形态）。
try {
  const recording = makeRecordingService();
  // 复刻 codegraph src/index.ts 的消费序列（#363 补充 3 + #417 A2）：
  // registerServer（携带 toolDefinitions+description）→ getStatus 收窄 → unregisterServer。
  const input: McpManagerServerInput = {
    name: "codegraph",
    description: "codegraph 本地代码图谱：结构类查询",
    transport: "stdio",
    command: "codegraph",
    args: ["serve", "--mcp"],
    toolCallTimeoutMs: 60000,
    reconnect: {},
    toolDefinitions: [{ name: "codegraph_explore", description: "探索" }] as ToolDefinition[],
  };
  const { existing } = await recording.registerServer(input);
  assert.equal(existing, false);
  const status = recording.getStatus("codegraph");
  assert.equal(status, undefined);
  await recording.unregisterServer("codegraph");
  assert.deepEqual(recording.__calls, [
    "registerServer(codegraph, transport=stdio, toolDefinitions=1)",
    "getStatus(codegraph)",
    "unregisterServer(codegraph)",
  ]);
  console.log("  ok   service-consumer: 消费方类型化调用形状与契约一致（registerServer/getStatus/unregisterServer）");
} catch (error) {
  console.error(`  FAIL service-consumer: ${(error as Error).message}`);
  process.exitCode = 1;
}

// ─────────────────────── 无直连 shared 静态断言 ───────────────────────
// codegraph src 消费入口必须走包公开入口，禁止直连 shared/ 类型文件。
// （放行注释内的命中——import 语句剔除行注释/块注释后匹配。）
{
  const pkgDir2 = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcDir = join(pkgDir2, "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (/\.ts$/.test(entry.name)) {
        const text = readFileSync(p, "utf8");
        const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const line of code.split("\n")) {
          if (/from\s+["']\.{1,2}\/.*shared\//.test(line) || /import\s*\(\s*["'][^"']*shared\//.test(line)) {
            offenders.push(`${p}: ${line.trim()}`);
          }
        }
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], "codegraph src 不得直连 shared/（消费入口必须走 @wingsky-1/dsh-mcp-manager 公开入口）");
  console.log("  ok   service-consumer: codegraph src 无直连 shared/ 引用");
}

// ─────────────────────── 依赖解析链断言 ───────────────────────
{
  const pkgDir3 = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkgJson = JSON.parse(readFileSync(join(pkgDir3, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
    exports?: Record<string, { types?: string; default?: string } | string>;
  };
  // devDep 声明 workspace:*（依赖解析链源头）。
  const dep = pkgJson.devDependencies?.["@wingsky-1/dsh-mcp-manager"];
  assert.ok(dep !== undefined, "codegraph devDependencies 应声明 @wingsky-1/dsh-mcp-manager");
  assert.ok(dep === "workspace:*", `codegraph 应声明 workspace:* 协议（实际 ${dep}）`);
  // 公开入口 types 指向 lib/index.d.ts（解析链末端存在）。
  const typesTarget =
    typeof pkgJson.exports?.["."] === "string"
      ? pkgJson.exports?.["."]
      : (pkgJson.exports?.["."] as { types?: string } | undefined)?.types;
  assert.ok(typeof typesTarget === "string" && typesTarget.endsWith("lib/index.d.ts"), "exports[.] 应含指向 lib/index.d.ts 的 types 条件");
  assert.ok(existsSync(join(pkgDir3, typesTarget as string)), `类型入口文件应存在（${typesTarget}）`);
  console.log("  ok   service-consumer: 依赖解析链完整（devDep workspace:* + exports[.].types → lib/index.d.ts）");
}
