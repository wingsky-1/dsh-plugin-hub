#!/usr/bin/env node
"use strict";

/**
 * verify-version — 发布门禁：校验每个包的 version 与当前 git tag（vX.Y.Z）一致。
 * tag 是版本唯一来源（与 dsh-web-ui 同策略）。CI release.yml 在发布前执行。
 *
 * 用法：node scripts/release/verify-version.ts [--log-file <path>]
 * 退出码：0 = 全部一致；1 = 存在不一致或非 tag 环境（CI 中由 release.yml 保证是 tag push）。
 *
 * --log-file（W1.1 发布证据链）：把本脚本输出到 stdout / stderr 的每一行同时镜像到该文件
 * （逐包 OK/FAIL 行 + 汇总行，含非 tag 环境与空包集的 fail 行）。调用方传 RUNNER_TEMP 下的
 * 路径（workspace 零落盘）；父目录不存在时本脚本逐级建出。落盘失败按 fail-closed 处理：
 * 证据写不下来 = 没有证据，不静默放行（exit 1）。
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tagVersion() {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--exact-match"], {
      encoding: "utf8",
      cwd: ROOT,
    }).trim();
    return tag.startsWith("v") ? tag.slice(1) : tag;
  } catch {
    return null;
  }
}

function collectPackages() {
  const pkgs = [];
  const packagesDir = join(ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJson = join(packagesDir, entry.name, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (pkg.private) continue;
      pkgs.push({ dir: entry.name, name: pkg.name, version: pkg.version });
    } catch {
      // 目录无 package.json（如 .gitkeep 占位）→ 跳过
    }
  }
  return pkgs;
}

/** 取 `--log-file value` / `--log-file=value`；未给出返回 null。 */
export function parseLogFile(argv: string[]): string | null {
  const eq = argv.findLast((a: string) => a.startsWith("--log-file="));
  if (eq !== undefined) {
    const value = eq.slice("--log-file=".length);
    return value === "" ? null : value;
  }
  const at = argv.lastIndexOf("--log-file");
  if (at === -1) return null;
  const value = argv[at + 1];
  return value === undefined || value === "" ? null : value;
}

/**
 * 落盘：父目录逐级建出（调用方只传路径，不负责建目录，避免 workflow 为此加前序步骤）。
 * 失败抛错，由 main 转成 fail-closed（exit 1）：证据写不下来不得静默放行。
 */
export function writeLogFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function main(argv: string[]): number {
  const logFile = parseLogFile(argv);
  // 镜像行：stdout / stderr 各自保持原样输出，同时收一份文本用于落盘。
  const mirrored: string[] = [];
  const emit = (line: string): void => {
    mirrored.push(line);
    console.log(line);
  };
  const emitErr = (line: string): void => {
    mirrored.push(line);
    console.error(line);
  };
  const flush = (): void => {
    if (logFile === null) return;
    try {
      writeLogFile(logFile, mirrored.length === 0 ? "" : mirrored.join("\n") + "\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[verify-version] 落盘失败（" + logFile + "）：" + msg);
      process.exit(1);
    }
  };

  const expected = tagVersion();
  if (!expected) {
    emitErr("[verify-version] 非 tag 环境（git describe 失败）——CI 中仅 tag push 触发");
    flush();
    return 1;
  }

  const pkgs = collectPackages();
  let failed = 0;
  for (const p of pkgs) {
    const ok = p.version === expected;
    emit(
      (ok ? "OK " : "FAIL") +
        " " +
        p.name.padEnd(38) +
        " " +
        p.version +
        (ok ? "" : "（期望 " + expected + "）"),
    );
    if (!ok) failed++;
  }

  if (pkgs.length === 0) {
    emitErr("[verify-version] 未发现任何非 private 包（插件尚未迁入）");
    flush();
    return 1;
  }
  emit(
    failed === 0
      ? "\n[verify-version] " + pkgs.length + " 个包版本全部一致（v" + expected + "）"
      : "\n[verify-version] " + failed + " 个包不一致",
  );
  flush();
  return failed === 0 ? 0 : 1;
}

/** 仅直接执行时跑 main（被 import 时只取纯函数）。 */
function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exitCode = main(process.argv.slice(2));
