/**
 * dsh-mem0 — HTTP 路由定义（Loopback-only 保护）。
 *
 * 路由列表：
 * - GET  /api/dsh-mem0/status  -> 插件及 stdio 后端运行状态、当前命名空间
 * - GET  /api/dsh-mem0/list    -> 列表查询（接受 ?namespace=）
 * - POST /api/dsh-mem0/add     -> 手动添加记忆条目
 * - POST /api/dsh-mem0/delete  -> 单条记忆删除
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { guardLoopbackMethod, readJsonBody, writeJson } from "../../../shared/host-utils.js";
import type { MemoryExecutor } from "./tool-definitions.ts";
import { GLOBAL_NAMESPACE, resolveGitCanonicalNamespace } from "./namespace.ts";

export interface RouteContext {
  executor: MemoryExecutor;
  getCurrentCwd: () => string | undefined;
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
        writeJson(res, 200, {
          ready: ctx.executor.isReady(),
          currentNamespace: currentNs,
          globalNamespace: GLOBAL_NAMESPACE,
          mode: "stdio",
        });
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
