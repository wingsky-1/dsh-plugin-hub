/**
 * dsh-notifier — 能力自检面的产物外壳与打包不变量（#784）。
 *
 * 为什么这些判据只能在这里守：断言对象是**可发布的形态**，不是 src 本身——`src/client/index.tsx`
 * 与 `src/client/settings/**` 的源码文本（界面真的挂上了诊断行、权限状态行的结构锚点）、
 * `lib/client.js` 的产物内容（诊断行真的被打进包里），以及 in-place esbuild 的**打包不变量**
 * （type-only 引用真被擦除、浏览器包里不含服务端标识符与 node 内置）。
 *
 * 跨端一致性与纯函数行为判据已搬到 test/client-unit/ 直连源码：原先把它们建在 esbuild 产物副本
 * 上，静态导入图里没有目标模块，perTest 覆盖分析据此把 `src/client/capabilities.ts` 判成零覆盖。
 * 本层只守「它真的被发布成了这个样子」。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";
import { assertClientSourceContract } from "../../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/capabilities.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});

describe("产物契约：能力自检面真的被界面挂上（源码 + 产物各判一次）", () => {
  it("客户端产物外壳契约（load id = 包名、IIFE 外壳、use strict）", () => {
    assertClientSourceContract(pkgDir);
  });

  // 纯函数的判据不能证明「界面真的挂了它」：删掉 builtinCard 里那两行调用，上面的用例照样全绿。
  it("两张内置频道卡的卡体各挂了自己的诊断行，且都没有挤进卡头 summary", () => {
    const src = readFileSync(join(pkgDir, "src/client/index.tsx"), "utf8");
    expect(src).toMatch(/clientDiagnosticsOf\(diagnostics, clientFacts\(\), t\)/u);
    // builtinCard 已整体搬去 settings/channels/builtin-card.tsx（该文件整体即 builtinCard 本体），
    // 故不再对 index.tsx 做 indexOf 切片：直接读卡文件。函数名锚显式判在位——锚一旦失效这条
    // 先红，免得判据退化成「对着另一个文件恒绿」（原切片形态下 indexOf 返回 -1 会静默退化）。
    const card = readFileSync(
      join(pkgDir, "src/client/settings/channels/builtin-card.tsx"),
      "utf8",
    );
    expect(card).toContain("export function builtinCard(");
    // 诊断行按类型分派已收进 builtinTypeRows（#732 E6）：卡体调用点 + 分派守卫 + 两处行渲染
    // 三个锚一起判——只看行渲染会漏掉「行还在但卡不挂」，只看调用点会漏掉「挂了但不按类型分派」。
    expect(card).toContain("{builtinTypeRows({");
    expect(card).toContain('if (type === "browser") {');
    expect(card).toContain('if (type === "system") {');
    expect(card).toContain("{browserDiagnosticsLine(diag)}");
    expect(card).toContain("{hostDiagnosticsBlock(diag)}");
    // 卡头那行在窄屏 @media (max-width: 480px) 下 display:none——诊断结论必须落在卡体。
    expect(card).toContain("<summary>");
    expect(card).toContain("</summary>");
    const summary = card.slice(card.indexOf("<summary>"), card.indexOf("</summary>"));
    expect(summary).not.toMatch(/hostDiagnosticsBlock|browserDiagnosticsLine/u);
    expect(card).toMatch(/className="dn-ch-body"/u);
  });

  // 权限状态行是显式契约锚点（style.css 头部登记），改结构会让既有窄屏/权限断言落空。
  it("权限状态行的结构没被改动（dn-ch-perm 锚点仍在）", () => {
    // browserPermLine 已搬去 settings/parts/diagnostics.tsx：只改读取路径，断言字面量不变。
    const src = readFileSync(join(pkgDir, "src/client/settings/parts/diagnostics.tsx"), "utf8");
    expect(src).toContain('<div className="dn-ch-perm">');
    expect(src).toContain('<span className="dn-ch-permText">{text}</span>');
  });

  // 构建面：源码有而产物没有，说明那个模块没被打进 client.js（用户侧就是一片空白）。
  it("产物 client.js 带上了诊断行（JS 侧拼接字面量存在，排除只剩 CSS 选择器的情况）", () => {
    const code = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
    expect(code).toContain('"dn-ch-diag dn-ch-diag-"');
    expect(code).toContain("clientDiagnosticsOf");
  });
});

describe("跨端形态：客户端模块自带实现，不夹带服务端代码", () => {
  // 跨端只共用**类型**；这条断言把「运行时只有一份实现」变成可判红的判据，而不是口头约定。
  it("打包产物里没有服务端模块的痕迹（`import type` 被擦除、服务端标识符不出现）", () => {
    const code = bundle.outputFiles[0]!.text;
    for (const marker of [
      "server/channels",
      "capabilities/type",
      "probeNotificationCapabilities",
      "readOsRelease",
      "REASON_CODES",
      "node:fs",
      "node:child_process",
    ]) {
      expect(code, `产物夹带了 ${marker}`).not.toContain(marker);
    }
  });

  // 干净模块的类型面此前直指 ../server/channels/impl/capabilities/type.ts 与 ../server/shared/reason.ts：
  // 类型 import 编译期擦除，所以产物断言看不见它——但它是「客户端依赖宿主实现文件」这条不该存在的
  // 依赖边的唯一入口（改一个字去掉 type 就变成运行时依赖）。故这里扫客户端源码本身，越界即红。
  it("src/client/** 没有任何指向 ../server/ 的 import（类型面也一样）", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/u.test(entry.name)) files.push(full);
      }
    };
    walk(join(pkgDir, "src/client"));
    // 判据面自证：扫描真的跑过，且三个关键文件都在面内（面缩了这条先红，免得判据退化成恒绿）。
    expect(files.length).toBeGreaterThan(0);
    for (const known of ["capabilities.ts", "index.tsx", "reason-text.ts"]) {
      expect(
        files.some((file) => file.endsWith("/" + known)),
        known,
      ).toBe(true);
    }
    const offenders = files
      .filter((file) => /from\s+["'][^"']*\/server\//u.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(pkgDir.length));
    expect(offenders).toEqual([]);
  });

  // 两处历史违规的落点：类型面改指共享面后，值面与类型面都只剩 src/shared/interface.ts 一个入口。
  it("能力面与理由面的类型 import 指向共享面", () => {
    for (const rel of ["src/client/capabilities.ts", "src/client/reason-text.ts"]) {
      expect(readFileSync(join(pkgDir, rel), "utf8"), rel).toMatch(
        /from "\.\.\/shared\/interface\.ts"/u,
      );
    }
  });
});
