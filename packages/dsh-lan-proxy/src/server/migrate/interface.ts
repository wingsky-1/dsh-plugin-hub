/**
 * 存量迁移域对外承诺：一次性 config.json → 官方 settings 命名空间收编。
 *
 * 历史文件格式的词汇只在本域出现；落盘走配置域的写面，不另开一条写路径。
 */
export { MIGRATED_BAK_NAME, migrateFileConfig } from "./impl/file/index.ts";
export type { MigrationOutcome } from "./impl/file/index.ts";
