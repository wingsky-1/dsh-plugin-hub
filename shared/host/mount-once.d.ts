/**
 * 防重挂载工具类型定义（js+d.ts 双写；类型与 shared/host/mount-once.js 对应）。
 * 独立包 + 聚合包并存时，同一插件双 entry 各自 apply 会双激活——apply 开头
 * 用 mountOnce(name) 占位，非首次挂载直接 return；effect 清理用 unmount(name) 释放。
 */

/** 尝试占位挂载；true=首次挂载（继续 apply），false=已挂载（跳过注册）。 */
export declare function mountOnce(name: string): boolean;

/** 卸载时释放占位（与 apply 的 effect 清理配对接入）。 */
export declare function unmount(name: string): void;

/** 调试/断言辅助：当前是否已挂载。 */
export declare function isMounted(name: string): boolean;

/** 测试/热重载辅助：清空全部挂载占位（smoke 多次 apply 需要；生产勿用）。 */
export declare function resetMounts(): void;