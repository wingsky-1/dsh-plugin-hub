import type { IncomingMessage, ServerResponse, RequestListener } from "node:http";

/**
 * 宿主插件骨架辅助定义（js+d.ts 双写；类型与 shared/host/plugin-skeleton.js 对应）。
 * 统一 apply 薄壳：disposers 收集 + ctx.effect 单一卸载 + health 路由（loopback 围栏）
 * + ROUTES 导出 + mount-once 防重。
 */

/**
 * 路由注册信息（与 dsh 宿主 webServer.register 契约一致）。
 */
export interface SkeletonRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;
}

/** 骨架暴露给 register 的 helpers。 */
export interface SkeletonHelpers {
  /** 注册路由（自动 loopback 围栏：非回环 403 / 方法错 405）；disposer 已收集。 */
  registerRoute(method: string | string[], path: string, handler: RequestListener, opts?: { fence?: boolean }): () => void;
  /** 注册工具（disposer 已收集）。 */
  registerTool(tool: Record<string, unknown>): () => void;
  /** 订阅事件（disposer 已收集）。 */
  on(event: string, handler: (...args: any[]) => void): () => void;
  /** 骨架收集的全部 disposer（需要时可直接追加）。 */
  disposers: Array<() => void>;
  /** 最终 ROUTES 常量（含 health 项）。 */
  ROUTES: Record<string, string>;
}

/** definePlugin 入参。 */
export interface DefinePluginOptions {
  name: string;
  routes?: Record<string, string>;
  healthRoute?: string;
  health?: RequestListener;
  register: (ctx: any, config: any, helpers: SkeletonHelpers) => void;
  loopback?: (req: IncomingMessage) => boolean;
}

/** 定义宿主插件（返回 cordis apply 薄壳）。 */
export declare function definePlugin(options: DefinePluginOptions): (ctx: any, config?: any) => void;