/**
 * dsh-mcp-manager upgrade 域 service 块 —— 装配面：跑链的时机、刻度的推进与不推进、对账与装配标记。
 *
 * 判据面：升级必须在各域装配**之前**跑完（先装配就等于让各域读到旧形态并带着它继续跑）。链本身锁四处：
 * **起点边界**（刻度恰好停在 `fromVersion` 的装机必须执行这一步——唯一的真实升级场景）、
 * **失败不推进**（刻度回写在 `run` 之后，失败即不写，下次从同一步重跑）、**三种落差分开报**
 * （要人去改的地方完全不同，合成一条等于三处都只剩「有出声」）、**装配标记**（重复装配当场抛、
 * release 只复位标记、失败不占住标记）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_LAYOUT,
  configFile,
  legacyFile,
  versionFile,
} from "../../../src/server/shared/interface.ts";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import { pendingSteps, reportGap } from "../../../src/server/upgrade/impl/chain/index.ts";
import type { UpgradeStep } from "../../../src/server/upgrade/impl/chain/type.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { compareVersions, pluginVersion } from "../../../src/server/upgrade/impl/version/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

let disposeHome: () => void;

beforeEach(() => {
  disposeHome = tempDshHome().dispose;
});

afterEach(() => {
  // 单例标记是模块级状态：用例失败也要复位，否则后续用例会被「只能装配一次」连坐。
  releaseUpgrade();
  disposeHome();
});

/** 步骤表里最高的目标版本：链跑完的刻度应当正好落在它上面。 */
function newestTarget(): string {
  return STEPS.map((step) => step.targetVersion).reduce((newest, version) =>
    compareVersions(version, newest) > 0 ? version : newest,
  );
}

/** 装配一次升级域（链在装配期跑完）。 */
async function assemble(overrides: Partial<UpgradeDeps> = {}) {
  const logger = overrides.logger ?? makeLogger();
  const deps: UpgradeDeps = { logger, storePath: "", ...overrides };
  await installUpgrade(deps);
  return { logger, deps };
}

/** 种一份刻度（父目录可能还不存在）。 */
function seedClock(version: string): void {
  mkdirSync(dirname(versionFile()), { recursive: true });
  writeFileSync(versionFile(), `${version}\n`, "utf8");
}

/** 合成一步：只用来断言排序与起点边界，不做任何磁盘动作。 */
function step(fromVersion: string, targetVersion: string): UpgradeStep {
  return { fromVersion, targetVersion, run: () => Promise.resolve() };
}

describe("装配期跑链", () => {
  it("装配返回时刻度已落在步骤表最后一步的目标版本，初始形态也已落定", async () => {
    await assemble();

    expect(readFileSync(versionFile(), "utf8").trim()).toBe(newestTarget());
    expect(existsSync(configFile())).toBe(true);
  });

  it("刻度已到目标版本的存储不再重跑步骤（否则每次启动都会拿旧文件盖回用户改过的新数据）", async () => {
    seedClock(newestTarget());
    const legacy = legacyFile(LEGACY_LAYOUT.config);
    writeFileSync(legacy, '{"legacy":true}\n', "utf8");

    await assemble();

    // 判据不能只看「新布局的内容没被覆盖」——步骤本身幂等，恒跑也绿；旧文件仍在原地才是「一次都没跑」的证据。
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(`${legacy}.migrated.bak`)).toBe(false);
    expect(existsSync(configFile())).toBe(false);
  });

  // 起点边界是唯一真实的升级场景：装机刻度恰好停在这一步的起点。边界写成 `> 0` 时这一步整个跳过，
  // 而外部表现是「升级后配置读空、旧文件还躺在 home 根目录」——故判据必须落在「旧文件被搬走了」上。
  it("刻度停在 fromVersion 的装机必须执行这一步", async () => {
    seedClock(STEPS[0].fromVersion);
    const legacy = legacyFile(LEGACY_LAYOUT.config);
    writeFileSync(legacy, '{"legacy":true}\n', "utf8");

    await assemble();

    expect(readFileSync(configFile(), "utf8")).toBe('{"legacy":true}\n');
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(`${legacy}.migrated.bak`, "utf8")).toBe('{"legacy":true}\n');
    expect(readFileSync(versionFile(), "utf8").trim()).toBe(newestTarget());
  });

  it("链失败即中止装配，并且**不推进刻度**：清障后从同一步重跑才写完", async () => {
    const legacy = legacyFile(LEGACY_LAYOUT.config);
    // 旧文件读不出来（同名目录）：这一步必然失败，而刻度文件本身的落点完全可写——
    // 于是「刻度没被写」是这次失败的直接后果，不是障碍物的副作用。
    mkdirSync(legacy, { recursive: true });

    await expect(assemble()).rejects.toThrow(`存储升级到 ${newestTarget()} 失败`);

    expect(existsSync(versionFile())).toBe(false);
    // 失败点之前没有任何一项落定：中止不是「跳过失败的那项继续跑」。
    expect(existsSync(configFile())).toBe(false);

    // 清障后重试：失败没有占住「已装配」，刻度此刻还不存在，只有真的重跑完链它才会落到目标版本。
    rmSync(legacy, { recursive: true, force: true });
    writeFileSync(legacy, '{"legacy":true}\n', "utf8");
    await assemble();

    expect(readFileSync(versionFile(), "utf8").trim()).toBe(newestTarget());
    expect(readFileSync(configFile(), "utf8")).toBe('{"legacy":true}\n');
  });

  // 刻度是「这一步做完了」的凭证：回写不进去却继续跑，下次启动会从一个不存在的刻度重来。
  it("步骤跑完但刻度回写失败即中止装配", async () => {
    mkdirSync(versionFile(), { recursive: true });
    writeFileSync(join(versionFile(), "占位"), "", "utf8");

    await expect(assemble()).rejects.toThrow(`存储版本号回写失败（${newestTarget()}）`);
  });
});

