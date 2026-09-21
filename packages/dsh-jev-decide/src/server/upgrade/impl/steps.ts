/**
 * upgrade 域实现：0→目标 的种子步骤（仅版本锚定，无数据变换）。
 *
 * 缺失文件以默认值落盘；已存在文件一律不动（退役键剥离、secrets 分离等真实迁移
 * 留给未来版本加步骤时再写，届时在本文件追加 step 函数并在 service 链中登记）。
 * 路径与版本语义复用 config 域（单一事实源），本域不自建第二份。
 */
import { configFile, presetsFile, secretsFile } from "../../config/interface.ts";
import type { SeedFiles, UpgradeIoPorts } from "../deps.ts";

/** 缺失即种（返回新建文件名；已存在即跳过）。 */
export function ensureSeeded(
  home: string | undefined,
  seed: SeedFiles,
  io: UpgradeIoPorts,
): string[] {
  const created: string[] = [];
  const targets: Array<readonly [string, string]> = [
    [configFile(home), seed.configJson],
    [presetsFile(home), seed.presetsJson],
    [secretsFile(home), seed.secretsJson],
  ];
  for (const [file, content] of targets) {
    if (!io.readTextSync(file).ok) {
      io.atomicWrite0600Sync(file, content);
      created.push(file);
    }
  }
  return created;
}
