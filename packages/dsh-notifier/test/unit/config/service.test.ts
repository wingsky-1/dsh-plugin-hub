/**
 * dsh-notifier config 域 service 块 —— 装配面（读写设置）。
 *
 * 面口径：只经 `config/interface.ts` 的 `installConfig` / `releaseConfig` / `readConfig` /
 * `readSettingsView` / `writeConfig`，只伪 `config/deps.ts` 声明的 `logger`。
 *
 * 导入顺序是硬性的：`configStore` 是模块级单例，落盘路径在**构造时**由 `notifierFile()` 定下，
 * 而静态 import 会在任何语句之前求值——顺序反了，本节全部落盘就写进真实 `~/.dsh`（正在跑的
 * `dsh web` 的 home）。故顶部先建临时 home，再动态导入被测模块；每个用例开跑前清掉配置文件，
 * 让「装配」始终相当于一次冷启动。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, afterEach, beforeEach, describe } from "vitest";

import type { RawSettingValue } from "../../../src/server/config/impl/model/type.ts";
import { CONFIG_FILE_NAME, notifierFile } from "../../../src/server/shared/interface.ts";
import { makeLogger, tempDshHome } from "../../helpers.ts";
import {
  registerHalfBrokenStorage,
  registerEmptyCredentials,
  registerWriteBaseline,
} from "./service-credentials-cases.ts";
import { registerFieldMerge } from "./service-merge-cases.ts";
import { registerAssemblyAndRead, registerDeliveryAndView } from "./service-read-cases.ts";
import {
  registerConcurrencyConflictCases,
  registerMergeAndCredentials,
  registerOptionalChannelKeys,
  registerPersistenceAndReplay,
  registerRevisionFingerprintCases,
  registerValidationAndMaskedCredentialCases,
  registerWriteFailureCases,
} from "./service-write-cases.ts";

const home = tempDshHome();
const configFile = notifierFile(CONFIG_FILE_NAME);
const { installConfig, releaseConfig, readConfig, readSettingsView, writeConfig } =
  await import("../../../src/server/config/interface.ts");

/** 装配一次并交出日志出口（DSH_HOME 已在模块顶部指向临时目录）。 */
function assemble() {
  const logger = makeLogger();
  installConfig({ logger });
  return logger;
}

/** 手写配置文件：模拟用户或别的工具改过磁盘上那一份（目录可能还不存在）。 */
function writeConfigFile(text: string): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, text);
}

/** 磁盘上的 JSON（写面必须落成可重新解析的完整文件）。 */
function onDisk(): Record<string, RawSettingValue> {
  return JSON.parse(readFileSync(configFile, "utf8"));
}

/** 装配一次并取该文件的修订号；先释放再写文件，避免把上一个快照带进来。 */
function revisionOfFile(text: string): number {
  releaseConfig();
  rmSync(configFile, { force: true });
  writeConfigFile(text);
  assemble();
  return readSettingsView().revision;
}

beforeEach(() => {
  // 冷启动：配置文件不存在与内容为空对读面是同一件事，这里统一成前者。
  rmSync(configFile, { recursive: true, force: true });
});

afterEach(() => {
  releaseConfig();
});

afterAll(() => {
  home.dispose();
});

const context = {
  assemble,
  configFile,
  installConfig,
  onDisk,
  readConfig,
  readSettingsView,
  releaseConfig,
  revisionOfFile,
  writeConfig,
  writeConfigFile,
};

describe("装配与读面", () => {
  registerAssemblyAndRead(context);
});

describe("读面两条通道：投递投影 vs 外发视图（#1016 S3）", () => {
  registerDeliveryAndView(context);
});

describe("写面：落盘、校验、版本", () => {
  registerPersistenceAndReplay(context);
  registerValidationAndMaskedCredentialCases(context);
  registerConcurrencyConflictCases(context);
  registerWriteFailureCases(context);
  registerRevisionFingerprintCases(context);
});

describe("写面的合并与凭据", () => {
  registerMergeAndCredentials(context);
});

describe("写面：频道的可选键（缺省即合法，显式非法仍拦）", () => {
  registerOptionalChannelKeys(context);
});

describe("写面：存量基线在写队列内取（#1016 批次 B）", () => {
  registerWriteBaseline(context);
});

describe("空串凭据不被掩码（#1016 缺陷 A）", () => {
  registerEmptyCredentials(context);
});

describe("写面按字段合并：键缺席 = 不动（#1016 S2）", () => {
  registerFieldMerge(context);
});

describe("半坏存量条目：保存不被锁死（#1016 S3 回归修复）", () => {
  registerHalfBrokenStorage(context);
});
