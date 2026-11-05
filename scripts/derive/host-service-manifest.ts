import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface NoDeclarationPackage {
  name: string;
  version: string;
  reason: string;
}

const NO_DECLARATION_REASON = "no root runtime API (static/data/WASM/platform package)";
const STATIC_ASSET_EXTENSIONS =
  /\.(?:json|css|html?|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|wasm|map)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function collectExportTypes(value: unknown, location: string, pkgDir: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectExportTypes(value[i], location + "[" + i + "]", pkgDir, out);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "types") {
      if (typeof target !== "string" || target.length === 0) {
        throw new Error(location + ".types 不是非空字符串：" + pkgDir);
      }
      if (target.includes("*")) {
        throw new Error(location + ".types 含通配符，无法枚举真实入口：" + target);
      }
      out.push(resolve(pkgDir, target));
      continue;
    }
    collectExportTypes(
      target,
      location + (location.endsWith("]") ? "[" + JSON.stringify(condition) + "]" : "." + condition),
      pkgDir,
      out,
    );
  }
}

function isStaticExportTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return target === "./dist/*" || STATIC_ASSET_EXTENSIONS.test(target);
  }
  const values = Array.isArray(target)
    ? target
    : isRecord(target)
      ? Object.entries(target)
          .filter(([condition]) => condition !== "types" && condition !== "typings")
          .map(([, value]) => value)
      : [];
  return values.length > 0 && values.every(isStaticExportTarget);
}

function hasStaticFileEvidence(pkgDir: string): boolean {
  const files = readdirSync(pkgDir, { recursive: true, encoding: "utf8" });
  return files.some(
    (file) =>
      !file.split(/[\\/]/).includes("node_modules") &&
      file !== "package.json" &&
      STATIC_ASSET_EXTENSIONS.test(file),
  );
}

function hasOnlyStaticEvidence(meta: Record<string, unknown>, pkgDir: string): boolean {
  if (
    ["main", "module"].some(
      (key) => typeof meta[key] === "string" && (meta[key] as string).length > 0,
    ) ||
    ["index.js", "index.cjs", "index.mjs"].some((name) => isFile(join(pkgDir, name)))
  ) {
    return false;
  }
  const exportsValue = meta.exports;
  if (exportsValue === undefined) return hasStaticFileEvidence(pkgDir);
  if (!isRecord(exportsValue) || "." in exportsValue) return false;
  const subpaths = Object.entries(exportsValue);
  return (
    subpaths.length > 0 &&
    subpaths.every(([key]) => key.startsWith(".")) &&
    subpaths.every(([, target]) => isStaticExportTarget(target))
  );
}

/** 返回全部真实声明入口；null 表示有正向静态证据的无声明包。 */
export function resolvePackageEntries(
  pkgDir: string,
  pkgName: string,
  meta: Record<string, unknown>,
): string[] | null {
  const declared: string[] = [];
  for (const key of ["types", "typings"]) {
    if (!(key in meta)) continue;
    const value = meta[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("包 " + pkgName + " 的 " + key + " 不是非空字符串：" + pkgDir);
    }
    declared.push(resolve(pkgDir, value));
  }
  collectExportTypes(meta.exports, "exports", pkgDir, declared);
  for (const entry of new Set(declared)) {
    if (!isFile(entry)) {
      throw new Error("包 " + pkgName + " 声明的类型目标不存在或不可读：" + entry);
    }
  }

  const conventional = [
    join(pkgDir, "lib", "types", "index.d.ts"),
    join(pkgDir, "lib", "index.d.ts"),
    join(pkgDir, "index.d.ts"),
  ].filter(isFile);
  const entries = [...new Set([...declared, ...conventional])];
  if (entries.length > 0) return entries;
  if (!hasOnlyStaticEvidence(meta, pkgDir)) {
    throw new Error("包 " + pkgName + " 无声明且无法证明仅暴露静态资源：" + pkgDir);
  }
  return null;
}

export function noDeclarationPackage(name: string, version: string): NoDeclarationPackage {
  return { name, version, reason: NO_DECLARATION_REASON };
}

export function noDeclarationSection(packages: {
  from: NoDeclarationPackage[];
  to: NoDeclarationPackage[];
}): string[] {
  const items = [
    ...packages.from.map((pkg) => "旧：" + pkg.name + "@" + pkg.version + "（" + pkg.reason + "）"),
    ...packages.to.map((pkg) => "新：" + pkg.name + "@" + pkg.version + "（" + pkg.reason + "）"),
  ];
  return items.length === 0
    ? []
    : ["## 无声明包（显式分类，不伪装为 typed）", ...items.map((item) => "- " + item), ""];
}
