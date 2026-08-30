/**
 * dsh-notifier — 通知中心服务类型面 + cordis Context 声明合并。
 *
 * 形态对表同仓 dsh-mcp-manager（service.ts）：提供方在 src/service.ts
 * 经 createNotifierService + ctx.provide('wingsky.notifier') 注册；
 * 消费方（其他 hub 插件，如 dsh-idle-archive）从本包引类型：
 *
 *   import type { NotifierService } from '@wingsky-1/dsh-notifier';
 *   export const inject = ['wingsky.notifier'];
 *   // apply(ctx) 内：ctx['wingsky.notifier'].send({...})
 *
 * 可选增强（不强制 inject）：ctx.get('wingsky.notifier', false) 探测后降级。
 * 版本兼容：服务实例暴露 apiVersion 常量；跨插件入口经形状守卫（评审 #4）。
 */
export type { NotifierService, NotifyRequest, NotifyResult, NotifySeverity, KindRegistration, NotifyChannel, ChannelCapabilities } from "./service.ts";
export { KIND_SEVERITY, BUILTIN_CHANNELS } from "./service.ts";
export type { NotifierServiceDeps } from "./service.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 通知中心核心服务：其他插件经此发送单向通知 / 注册动态通知类型（'wingsky.notifier'）。 */
    "wingsky.notifier": import("./service.ts").NotifierService;
  }
}