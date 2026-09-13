/**
 * dsh-notifier — 投递理由的客户端渲染（#782 批 1）。
 *
 * 为什么这些判据只能在这里守：`code` 是服务端与客户端之间**唯一**的文案契约——一边加了 code
 * 而另一边没有对应文案，用户看到的就是一行英文标识符。这是跨端一致性，任何一侧自己的单测都
 * 测不到，故这里把两份清单直接对起来。
 *
 * 其余判据守「读侧宽容但不含糊」：升级前的散文、认不出的 code、手改过的半截值，都不能渲染成
 * `undefined`，也不许被冒充成成功（`skipped` 与 `failed` 都带不出绿色）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";
import { assertClientSourceContract } from "../../../../test/smoke-lib.ts";

import { REASON_CODES } from "../../src/server/shared/reason.ts";
import type { NotifierLocaleKey } from "../../src/client/locales.ts";
import { en, zh } from "../../src/client/locales.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 即时打包 `src/client/reason-text.ts` 再执行（本层既有范式：断言对象是**可发布的形态**，不是
 * 源码直载）。这里顺带拿到一条真正的护栏——esbuild 的默认 platform 是浏览器，若哪天有人把
 * `../server/shared/reason.ts` 的 **type-only** 引用改成值引用、而那个模块又引了 node 内置，
 * 这一步会**直接打包失败**，而不是等到浏览器里炸。
 */
const bundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/reason-text.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
});
const { deliveryViewOf, reasonDetail, reasonText } = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
)) as typeof import("../../src/client/reason-text.ts");

/** 官方向翻译函数的最薄替身：`{name}` 插值 zh 字典（省略的只有 locale 服务的注册面）。 */
function t(k: NotifierLocaleKey, params?: Readonly<Record<string, string | number>>): string {
  return zh[k].replace(/\{(\w+)\}/gu, (match, name: string) =>
    params !== undefined && Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match,
  );
}

