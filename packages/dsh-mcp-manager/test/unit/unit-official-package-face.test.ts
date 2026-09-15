/**
 * 官方 MCP 客户端包名的导入面锁（#767 S1-4c；设计 §6.4-2 的静态断言落地）。
 *
 * 判据：本包对 `@deepseek-ai/dsh-mcp-client` 的**唯一**合规接触面是「运行时按包名解析」——
 * loader 的 `import(说明符)` 调用，而说明符取自 server/shared/constants.ts 的那一个常量。
 * 该包不在 pnpm catalog、仓库内不可解析（实测 require.resolve → MODULE_NOT_FOUND），任何
 * 编译期 import / require / 字面量动态 import 都会让 tsc 解析失败、或在打包期被 esbuild 当
 * 本地依赖内联（发布物里就多出一份官方客户端的副本）。
 *
 * 为什么还要一条测试：那两种失败都要等到 CI 或用户机上才现形；这条在改动当刻就判红。契约面
 * 另有 pnpm-workspace.yaml 的「仅限 import type」与 contract-check 兜住，本测试是更早的一道。
 *
 * 判据面刻意只含 src 与 test：草稿区（.maintenance-drafts/）里的真机尖刺本来就要按包名 import。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const SPECIFIER = "@deepseek-ai/dsh-mcp-client";

/** 参与判据的文件（.ts/.tsx；.d.ts 无值面）。 */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

/** 包根相对路径（判词里稳定可读）。 */
function rel(abs: string): string {
  return abs.slice(pkgDir.length).replace(/\\/g, "/");
}

/** 逐行命中（行号 + 内容）；global 正则每次重置 lastIndex。 */
function hits(text: string, re: RegExp): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line: string, index: number) => {
    re.lastIndex = 0;
    if (re.test(line)) found.push(`${index + 1}: ${line.trim()}`);
  });
  return found;
}

const SRC_FILES = collectFiles(join(pkgDir, "src"));
const TEST_FILES = collectFiles(join(pkgDir, "test"));
const ALL_FILES = [...SRC_FILES, ...TEST_FILES];

describe("官方 dsh-mcp-client 的导入面锁", () => {
  it("src / test 里没有任何对官方包的编译期 import（含 import type）", () => {
    const re = new RegExp(`from\\s+["']${SPECIFIER}["']`, "g");
    const found = ALL_FILES.filter((f) => hits(readFileSync(f, "utf8"), re).length > 0).map(rel);
    expect(found, "官方包不在 catalog：编译期 import 会让 tsc 直接解析失败").toEqual([]);
  });

  it("src / test 里没有 require(...) / 字面量动态 import(...) / 副作用 import", () => {
    // 副作用形态（`import "…"`）既没有 from 也没有括号，前一条判据与它不相交——漏了它，
    // 「只在 constants.ts 保留一处字面量」这条也就被绕过了。
    const forms = [
      new RegExp(`require\\(\\s*["']${SPECIFIER}["']`, "g"),
      new RegExp(`import\\(\\s*["']${SPECIFIER}["']`, "g"),
      new RegExp(`import\\s+["']${SPECIFIER}["']`, "g"),
    ];
    const found = ALL_FILES.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return forms.flatMap((re) => hits(text, re).map((h) => `${rel(f)} ${h}`));
    });
    expect(found, "按包名解析只许经 loader 的 import(说明符)，说明符取自共享层常量").toEqual([]);
  });

  it("包名字面量在 src 里只有一处物理定义，且落在 server/shared/constants.ts", () => {
    const re = new RegExp(`["']${SPECIFIER}["']`, "g");
    const found = SRC_FILES.flatMap((f) =>
      hits(readFileSync(f, "utf8"), re).map((h) => `${rel(f)} ${h}`),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("src/server/shared/constants.ts");
  });

  it("没有对 @deepseek-ai/cordis-plugin-loader 的 import（不在 catalog，类型面取不到）", () => {
    const re = /from\s+["']@deepseek-ai\/cordis-plugin-loader["']/g;
    const found = ALL_FILES.filter((f) => hits(readFileSync(f, "utf8"), re).length > 0).map(rel);
    expect(found, "loader 服务的形状由 server/shared/host-faces.ts 自持声明").toEqual([]);
  });
});
