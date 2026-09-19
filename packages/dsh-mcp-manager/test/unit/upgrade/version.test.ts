/**
 * dsh-mcp-manager upgrade 域 version 块 —— 存储刻度、插件版本与版本比较。
 *
 * 判据面：刻度是「升级做到哪一步」的唯一凭证，读错一处就是整条链空转或永久停摆——而两者的外部表现
 * 与「版本没变」一模一样。版本比较必须**逐段按数值**：字符串比较会把 0.10.0 判成小于 0.9.0，于是
 * 新版本永远升不上去。插件版本必须来自 package.json（常量与发布版本之间没有任何机制保证同步）。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { versionFile } from "../../../src/server/shared/interface.ts";
import {
  compareVersions,
  packageRootFrom,
  pluginVersion,
  readStoredVersion,
  writeStoredVersion,
} from "../../../src/server/upgrade/impl/version/index.ts";
import { tempDshHome } from "../../helpers.ts";

let home: string;
let disposeHome: () => void;

beforeEach(() => {
  const isolated = tempDshHome();
  home = isolated.dir;
  disposeHome = isolated.dispose;
});

afterEach(() => {
  disposeHome();
});

/** 包清单里的版本：判据与实现不能共用同一个来源，故这里直接读包根那份文件。 */
function manifestVersion(): string {
  const manifest: { version?: string } = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  if (typeof manifest.version !== "string") throw new Error("包清单没有 version 字段");
  return manifest.version;
}

/** 目录里残留的临时名（写失败必须清干净）。 */
function temporaryNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

describe("compareVersions：逐段数值比较", () => {
  it.each<[string, string, number]>([
    ["0.2.5", "0.2.5", 0],
    ["0.2.5", "0.2.4", 1],
    ["0.2.4", "0.2.5", -1],
    ["0.10.0", "0.9.0", 1],
    ["0.3", "0.3.0", 0],
    // 段数不同时多余的段必须参与比较：只比到较短的那个，`0.2.5 > 0.2` 会被判成相等。
    ["0.2.5", "0.2", 1],
    ["1.0.0", "0.99.99", 1],
    ["0.0.0", "0.0.0", 0],
    // #903 parseVersion 收口：后缀显式剥离；非数值段归零（fail-safe 跑全链，不抛）。
    ["0.2.5-rc.1", "0.2.5", 0],
    ["a.b.c", "0.0.0", 0],
    ["", "0.0.0", 0],
  ])("%s 与 %s 比较 → %i", (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });
});

describe("刻度读写", () => {
  it("写进去再读回来是同一个版本号（刻度是纯文本一行，末尾换行不算内容）", async () => {
    await writeStoredVersion("0.2.5");

    expect(await readStoredVersion()).toBe("0.2.5");
    expect(readFileSync(versionFile(), "utf8")).toBe("0.2.5\n");
  });

  it("没有刻度文件时从 0.0.0 起算：从未升级过的安装要跑整条链（每步自己判断有没有活要干）", async () => {
    expect(await readStoredVersion()).toBe("0.0.0");
  });

  it("空白刻度文件也算从未升级过（空串不能被当成一个版本号去比较）", async () => {
    await writeStoredVersion("0.2.5");
    writeFileSync(versionFile(), "  \n", "utf8");

    expect(await readStoredVersion()).toBe("0.0.0");
  });

  it("刻度回写不进去即抛，且不残留临时名（回写失败要让上层看见，不是静默停摆）", async () => {
    // 刻度路径被同名目录占住：临时文件写得进去，rename 覆盖不了它。
    mkdirSync(versionFile(), { recursive: true });

    await expect(writeStoredVersion("0.2.5")).rejects.toThrow();
    expect(temporaryNames(join(home, "@wingsky-1", "dsh-mcp-manager"))).toEqual([]);
  });
});

describe("pluginVersion：从 package.json 读，不写常量", () => {
  it("返回包清单里的版本，而不是兜底值", () => {
    expect(pluginVersion()).toBe(manifestVersion());
  });

  it("包根按最近的一个 package.json 解析：找到即停", () => {
    mkdirSync(join(home, "nested", "deeper", "deepest"), { recursive: true });
    writeFileSync(join(home, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");

    expect(packageRootFrom(join(home, "nested", "deeper", "deepest"))).toBe(home);
    expect(packageRootFrom(home)).toBe(home);
  });

  it("超过搜索上限仍没有 package.json 时回落 undefined（不一路走到文件系统根去撞别人的包）", () => {
    const deep = join(home, ...Array.from({ length: 12 }, (_, index) => `d${index}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(home, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");

    expect(packageRootFrom(deep)).toBeUndefined();
  });
});
