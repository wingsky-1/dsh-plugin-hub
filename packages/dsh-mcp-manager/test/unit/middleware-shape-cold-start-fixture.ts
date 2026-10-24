/** #1168 冷启动测试共享的状态工厂与场景 helper。 */
import { createMiddlewareShapeSupport } from "./middleware-shape-support.ts";
import type { MiddlewareHost } from "../../src/server/connection/runtime/deps.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ServerConfig } from "../../src/server/config/interface.ts";

const { McpMiddleware } = await import("../../src/server/connection/runtime/interface.ts");
const { registerMiddlewareTools } = await import("../../src/server/inject/interface.ts");

export const coldStartShape = createMiddlewareShapeSupport();
export const makeHost = coldStartShape.makeHost.bind(coldStartShape);
export const remoteEntry = coldStartShape.remoteEntry.bind(coldStartShape);
export const trackMw = coldStartShape.trackMw.bind(coldStartShape);
export const makeUnit = coldStartShape.makeUnit.bind(coldStartShape);
export { McpMiddleware };

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function virtualServer(description: string): ServerConfig {
  return {
    name: "echo",
    transport: "stdio",
    command: "node",
    enabled: true,
    toolDefinitions: [
      {
        name: "ping",
        description,
        parameters: { type: "object", properties: {} },
        output: {
          schema: { type: "object", properties: {} },
          render: () => [{ type: "text", text: "" }],
        },
        execute: async () => ({}),
      },
    ],
  };
}

export function registeredTools(
  mw: InstanceType<typeof McpMiddleware>,
  host: ReturnType<typeof makeHost>["host"],
  root: string,
) {
  const definitions: ToolDefinition[] = [];
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        definitions.push(definition);
        return () => {};
      },
      schemas: () => host.ctx.tools.schemas(),
    },
    on: () => () => {},
  };
  registerMiddlewareTools(ctx as unknown as Context, mw, async () => root, {
    disabledTools: new Map(),
  });
  return definitions;
}

export type ColdStartHost = MiddlewareHost;
