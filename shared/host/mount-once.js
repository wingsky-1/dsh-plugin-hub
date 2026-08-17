// dsh 插件家族共享层 — mount-once 防重挂载（单一事实源，进程级）。
//
// 背景：0.2.0 起 patch id 统一 ui-<name>，聚合行 = 子包行原样拼接（同 id，无
// config）。同一插件若被重复 apply（同一进程内多次加载同名插件、测试/热重载等）
// 会造成重复注册——apply 开头用本模块防重：同一进程内同名插件只 apply 一次，
// effect 卸载时释放。独立+聚合双装场景由 loader 按相同 entry id 的 duplicate
// 抛 TypeError（fail-loud）兜底，README 声明禁双装。
//
// 实现要点：挂载表挂在 **globalThis**（而非模块内 Set）——
// 1. 真正「进程级」：独立包、聚合包、各产物副本（esbuild 内联）共享同一注册表，
//    跨副本互斥生效（评审 G3 指出的模块级 Set 无法跨副本互斥的缺陷）；
// 2. 便于测试/热重载：外部可经 globalThis.__DSH_MOUNTED__ 查看或重置占位。
//
// 注意：shared 层保持 js + d.ts 双写（tsc rootDir 硬约束，不可 TS 化）。

/** 进程级已挂载注册表（host 进程全局共享；key 为插件名/包名）。 */
const mounted = (globalThis.__DSH_MOUNTED__ ??= new Set());

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

/** 测试/热重载辅助：清空全部挂载占位（smoke 多次 apply 需要；生产勿用）。 */
export function resetMounts() {
  mounted.clear();
}
