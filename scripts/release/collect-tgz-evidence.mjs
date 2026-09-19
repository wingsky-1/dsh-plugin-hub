#!/usr/bin/env node
/**
 * collect-tgz-evidence — 发布证据链 W1.3：按 publish 步骤同一包集合逐个 `pnpm pack`，
 * 把 tgz 复制到证据目录并生成 SHA256SUMS，随后删掉 tgz 本体（只上传校验和与日志，不传本体）。
 *
 * 包集合与发布步骤同源：直接执行 `scripts/release/publish-if-missing.ts` 取待发布清单
 * （子进程复用，不改 publish-if-missing.ts 一字——Publish 语义不动），哈希的正是即将发布的
 * 那组产物。证据目录只用 RUNNER_TEMP 下的路径（workspace 零落盘）：--out-dir 必须传绝对
 * 路径，相对路径即参数非法（exit 2），从结构上杜绝证据写进工作树。
 *
 * 用法：node scripts/release/collect-tgz-evidence.mjs --out-dir <绝对路径> [--keep-tgz]
 * 退出码：0 = 收集完成；1 = 判据失败（清单取不到 / 包集合空 / pack 失败 / 无 tgz / 落盘失败）；
 *         2 = 参数非法（经 lib/gate-exit.mjs 的 failClosed，判词可检索）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failClosed } from "../lib/gate-exit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIST_SCRIPT = join(ROOT, "scripts", "release", "publish-if-missing.ts");
export const SHA_FILENAME = "SHA256SUMS";
export const LOG_FILENAME = "collect-tgz-evidence.log";

/** 取 `--flag value` / `--flag=value`；未给出返回 fallback（与仓内其余判据同形）。 */
export function argValue(argv, flag, fallback) {
  const eq = argv.findLast(function (a) {
    return a.startsWith(flag + "=");
  });
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = argv.lastIndexOf(flag);
  return idx !== -1 && argv[idx + 1] !== undefined ? argv[idx + 1] : fallback;
}

/**
 * 参数解析（纯函数，抛错而非退出，调用方按 exit 2 处理）。
 * --out-dir 必填且必须绝对路径：相对路径会把证据写进工作树（零落盘红线），fail-closed。
 */
export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const outDir = argValue(argv, "--out-dir", null);
  if (outDir === null || outDir === "") throw new Error("缺少 --out-dir <绝对路径>");
  if (!isAbsolute(outDir))
    throw new Error("--out-dir 必须是绝对路径（证据不得落盘到工作树）：实际 " + outDir);
  const known = new Set(["--out-dir", "--keep-tgz", "--help", "-h"]);
  const bad = argv.filter(function (a) {
    if (!a.startsWith("--")) return true;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (known.has(flag)) return false;
    return true;
  });
  // --out-dir 的取值（绝对路径，以 / 开头）不是 flag，不计入未知参数。
  const stray = bad.filter(function (a) {
    return a !== outDir;
  });
  if (stray.length > 0) throw new Error("未知参数 " + stray.join(" "));
  return { help: false, outDir: outDir, keepTgz: argv.includes("--keep-tgz") };
}

/** 单个文件的 sha256（hex）。 */
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** SHA256SUMS 行：`sha256sum` 默认文本形态（`<hex>  <文件名>`，两空格），便于肉眼比对。 */
export function renderShaLines(files) {
  return files.map(function (f) {
    return sha256File(f.path) + "  " + f.name;
  });
}

/** 与发布步骤同一包集合：子进程跑 publish-if-missing.ts，stdout 每行一个包名。 */
export function listPublishSet() {
  let raw;
  try {
    raw = execFileSync("node", [LIST_SCRIPT], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    throw new Error("待发布清单取不到（publish-if-missing.ts 非零退出）：" + (err.message || err));
  }
  return String(raw)
    .split("\n")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

export function usage() {
  return (
    "用法：node scripts/release/collect-tgz-evidence.mjs --out-dir <绝对路径> [--keep-tgz]\n" +
    "证据目录只用 RUNNER_TEMP 下的路径（workspace 零落盘）。"
  );
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    failClosed("collect-tgz-evidence: " + err.message);
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const log = [];
  const emit = function (line) {
    log.push(line);
    console.log(line);
  };
  const fail = function (why) {
    emit("::error::collect-tgz-evidence：" + why);
    return 1;
  };
  mkdirSync(opts.outDir, { recursive: true });
  let pkgs;
  try {
    pkgs = listPublishSet();
  } catch (err) {
    return fail(err.message);
  }
  if (pkgs.length === 0) return fail("待发布包集合为空——禁止在空集上全绿");
  emit("待发布包（与 publish 步骤同源）：" + pkgs.join(", "));
  const tmp = mkdtempSync(join(tmpdir(), "tgz-evidence-"));
  try {
    for (const pkg of pkgs) {
      emit("pack " + pkg);
      try {
        execFileSync("pnpm", ["--filter", pkg, "pack", "--pack-destination", tmp], {
          cwd: ROOT,
          stdio: "pipe",
        });
      } catch (err) {
        return fail("pnpm pack 失败：" + pkg + "（" + (err.message || err) + "）");
      }
    }
    const tgz = readdirSync(tmp)
      .filter(function (f) {
        return f.endsWith(".tgz");
      })
      .sort();
    if (tgz.length === 0) return fail("pack 未产出任何 tgz");
    for (const f of tgz) copyFileSync(join(tmp, f), join(opts.outDir, f));
    const lines = renderShaLines(
      tgz.map(function (f) {
        return { name: f, path: join(opts.outDir, f) };
      }),
    );
    try {
      writeFileSync(join(opts.outDir, SHA_FILENAME), lines.join("\n") + "\n", "utf8");
    } catch (err) {
      return fail("SHA256SUMS 落盘失败：" + (err.message || err));
    }
    for (const line of lines) emit(line);
    emit("SHA256SUMS： " + tgz.length + " 个 tgz");
    if (!opts.keepTgz) {
      for (const f of tgz) rmSync(join(opts.outDir, f));
      emit("tgz 本体已删除（不上传，只留校验和）");
    }
    try {
      writeFileSync(join(opts.outDir, LOG_FILENAME), log.join("\n") + "\n", "utf8");
    } catch (err) {
      return fail("收集日志落盘失败：" + (err.message || err));
    }
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
