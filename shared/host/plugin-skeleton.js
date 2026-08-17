// dsh 插件家族共享层 — 宿主插件骨架（单一事实源）。
//
// 目标：统一 7 插件各自手写的 apply 薄壳（disposers 收集 + ctx.effect 单一卸载 +
// health 路由 + loopback 围栏 + ROUTES 导出 + mount-once 防重），新插件与重写
// 插件直接使用；存量插件不强推（避免大改回归风险）。
//
// 设计要点（对齐本仓库踩坑记录）：
// - ctx.effect 的 fn 立即执行，清理必须写在返回的 disposer 里——本骨架把
//   disposer 统一收集进数组，effect 返回卸载函数。
// - webServer.register / tools.register 不是 fiber 自动管理——注册时返回的
//   disposer 全部收集，插件卸载时统一调用。
// - health 路由为必选项：GET + loopback 围栏（非回环 403、方法不匹配 405）。
// - mount-once：进程级注册表防重复挂载（独立+聚合并存时同一插件只 apply 一次）。
//
// 注意：shared 层保持 js + d.ts 双写（tsc rootDir 硬约束，不可 TS 化）。
import { isLoopbackRequest } from "../loopback.js";
import { mountOnce, unmount } from "./mount-once.js";

/**
 * 定义宿主插件（返回 cordis apply 薄壳）。
 *
 * @param {object} options
 * @param {string} options.name 插件名（cordis 短名，如 dsh-gzip——同时作为日志、
 *   mount-once 标识与默认 health 路径 /api/<name>/health 的组成部分）
 * @param {Record<string,string>} [options.routes] 路由常量表（{ key: path }），
 *   骨架自动并入 health 项并作为 ROUTES 导出
 * @param {string} [options.healthRoute] health 路由路径（缺省 /api/<name>/health）
 * @param {import("node:http").RequestListener} [options.health] health handler
 *   （缺省返回 { ok: true, plugin: name }）；需返回 { ok, plugin, ...状态摘要 }
 * @param {(ctx: any, config: any, helpers: object) => void} options.register
 *   业务注册函数：内部用 helpers 注册路由/工具/事件，骨架统一收集 disposer
 * @param {(req: import("node:http").IncomingMessage) => boolean} [options.loopback]
 *   回环判定（缺省用共享 isLoopbackRequest）
 * @returns {Function} apply(ctx, config) 薄壳
 */
export function definePlugin({ name, routes = {}, healthRoute, health, register, loopback = isLoopbackRequest }) {
  return function apply(ctx, config = {}) {
    // mount-once：同一进程内同名插件只 apply 一次。注意：跨包副本（独立包与
    // 聚合包各自 esbuild 内联）的注册表相互独立，无法跨副本互斥——真正互斥由
    // loader 按 entry id（0.2.0 起独立 ui- / 聚合 web-ui- 不同 id 并存）保证，
    // 本防重拦截的是「同一副本被重复 apply（如测试/热重载）」场景。
    if (!mountOnce(name)) {
      console.warn(`[${name}] 已挂载，跳过重复注册（mount-once）`);
      return;
    }

    const disposers = [];
    const utils = {
      /** 注册路由；自动套 loopback 围栏（先 403 fail-closed，后 405）。 */
      registerRoute(method, path, handler, { fence = true } = {}) {
        const wrapped = fence ? wrapLoopback(method, path, handler, loopback) : handler;
        const dispose = ctx.webServer.register({ kind: "exact", path, handler: wrapped });
        disposers.push(dispose);
        return dispose;
      },
      /** 注册工具（disposer 自动收集）。 */
      registerTool(tool) {
        const dispose = ctx.tools.register(tool);
        disposers.push(dispose);
        return dispose;
      },
      /** 订阅事件（disposer 自动收集）。 */
      on(event, handler) {
        const dispose = ctx.on(event, handler);
        disposers.push(dispose);
        return dispose;
      },
      disposers,
    };

    try {
      const routePath = healthRoute ?? routes.health ?? `/api/${name}/health`;
      const ROUTES = { ...routes, health: routePath };
      utils.registerRoute("GET", routePath, health ?? healthDefault(name), { fence: true });

      register(ctx, config, { ...utils, ROUTES });
    } catch (e) {
      // 注册失败：清理已收集的 disposer + 释放 mount-once 占位，再抛给宿主
      for (const d of disposers) {
        try { d(); } catch { /* 忽略单个清理失败 */ }
      }
      unmount(name);
      throw e;
    }

    // 单一卸载点：ctx.effect 的 fn 立即执行，清理写在返回的 disposer 里
    ctx.effect(
      () => () => {
        for (const d of disposers) {
          try { d(); } catch { /* 单个清理失败不阻断其余 */ }
        }
        unmount(name);
      },
      name,
    );
  };
}

/** health 缺省 handler：{ ok: true, plugin }（诊断「插件没生效」的标准入口）。 */
function healthDefault(name) {
  return (_req, res) => {
    writeJsonSafe(res, 200, { ok: true, plugin: name });
  };
}

/** loopback 围栏包装：先 loopback 403（fail-closed，仓库既定惯例），后方法 405。 */
function wrapLoopback(method, path, handler, loopback) {
  const methods = Array.isArray(method) ? method : [method];
  return (req, res) => {
    if (!loopback(req)) {
      writeJsonSafe(res, 403, { ok: false, error: "loopback only" });
      return;
    }
    if (!methods.includes(req.method)) {
      writeJsonSafe(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    return handler(req, res);
  };
}

/** 最小 JSON 写响应（骨架自用，避免依赖 host-utils 形成环）。 */
function writeJsonSafe(res, status, payload) {
  if (res.headersSent) return;
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
    });
    res.end(JSON.stringify(payload));
  } catch { /* 响应已关闭则忽略 */ }
}