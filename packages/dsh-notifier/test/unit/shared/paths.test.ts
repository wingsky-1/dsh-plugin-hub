/**
 * dsh-notifier shared 域 paths 块 —— 存储布局与 DSH_HOME 解析。
 *
 * 为什么值得单独一测：文件名是**迁移契约**的一半（升级模块要把旧文件搬到这些名字上），
 * 陈旧路径与陈旧文件名都会静默丢数据——升级读空、旧文件留在原地、用户看到「通知记录没了」。
 * 路径随 `DSH_HOME` 走是另一半：隔离验证与测试换掉该变量即换掉全部落盘位置，漏一处就写进真实 `~/.dsh`。
 */
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  VERSION_FILE_NAME,
  legacyFile,
  notifierFile,
  toastScriptPath,
} from "../../../src/server/shared/interface.ts";
import { tempDshHome, withEnv } from "../../helpers.ts";

/** 本文件内建过的隔离环境，逐个在 afterEach 还原（漏一个就会污染后续用例的落盘位置）。 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

describe("存储文件名即迁移契约", () => {
  it("五个文件名逐字固定", () => {
    expect([
      CONFIG_FILE_NAME,
      HISTORY_FILE_NAME,
      STATUS_FILE_NAME,
      SEQ_FILE_NAME,
      VERSION_FILE_NAME,
    ]).toEqual(["config.json", "history.jsonl", "status.json", "seq.json", "version"]);
  });

  it("插件私有目录按 npm 包名分区，不与其它插件争用 DSH home 根", () => {
    const home = tempDshHome();
    cleanups.push(home.dispose);
    expect(notifierFile(CONFIG_FILE_NAME)).toBe(
      join(home.dir, "@wingsky-1", "dsh-notifier", "config.json"),
    );
  });

  it("旧布局在 DSH home 根：迁移的读端与写端必须同时可命名，否则迁移会读空", () => {
    const home = tempDshHome();
    cleanups.push(home.dispose);
    expect(legacyFile("dsh-notifier.json")).toBe(join(home.dir, "dsh-notifier.json"));
  });
});

describe("DSH_HOME 语义（与 shared/dsh-home.js、官方 resolveDshHome 同源）", () => {
  it("空白 DSH_HOME 视同未设置，回落 <home>/.dsh", () => {
    // 两个 home 变量都设：POSIX 读 HOME，Windows 按 libuv 语义读 USERPROFILE。
    cleanups.push(
      withEnv({ DSH_HOME: "   ", HOME: "/dsh-home-probe", USERPROFILE: "/dsh-home-probe" }),
    );
    expect(notifierFile(VERSION_FILE_NAME)).toBe(
      join("/dsh-home-probe", ".dsh", "@wingsky-1", "dsh-notifier", "version"),
    );
  });
});

describe("系统通知脚本位置", () => {
  it("反推尾段与脚本在 src 下的真实位置一致（脚本搬家而函数没跟上即红）", () => {
    // 该函数按**包入口所在目录**反推：产物形态是内联的 lib/index.js，资源随 bundle-host 按
    // src 相对结构复制到 lib/ 下，故尾段必须等于脚本相对 src 的路径。断言「该路径存在」是假红
    // ——直跑 src 时包入口在 src 顶层，反推落点本就不存在；断言写死字面量则要人肉同步。
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
    const scripts = globSync("**/*.ps1", { cwd: srcRoot });
    expect(scripts).toHaveLength(1);
    expect(toastScriptPath().replaceAll("\\", "/").endsWith(`/${scripts[0]!}`)).toBe(true);
  });
});