describe("装配期的对账用真实插件版本", () => {
  /**
   * 判据刻意不写成「装配后有没有 warn」这种与包版本无关的形态，而是让用例自己算一遍落差——把
   * `pluginVersion()` 换回常量、或把对账挪到链之前，这条算术都对不上（前者的消息里不会出现真实版本号，
   * 后者报的是「存储版本 0.0.0 落后」，不含步骤表的目标版本）。
   *
   * 本包尚未发版时步骤表（0.2.5）超前于 package.json，此刻的期望是「一条不同步 warn」；发版对齐后
   * 期望自动变成「零 warn」——这正是对账要报的那种落差，不是需要改用例的例外。
   */
  it("落差有就出声、没有就零噪音，且消息里同时出现步骤表目标与真实插件版本", async () => {
    const logger = makeLogger();
    const plugin = pluginVersion();

    await assemble({ logger });

    expect(logger.warns).toHaveLength(compareVersions(newestTarget(), plugin) === 0 ? 0 : 1);
    if (compareVersions(newestTarget(), plugin) !== 0) {
      expect(logger.warns[0]).toContain(newestTarget());
      expect(logger.warns[0]).toContain(plugin);
    }
  });
});

describe("链跑完后的版本对账：三种落差分开报", () => {
  // 三态的判据必须分别给：只用「装配后有没有 warn」这一条，把三种落差合并成一条也绿，
  // 而它们要人去改的地方完全不同（补步骤 / 改 package.json / 换回正确的装机）。
  it("刻度与插件版本一致：一个字的诊断都不出（对账不该成为日常噪音）", () => {
    const logger = makeLogger();

    reportGap(newestTarget(), newestTarget(), logger);

    expect(logger.warns).toEqual([]);
  });

  it("刻度落后于插件版本：报「缺少对应的升级步骤」（改的是步骤表）", () => {
    const logger = makeLogger();

    reportGap("0.1.0", "0.3.0", logger);

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("存储版本 0.1.0 落后于插件版本 0.3.0");
    expect(logger.warns[0]).toContain("缺少对应的升级步骤");
  });

  it("刻度超前而步骤表也超前：报「步骤表与 package.json 不同步」（改的是 package.json）", () => {
    const logger = makeLogger();

    reportGap("0.3.0", "0.2.3", logger);

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain(`升级链的目标版本 ${newestTarget()} 高于插件版本 0.2.3`);
    expect(logger.warns[0]).toContain("步骤表与 package.json 不同步");
  });

  it("刻度超前而步骤表没超前：报「不回退」（装的是更旧的包，改的是装机本身）", () => {
    const logger = makeLogger();

    reportGap("0.3.0", newestTarget(), logger);

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain("本插件的升级链不回退");
  });
});

describe("待办步：按目标版本升序，刻度停在起点才算待办", () => {
  it("不按声明顺序执行：声明倒序的两步也按目标版本升序返回", () => {
    const declared = [step("0.2.5", "0.3.0"), step("0.0.0", "0.2.5")];

    expect(pendingSteps(declared, "0.0.0").map((entry) => entry.targetVersion)).toEqual([
      "0.2.5",
      "0.3.0",
    ]);
  });

  it("刻度已到某步起点之后即跳过该步（含恰好停在起点时必须执行的边界）", () => {
    const table = [step("0.0.0", "0.2.5"), step("0.2.5", "0.3.0")];

    expect(pendingSteps(table, "0.2.5").map((entry) => entry.targetVersion)).toEqual(["0.3.0"]);
    expect(pendingSteps(table, "0.3.0")).toEqual([]);
    expect(pendingSteps(table, "0.0.0")).toHaveLength(2);
  });
});

describe("生命周期", () => {
  it("重复装配当场抛错；release 幂等、不清掉已落盘的迁移结果，之后可以再装配", async () => {
    await assemble();
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    await expect(assemble()).rejects.toThrow("dsh-mcp-manager: upgrade 域只能装配一次");

    const before = readFileSync(configFile(), "utf8");
    releaseUpgrade();
    releaseUpgrade();
    // 本域没有需要在卸载时收回的东西：链已经写完的文件不会被卸载动作改回去。
    expect(readFileSync(configFile(), "utf8")).toBe(before);

    await expect(assemble()).resolves.toBeDefined();
  });
});
