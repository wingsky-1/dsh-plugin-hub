/**
 * upgrade 域实现：0→目标 的种子步骤（仅版本锚定，无数据变换）。
 *
 * 缺失文件以默认值落盘；已存在文件一律不动（退役键剥离、secrets 分离等真实迁移
 * 留给未来版本加步骤时再写，届时在本文件追加 step 函数并在 service 链中登记）。
 */
import type { UpgradeDeps, UpgradeIoPorts } from "../deps.ts";
import { configFile, presetsFile, secretsFile } from "./paths.ts";
import type { SeedFiles } from "../deps.ts";

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

/** 依赖 UpgradeDeps 的种子入口（service 层调用；单测可直调 ensureSeeded）。 */
export function seedMissing(home: string | undefined, deps: UpgradeDeps): string[] {
  return ensureSeeded(home, deps.seedDefaults(), deps.io);
}
