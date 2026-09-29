/**
 * dsh-notifier — 投递明细的产物外壳与打包不变量（#782 批 1）。
 *
 * 为什么这些判据只能在这里守：断言对象是**可发布的形态**，不是 src 本身——`src/client/settings/**`
 * 的源码文本（历史条目真的挂上了 deliveryLines、渲染体输出明细类名）、`lib/client.js` 的产物内容
 * （明细渲染真的被打进包里），以及 in-place esbuild 的**打包不变量**。
 *
 * 打包不变量为什么必须留在这里：esbuild 默认 platform 是浏览器，若哪天有人把
 * `../server/shared/reason.ts` 的 **type-only** 引用改成值引用、而那个模块又引了 node 内置，
 * 这一步会**直接打包失败**，而不是等到浏览器里炸。
 *
 * 理由文案、读侧宽容性与跨端一致性（服务端每个 code 都有客户端文案）的判据已搬到
 * test/client-unit/ 直连源码：原先把它们建在 esbuild 产物副本上，静态导入图里没有目标模块，
 * perTest 覆盖分析据此把 `src/client/reason-text.ts` 判成零覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";
import { assertClientSourceContract } from "../../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/reason-text.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});

describe("产物契约：逐出口明细真的被渲染出来（判据 7 的判据面）", () => {
  // 本包此前没有任何 lib/client.js 契约断言。这里补上外壳契约（load id 等于包名等），
  // 再把「历史条目渲染逐出口明细」这条钉成可判红的判据——它是 skipped / failed 唯一的可见落点。
  it("客户端产物外壳契约（load id = 包名、IIFE 外壳、use strict）", () => {
    assertClientSourceContract(pkgDir);
  });

  // 纯函数的判据不能证明「界面真的挂了它」：删掉 historyPane 里那一行调用，纯函数用例照样全绿。
  // 故这里对源码形态与产物形态各判一次，三者互补（调用点 / 渲染体 / 构建是否真的带上了它）。
  it("历史条目挂上了 deliveryLines（源码契约：删掉这行调用即判红）+ 渲染体输出明细类名", () => {
    // 调用点随 history pane 搬到 settings/panes/history.tsx，渲染体在 settings/parts/rows.tsx：
    // 两处各读各的文件，判据强度不变——调用点被删或渲染体类名被改写，各自判红。
    const src = readFileSync(join(pkgDir, "src/client/settings/panes/history.tsx"), "utf8");
    expect(src).toMatch(/\{deliveryLines\(r, t\)\}/u);
    const rows = readFileSync(join(pkgDir, "src/client/settings/parts/rows.tsx"), "utf8");
    expect(rows).toMatch(/className=\{"dn-ch-delivery dn-ch-delivery-" \+ view\.status\}/u);
  });

  // 构建面：源码有而产物没有，说明那个模块没被打进 client.js（判据 7 会在用户侧归零）。
  // 断言的是 JS 侧的字符串拼接形态，CSS 文本里的 `.dn-ch-delivery` 选择器不会误命中。
  it("产物 client.js 带上了明细渲染（JS 侧拼接字面量存在，排除只剩 CSS 选择器的情况）", () => {
    const code = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
    expect(code).toContain("dn-ch-delivery dn-ch-delivery-");
    expect(code).toContain("dn-set-historyChannels");
  });
});

describe("跨端形态：客户端模块自带实现，不夹带服务端代码", () => {
  // 跨端只共用**类型**；这条断言把「运行时只有一份实现」变成可判红的判据，而不是口头约定。
  it("打包产物里没有服务端模块的痕迹（node 内置与服务端标识符都不出现）", () => {
    const code = bundle.outputFiles[0]!.text;
    for (const marker of ["node:fs", "node:child_process", "node:module", "truncateCodePoints"]) {
      expect(code, `产物夹带了 ${marker}`).not.toContain(marker);
    }
  });
});
