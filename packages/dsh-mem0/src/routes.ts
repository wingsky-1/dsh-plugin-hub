/**
 * dsh-mem0 — HTTP 路由定义（Loopback-only 保护）。
 *
 * 路由列表：
 * - GET  /api/dsh-mem0/status  -> 插件及 stdio 后端运行状态、诊断原因、当前命名空间
 * - GET  /api/dsh-mem0/config  -> 获取脱敏后的当前配置
 * - POST /api/dsh-mem0/config  -> 更新配置并即时热生效（失败自动回滚旧配置）
 * - GET  /api/dsh-mem0/list    -> 列表查询（接受 ?namespace=，返回结构化条目）
 * - POST /api/dsh-mem0/add     -> 手动添加记忆条目
 * - POST /api/dsh-mem0/delete  -> 单条记忆删除
 * - POST /api/dsh-mem0/start   -> 手动拉起记忆服务（#612，幂等互斥）
 * - GET  /api/dsh-mem0/llm-providers -> DSH 提供商列表 + 近 7 天用量徽标
 * - GET  /api/dsh-mem0/llm-models   -> 指定提供商下的模型列表
 * - POST /api/dsh-mem0/install     -> 依赖一键安装/自愈
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../shared/host-utils.js";
import type { MemoryExecutor } from "./tool-definitions.ts";
import { GLOBAL_NAMESPACE, resolveGitCanonicalNamespace } from "./namespace.ts";
import { sanitizeConfigForClient, type Mem0Config } from "./config.ts";
import type { ExecutorStatus } from "./executor.ts";
import { listLlmProviders, listLlmModels } from "./provider-resolver.ts";
import { aggregateProviderUsage } from "./usage-aggregator.ts";

/** 结构化记忆条目（前端列表直接消费）。 */
export interface MemoryListItem {
  id: string;
  memory: string;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
}

export interface MemoryListParseResult {
  items: MemoryListItem[];
  /** python 端返回错误（JSON error 通道或旧文本错误前缀）。 */
  error?: string;
  /** 输出形态来源，便于诊断。 */
  format: "json" | "text-fallback";
}

/**
 * 解析 memory_list 工具输出：
 * 1. 优先 JSON（#612 新形态：{ok:true, items:[...]}）；
 * 2. 回退旧文本形态（"- [id] text" / "- text (id: xxx)"）——鲁棒性兜底，不是版本兼容；
 * 3. 错误串（[memory_list failed: ...] / JSON error 通道）单独识别，绝不当条目渲染。
 */
export function parseMemoryListOutput(text: string): MemoryListParseResult {
  const trimmed = (text || "").trim();
  if (!trimmed) return { items: [], format: "json" };

  // 1. JSON 形态
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { ok?: boolean; error?: string; items?: unknown };
      if (parsed.ok === false) {
        return { items: [], error: parsed.error || "memory_list failed", format: "json" };
      }
      if (Array.isArray(parsed.items)) {
        const items = parsed.items
          .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
          .map((it) => ({
            id: typeof it.id === "string" ? it.id : "",
            memory: typeof it.memory === "string" ? it.memory : "",
            ...(typeof it.created_at === "string" ? { createdAt: it.created_at } : {}),
            ...(typeof it.updated_at === "string" ? { updatedAt: it.updated_at } : {}),
            ...(typeof it.user_id === "string" ? { userId: it.user_id } : {}),
          }))
          .filter((it) => it.id || it.memory);
        return { items, format: "json" };
      }
    } catch {
      // JSON 解析失败落入文本回退
    }
  }

  // 2. 错误串识别（旧文本形态错误前缀）
  const errMatch = trimmed.match(/^\[memory_list failed:\s*([\s\S]+)\]$/);
  if (errMatch) {
    return { items: [], error: errMatch[1]?.trim() || "memory_list failed", format: "text-fallback" };
  }

  // 3. 旧文本形态回退解析
  const items: MemoryListItem[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const bracket = l.match(/^-\s*\[([^\]]+)\]\s*([\s\S]+)$/);
    const paren = l.match(/^-\s*([\s\S]+?)\s*\(id:\s*([^)]+)\)/);
    if (bracket) {
      items.push({ id: bracket[1]?.trim() || "", memory: bracket[2]?.trim() || "" });
    } else if (paren) {
      items.push({ id: paren[2]?.trim() || "", memory: paren[1]?.trim() || "" });
    } else {
      // 无结构行：作为纯文本条目保留（id 置空 → 前端不渲染删除按钮）
      items.push({ id: "", memory: l });
    }
  }
  return { items, format: "text-fallback" };
}

