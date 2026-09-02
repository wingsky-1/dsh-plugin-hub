/**
 * Stryker 测试宿主 lib→src 重定向 resolve hook（issue #423 方案 A）。
 *
 * 由 mutation-lib-to-src-hook.mjs 经 Node `module.register` 注册进 ESM 解析链，
 * 把解析落点位于 `packages/<pkg>/lib/<relative-file>.(js|ts)` 的任意相对产物
 * 重定向到同包 `src/<relative-file>.ts`：
 *   lib/index.js        → src/index.ts
 *   lib/routes.js       → src/routes.ts
 *   lib/sub/module.js   → src/sub/module.ts
 * 静态 `import ... from "../lib/..."` 与动态 `await import(...)` 走同一
 * resolve 链，都会被拦截。
 *
 * 必须在 nextResolve 之前拦截：stryker sandbox 里通常没有 lib 产物，
 * 默认解析会先抛 ERR_MODULE_NOT_FOUND，hook 根本接不到。
 *
 * 拦截规则：
 *  - 仅处理相对 specifier（./ ../）与 file: URL；其它（node: 内置、裸包、
 *    绝对路径字符串）原样交给 nextResolve；
 *  - 先 POSIX 归一化再判定，支持任意相对层级，但 `..` 逃逸出
 *    `packages/<pkg>/lib/` 后不命中（packages 边界：每个包只映射到自己的 src）；
 *  - shared / node_modules 路径段、client 产物（lib/client.js、lib/client/**、
 *    lib/client-*.js 客户端 chunk）一律不映射为宿主 src；
 *  - 兜底：nextResolve 的 file: 解析结果若仍是 lib 产物形态也重定向
 *    （捕获 Node 对相对引用的扩展名补充等派生路径）。
 *
 * 为什么不动测试源码 import：*.test.ts 仍写 `../lib/index.js`（普通
 * `pnpm test`/smoke 测的就是 lib 构建产物）；重定向只在 stryker 变异宿主内生效。
 *
 * 可测性：核心判定收敛到纯函数 canRedirectLibToSrc(filePath, { root })，
 * 无隐式环境依赖；specifier 解析是 candidateFrom(specifier, parentURL)；
 * resolve 的端到端行为由子进程测试（mutation-lib-to-src-loader.test.ts）验证。
 */