describe("产物契约：逐出口明细真的被渲染出来（判据 7 的判据面）", () => {
  // 本包此前没有任何 lib/client.js 契约断言。这里补上外壳契约（load id 等于包名等），
  // 再把「历史条目渲染逐出口明细」这条钉成可判红的判据——它是 skipped / failed 唯一的可见落点。
  it("客户端产物外壳契约（load id = 包名、IIFE 外壳、use strict）", () => {
    assertClientSourceContract(pkgDir);
  });

  // 纯函数的判据不能证明「界面真的挂了它」：删掉 historyPane 里那一行调用，纯函数用例照样全绿。
  // 故这里对源码形态与产物形态各判一次，三者互补（调用点 / 渲染体 / 构建是否真的带上了它）。
  it("历史条目挂上了 deliveryLines（源码契约：删掉这行调用即判红）+ 渲染体输出明细类名", () => {
    const src = readFileSync(join(pkgDir, "src/client/index.tsx"), "utf8");
    expect(src).toMatch(/\{deliveryLines\(r\)\}/u);
    expect(src).toMatch(/className=\{"dn-ch-delivery dn-ch-delivery-" \+ view\.status\}/u);
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

describe("跨端一致性：服务端每个 code 都有客户端文案", () => {
  // 这条是「服务端加 code 而客户端漏配文案」的唯一拦截点：漏了就是用户看到 reasonBarkHttp。
  it("REASON_CODES 的每一项都能在 zh 与 en 里查到文案（且不是回落成 key 本体）", () => {
    for (const code of REASON_CODES) {
      const localeKey = code as NotifierLocaleKey;
      expect(zh[localeKey], `zh 缺 ${code}`).toBeTypeOf("string");
      expect(en[localeKey], `en 缺 ${code}`).toBeTypeOf("string");
      expect(zh[localeKey], `${code} 的 zh 文案回落到 key 本体`).not.toBe(code);
      expect(en[localeKey], `${code} 的 en 文案回落到 key 本体`).not.toBe(code);
    }
  });
});

describe("reasonText：主文案", () => {
  it("结构化理由走字典渲染，参数按 `{name}` 插值（服务端只给数据，文案在客户端）", () => {
    expect(reasonText({ code: "reasonBarkHttp", params: { status: 503 } }, t)).toBe(
      zh.reasonBarkHttp.replace("{status}", "503"),
    );
    expect(reasonText({ code: "reasonSystemPopupFailed", params: { bin: "notify-send" } }, t)).toBe(
      zh.reasonSystemPopupFailed.replace("{bin}", "notify-send"),
    );
  });

  // 升级前的行整句都是原文，它**不是**文案：逐字显示才是诚实的，套一层「记录于升级前」反而
  // 把唯一有信息量的那句盖掉。
  it("reasonLegacy 逐字显示 detail（升级前的整句原文不是文案）", () => {
    expect(reasonText({ code: "reasonLegacy", detail: "bark HTTP 401: bad token" }, t)).toBe(
      "bark HTTP 401: bad token",
    );
    // 原文缺失时才退到字典里那句中性说明
    expect(reasonText({ code: "reasonLegacy" }, t)).toBe(zh.reasonLegacy);
  });

  // 负例：更新版本的插件写下的陌生 code 不该被猜成某句已知文案，也不该渲染成 undefined。
  it("认不出的 code 中性回退：有原文给原文，没有才给 reasonUnknown", () => {
    expect(reasonText({ code: "reasonFromTheFuture", detail: "宿主原话" }, t)).toBe("宿主原话");
    expect(reasonText({ code: "reasonFromTheFuture" }, t)).toBe(zh.reasonUnknown);
  });

  it("读不出形态的值（裸串 / null / 数组 / 空对象）都不渲染成 undefined", () => {
    expect(reasonText("连接超时", t)).toBe("连接超时");
    expect(reasonText(null, t)).toBe(zh.reasonUnknown);
    expect(reasonText([], t)).toBe(zh.reasonUnknown);
    expect(reasonText({}, t)).toBe(zh.reasonUnknown);
    expect(reasonText(undefined, t)).toBe(zh.reasonUnknown);
  });
});

describe("reasonDetail：宿主原文", () => {
  it("结构化理由交出原文，reasonLegacy 不重复展示（它已经是主文案）", () => {
    expect(
      reasonDetail({ code: "reasonWebhookHttp", params: { status: 500 }, detail: "<html>502" }),
    ).toBe("<html>502");
    expect(reasonDetail({ code: "reasonLegacy", detail: "旧的整句" })).toBe("");
    expect(reasonDetail({ code: "reasonSkipConfig" })).toBe("");
    expect(reasonDetail("裸串")).toBe("");
  });
});

describe("deliveryViewOf：历史里一条投递明细的视图", () => {
  it("三种状态各自成行：ok 不带理由，failed / skipped 带主文案", () => {
    expect(deliveryViewOf({ channelId: "browser", status: "ok" }, t)).toEqual({
      channelId: "browser",
      status: "ok",
      statusText: zh.chStatusOk,
      reason: "",
      detail: "",
    });
    expect(
      deliveryViewOf(
        {
          channelId: "system",
          status: "skipped",
          reason: { code: "reasonSkipEnvironment" },
        },
        t,
      ),
    ).toEqual({
      channelId: "system",
      status: "skipped",
      statusText: zh.chStatusSkipped,
      reason: zh.reasonSkipEnvironment,
      detail: "",
    });
    expect(
      deliveryViewOf(
        {
          channelId: "webhook:w",
          status: "failed",
          reason: { code: "reasonWebhookHttp", params: { status: 401 }, detail: "nope" },
        },
        t,
      ),
    ).toEqual({
      channelId: "webhook:w",
      status: "failed",
      statusText: zh.chStatusFailed,
      reason: zh.reasonWebhookHttp.replace("{status}", "401"),
      detail: "nope",
    });
  });

  // 值域外的一律读不出：status 是这一行的判据，交给界面去猜的代价是把一次真失败画成成功。
  it("值域外的明细判读不出：陌生 status、缺 channelId、非对象都不成行", () => {
    expect(deliveryViewOf({ channelId: "x", status: "unknown" }, t)).toBeUndefined();
    expect(deliveryViewOf({ status: "failed" }, t)).toBeUndefined();
    expect(deliveryViewOf({ channelId: "", status: "ok" }, t)).toBeUndefined();
    expect(deliveryViewOf("framing", t)).toBeUndefined();
    expect(deliveryViewOf(null, t)).toBeUndefined();
  });

  // 读不出的理由不该让整行消失：channelId + status 才是如实的那部分。
  it("理由读不出时明细仍在：状态如实，理由回落成中性文案", () => {
    expect(deliveryViewOf({ channelId: "bark:a", status: "failed", reason: 42 }, t)).toEqual({
      channelId: "bark:a",
      status: "failed",
      statusText: zh.chStatusFailed,
      reason: zh.reasonUnknown,
      detail: "",
    });
  });
});
