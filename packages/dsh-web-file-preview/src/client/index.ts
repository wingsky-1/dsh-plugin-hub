/**
 * dsh-web-file-preview — 浏览器端入口（issue #698 重定位后）。
 *
 * 插件在 0.1.5-rc.1 上只剩一件事：把对话内「用默认应用打开」的文件请求改写成官方
 * 右侧栏预览（见 present-open-redirect.ts）。官方预览已覆盖渲染，插件不再自带渲染器、
 * 数据面与样式，也不再拦截对话内的普通文件点击——那些点击官方本来就打开右侧栏预览。
 */

import { REDIRECT_SERVICE, installPresentOpenRedirect } from "./present-open-redirect.ts";

export function apply(ctx: any): void {
  try {
    const restore = installPresentOpenRedirect(ctx);
    ctx.effect(() => () => {
      restore();
    }, "dsh-web-file-preview: present-open redirect");
  } catch (error) {
    console.warn("[dsh-web-file-preview] mount failed:", error);
  }
}

// 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）。
// 注入代理按本数组校验 ctx 属性访问，漏声明即抛 "without inject"（#486-fix）：sessions
// 用于把卡片路径折叠成工作区相对地址，sidebarRight 是官方右侧栏导航入口（REDIRECT_SERVICE
// 与装配模块共用同一常量，防两处名字漂移）。旧版 dsh 没有 sidebarRight，该数组不满足即
// 整体不激活。
export const inject: string[] = ["sessions", REDIRECT_SERVICE];
