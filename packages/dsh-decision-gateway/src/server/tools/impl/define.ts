/**
 * tools 域实现：模型工具定义（ws_request_verdict / ws_list_verdict_guides）。
 *
 * - 注册面只经组合根的 ctx.tools.register 进入宿主；本模块只产出定义；
 * - exec 上下文防御式读取（sessionId/cwd 缺席即回落 unknown/process.cwd()）；
 * - output 附 JSON 渲染（文本块），失败包络同样可读（无概率字段）；
 * - ws_list_verdict_guides 只读（不记录历史、不触网络）。
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
    name: "ws_request_verdict",
    description:
      "Ask the JEV SystemOne model for a calibrated judgment over text you supply, and get back a structured verdict your code can branch on. " +
      "Ask in English when you can: state, instructions and options calibrate best in English; Chinese is fully supported (lang zh) but may return slightly lower confidence. " +
      "USE when you must decide rather than generate text: pick one option (general), rate a plan 1-5 (plan-review), gate a risky change as safe or risky (risk-check), check text for leaked secrets (secret-leak), or ask any custom question set (custom). " +
      "DO NOT use for open-ended reasoning, writing, or performing actions: this tool only judges and returns a verdict, acting on it is always your decision. " +
      "You MUST supply questions_override on every call (1-20 questions; templates store no questions): choice questions need 2-10 options, score questions must not carry options but may carry levels (2-10 rubric strings, default 1-5), question and preset ids must be lowercase ASCII letters, digits or hyphens. " +
      "Texts matching secret shapes (API keys, tokens, private-key blocks, password assignments) never leave the device and return choice human for a person to review. " +
      "A disabled preset fails with PRESET_DISABLED: check availability first with ws_list_verdict_guides. " +
      "Success returns choice or score plus confidence 0-1, tier (none/low/high) and automation (manual/assisted/auto/suggest-only, advisory only: truncated inputs force suggest-only, except local-precheck routing which stays manual). " +
      "Failures carry errorCode and category (for example NO_KEY, UPSTREAM, RATE_LIMITED, TIMEOUT). " +
      "Without a configured key every call fails NO_KEY: ask the user to configure one in settings.",
    parameters: {
      type: "object",
      properties: {
        preset_id: {
          type: "string",
          enum: ["general", "secret-leak", "plan-review", "risk-check", "custom"],
          description:
            "Which frozen decision template to apply. general: choose one of your options; plan-review: rate with score questions (no options); risk-check: proceed-or-not choice (options like safe/risky); secret-leak: leaked-or-clean check (often disabled; secret-shaped text never leaves the device); custom: any 1-20 questions you supply. User-created custom preset ids (custom:true entries in ws_list_verdict_guides) are also accepted.",
        },
        state: {
          type: "object",
          description: "The content under review.",
          properties: {
            text: {
              type: "string",
              description:
                "The text to judge; must be non-blank. Over-long text is truncated (see truncated/originalLength in the verdict).",
            },
            lang: {
              type: "string",
              enum: ["en", "zh", "unknown"],
              description: "Language of text (required, no default).",
            },
          },
          required: ["text", "lang"],
        },
        questions_override: {
          type: "array",
          description:
            "Full question set for this call, 1-20 questions (required; templates store no questions). ids must be unique.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Question id: ASCII lowercase letters, digits or hyphens, 1-64 chars.",
              },
              text: {
                type: "string",
                description: "Question text: 1-255 chars, must be non-blank.",
              },
              kind: {
                type: "string",
                enum: ["choice", "score"],
                description: "choice picks one option; score rates 1-5.",
              },
              options: {
                type: "array",
                items: { type: "string" },
                description:
                  "Choice only: 2-10 non-empty options (each 64 chars max). Forbidden on score questions.",
              },
              levels: {
                type: "array",
                items: { type: "string" },
                description:
                  "Score only: 2-10 rubric level descriptions (default 1-5 when omitted). Forbidden on choice questions.",
              },
            },
            required: ["id", "text", "kind"],
          },
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
      return decide(args, base);
    },
  };
  const listTool = {
    name: "ws_list_verdict_guides",
    description:
      "List the frozen JEV preset catalogue with live enabled state (read-only: no network, no history). " +
      "Each entry carries its English asking guide (how to shape questions_override for it), templateVersion (always 1) and automationCap (0 manual-only, 1 low, 2 high). " +
      "Call this before ws_request_verdict to check a preset is enabled and to copy its asking conventions.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "array" },
      render: renderJson,
    },
    isConcurrencySafe: () => true,
    execute: () => Promise.resolve(listPresets(assembly.snapshot())),
  };
  return [decideTool as ToolDefinition, listTool as ToolDefinition];
}
