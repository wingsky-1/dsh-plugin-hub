/**
 * dsh-notifier src/shared —— 理由 code 闭集的直连判据。
 *
 * 这次收口的起因：客户端有一份 `const LEGACY_CODE = "reasonLegacy"`，注释自述「与服务端
 * REASON_LEGACY 同值」，而没有任何断言锁住两者相等——改一边就是一个读不出来的历史行。
 * 收口后两端消费同一个绑定，「同值」由构造保证；本文件再把值、成员与「客户端不再有第二份
 * 字面量」钉成可判红的判据。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REASON_CODES, REASON_LEGACY } from "../../../src/shared/interface.ts";

const pkgDir = fileURLToPath(new URL("../../../", import.meta.url));

describe("REASON_LEGACY", () => {
  it("字面量与表内位置都钉住（旧散文的收编 code 只有一个）", () => {
    expect(REASON_LEGACY).toBe("reasonLegacy");
    expect(REASON_CODES[0]).toBe(REASON_LEGACY);
    expect(REASON_CODES).toContain(REASON_LEGACY);
  });
});

describe("REASON_CODES", () => {
  it("成员与顺序逐项钉住（新增 code 必须显式落在这张表上）", () => {
    expect([...REASON_CODES]).toEqual([
      "reasonLegacy",
      "reasonSkipConfig",
      "reasonSkipEnvironment",
      "reasonSystemPopupFailed",
      "reasonSystemSoundFailed",
      "reasonSystemToastScriptMissing",
      "reasonSystemToneUnwritable",
      "reasonBarkRequestFailed",
      "reasonBarkHttp",
      "reasonBarkRejected",
      "reasonBarkBodyUnreadable",
      "reasonWebhookTemplateInvalid",
      "reasonWebhookRequestFailed",
      "reasonWebhookHttp",
      "reasonUnknownTarget",
      "reasonChannelThrew",
      "reasonThrottled",
    ]);
  });

  // 重复项不改变联合类型，却会让客户端的穷尽表看起来更全：漏一条文案仍能编译过。
  it("无重复项", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });
});

describe("单点化：客户端不再抄一份同值字面量", () => {
  const clientSrc = () => readFileSync(join(pkgDir, "src/client/reason-text.ts"), "utf8");

  // 这一段只留「有没有 / 多没多」的最小结构锚，**不留计数**。为什么：本文件从 import.meta.url
  // 推导包目录去读盘，变异沙箱内读到的是被变异体包装过的同一份文件，于是「出现几次」这类断言
  // 锁的是环境而不是行为——CI 上它曾以 expected 5 to be 3 直接把该变异段的 dry run 判死。
  // 「客户端不再有第二份字面量」这件事无法用行为表达（两份字面量同值时行为完全一致），故只能
  // 靠结构锚；而 reasonLegacy 的行为判据在 test/client-unit/reason-text.test.ts 里（喂带 detail
  // 与不带 detail 两种输入，断主文案与 detail 去重），不在这里重复一遍。
  it("客户端引用共享绑定，LEGACY_CODE 已不存在", () => {
    const src = clientSrc();
    expect(src).not.toMatch(/LEGACY_CODE/u);
    expect(src).toContain("REASON_LEGACY");
    expect(src).toContain('from "../shared/interface.ts"');
  });

  it("客户端引用的是共享面而不是宿主实现（类型面同理）", () => {
    const src = clientSrc();
    expect(src).not.toContain("../server/");
    // 类型面必须仍是 import type：值引会把宿主实现拖进浏览器产物
    expect(src).toMatch(/import type \{[^}]*ReasonCode[^}]*\} from "\.\.\/shared\/interface\.ts"/u);
  });
});

describe("宿主实现侧：code 闭集是转出而不是第二份声明", () => {
  it("src/server/shared/reason.ts 只保留值函数与转出", () => {
    const src = readFileSync(join(pkgDir, "src/server/shared/reason.ts"), "utf8");
    expect(src).not.toMatch(/export const REASON_LEGACY/u);
    expect(src).not.toMatch(/export const REASON_CODES/u);
    expect(src).toMatch(/export \{ REASON_CODES, REASON_LEGACY \};/u);
    // 值函数仍在（它们依赖 ./text.ts，进不了零 import 的共享面）
    for (const fn of [
      "export function reason(",
      "export function reasonFromCause(",
      "export function normalizeReason(",
      "export function sameReasonShape(",
      "export function clampReasonDetail<",
    ]) {
      expect(src, fn).toContain(fn);
    }
  });
});