import { dirname, join, posix as posixPath, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 仓库根（lib→src 的 packages 边界锚点）。
 * 惰性读取：子进程测试可设 DSH_MUTATION_LIB2SRC_ROOT 指向 mkdtemp fake 仓库。
 */
function currentRoot() {
  return process.env.DSH_MUTATION_LIB2SRC_ROOT ?? join(import.meta.dirname, "../..");
}

/** 统一分隔符（Windows `\` → `/`），后续全部按 POSIX 段级匹配。 */
function toPosix(p) {
  return String(p).replaceAll("\\", "/");
}

/** root 必须是绝对形态（unix `/…` 或 Windows 盘符 `C:/…`），防相对根误判。 */
function isUsableRoot(rootPosix) {
  return rootPosix.startsWith("/") || /^[A-Za-z]:\//.test(rootPosix);
}

/**
 * POSIX 归一化：折叠 `.` / `..`。归一化后仍含 `..` 视为逃出文件系统根，拒绝。
 * 输入已是 POSIX 分隔符。
 */
function normalizePosix(p) {
  const n = posixPath.normalize(p);
  if (n.split("/").includes("..")) return null;
  return n;
}

/**
 * client 产物（与宿主 src 两套构建链）：
 *  - lib/client.js 客户端 bundle 入口；
 *  - lib/client/** 客户端目录；
 *  - lib/client-*.js 客户端附加 chunk（如 client-mermaid.js）。
 * 宿主模块 client-logic.ts 的产物 client-logic.js 放行（映射到 src/client-logic.ts）。
 */
function isClientProduct(relPosix) {
  const segs = relPosix.split("/");
  if (segs.includes("client")) return true;
  const base = segs[segs.length - 1] ?? "";
  const stem = base.replace(/\.(js|ts)$/, "");
  if (stem === "client") return true;
  // client-*.js 客户端 chunk（client-mermaid.js 等）；宿主模块 client-logic 放行
  if (stem.startsWith("client-") && stem !== "client-logic") return true;
  return false;
}

/** 绝对文件路径 → 所属包信息。 */
function lookupPkg(filePath, root) {
  const rootPosix = normalizePosix(toPosix(root));
  const pathPosix = normalizePosix(toPosix(filePath));
  if (!rootPosix || !pathPosix || !isUsableRoot(rootPosix)) return null;
  const pkg = pkgOf(rootPosix, pathPosix);
  return pkg ? { root, pkg } : null;
}

/**
 * 返回 file: 父模块所在的 packages/<pkg>，供 resolve 防跨包重定向。
 */
export function pkgRootFromParent(parentURL) {
  if (typeof parentURL !== "string" || !parentURL.startsWith("file:")) return null;
  try {
    const fp = fileURLToPath(parentURL);
    return lookupPkg(fp, currentRoot());
  } catch {
    return null;
  }
}

/** file URL 或绝对路径字符串 → 该文件所属 packages/<pkg>（无则 null）。 */
function pkgOfUrl(url, root) {
  if (typeof url !== "string") return null;
  const rootPosix = normalizePosix(toPosix(root));
  if (!rootPosix || !isUsableRoot(rootPosix)) return null;
  let posixPathStr = url;
  if (url.startsWith("file:")) {
    try {
      posixPathStr = fileURLToPath(url);
    } catch {
      return null;
    }
  }
  posixPathStr = normalizePosix(toPosix(posixPathStr));
  if (!posixPathStr) return null;
  return pkgOf(rootPosix, posixPathStr);
}

/** posixPath 是否位于 <rootPosix>/packages/<pkg>/ 子树内；是则返回 pkg 名。 */
function pkgOf(rootPosix, posixPathStr) {
  const prefix = `${rootPosix}/packages/`;
  if (!posixPathStr.startsWith(prefix)) return null;
  const head = posixPathStr.slice(prefix.length).split("/")[0];
  return head || null;
}

/**
 * 核心纯函数：`packages/<pkg>/lib/<relative-file>.(js|ts)` → 同包
 * `src/<relative-file>.ts`。命中返回 { filePath, hint }，否则 null。
 * 选项 pkg（可选）限定目标包——测试用它直接断言跨包场景为 null。
 *
 * 安全语义（保留 packages 边界）：
 *  - 先归一化再判定——`lib/sub/../index.js` 折叠后仍在 lib 内则命中；
 *    `lib/../../../outside.js` 折叠后越界则不命中；
 *  - 每个包只映射到自己的 src（packages/A/lib/X → packages/A/src/X）；
 *  - shared / node_modules 路径段、client 产物一律不命中；
 *  - 目标再做一次防回归验证：无 `..`、不落回 lib、确在 `<pkg>/src/` 子树。
 */
export function canRedirectLibToSrc(filePath, options = {}) {
  const root = options.root ?? currentRoot();
  const rootPosix = normalizePosix(toPosix(root));
  if (!rootPosix || !isUsableRoot(rootPosix)) return null;

  const posixPathStr = normalizePosix(toPosix(filePath));
  if (!posixPathStr) return null;

  const pkg = pkgOf(rootPosix, posixPathStr);
  if (!pkg) return null;
  if (options.pkg !== undefined && options.pkg !== pkg) return null;

  const libRoot = `${rootPosix}/packages/${pkg}/lib`;
  if (posixPathStr !== libRoot && !posixPathStr.startsWith(`${libRoot}/`)) return null;

  let rel = posixPathStr.slice(libRoot.length + 1);
  if (!rel) return null;

  const relSegs = rel.split("/");
  if (relSegs.includes("node_modules") || relSegs.includes("shared")) return null;
  if (isClientProduct(rel)) return null;

  if (rel.endsWith(".js")) rel = `${rel.slice(0, -3)}.ts`;
  else if (!rel.endsWith(".ts")) return null; // .js 产物改后缀；.ts 保持（sandbox 偶发）

  const target = `${rootPosix}/packages/${pkg}/src/${rel}`;
  const targetNorm = normalizePosix(target);
  if (!targetNorm) return null;
  const segs = targetNorm.split("/");
  const pkgIdx = segs.indexOf(pkg);
  const srcIdx = segs.indexOf("src");
  if (segs.includes("lib")) return null;
  if (pkgIdx < 0 || srcIdx <= pkgIdx) return null;
  if (!targetNorm.startsWith(`${rootPosix}/packages/${pkg}/src/`)) return null;

  return { filePath: targetNorm, hint: `lib→src: ${posixPathStr} => ${targetNorm}` };
}

/**
 * 从 specifier + parentURL 得到绝对候选文件路径。
 * 仅相对 `./` `../` 与 `file:` URL；其余返回 null（交给 nextResolve）。
 * file: URL 经 fileURLToPath 解码（百分号编码 / Windows 盘符）。
 */
export function candidateFrom(specifier, parentURL) {
  if (typeof specifier !== "string") return null;
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return null;
    }
  }
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return null;
  if (typeof parentURL !== "string" || !parentURL.startsWith("file:")) return null;
  try {
    return pathResolve(dirname(fileURLToPath(parentURL)), specifier);
  } catch {
    return null;
  }
}

export async function resolve(specifier, context, nextResolve) {
  // 1) 相对 / file: URL specifier：nextResolve 前拦截（无 lib sandbox 适配）。
  //    跨包守卫：父模块与候选必须同属一个 packages/<pkg>（pkgOfUrl 归一化比较）。
  const parentPkg = pkgRootFromParent(context.parentURL)?.pkg ?? null;
  const candidate = candidateFrom(specifier, context.parentURL);
  if (candidate) {
    const hit = canRedirectLibToSrc(candidate);
    if (hit && parentPkg !== null && pkgOfUrl(candidate, currentRoot()) === parentPkg) {
      return { url: pathToFileURL(hit.filePath).href, shortCircuit: true };
    }
  }

  // 2) 兜底：nextResolve 结果若仍是 lib 产物形态也重定向（同跨包守卫）
  const resolved = await nextResolve(specifier, context);
  if (typeof resolved.url === "string" && resolved.url.startsWith("file:")) {
    try {
      const hit = canRedirectLibToSrc(fileURLToPath(resolved.url));
      if (hit && parentPkg !== null && pkgOfUrl(resolved.url, currentRoot()) === parentPkg) {
        return { url: pathToFileURL(hit.filePath).href, shortCircuit: true };
      }
    } catch {
      // 非 file 路径：原样返回
    }
  }
  return resolved;
}
