import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, resolvePkgArg } from "./verify-core.mjs";
import { CliError } from "./cli.mjs";

function newestMtime(dir) {
  let newest = 0;
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) {
        const mtime = statSync(entryPath).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  walk(dir);
  return newest;
}

function hasBuildScript(pkgAbs) {
  try {
    return !!JSON.parse(readFileSync(join(pkgAbs, "package.json"), "utf8")).scripts?.build;
  } catch {
    return false;
  }
}

function buildProductDirs(abs) {
  return ["lib", "dist"]
    .map((dir) => join(abs, dir))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

function warnIfStale(abs, products, outWarn) {
  const src = join(abs, "src");
  const sourceMtime = existsSync(src) ? newestMtime(src) : 0;
  const productMtime = Math.max(...products.map(newestMtime));
  if (sourceMtime > productMtime) {
    outWarn(`警告: 源码比构建产物新（--no-build 可能验证到旧版本）: ${abs}`);
  }
}

function runPluginBuild(abs, jsonMode, out) {
  out(`构建插件: ${abs}`);
  const result = spawnSync("pnpm", ["build"], {
    cwd: abs,
    env: process.env,
    stdio: ["inherit", jsonMode ? "pipe" : "inherit", "inherit"],
    timeout: 600000,
  });
  if (jsonMode && result.stdout) process.stderr.write(String(result.stdout));
  if (result.status !== 0) {
    throw new CliError(`错误: pnpm build 失败（退出码 ${result.status}）: ${abs}`, EXIT.FAIL);
  }
}

function preparePlugin(item, deps) {
  const label = item.kind === "path" ? item.abs : item.input;
  if (item.kind === "spec" || !existsSync(join(item.abs, "package.json"))) {
    deps.out(
      `跳过: 非本地插件目录（无 package.json）: ${label}（若为包名/git URL 将原样传给 dsh）`,
    );
    return;
  }
  if (deps.noBuild) {
    const products = buildProductDirs(item.abs);
    if (products.length === 0) {
      throw new CliError(
        `错误: --no-build 但缺少构建产物（lib/ 或 dist/）: ${item.abs}\n` +
          "       请先 pnpm build，或去掉 --no-build 让脚本自动构建",
        EXIT.USAGE,
      );
    }
    warnIfStale(item.abs, products, deps.outWarn);
    return;
  }
  if (hasBuildScript(item.abs)) runPluginBuild(item.abs, deps.jsonMode, deps.out);
  else deps.out(`跳过构建（无 build 脚本）: ${item.abs}`);
}

export function setupPlugins(pkgs, deps) {
  if (pkgs.length === 0) return;
  const items = pkgs.map(resolvePkgArg);
  for (const item of items) preparePlugin(item, deps);
  const addArgs = items.map((item) => (item.kind === "path" ? item.abs : item.input));
  const add = deps.runDsh(["plugin", "--profile", deps.profile, "add", ...addArgs], true);
  if (add.status !== 0) {
    throw new CliError(
      `错误: dsh plugin add 失败（已传入归一化路径）:\n${addArgs.map((path) => `  - ${path}`).join("\n")}`,
      EXIT.FAIL,
    );
  }
}

export function initProfileAndBundles({ isolatedHome, profile, runDsh }) {
  const init = runDsh(["plugin", "--profile", profile, "list"], true);
  if (init.status !== 0) {
    throw new CliError(
      `错误: profile 初始化失败（dsh plugin --profile ${profile} list）——检查 dsh 入口与版本`,
      EXIT.FAIL,
    );
  }
  const profilePkg = join(isolatedHome, "profiles", profile, "package.json");
  const pkg = JSON.parse(readFileSync(profilePkg, "utf8"));
  const bundles = pkg.dsh.profile.bundles;
  if (!bundles.includes("@deepseek-ai/dsh-base")) bundles.unshift("@deepseek-ai/dsh-base");
  if (!bundles.includes("@deepseek-ai/dsh-web-app")) {
    bundles.splice(bundles.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app");
  }
  writeFileSync(profilePkg, JSON.stringify(pkg, null, 2));
}
