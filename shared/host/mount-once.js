// dsh 插件家族共享层 — mount-once 防重挂载（单一事实源）。
//
// 背景：0.2.0 起独立包 patch id 统一 ui-<name>、聚合包行 id 为 web-ui-<name>
// （不同 id 并存，loader 层不再 duplicate-id 冲突），但同一个 npm 包若同时
// 以独立+聚合两种方式安装，会出现两个 entry 各自 apply → 双激活
// （lan-proxy 双监听 EADDRINUSE / notifier 重复通知）。插件层用本模块在
// apply 开头防重：同一进程内同名插件只 apply 一次，effect 卸载时释放。
//
// 注意：shared 层保持 js + d.ts 双写（tsc rootDir 硬约束，不可 TS 化）。

/** 进程级已挂载注册表（key 为插件名/包名，独立包与聚合包同源同 key）。 */
const mounted = new Set();

/**
 * 尝试占位挂载。返回 true 表示本次是首次挂载（可继续 apply）；
 * false 表示已挂载过（调用方应跳过注册并直接 return）。
 */
export function mountOnce(name) {
  if (mounted.has(name)) return false;
  mounted.add(name);
  return true;
}

/** 卸载时释放占位（与 apply 的 effect 清理配对接入）。 */
export function unmount(name) {
  mounted.delete(name);
}

/** 调试/断言辅助：当前是否已挂载。 */
export function isMounted(name) {
  return mounted.has(name);
}