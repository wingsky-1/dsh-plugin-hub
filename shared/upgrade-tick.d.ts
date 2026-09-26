/**
 * 空步：立即完成，不碰任何存储。调用方把版本号写在自己的步骤表里，run 统一指到本函数。
 *
 * @returns {Promise<void>} 恒为完成态的 Promise。
 */
export function tickUpgradeVersion(): Promise<void>;

/**
 * 空步（同步链用）：什么都不做，立即返回。
 */
export function tickUpgradeVersionSync(): void;
