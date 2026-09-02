/**
 * Stryker 测试宿主 lib→src 重定向 resolve hook（issue #423 方案 A）。
 *
 * 由 mutation-lib-to-src-hook.mjs 经 Node `module.register` 注册进 ESM 解析链，
 * 把 `packages/<pkg>/lib/index.js` 的解析结果重定向到同包 `src/index.ts`：
 * 静态 `import ... from "../lib/index.js"` 与动态
 * `await import("../lib/index.js")` 都会被拦截（两者走同一 resolve 链）。
 *
 * 必须在 nextResolve 之前拦截：stryker sandbox 里通常没有 lib 产物，
 * 默认解析会先抛 ERR_MODULE_NOT_FOUND，hook 根本接不到。
 *
 * 拦截规则（精确）：
 *  - 仅当「相对 parent 解析后」落到 `…/packages/<pkg>/lib/index.js`（或 .ts）；
 *  - 重定向到同包 `src/index.ts`；
 *  - 共享 shared/ 与 node_modules 的 lib 一律不动；
 *  - 其它模块（node: 内置、裸包、相对非 lib/index 文件）原样 nextResolve。
 *
 * 为什么不动测试源码 import：*.test.ts 仍写 `../lib/index.js`（普通
 * `pnpm test`/smoke 测的就是 lib 构建产物）；重定向只在 stryker 变异宿主内生效。
 */
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_LIB_INDEX = /\/packages\/([^/]+)\/lib\/index\.(?:js|ts)$/;

function tryRedirect(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const match = normalized.match(PACKAGE_LIB_INDEX);
  if (!match) return null;
  return normalized.replace(
    `/packages/${match[1]}/lib/index.${normalized.endsWith(".ts") ? "ts" : "js"}`,
    `/packages/${match[1]}/src/index.ts`,
  );
}

function candidateFrom(specifier, parentURL) {
  if (typeof specifier !== "string") return null;
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return null;
    }
  }
  if (!parentURL || typeof parentURL !== "string" || !parentURL.startsWith("file:")) {
    return null;
  }
  if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return null;
  try {
    return pathResolve(dirname(fileURLToPath(parentURL)), specifier);
  } catch {
    return null;
  }
}

export async function resolve(specifier, context, nextResolve) {
  const candidate = candidateFrom(specifier, context.parentURL);
  if (candidate) {
    const redirected = tryRedirect(candidate);
    if (redirected) {
      return { url: pathToFileURL(redirected).href, shortCircuit: true };
    }
  }

  const resolved = await nextResolve(specifier, context);
  if (typeof resolved.url === "string" && resolved.url.startsWith("file:")) {
    try {
      const redirected = tryRedirect(fileURLToPath(resolved.url));
      if (redirected) {
        return { url: pathToFileURL(redirected).href, shortCircuit: true };
      }
    } catch {
      // 非 file 路径：原样返回
    }
  }
  return resolved;
}
