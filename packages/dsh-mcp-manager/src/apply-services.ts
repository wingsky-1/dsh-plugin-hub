/**
 * dsh-mcp-manager — apply 装配拆分：核心化服务注入面（#592 阶段二 Batch A）。
 *
 * 职责：把 apply() 中向容器提供 mcpManager 核心化服务的 8 方法服务对象装配
 * 抽为独立工厂（原内联闭包是 apply 圈复杂度 78 的主要来源之一）。
 *
 * 契约红线：service-contract.test.ts 以源文本静态扫描 provide marker 提取
 * 方法面（8 方法/参数形状，fail-loud）——本文件保留与拆分前**逐字相同**的
 * marker 与方法名/参数形状，拆分零行为变更；若改方法面须同步契约清单。
 * 注意：本文件注释中不得出现该 marker 的逐字形态（静态扫描按首个命中定位，
 * 注释命中会导致配对错扫——契约测试会红提示）。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { McpManager } from "./connection/interface.ts";
import type { McpServerSummary } from "../../../shared/mcp-manager-service.js";

/**
 * 向宿主容器提供核心化服务 `ctx.mcpManager`（供其他插件运行时注入/控制/查询
 * MCP 服务器）。提供时机由调用方保证（store.load 之后 manager 已就绪）；卸载
 * 由 mcp-manager 自身 dispose() 全量清理（含 runtime 条目与 supervisor）。
 * 兼容：fake ctx（单元测试 mock）可能无 provide，可选调用静默降级。
 */
export function provideMcpManagerService(ctx: Context, manager: McpManager): void {
  if (typeof (ctx as unknown as { provide?: unknown }).provide !== "function") return;
  ctx.provide("mcpManager", {
    // 注入面（内存态不落盘，同名幂等；toolDefinitions 可选封装定义透传 supervisor）
    registerServer: (server: Record<string, unknown>) => manager.registerServer(server),
    unregisterServer: (name: string) => manager.unregisterServer(name),
    // 控制面（通用 MCP 生命周期：注册即连、注销即断的补充控制）
    connect: (name: string, scope?: string) => manager.connect(name, scope),
    disconnect: (name: string, scope?: string) => manager.disconnect(name, scope),
    reconnect: (name: string, scope?: string) => manager.reconnect(name, scope),
    // 查询面（服务状态感知：连接状态 / 工具列表 / 全量摘要）
    getStatus: (name: string) => {
      const servers = (manager.summary().servers ?? []) as Array<Record<string, unknown>>;
      const found = servers.find((s) => s.name === name);
      if (found === undefined) return undefined;
      return found as unknown as McpServerSummary;
    },
    getTools: (name: string) => {
      // 契约（#382 F4）：getTools 返回**注册名**（mcp__<server>__<tool> 前缀，
      // 与 ctx.tools 注册表一致）；summary().tools 返回**裸名**（展示/禁用表
      // 键口径）。消费方按需自取，勿混用两套键。
      const sup = manager.supervisors.get(name);
      if (sup === undefined) return [];
      const tools: Array<{ name: string; description?: string }> = [];
      for (const [toolName, meta] of sup.toolMeta ?? new Map()) {
        tools.push({
          name: toolName,
          description: typeof meta?.description === "string" ? meta.description : undefined,
        });
      }
      return tools;
    },
    list: () =>
      (manager.summary().servers ?? []) as unknown as McpServerSummary[],
  });
}
