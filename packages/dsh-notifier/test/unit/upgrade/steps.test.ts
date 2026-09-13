/**
 * dsh-notifier upgrade 域 steps 块 —— 0.2.3 → 0.2.4 的存储布局归位。
 *
 * 判据面：这是唯一**动用户数据**的一步。搬错的表现是静默丢数据——历史读空、状态表回默认、旧文件
 * 留在 home 根目录，而用户只会看到「通知记录没了」。故逐条锁：内容逐字保留、旧文件留痕、
 * 目标已存在时**不覆盖**（用户可能已经在新位置改过东西）、重跑不累积归档。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  legacyFile,
  notifierFile,
} from "../../../src/server/shared/interface.ts";
import { migrateStorageLayout } from "../../../src/server/upgrade/impl/steps/storage-layout.ts";
import { tempDshHome } from "../../helpers.ts";

/** 本文件内建过的隔离环境，逐个在 afterEach 还原并删除。 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

/** 建一个隔离 DSH_HOME（迁移的读端与写端都从它解析路径）。 */
function isolatedHome(): string {
  const home = tempDshHome();
  cleanups.push(home.dispose);
  return home.dir;
}

function writeLegacy(name: string, text: string): void {
  writeFileSync(legacyFile(name), text, "utf8");
}

/** 旧文件名 → 新文件名 → 一份有代表性的内容（jsonl 是多行、json 是单行、seq 是数字）。 */
const ENTRIES = [
  ["dsh-notifier-history.jsonl", HISTORY_FILE_NAME, '{"ts":1,"kind":"done"}\n{"ts":2}\n'],
  [
    "dsh-notifier-status.json",
    STATUS_FILE_NAME,
    '{"bark:main":{"lastTs":9,"lastStatus":"ok","failStreak":0}}\n',
  ],
  ["notifier-seq.json", SEQ_FILE_NAME, "7\n"],
] as const;

describe("旧文件归位", () => {
  it.each(ENTRIES)(
    "%s 搬成新布局的 %s：内容逐字保留，旧文件改名留痕",
    (legacyName, targetName, text) => {
      isolatedHome();
      writeLegacy(legacyName, text);

      migrateStorageLayout();

      expect(readFileSync(notifierFile(targetName), "utf8")).toBe(text);
      expect(existsSync(legacyFile(legacyName))).toBe(false);
      expect(readFileSync(`${legacyFile(legacyName)}.migrated.bak`, "utf8")).toBe(text);
    },
  );

  it("没有旧文件时也把初始形态落定（目标不存在会让「这一份处理过了」的判据永远不成立）", () => {
    isolatedHome();
    migrateStorageLayout();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe("");
    expect(readFileSync(notifierFile(STATUS_FILE_NAME), "utf8")).toBe("{}\n");
    // 序号文件的初始形态与流侧落盘同形（流侧写 `${seq}\n`）：首次读取要得到 0。
    expect(readFileSync(notifierFile(SEQ_FILE_NAME), "utf8")).toBe("0\n");
  });

  it("目标已存在时只归档旧文件、不覆盖目标（用户可能已经在新位置改过东西，拿历史盖回去就是用旧盖新）", () => {
    const home = isolatedHome();
    mkdirSync(dirname(notifierFile(HISTORY_FILE_NAME)), { recursive: true });
    writeFileSync(notifierFile(HISTORY_FILE_NAME), '{"ts":99}\n', "utf8");
    writeLegacy("dsh-notifier-history.jsonl", '{"ts":1}\n');

    migrateStorageLayout();

    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":99}\n');
    expect(readFileSync(`${legacyFile("dsh-notifier-history.jsonl")}.migrated.bak`, "utf8")).toBe(
      '{"ts":1}\n',
    );
    expect(readdirSync(home)).toContain("dsh-notifier-history.jsonl.migrated.bak");
  });

  it("重跑不累积归档名（旧文件第一次就改成了固定后缀，第二次已无源文件可归档）", () => {
    const home = isolatedHome();
    writeLegacy("dsh-notifier-history.jsonl", '{"ts":1}\n');

    migrateStorageLayout();
    migrateStorageLayout();

    expect(readdirSync(home).filter((name) => name.endsWith(".migrated.bak"))).toEqual([
      "dsh-notifier-history.jsonl.migrated.bak",
    ]);
    expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":1}\n');
  });

  it("旧文件读不出来即抛（迁移没做完而启动照常，等于让各域按错误的形态去读数据）", () => {
    isolatedHome();
    // 同名目录：路径存在但没有可读内容——「搬不动」不能被当成「没有旧数据」。
    mkdirSync(legacyFile("dsh-notifier-history.jsonl"), { recursive: true });

    expect(() => migrateStorageLayout()).toThrow(/旧存储文件不可读/u);
  });

  // 归档是「这一份处理过了」的标记：改名失败却继续，旧数据就悬在两套布局之间（新位置有了副本，
  // 归档标记却没有），而用户看到的是「迁移成功」。
  it("旧文件改名失败即抛（归档没成功就不能算这一步做完了）", () => {
    isolatedHome();
    const legacy = legacyFile("dsh-notifier-history.jsonl");
    writeLegacy("dsh-notifier-history.jsonl", '{"ts":1}\n');
    // 归档目标被非空目录占住：rename 覆盖不了它。
    mkdirSync(`${legacy}.migrated.bak`, { recursive: true });
    writeFileSync(join(`${legacy}.migrated.bak`, "占位"), "", "utf8");

    expect(() => migrateStorageLayout()).toThrow(/旧存储文件改名失败/u);
  });
});
