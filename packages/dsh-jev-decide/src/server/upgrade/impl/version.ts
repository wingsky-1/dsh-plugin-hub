/**
 * upgrade 域实现：存储版本读写与比较（VERSION 文件是升级链刻度）。
 *
 * 缺失/空即 "0"（从未锚定）；比较按 semver 数字段（缺位补零，故 "0" == "0.0.0"）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpgradeDeps } from "../deps.ts";
import { versionFile } from "./paths.ts";

/** 缺失版本文件的起点（从未锚定）。 */
export const BASELINE_VERSION = "0";

/** 读存储版本（缺席/空即基线，不抛）。 */
export function readStoredVersion(home: string | undefined, deps: UpgradeDeps): string {
  const read = deps.io.readTextSync(versionFile(home));
  if (!read.ok) return BASELINE_VERSION;
  const text = read.text.trim();
  return text === "" ? BASELINE_VERSION : text;
}

/** 写存储版本（锚定完成即推进；经 0600 原子写）。 */
export function writeStoredVersion(
  home: string | undefined,
  version: string,
  deps: UpgradeDeps,
): void {
  deps.io.atomicWrite0600Sync(versionFile(home), version + "\n");
}

/** 解析 semver 数字段（非数字段按 0；预发布后缀不参与比较）。 */
function parseVersion(text: string): number[] {
  return text.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** 比较版本（-1/0/1；段数不同缺位补零）。 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** 本包版本（读包根 package.json；读不到即 undefined，由调用方决定回落）。 */
export function pluginVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = join(here, "..", "..", "..", "..", "package.json");
    const parsed: { version?: string } = JSON.parse(readFileSync(manifest, "utf8")) as {
      version?: string;
    };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
