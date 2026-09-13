/**
 * dsh-notifier upgrade 域 service 块 —— 装配面：跑链的时机、存量迁移的挂载与卸载。
 *
 * 判据面：升级必须在**各域装配之前**同步跑完（先装配就等于让各域读到旧形态并带着它继续跑），
 * 而存量配置的迁移只能等宿主 settings 服务就绪（那个服务可能晚到、也可能根本不来）。两件事的时序
 * 都不能靠「反正快了」蒙过去：前者判「装配返回时磁盘已是当前形态」，后者判「服务不来就不写」。
 *
 * 链本身还锁两处：**起点边界**（刻度恰好停在 `fromVersion` 的装机必须执行这一步——唯一的真实升级
 * 场景；判据落在「旧文件被搬走了」，因为步骤幂等，只看新布局是否被覆盖的话恒跑也绿）与**落后/超前
 * 对账**（三种落差分属三处要改的地方，合成一条等于三处都只剩「有出声」这一个判据）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HISTORY_FILE_NAME,
  VERSION_FILE_NAME,
  legacyFile,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import type {
  ConfigPort,
  LegacySettingsPort,
  UpgradeDeps,
} from "../../../src/server/upgrade/deps.ts";
import { reportGap } from "../../../src/server/upgrade/impl/chain/index.ts";
import type {
  LegacySettingsEntry,
  LegacySettingsFace,
} from "../../../src/server/upgrade/impl/legacy/type.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { compareVersions } from "../../../src/server/upgrade/impl/version/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, pollUntil, settleMicrotasks, tempDshHome } from "../../helpers.ts";

/** 写面结果经能力面的签名可达，不请 config 域再多导出一个名字。 */
type WriteResult = Awaited<ReturnType<ConfigPort["writeConfig"]>>;

/** 迁移只写这些字段，视图不参与判定。 */
const VIEW = { user: {}, revision: 1, writable: true, effective: {} };

/** 0.2.3 及更早的历史文件在 home 根目录，名字与新布局不同。 */
const LEGACY_HISTORY_FILE_NAME = "dsh-notifier-history.jsonl";

/** 步骤表里最高的目标版本：链跑完的刻度应当正好落在它上面。 */
function newestTarget(): string {
  return STEPS.map((step) => step.targetVersion).reduce((newest, version) =>
    compareVersions(version, newest) > 0 ? version : newest,
  );
}

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  releaseUpgrade();
  home.dispose();
});

