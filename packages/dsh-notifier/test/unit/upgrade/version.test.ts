/**
 * dsh-notifier upgrade 域 version 块 —— 存储刻度与版本比较。
 *
 * 判据面：刻度是「升级做到哪一步」的唯一凭证，读错一处就是整条链空转或永久停摆——而两者的外部表现
 * 与「版本没变」一模一样。版本比较必须**逐段按数值**：字符串比较会把 0.10.0 判成小于 0.9.0，
 * 于是新版本永远升不上去。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  VERSION_FILE_NAME,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import {
  compareVersions,
  readStoredVersion,
  writeStoredVersion,
} from "../../../src/server/upgrade/impl/version/index.ts";
import { tempDshHome } from "../../helpers.ts";

/** 本文件内建过的隔离环境，逐个在 afterEach 还原并删除。 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

/** 建一个隔离 DSH_HOME（刻度的读写都以它为根）。 */
function isolatedHome(): void {
  const home = tempDshHome();
  cleanups.push(home.dispose);
}

describe("compareVersions", () => {
  it.each<[string, string, number]>([
    ["0.2.3", "0.2.3", 0],
    ["0.2.4", "0.2.3", 1],
    ["0.2.3", "0.2.4", -1],
    ["0.10.0", "0.9.0", 1],
    ["0.3", "0.3.0", 0],
    // 段数不同时多余的段必须参与比较：只比到较短的那个，`0.2.4 > 0.2` 会被判成相等。
    ["0.2.4", "0.2", 1],
    ["1.0.0", "0.99.99", 1],
  ])("%s 与 %s 比较 → %i", (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });
});

describe("刻度读写", () => {
  it("写进去再读回来是同一个版本号（刻度是纯文本一行，末尾换行不算内容）", () => {
    isolatedHome();
    expect(writeStoredVersion("0.2.4")).toEqual({ ok: true });
    expect(readStoredVersion()).toBe("0.2.4");
    expect(readFileSync(notifierFile(VERSION_FILE_NAME), "utf8")).toBe("0.2.4\n");
  });

  it("没有刻度文件时从 0.0.0 起算：从未升级过的安装要跑整条链（每步自己判断有没有活要干）", () => {
    isolatedHome();
    expect(readStoredVersion()).toBe("0.0.0");
  });

  it("空白刻度文件也算从未升级过（空串不能被当成一个版本号去比较）", () => {
    isolatedHome();
    writeTextAtomicSync(notifierFile(VERSION_FILE_NAME), "  \n");
    expect(readStoredVersion()).toBe("0.0.0");
  });
});
