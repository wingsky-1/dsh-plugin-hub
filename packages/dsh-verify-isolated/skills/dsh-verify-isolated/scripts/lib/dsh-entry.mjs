import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

function checkExecutable(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    if (process.platform === "win32") return resolve(path);
    return (stat.mode & 0o111) !== 0 ? resolve(path) : null;
  } catch {
    return null;
  }
}

function winPathHit(dir, candidate) {
  for (const ext of ["exe", "cmd", "bat"]) {
    const hit = checkExecutable(`${join(dir, candidate)}.${ext}`);
    if (hit) return hit;
  }
  return null;
}

function pathHit(dir, candidate) {
  const hit = checkExecutable(join(dir, candidate));
  if (hit) return hit;
  if (process.platform !== "win32") return null;
  return winPathHit(dir, candidate);
}

export function resolveDsh(candidate) {
  if (!candidate) return null;
  const hasSep =
    candidate.includes("/") || (process.platform === "win32" && candidate.includes("\\"));
  if (isAbsolute(candidate) || hasSep) return checkExecutable(candidate);
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const hit = pathHit(dir, candidate);
    if (hit) return hit;
  }
  return null;
}

export function isWinScript(path) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(path);
}

export function readDshVersion(abs) {
  try {
    const raw = execFileSync(abs, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      ...(isWinScript(abs) ? { shell: true } : {}),
    });
    return (raw.split("\n")[0] || "").trim() || null;
  } catch {
    return null;
  }
}
