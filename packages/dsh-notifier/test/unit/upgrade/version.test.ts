/**
 * dsh-notifier upgrade 域刻度读侧：存储版本（`version` 文件里的刻度）的**读策略**。
 *
 * 为什么判据落在包内而不在共享层：`shared/upgrade-chain.js` 只 `await ports.readScale()`，它
 * 一概不替消费方决定「读不到刻度怎么办」——回落起点还是中止启动、什么算合法版本号，都是本包
 * 自己的业务决定。本文件的四条判据就是那四个决定，链驱动自身（步骤筛选 / 逐步回写 / 对账告警）
 * 不在此重复。
 *
 * 落盘隔离：刻度路径经 `notifierFile()` 从 `DSH_HOME` 现拼（不在模块加载期定死），故每个用例
 * 一份 mkdtemp 临时 home，afterEach 连目录一起删——仓库内不留任何运行时产物。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UpgradeDeps } from "../../../src/server/upgrade/deps.ts";
import {
  CONFIG_FILE_NAME,
  SEQ_FILE_NAME,
  VERSION_FILE_NAME,
  legacyFile,
  notifierFile,
} from "../../../src/server/shared/interface.ts";
import { installUpgrade, releaseUpgrade } from "../../../src/server/upgrade/interface.ts";
import { readStoredVersion } from "../../../src/server/upgrade/impl/version/index.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";

/** 旧存储位置里的序号文件名（刻度读不出来时，链若照跑就会把它搬进新落点并改名留痕）。 */
const LEGACY_SEQ_FILE = "notifier-seq.json";

/** 旧文件改名后缀：判据要的是「旧文件被处理过」，名字必须与实现同名的固定标记。 */
const MIGRATED_SUFFIX = ".migrated.bak";

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  // 装配标记是进程级单例状态：用例失败也要复位，否则后续用例会被「只能装配一次」连坐。
  releaseUpgrade();
  home.dispose();
});

/** 刻度文件的绝对路径（本包私有存储目录下）。 */
function versionPath(): string {
  return notifierFile(VERSION_FILE_NAME);
}

/** 落一份刻度：存储目录按需建（存量安装里它已在，全新安装里它不存在）。 */
function writeScale(text: string): string {
  const path = versionPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * 临时 home 的完整落盘清单（相对路径 + 类型 + 字节数 + 全文）。
 *
 * 「抛完之后磁盘一个字节都没动」这种否定判据只能钉在这样的快照上：单断「某文件不存在」说不清
 * 是这次没写、还是本来就没有；把内容也带上，才连「写了又改回原样」都盖得住。
 */
function diskSnapshot(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const where = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        rows.push(`${where}/`);
        walk(join(dir, entry.name), where);
        continue;
      }
      rows.push(
        `${where} ${statSync(join(dir, entry.name)).size}B ${readFileSync(join(dir, entry.name), "utf8")}`,
      );
    }
  };
  walk(root, "");
  return rows.sort();
}

describe("读不到刻度：只有精确 ENOENT 从 0.0.0 起跑", () => {
  it("刻度文件不存在时返回 0.0.0，不中止启动（真 ENOENT 路径，不用接缝伪造）", () => {
    // 走真实同步读：全新安装的常态就是「存储目录都还没有」，接缝造不出这条路径。
    expect(existsSync(versionPath())).toBe(false);

    expect(readStoredVersion()).toBe("0.0.0");
  });
});

describe("读错误即中止启动（fail-closed，不把坏源伪装成全新安装）", () => {
  it("刻度路径是目录时抛读取失败，判词带出 Node 错误码 EISDIR", () => {
    // 路径与建目录分开写：mkdirSync 带 recursive 时返回 string | undefined，
    // 拿它的返回值当路径用会把 undefined 传进 statSync（TS2769）。
    const path = versionPath();
    mkdirSync(path, { recursive: true });

    expect(() => readStoredVersion()).toThrow(/存储版本文件读取失败/);
    expect(() => readStoredVersion()).toThrow(/EISDIR/);
    // 中止的另一半：抛错不许顺手把坏源补成一个能读的刻度（那正是把坏源伪装成全新安装）。
    // 目录也必须原样留在原地——换成文件即说明读面擅自改了现场。
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it("抛错后磁盘一个字节都没动（不写盘、不留临时文件）", () => {
    mkdirSync(versionPath(), { recursive: true });
    const before = diskSnapshot(home.dir);

    expect(() => readStoredVersion()).toThrow(/存储版本文件读取失败/);

    expect(diskSnapshot(home.dir)).toEqual(before);
  });

  it("非 ENOENT 的读错误同样中止：EACCES 不回落起点", () => {
    // 接缝只为稳定覆盖 Node 错误码：EACCES 造不出稳定的真实目录形态（chmod 会被 root 绕过）。
    expect(() =>
      readStoredVersion(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }),
    ).toThrow(/存储版本文件读取失败（EACCES）/);
  });

  it("读错误不带 code 时按读取失败处理，判词里不出现空码段", () => {
    expect(() =>
      readStoredVersion(() => {
        throw new Error("读面炸了");
      }),
    ).toThrow("dsh-notifier: 存储版本文件读取失败 — 读面炸了");
  });
});

describe("空白刻度即中止启动（不是「没升级过」）", () => {
  it.each(["", "   ", "\n\t\n"])("刻度内容 %j → 抛存储版本文件为空", (text) => {
    writeScale(text);

    expect(() => readStoredVersion()).toThrow(/存储版本文件为空/);
  });
});

describe("非法版本号即中止启动（合法刻度长什么样是本包的白名单）", () => {
  it.each(["not-a-version", "0.2.3junk", "0.02.3", "0.2", "2.0.0", "1.0.0-rc.1"])(
    "刻度内容 %s → 抛非法或不支持的版本号",
    (text) => {
      writeScale(`${text}\n`);

      expect(() => readStoredVersion()).toThrow(/非法或不支持的版本号/);
    },
  );

  it.each(["0.2.3", "1.0.0", "1.12.7"])("白名单内的 %s 原样返回（别把合法值一起拒掉）", (text) => {
    writeScale(`${text}\n`);

    expect(readStoredVersion()).toBe(text);
  });

  it("首尾空白按 trim 去掉，中间内容逐字保留", () => {
    writeScale("  0.2.3  \n");

    expect(readStoredVersion()).toBe("0.2.3");
  });
});

describe("读侧中止的后果：一步迁移都不发生", () => {
  /** 链的入参：读刻度就中止，故存量读面在真跑到的路径上一次都不会被调用。 */
  function deps(): UpgradeDeps {
    return { logger: makeLogger(), legacySettings: { describe: () => [] } };
  }

  it("刻度读不出来时 upgrade 域装配中止：存量不读、目标不落、旧文件不改名", async () => {
    // 读侧一旦翻成 fail-safe（回落 0.0.0），0.2.3 → 0.2.4 那一步就会照跑：旧文件被搬进新落点、
    // 旧文件改名留痕。故「零迁移动作」只有钉住目标文件与归档名才看得见，单断「抛了」太弱。
    const legacySeq = legacyFile(LEGACY_SEQ_FILE);
    writeFileSync(legacySeq, "7\n", "utf8");
    mkdirSync(versionPath(), { recursive: true });

    await expect(installUpgrade(deps())).rejects.toThrow(/存储版本文件读取失败/);
    expect(existsSync(notifierFile(SEQ_FILE_NAME))).toBe(false);
    expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
    expect([readFileSync(legacySeq, "utf8"), existsSync(`${legacySeq}${MIGRATED_SUFFIX}`)]).toEqual(
      ["7\n", false],
    );
  });
});
