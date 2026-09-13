/**
 * dsh-notifier upgrade 域 service 块 —— 装配面：跑链的时机、存量迁移的挂载与卸载。
 *
 * 判据面：升级必须在**各域装配之前**同步跑完（先装配就等于让各域读到旧形态并带着它继续跑），
 * 而存量配置的迁移只能等宿主 settings 服务就绪（那个服务可能晚到、也可能根本不来）。两件事的时序
 * 都不能靠「反正快了」蒙过去：前者判「装配返回时磁盘已是当前形态」，后者判「服务不来就不写」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HISTORY_FILE_NAME,
  VERSION_FILE_NAME,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import type {
  ConfigPort,
  LegacySettingsPort,
  UpgradeDeps,
} from "../../../src/server/upgrade/deps.ts";
import type {
  LegacySettingsEntry,
  LegacySettingsFace,
} from "../../../src/server/upgrade/impl/legacy/type.ts";
import { STEPS } from "../../../src/server/upgrade/impl/steps/index.ts";
import { compareVersions } from "../../../src/server/upgrade/impl/version/index.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, pollUntil, tempDshHome } from "../../helpers.ts";

/** 写面结果经能力面的签名可达，不请 config 域再多导出一个名字。 */
type WriteResult = Awaited<ReturnType<ConfigPort["writeConfig"]>>;

/** 迁移只写这些字段，视图不参与判定。 */
const VIEW = { user: {}, revision: 1, writable: true, effective: {} };

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
});

describe("存量设置的迁移：等 settings 服务就绪", () => {
  it("服务没来之前不写配置，就绪后经 config 写面把存量设置落盘", () => {
    const legacy = makeLegacy([
      { ns: "dsh-notifier", user: { enabled: true, notifyAsk: false, notifySound: false } },
    ]);
    const { config } = assemble({ legacy });
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
    expect(() => assemble()).toThrow(/只能装配一次/u);

    releaseUpgrade();
    expect(legacy.detachedCount()).toBe(1);

    releaseUpgrade();
    expect(legacy.detachedCount()).toBe(1);

    expect(() => assemble()).not.toThrow();
  });
});