/** 假 settings 接入面：handler 捕获下来手动触发，退订记账（服务永不就绪的路径也要能收干净）。 */
function makeLegacy(entries: ReadonlyArray<LegacySettingsEntry> = []) {
  const handlers: Array<(settings: LegacySettingsFace) => void> = [];
  let detached = 0;
  const port: LegacySettingsPort = {
    whenReady: (handler) => {
      handlers.push(handler);
      return () => {
        detached += 1;
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
  };
  return {
    port,
    handlers,
    detachedCount: () => detached,
    ready: (): void => {
      for (const handler of [...handlers]) handler({ describe: () => entries });
    },
  };
}

/** 假 config 写面：记账并按用例指定的结果作答。 */
function makeConfig(result?: WriteResult) {
  const writes: Array<{ patch: unknown; revision?: number }> = [];
  const port: ConfigPort = {
    writeConfig: async (patch, revision) => {
      writes.push({ patch, revision });
      return result ?? { ok: true, view: VIEW };
    },
  };
  return { port, writes };
}

/** 装配一次升级域（链在装配期同步跑完）。 */
function assemble(
  options: {
    legacy?: ReturnType<typeof makeLegacy>;
    config?: ReturnType<typeof makeConfig>;
  } = {},
) {
  const logger = makeLogger();
  const legacy = options.legacy ?? makeLegacy();
  const config = options.config ?? makeConfig();
  const deps: UpgradeDeps = { logger, legacySettings: legacy.port, config: config.port };
  installUpgrade(deps);
  return { logger, legacy, config, deps };
}

describe("装配期跑链", () => {
  it("装配返回时刻度已落在步骤表最后一步的目标版本，初始形态也已落定", () => {
    assemble();

    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim()).toBe(newestTarget());
    expect(existsSync(notifierFile(HISTORY_FILE_NAME))).toBe(true);
  });

  it("刻度已到目标版本的存储不再重跑步骤（否则每次启动都会拿旧文件盖回用户改过的新数据）", () => {
    mkdirSync(dirname(notifierFile(HISTORY_FILE_NAME)), { recursive: true });
    writeFileSync(notifierFile(HISTORY_FILE_NAME), '{"ts":99}\n', "utf8");
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${newestTarget()}\n`);

    assemble();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":99}\n');
  });

  // 起点边界是唯一真实的升级场景：装机刻度恰好停在这一步的起点。边界写成 `> 0` 时这一步整个跳过，
  // 而外部表现是「升级后历史读空、旧文件还躺在 home 根目录」——故判据必须落在「旧文件被搬走了」上。
  it("刻度停在 0.2.3 的装机必须执行 0.2.3→0.2.4 这一步", () => {
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), "0.2.3\n");
    const legacy = legacyFile(LEGACY_HISTORY_FILE_NAME);
    writeFileSync(legacy, '{"ts":7}\n', "utf8");

    assemble();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":7}\n');
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(`${legacy}.migrated.bak`, "utf8")).toBe('{"ts":7}\n');
  });

  // 反方向：刻度已到目标时这一步一次都不能跑。判据不能只看「新布局的内容没被覆盖」——步骤本身幂等，
  // 恒跑也绿；旧文件仍在原地才是「一次都没跑」的证据（跑了就会归档它）。
  it("刻度已到目标版本时这一步完全不执行：home 根的旧文件原地不动", () => {
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), `${newestTarget()}\n`);
    const legacy = legacyFile(LEGACY_HISTORY_FILE_NAME);
    writeFileSync(legacy, '{"ts":7}\n', "utf8");

    assemble();

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(`${legacy}.migrated.bak`)).toBe(false);
  });

  // 刻度是「这一步做完了」的凭证：回写不进去却继续跑，下次启动会从一个不存在的刻度重来。
  it("步骤跑完但刻度回写失败即中止启动", () => {
    // version 的位置被同名目录占住：临时文件写得进去，rename 覆盖不了它——回写必然失败。
    mkdirSync(notifierFile(VERSION_FILE_NAME), { recursive: true });
    writeFileSync(join(notifierFile(VERSION_FILE_NAME), "占位"), "", "utf8");

    let caught: unknown;
    try {
      assemble();
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(`存储版本号回写失败（${newestTarget()}）`);
  });

  it("链跑完必做一次版本对账且落差出声（静默地把刻度当成看起来对的值比报错更糟）", () => {
    const { logger } = assemble();

    expect(logger.warns.length).toBeGreaterThan(0);
  });

  it("链失败即中止启动，并说清失败在哪一步；此时不订阅存量迁移（带着半完成迁移继续跑更危险）", () => {
    // 包私有目录的位置被一个同名文件占住：写目标文件必然失败。
    mkdirSync(join(home.dir, "@wingsky-1"), { recursive: true });
    writeFileSync(join(home.dir, "@wingsky-1", "dsh-notifier"), "", "utf8");
    const legacy = makeLegacy();

    let caught: unknown;
    try {
      assemble({ legacy });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(`存储升级到 ${newestTarget()} 失败`);
    expect(legacy.handlers).toEqual([]);
  });

  it("链失败后重试装配会真正重跑链（失败不该占住「已装配」，否则启动失败一次就再也装不上）", () => {
    // 包私有目录的位置被一个同名文件占住：第一次装配必然在写盘那一步失败。
    mkdirSync(join(home.dir, "@wingsky-1"), { recursive: true });
    const blocker = join(home.dir, "@wingsky-1", "dsh-notifier");
    writeFileSync(blocker, "", "utf8");
    expect(() => assemble()).toThrow(/存储升级到 .* 失败/u);

    rmSync(blocker, { force: true });

    // 障碍已清：刻度文件此刻还不存在，只有第二次装配真的从头跑完链，它才会落到目标版本。
    const legacy = makeLegacy();
    expect(() => assemble({ legacy })).not.toThrow();
    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim()).toBe(newestTarget());
    expect(legacy.handlers).toHaveLength(1);
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

describe("存量设置的迁移：等 settings 服务就绪", () => {
  it("服务没来之前不写配置，就绪后经 config 写面把存量设置落盘", async () => {
    const legacy = makeLegacy([
      { ns: "dsh-notifier", user: { enabled: true, notifyAsk: false, notifySound: false } },
    ]);
    const { config, logger } = assemble({ legacy });
    expect(config.writes).toEqual([]);

    legacy.ready();

    expect(config.writes).toHaveLength(1);
    expect(config.writes[0]!.patch).toEqual({
      notifyAsk: false,
      notifySound: false,
      browserSound: false,
      systemSound: false,
    });
    expect(config.writes[0]!.revision).toBeUndefined();
    // 写成功也不许出声：那是一条「迁移失败」的日志，写反了会在每次升级后误报一次。
    await settleMicrotasks();
    expect(logger.warns.filter((text) => text.includes("存量设置迁移失败"))).toEqual([]);
  });

  it("没有存量设置时不写配置（空写会在配置里造出一次无变化的修订，界面上的「已改」标记随之失灵）", () => {
    const { legacy, config } = assemble();

    legacy.ready();

    expect(config.writes).toEqual([]);
  });

  it("写面失败只出声不抛（这是装配之后的异步回调，抛出去没人接得住，症状是「升级后设置回到默认」）", async () => {
    const legacy = makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]);
    const { config, logger } = assemble({
      legacy,
      config: makeConfig({ ok: false, reason: "unavailable" }),
    });

    expect(() => legacy.ready()).not.toThrow();
    expect(config.writes).toHaveLength(1);
    await pollUntil(
      () => logger.warns.some((text) => text.includes("存量设置迁移失败")),
      "迁移失败未出声",
    );
  });
});

describe("生命周期", () => {
  it("重复装配当场抛错；release 退订等待并幂等，之后可以再装配", () => {
    const { legacy } = assemble();
    // 说清是哪个域拒绝的：`/只能装配一次/` 这种宽判据在「装配体被整段短路」时也会绿。
    expect(() => assemble()).toThrow("dsh-notifier: upgrade 域只能装配一次");

    releaseUpgrade();
    expect(legacy.detachedCount()).toBe(1);

    releaseUpgrade();
    expect(legacy.detachedCount()).toBe(1);

    expect(() => assemble()).not.toThrow();
  });
});
