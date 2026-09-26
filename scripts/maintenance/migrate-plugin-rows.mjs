#!/usr/bin/env node

/**
 * 一次性 profile row identity 迁移：ui-dsh-* -> dsh-*。
 *
 * 默认 dry-run；--apply 只改 patch 的 id 字段，保留 name/config/disabled/顺序，
 * 每个文件先写临时文件再 rename，并保留时间戳备份。DSH settings namespace 已在
 * v0.2.5 使用 dsh-*，本工具不搬运 settings 文档；发现旧 ui-* settings section
 * 时只报告并 fail-closed，避免把未知字段静默写入新 namespace。
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { dshHome } from "../../shared/dsh-home.js";

const DATA = JSON.parse(
  readFileSync(new URL("../data/plugin-row-migration.json", import.meta.url), "utf8"),
);
const LEGACY_TO_CANONICAL = DATA.legacyToCanonical;

class MigrationConflict extends Error {}

function usage() {
  return [
    "用法: node scripts/maintenance/migrate-plugin-rows.mjs [options]",
    "",
    "选项:",
    "  --home <path>   DSH home（默认取 DSH_HOME 或 ~/.dsh）",
    "  --patch <path>  额外 patch 文件，可重复",
    "  --apply         实际写回；默认只 dry-run",
    "  --json          只输出 JSON",
    "  --help          显示帮助",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { apply: false, json: false, home: dshHome(), patches: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--home") options.home = resolve(requireValue(argv, ++i, "--home"));
    else if (arg === "--patch") options.patches.push(resolve(requireValue(argv, ++i, "--patch")));
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} 缺少参数`);
  return value;
}

function discoverPatchFiles(home, extra) {
  const found = [];
  const add = (path) => {
    if (existsSync(path) && !found.includes(path)) found.push(path);
  };
  add(join(home, "cordis.patch.yml"));
  const profiles = join(home, "profiles");
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) add(join(profiles, name, "cordis.patch.yml"));
  }
  for (const path of extra) add(path);
  return found.sort();
}

function parseYaml(text, path) {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new MigrationConflict(`${path}: YAML 解析失败: ${document.errors[0].message}`);
  }
  return document;
}

function scalar(node) {
  return typeof node?.value === "string" ? node.value : undefined;
}

function rowId(map) {
  if (!isMap(map)) return undefined;
  for (const pair of map.items) {
    if (pair.key && scalar(pair.key) === "id") return scalar(pair.value);
  }
  return undefined;
}

function collectRows(document) {
  const rows = [];
  const walk = (node) => {
    if (isSeq(node)) {
      for (const item of node.items) walk(item);
      return;
    }
    if (!isMap(node)) return;
    for (const pair of node.items) {
      if (!(pair.key && scalar(pair.key) === "insert") || !isSeq(pair.value)) continue;
      for (const item of pair.value.items) rows.push({ map: item, id: rowId(item) });
    }
  };
  walk(document.contents);
  return rows;
}

function checkRows(path, text) {
  const document = parseYaml(text, path);
  const rows = collectRows(document).filter((row) => typeof row.id === "string");
  const counts = new Map();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const conflicts = [];
  for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
    if ((counts.get(legacy) ?? 0) > 1) conflicts.push(`重复 legacy id: ${legacy}`);
    if ((counts.get(legacy) ?? 0) > 0 && (counts.get(canonical) ?? 0) > 0) {
      conflicts.push(`legacy/canonical 同时存在: ${legacy} / ${canonical}`);
    }
  }
  if (conflicts.length > 0) throw new MigrationConflict(`${path}: ${conflicts.join("; ")}`);
  return rows;
}

function migrateText(path, text) {
  checkRows(path, text);
  let changes = 0;
  const next = text
    .split(/(\r?\n)/)
    .map((part) => {
      if (part.startsWith("\n") || part.startsWith("\r")) return part;
      const match = part.match(/^(\s*(?:- )?id\s*:\s*)(["']?)([^"'#\s]+)(\2)(\s*(?:#.*)?)$/);
      if (!match) return part;
      const canonical = LEGACY_TO_CANONICAL[match[3]];
      if (!canonical) return part;
      changes += 1;
      return `${match[1]}${match[2]}${canonical}${match[4]}${match[5]}`;
    })
    .join("");
  if (changes > 0) checkRows(path, next);
  return { text: next, changes };
}

function legacySettingsSections(home) {
  const found = [];
  for (const name of ["settings.yaml", "settings.yaml.imported"]) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const document = parseYaml(text, path);
    const value = document.toJS();
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of Object.keys(value)) {
      if (key in LEGACY_TO_CANONICAL) found.push({ file: path, namespace: key });
    }
  }
  return found;
}

function migrateFile(path, apply) {
  const original = readFileSync(path, "utf8");
  const result = migrateText(path, original);
  let backup;
  if (apply && result.changes > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${path}.bak-${stamp}`;
    copyFileSync(path, backup);
    const temporary = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, result.text, "utf8");
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
  return { path, changes: result.changes, backup };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!existsSync(options.home)) throw new Error(`DSH home 不存在: ${options.home}`);
  const files = discoverPatchFiles(options.home, options.patches);
  const settingsSections = legacySettingsSections(options.home);
  const results = files.map((path) => migrateFile(path, options.apply));
  const report = {
    mode: options.apply ? "apply" : "dry-run",
    home: options.home,
    files: results,
    totalChanges: results.reduce((sum, item) => sum + item.changes, 0),
    settingsSections,
  };
  if (settingsSections.length > 0) {
    report.error =
      "发现旧 ui-* settings section；请先按插件 schema 定向处理，工具未修改 settings 文档";
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[${report.mode}] files=${files.length} changes=${report.totalChanges}`);
    for (const item of results) {
      console.log(
        `${item.changes > 0 ? "change" : "skip  "} ${item.path}${item.backup ? ` backup=${item.backup}` : ""}`,
      );
    }
    for (const section of settingsSections) {
      console.log(`settings legacy namespace: ${section.namespace} (${section.file})`);
    }
  }
  if (settingsSections.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`migrate-plugin-rows: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
