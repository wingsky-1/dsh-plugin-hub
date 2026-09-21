/**
 * tools 域实现：模型工具定义（ws_jev_decide / ws_jev_list_presets）。
 *
 * - 注册面只经组合根的 ctx.tools.register 进入宿主；本模块只产出定义；
 * - exec 上下文防御式读取（sessionId/cwd 缺席即回落 unknown/process.cwd()）；
 * - output 附 JSON 渲染（文本块），失败包络同样可读（无概率字段）；
 * - ws_jev_list_presets 只读（不记录历史、不触网络）。
 */
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { CustomPreset } from "../../../shared/interface.ts";
import type { DecideDeps } from "../deps.ts";
import { decide, listPresets } from "./service.ts";

/** 工具装配（组合根绑定：exec→deps 映射 + 快照取数）。 */
export interface ToolAssembly {
  readonly depsFor: (exec: unknown) => DecideDeps;
  readonly snapshot: () => {
    readonly isEnabled: (presetId: string) => boolean;
    readonly capOf: (presetId: string) => number;
    readonly customs?: readonly CustomPreset[];
  };
}

/**
 * exec 取 sessionId（多形态防御读取）。
 *
 * 本函数是两处解析规则收敛后的唯一实现（D4）：组合根直接引用本导出，不再自写根侧版本。
 */
export function sessionOf(exec: unknown): string {
  if (exec !== null && typeof exec === "object") {
    const rec = exec as Record<string, unknown>;
    const direct = rec["sessionId"];
    if (typeof direct === "string" && direct.length > 0) return direct;
    for (const key of ["session", "agent"]) {
      const nested = rec[key];
      if (nested !== null && typeof nested === "object") {
        const id = (nested as Record<string, unknown>)["id"];
        if (typeof id === "string" && id.length > 0) return id;
      }
    }
  }
  return "unknown";
}

/** exec 取工作目录（缺席回落进程 cwd；与 sessionOf 同源收敛，见上）。 */
export function rootOf(exec: unknown): string {
  if (exec !== null && typeof exec === "object") {
    const rec = exec as Record<string, unknown>;
    for (const key of ["cwd", "root", "workdir"]) {
      const value = rec[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return process.cwd();
}

/** 值转单文本块（失败包络同样 JSON 可读）。 */
function renderJson(
  _args: unknown,
  value: unknown,
): { readonly type: "text"; readonly text: string }[] {
  return [{ type: "text", text: JSON.stringify(value) }];
}

/** 产出两工具定义。 */
export function buildToolDefinitions(assembly: ToolAssembly): ToolDefinition[] {
  const decideTool = {
    name: "ws_jev_decide",
    description:
      "Run a frozen JEV preset decision (SystemOne). Local secret-shape hits never leave the device and route to human.",
    parameters: {
      type: "object",
      properties: {
        preset_id: {
          type: "string",
          description: "Frozen preset id (general|secret-leak|plan-review|risk-check|custom)",
        },
        state: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to judge (non-empty; truncated at truncBudget)",
            },
            lang: { type: "string", description: "en|zh|unknown (required, no default)" },
          },
          required: ["text", "lang"],
        },
        questions_override: {
          type: "array",
          description:
            "Caller-supplied full question set, required (1-20). Templates hold no questions.",
        },
      },
      required: ["preset_id", "state", "questions_override"],
    },
    output: {
      schema: { type: "object" },
      render: renderJson,
    },
    isConcurrencySafe: () => true,
    execute: (args: unknown, exec: unknown) => {
      const base = assembly.depsFor(exec);
      return decide(args, { ...base, root: rootOf(exec), sessionId: sessionOf(exec) });
    },
  };
  const listTool = {
    name: "ws_jev_list_presets",
    description: "List frozen JEV presets with enabled state (read-only).",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object" },
      render: renderJson,
    },
    isConcurrencySafe: () => true,
    execute: () => Promise.resolve(listPresets(assembly.snapshot())),
  };
  return [decideTool as ToolDefinition, listTool as ToolDefinition];
}
