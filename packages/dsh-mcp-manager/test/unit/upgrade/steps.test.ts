/**
 * dsh-mcp-manager upgrade 域 steps 表接线 —— 装配方驱动的确实是本包自己的迁移动作。
 *
 * 判据面：链驱动本身（待办步筛选、逐步 await、每步回写、失败即抛、跑后对账）是共享层的判据，那里有
 * 自己的用例；业务 step 函数的行为（四态 / 幂等 / 坏内容 / mtime / 接管）由同目录
 * `storage-layout.test.ts` 守。本文件只补中间那一环——`STEPS` 这张表接进装配方之后，链驱动的
 * 确实是「存储布局归位」这个本包动作，刻度也确实被这张表推到了最后一格。
 *
 * 断言一律落在可观察的磁盘效果上（旧路径文件改名留痕 / 新落点内容逐字一致 / 刻度文件内容），
 * 不断言链内部调用次数、排序与错误文案。
 *
 * 末节是刻度**读侧**的最小判据（空白刻度按起点起算）：那是本包自己的读策略，链驱动只 await
 * `readScale` 不替它决定——刻度落点与读到什么算哪一版都属本域，故随本文件守，不另立文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newestTargetVersion } from "../../../../../shared/upgrade-chain.js";
import {
  LEGACY_LAYOUT,
  configFile,
  legacyFile,
  userStatePath,
  versionFile,
} from "../../../src/server/shared/interface.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { readStoredVersion } from "../../../src/server/upgrade/impl/version/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

/** 归档后缀：与实现同名的固定标记（判据要的是「旧路径被处理过」，故名字必须与实现一致地固定）。 */
const MIGRATED_SUFFIX = ".migrated.bak";

let disposeHome: () => void;

beforeEach(() => {
  disposeHome = tempDshHome().dispose;
});

afterEach(() => {
  // 装配标记是模块级单例状态：用例失败也要复位，否则后续用例会被「只能装配一次」连坐。
  releaseUpgrade();
  disposeHome();
});

/** 装配方入口：与组合根同一副面孔（await 装配 → 链已跑完）。 */
async function assemble(): Promise<void> {
  await installUpgrade({ logger: makeLogger(), storePath: "" });
}

/** 本域业务迁移那一步的目标版本（锚点是原点 `0.0.0`，不依赖表内的书写顺序）。 */
function migratedTarget(): string {
  return STEPS.find((step) => step.fromVersion === "0.0.0")?.targetVersion ?? "";
}

describe("STEPS 表接线：装配方驱动的确实是本包迁移动作", () => {
  it("存量安装（无刻度）→ 旧路径文件改名留痕、包私有新落点出现且内容逐字一致", async () => {
    const legacyConfig = legacyFile(LEGACY_LAYOUT.config);
    const legacyState = legacyFile(LEGACY_LAYOUT.userState);
    writeFileSync(legacyConfig, '{"servers":["from-legacy"]}\n', "utf8");
    writeFileSync(legacyState, '{"disabled":{"a":{"b":true}}}\n', "utf8");

    await assemble();

    // 判据是「搬过去了」而不是「新文件在」：新文件存在可能只是空初始形态，内容逐字一致 + 旧文件
    // 改名留痕才是本包这次迁移动作真的跑过——链装错表（接了别的动作）时这两条同时落空。
    for (const [legacy, target, text] of [
      [legacyConfig, configFile(), '{"servers":["from-legacy"]}\n'],
      [legacyState, userStatePath(), '{"disabled":{"a":{"b":true}}}\n'],
    ]) {
      expect([legacy, readFileSync(target, "utf8")]).toEqual([legacy, text]);
      expect([legacy, existsSync(legacy)]).toEqual([legacy, false]);
      expect([legacy, readFileSync(`${legacy}${MIGRATED_SUFFIX}`, "utf8")]).toEqual([legacy, text]);
    }
  });

  it("刻度停在表里的最后一格：越过业务迁移那一步，空步登记丢了就停在上一格", async () => {
    await assemble();

    const newest = newestTargetVersion(STEPS);
    // 无形态变化的版本同样占一步登记，否则存储刻度永远停在旧值上（表少登记一格，这里当场红）。
    expect(newest).not.toBe(migratedTarget());
    expect(readFileSync(versionFile(), "utf8").trim()).toBe(newest);
  });
});

describe("刻度读侧：空白刻度按起点起算", () => {
  it("刻度文件只有空白 → 读回 0.0.0（空串不是合法刻度），改坏必须红", async () => {
    mkdirSync(dirname(versionFile()), { recursive: true });
    writeFileSync(versionFile(), " \n\t\n", "utf8");

    expect(await readStoredVersion()).toBe("0.0.0");
  });
});