export interface RouteContext {
  executor: MemoryExecutor & {
    getStatus?: () => ExecutorStatus;
    restart?: (env?: Record<string, string>) => Promise<void>;
    markEnvBuildFailed?: (detail: string) => void;
  };
  getCurrentCwd: () => string | undefined;
  getConfig: () => Mem0Config;
  updateConfig: (patch: Record<string, unknown>) => Promise<Mem0Config>;
  installDependencies?: () => Promise<{ ok: boolean; pythonBin: string; error?: string }>;
  /** #612：手动拉起记忆服务（幂等互斥），复用最近一次环境覆盖配置。 */
  startExecutor?: () => Promise<void>;
  /** #612：环境探测（懒触发，秒级重操作）。 */
  probeEnvironment?: () => Promise<{ ok: boolean; pythonBin: string; reason?: string; detail?: string }>;
  /** #612：服务 stderr 日志尾随（环形最近 N 行，已脱敏）。 */
  getStderrTail?: () => string[];
  appCtx?: unknown;
}

export function createMem0Routes(ctx: RouteContext): WebRoute[] {
  // #612：/start 幂等互斥哨兵（模块级并发安全：Node 单线程事件循环内无竞态）
  let startInFlight = false;
  return [
    {
      kind: "exact",
      path: "/api/dsh-mem0/status",
      handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["GET"])) return;
        const currentCwd = ctx.getCurrentCwd();
        const currentNs = resolveGitCanonicalNamespace(currentCwd);
        const execStatus = typeof ctx.executor.getStatus === "function"
          ? ctx.executor.getStatus()
          : { ready: ctx.executor.isReady(), reason: ctx.executor.isReady() ? "ready" : "idle" };

        // #612：stderr 日志尾随随 status 返回（服务端已脱敏），驱动诊断抽屉展示
        let stderrTail: string[] | undefined;
        if (typeof ctx.getStderrTail === "function") {
          try {
            stderrTail = ctx.getStderrTail();
          } catch {
            stderrTail = undefined;
          }
        }

        writeJson(res, 200, {
          ready: ctx.executor.isReady(),
          status: execStatus,
          currentNamespace: currentNs,
          globalNamespace: GLOBAL_NAMESPACE,
          mode: "stdio",
          ...(stderrTail ? { stderrTail } : {}),
        });
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/probe",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        // #612：环境探测懒触发（import mem0 秒级重操作，不随页面常驻）
        if (typeof ctx.probeEnvironment !== "function") {
          writeJson(res, 501, { ok: false, error: "Probe not supported in this context" });
          return;
        }
        try {
          const result = await ctx.probeEnvironment();
          writeJson(res, 200, result);
        } catch (err) {
          writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/config",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["GET", "POST"])) return;
        if (req.method === "GET") {
          const cfg = ctx.getConfig();
          writeJson(res, 200, {
            ok: true,
            config: sanitizeConfigForClient(cfg),
          });
          return;
        }

        // POST 更新配置
        try {
          const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
          if (!body || typeof body !== "object") {
            writeJson(res, 400, { error: "Invalid configuration payload" });
            return;
          }
          const updated = await ctx.updateConfig(body);
          writeJson(res, 200, {
            ok: true,
            config: sanitizeConfigForClient(updated),
          });
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/llm-providers",
      handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["GET"])) return;
        // #612：宿主 llm seam 异常时降级为空列表（前端展示明确空态），不再 400
        let providers: ReturnType<typeof listLlmProviders> = [];
        try {
          providers = listLlmProviders(ctx.appCtx);
        } catch {
          providers = [];
        }
        // #612：附带近 7 天用量徽标（provider-usage 缺失时静默降级为空对象）
        let usage: Record<string, { calls: number; outputTokens: number; lastDay: string }> = {};
        try {
          usage = Object.fromEntries(aggregateProviderUsage());
        } catch {
          usage = {};
        }
        writeJson(res, 200, {
          ok: true,
          providers,
          usage,
        });
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/llm-models",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["GET"])) return;
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const provider = url.searchParams.get("provider") || "";
        let result: Awaited<ReturnType<typeof listLlmModels>>;
        try {
          result = await listLlmModels(ctx.appCtx, provider);
        } catch (err) {
          result = { ok: false, reason: err instanceof Error ? err.message : "discover-failed" };
        }
        writeJson(res, 200, result);
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/start",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        // #612：手动拉起记忆服务（幂等——已就绪时直接返回成功；互斥——进行中直接拒绝）
        if (ctx.executor.isReady()) {
          const execStatus = typeof ctx.executor.getStatus === "function" ? ctx.executor.getStatus() : undefined;
          writeJson(res, 200, { ok: true, alreadyReady: true, status: execStatus });
          return;
        }
        if (typeof ctx.startExecutor !== "function") {
          writeJson(res, 501, { ok: false, error: "Manual start not supported in this context" });
          return;
        }
        if (startInFlight) {
          writeJson(res, 409, { ok: false, error: "Start already in progress" });
          return;
        }
        startInFlight = true;
        try {
          await ctx.startExecutor();
          const execStatus = typeof ctx.executor.getStatus === "function" ? ctx.executor.getStatus() : undefined;
          writeJson(res, 200, { ok: ctx.executor.isReady(), status: execStatus });
        } catch (err) {
          writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        } finally {
          startInFlight = false;
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/install",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        if (typeof ctx.installDependencies !== "function") {
          writeJson(res, 501, { ok: false, error: "Auto-install not supported in this context" });
          return;
        }
        try {
          const result = await ctx.installDependencies();
          writeJson(res, 200, result);
        } catch (err) {
          writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/list",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["GET"])) return;
        if (!ctx.executor.isReady()) {
          writeJson(res, 503, { error: "Memory service offline" });
          return;
        }
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const nsParam = url.searchParams.get("namespace");
          const targetNs = nsParam ? nsParam.trim() : resolveGitCanonicalNamespace(ctx.getCurrentCwd());
          const text = await ctx.executor.list(targetNs);
          writeJson(res, 200, { namespace: targetNs, ...parseMemoryListOutput(text), raw: text });
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/add",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        if (!ctx.executor.isReady()) {
          writeJson(res, 503, { error: "Memory service offline" });
          return;
        }
        try {
          const body = (await readJsonBody(req)) as { text?: string; namespace?: string } | undefined;
          const text = body?.text?.trim();
          if (!text) {
            writeJson(res, 400, { error: "text is required" });
            return;
          }
          const targetNs = body?.namespace?.trim() || resolveGitCanonicalNamespace(ctx.getCurrentCwd());
          const result = await ctx.executor.add(text, targetNs);
          writeJson(res, 200, { ok: true, result });
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    {
      kind: "exact",
      path: "/api/dsh-mem0/delete",
      async handler(req: IncomingMessage, res: ServerResponse) {
        if (!guardLoopbackMethod(req, res, ["POST"])) return;
        if (!ctx.executor.isReady()) {
          writeJson(res, 503, { error: "Memory service offline" });
          return;
        }
        try {
          const body = (await readJsonBody(req)) as { memory_id?: string } | undefined;
          const memoryId = body?.memory_id?.trim();
          if (!memoryId) {
            writeJson(res, 400, { error: "memory_id is required" });
            return;
          }
          const result = await ctx.executor.delete(memoryId);
          writeJson(res, 200, { ok: true, result });
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
  ];
}
