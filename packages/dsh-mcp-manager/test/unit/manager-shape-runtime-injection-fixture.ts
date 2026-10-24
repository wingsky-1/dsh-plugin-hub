/** Manager 方法面的自然职责测试与专属fixture。 */

import { afterEach, beforeEach } from "vitest";

import { pollUntil } from "../helpers.ts";

import { makeManager, makeTempDir } from "./manager-shape-support.ts";

let prevHome: string | undefined;

let homeDir: string;

function wrappedTool() {
  return {
    name: "cg_node",
    description: "查符号",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      render: (a: unknown, v: { text: unknown }) => [{ type: "text", text: v.text }],
    },
    // String() 与模板内插转义逐字一致，此处不断言、只为类型收窄。
    execute: async (args: unknown) => ({
      text: `node(${String((args as { symbol: unknown }).symbol)})`,
    }),
  };
}

async function registered({ unregister = false } = {}) {
  const { manager, store, log } = makeManager(homeDir);
  await manager.initMiddleware();
  // 池由前置装配保证存在（initMiddleware/真装载刚跑完），此处断言存在。
  const mw = manager.middleware!;
  // 经 registerServer 注入（带 toolDefinitions）→ start 触达 @global 单元虚拟连接，
  // 不注册 mcp__ 直呼工具（单池后没有第二本账）。
  await manager.registerServer({
    name: "cg",
    transport: "stdio",
    command: "codegraph",
    args: ["serve", "--mcp"],
    toolDefinitions: [wrappedTool()],
  });
  await pollUntil(
    "@global 单元虚拟连接建立",
    () => mw.units.get("@global")?.connections.has("cg") === true,
  );
  if (unregister) await manager.unregisterServer("cg");
  return { manager, store, log, mw };
}
export { homeDir, prevHome, registered, wrappedTool };
export function registerRuntimeInjectionHooks() {
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-mgr2w-");
    process.env.DSH_HOME = homeDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
}
