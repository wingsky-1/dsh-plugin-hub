/** upgrade steps 域测试的专属 fixture：隔离根、旧文件与 canonical-keys 的共用夹具。 */
import { readFileSync, writeFileSync } from "node:fs";

import { tempDshHome } from "../../helpers.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  legacyFile,
  notifierFile,
  writeTextAtomicSync,
} from "../../../src/server/shared/interface.ts";
import { migrateCanonicalKeys } from "../../../src/server/upgrade/impl/steps/canonical-keys.ts";

/** 本组测试内建过的隔离环境，逐个在各文件 afterEach 还原并删除。 */
export const cleanups: Array<() => void> = [];

/** 建一个隔离 DSH_HOME（迁移的读端与写端都从它解析路径）。 */
export function isolatedHome(): string {
  const home = tempDshHome();
  cleanups.push(home.dispose);
  return home.dir;
}

export function writeLegacy(name: string, text: string): void {
  writeFileSync(legacyFile(name), text, "utf8");
}

export const BARK = { type: "bark", id: "bark:1", baseUrl: "https://x", deviceKey: "k" };
export const HOOK = { type: "webhook", id: "hook:1", url: "https://y" };

function builtinDefault(type: string): Record<string, unknown> {
  const found = DEFAULT_CONFIG.channels.find((channel) => channel.type === type);
  if (found === undefined) throw new Error("默认表里没有内置频道 " + type);
  return found as unknown as Record<string, unknown>;
}

export const BROWSER = builtinDefault("browser");
export const SYSTEM = builtinDefault("system");

/** 落盘后的频道数组（存储层形状不受契约约束，按原始值看）。 */
export function channelsOnDisk(stored: Record<string, unknown>): Array<Record<string, unknown>> {
  return stored.channels as Array<Record<string, unknown>>;
}

/** 种一份磁盘配置并跑一步清理，返回落盘后的内容。 */
export function clean(stored: Record<string, unknown>): Record<string, unknown> {
  isolatedHome();
  writeTextAtomicSync(notifierFile(CONFIG_FILE_NAME), `${JSON.stringify(stored, null, 2)}\n`);
  migrateCanonicalKeys();
  return JSON.parse(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")) as Record<
    string,
    unknown
  >;
}

/** 旧文件名 → 新文件名 → 一份有代表性的内容（jsonl 是多行、json 是单行、seq 是数字）。 */
export const ENTRIES = [
  ["dsh-notifier-history.jsonl", HISTORY_FILE_NAME, '{"ts":1,"kind":"done"}\n{"ts":2}\n'],
  [
    "dsh-notifier-status.json",
    STATUS_FILE_NAME,
    '{"bark:main":{"lastTs":9,"lastStatus":"ok","failStreak":0}}\n',
  ],
  ["notifier-seq.json", SEQ_FILE_NAME, "7\n"],
] as const;
