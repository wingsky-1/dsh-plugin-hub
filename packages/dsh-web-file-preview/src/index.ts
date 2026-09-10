/**
 * dsh-web-file-preview — 组合根（宿主半边）。
 *
 * 重定位后插件只有客户端半边：把对话内「用默认应用打开」的文件请求改写成官方右侧栏
 * 预览（见 src/client/present-open-redirect.ts）。宿主不注册任何路由、不读文件，也不
 * 注入任何宿主服务，因此这里只保留 bundle 契约所需的最小面。
 *
 * 纯逻辑（请求谓词与官方地址构造）经此透出，供 smoke 与单元测试直测。
 */

/** 稳定的 cordis 插件名。 */
export const name = "web-file-preview";

/**
 * 宿主路由表：重定位后为空。
 *
 * 保留该导出是为了满足宿主入口契约——`verify:npmlayout` 要求声明了 `dsh.client`
 * 的包其宿主入口含 `ROUTES|route` 字样（客户端路由的单一事实源约定）。
 */
export const ROUTES = {} as const;

/** 宿主无副作用：路由与文件读取已随重定位全部移除。 */
export function apply(): void {}

// issue #698：「打开文件」→ 官方右侧栏预览的重定向纯逻辑（DOM-free，客户端装配经
// src/client/present-open-redirect.ts 引用，此处透出供 smoke/单测直测）。
export {
  PRESENT_OPEN_PATH, PENDING_TTL_MS, isOpenRequest, sessionIdOf,
  fileAddressFor, looksLikeFilePath, usablePending,
} from "./present-open.ts";
export type { PendingEntry } from "./present-open.ts";
