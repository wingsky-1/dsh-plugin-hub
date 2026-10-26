import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = join(HERE, "..", "..");
export const SKILL_DIR = join(PKG_ROOT, "skills", "dsh-verify-isolated");
export const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
export const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
export const scriptFile = join(SCRIPTS_DIR, "verify-isolated.mjs");
export const driverFile = join(SCRIPTS_DIR, "browser-driver.mjs");
export const TARGET_DSH_VERSION = "0.2.1-rc.2";
export const REF_DIR = join(SKILL_DIR, "references");
export const REF_FILES = [
  "script-contracts.md",
  "manual-setup.md",
  "browser-kernel.md",
  "viewport-geometry.md",
];

export function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) return {};
  const lines = match[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (kv === null) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest !== "" && !/^[>|][-+]?$/.test(rest)) {
      out[key] = rest;
      continue;
    }
    const block = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      block.push(lines[i + 1].trim());
      i += 1;
    }
    out[key] = rest.startsWith("|") ? block.join("\n") : block.join(" ");
  }
  return out;
}

export function winCmdShimFor(scriptAbs) {
  if (process.platform !== "win32") return scriptAbs;
  const cmdShim = join(dirname(scriptAbs), `${basename(scriptAbs, ".mjs")}.cmd`);
  writeFileSync(cmdShim, `@echo off\r\n"${process.execPath}" "%~dp0${basename(scriptAbs)}" %*\r\n`);
  return cmdShim;
}
