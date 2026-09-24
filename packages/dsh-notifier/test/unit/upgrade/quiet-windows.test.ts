/**
 * dsh-notifier upgrade 域 quiet-windows 块 —— 0.2.5 → 0.2.6 免打扰多时间窗割接。
 *
 * 判据面：这是动用户数据的第二步（第一步是 0.2.4 的配置形态割接）。搬错的表现是静默丢时段——
 * 用户配好的深夜窗口在升级后不再生效，而界面只会显示新形态的空列表。故逐条锁：旧起止逐字搬进
 * windows[0]、旧键删除、其余键不动；重跑逐字不动；半截旧形与坏文件不动（不替用户编窗口，
 * 不让一份读不懂的文件阻断启动）。
 */
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE_NAME,
  VERSION_FILE_NAME,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import { migrateQuietWindows } from "../../../src/server/upgrade/impl/steps/quiet-windows.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  releaseUpgrade();
  home.dispose();
});

/** 种一份磁盘上的配置文件。 */
function seedConfig(stored: Record<string, unknown>): void {
  writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), JSON.stringify(stored, null, 2) + "\n");
}

/** 磁盘上的配置文件内容。 */
function configOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("migrateQuietWindows：旧 start/end 搬进 windows[0] 并删旧键", () => {
  it("完整旧形：起止逐字搬进 windows[0]，旧键删除，其余键不动", () => {
    seedConfig({
      notifyAsk: false,
      quietHours: { enabled: true, start: "23:00", end: "07:00", allowKinds: ["error"] },
    });

    migrateQuietWindows();

    const quiet = configOnDisk().quietHours as Record<string, unknown>;
    expect(quiet).toEqual({
      enabled: true,
      windows: [{ start: "23:00", end: "07:00" }],
      allowKinds: ["error"],
    });
    expect(configOnDisk().notifyAsk).toBe(false);
  });

  it("幂等：已迁移的文件重跑逐字不动（压缩格式种文件，缩进会暴露白写一次）", () => {
    const before = JSON.stringify({
      quietHours: { enabled: true, windows: [{ start: "23:00", end: "07:00" }] },
    });
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), before);

    migrateQuietWindows();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
  });

  it("混合形态（windows 与旧键并存）：清旧键，windows 原样保留", () => {
    seedConfig({
      quietHours: {
        enabled: true,
        start: "23:00",
        end: "07:00",
        windows: [{ start: "12:00", end: "13:00" }],
      },
    });

    migrateQuietWindows();

    const quiet = configOnDisk().quietHours as Record<string, unknown>;
    expect(quiet).toEqual({ enabled: true, windows: [{ start: "12:00", end: "13:00" }] });
  });

  it("半截旧形（缺一半时钟键）：不动，不替用户编半个窗口", () => {
    const before = JSON.stringify({ quietHours: { enabled: true, start: "23:00" } });
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), before);

    migrateQuietWindows();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
  });

  it("没有 quietHours：文件逐字不动", () => {
    const before = JSON.stringify({ notifyAsk: false });
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), before);

    migrateQuietWindows();

    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
  });

  it("没有配置文件：不凭空建一份", () => {
    migrateQuietWindows();

    expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
  });

  it("配置文件不是合法 JSON：不抛，文件不动", () => {
    writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), "{ 坏掉的\n");
    const before = readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8");

    expect(() => migrateQuietWindows()).not.toThrow();
    expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(before);
  });
});

describe("链级：刻度停在 0.2.5 的装机跑完这一步", () => {
  it("旧形文件被割接，刻度到 0.2.6", () => {
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), "0.2.5\n");
    seedConfig({ quietHours: { enabled: true, start: "23:00", end: "07:00" } });
    const face = {
      describe: () => {
        return [] as unknown as ReturnType<UpgradeDeps["legacySettings"]["describe"]>;
      },
    };
    const deps: UpgradeDeps = { logger: makeLogger(), legacySettings: face };

    installUpgrade(deps);

    const quiet = configOnDisk().quietHours as Record<string, unknown>;
    expect(quiet).toEqual({ enabled: true, windows: [{ start: "23:00", end: "07:00" }] });
    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8").trim()).toBe("0.2.6");
  });
});
