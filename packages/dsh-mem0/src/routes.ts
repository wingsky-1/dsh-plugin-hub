/**
 * dsh-mem0 — HTTP 路由定义（Loopback-only 保护）。
 *
 * 路由列表：
 * - GET  /api/dsh-mem0/status  -> 插件及 stdio 后端运行状态、诊断原因、当前命名空间
 * - GET  /api/dsh-mem0/config  -> 获取脱敏后的当前配置
 * - POST /api/dsh-mem0/config  -> 更新配置并即时热生效
 * - GET  /api/dsh-mem0/list    -> 列表查询（接受 ?namespace=）
 * - POST /api/dsh-mem0/add     -> 手动添加记忆条目
 * - POST /api/dsh-mem0/delete  -> 单条记忆删除
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../shared/host-utils.js";
import type { MemoryExecutor } from "./tool-definitions.ts";
import { GLOBAL_NAMESPACE, resolveGitCanonicalNamespace } from "./namespace.ts";
import { sanitizeConfigForClient, type Mem0Config } from "./config.ts";
import type { ExecutorStatus } from "./executor.ts";

export interface RouteContext {
  executor: MemoryExecutor & {
    getStatus?: () => ExecutorStatus;
    restart?: (env?: Record<string, string>) => Promise<void>;
  };
  getCurrentCwd: () => string | undefined;
  getConfig: () => Mem0Config;
  updateConfig: (patch: Record<string, unknown>) => Promise<Mem0Config>;
  installDependencies?: () => Promise<{ ok: boolean; pythonBin: string; error?: string }>;
}

export function createMem0Routes(ctx: RouteContext): WebRoute[] {
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

        writeJson(res, 200, {
          ready: ctx.executor.isReady(),
          status: execStatus,
          currentNamespace: currentNs,
          globalNamespace: GLOBAL_NAMESPACE,
          mode: "stdio",
        });
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
          writeJson(res, 200, { namespace: targetNs, result: text });
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
