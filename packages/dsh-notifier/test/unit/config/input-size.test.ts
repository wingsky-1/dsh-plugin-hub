/**
 * dsh-notifier config input shared 上界尺寸判据自然块。
 */
import { describe, expect, it } from "vitest";

import {
  validateSettings,
  validateSettingsWithMerge,
} from "../../../src/server/config/impl/input/index.ts";
import { BARK_LEVELS_LIMIT, WEBHOOK_TEMPLATE_MAX_CHARS } from "../../../src/shared/interface.ts";
import { BARK, WEBHOOK, withBuiltins } from "./input-input-support.ts";

describe("尺寸判据：分界线落在 shared 的上界上（#1016 第二事实源收口）", () => {
  it("webhook template：恰好等于共享上界放行，多一字符 400 且话术点名共享上界", () => {
    // `auth` 必带且要合法，否则这条会先栽在取值域判据上——那不是本块要判的那一条。
    const atLimit = validateSettings({
      channels: withBuiltins([
        { ...WEBHOOK, auth: "none", template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS) },
      ]),
    });
    expect(atLimit.ok).toBe(true);

    const verdict = validateSettings({
      channels: withBuiltins([
        { ...WEBHOOK, auth: "none", template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS + 1) },
      ]),
    });
    expect(verdict.ok).toBe(false);
    // 话术里的上界取自共享值：写面若忘了跟上共享 schema（或反过来自己另抄一份），这条打红。
    expect(verdict.ok ? "" : verdict.error.hint).toContain(String(WEBHOOK_TEMPLATE_MAX_CHARS));
  });

  it("bark levels：恰好等于共享上界放行，多一项 400 且话术点名共享上界", () => {
    const atLimit = Object.fromEntries(
      Array.from({ length: BARK_LEVELS_LIMIT }, (_unused, index) => [`kind-${index}`, "active"]),
    );
    expect(validateSettings({ channels: withBuiltins([{ ...BARK, levels: atLimit }]) }).ok).toBe(
      true,
    );

    const verdict = validateSettings({
      channels: withBuiltins([{ ...BARK, levels: { ...atLimit, "kind-extra": "active" } }]),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.error.hint).toContain(String(BARK_LEVELS_LIMIT));
  });

  // 「拒新增、不动存量」在判据这一侧的那一笔账：不带 inherited 时每个键都算本次提交，故上面两条
  // 越界的值必拒。带上 inherited 把这两个字段标成沿用存量，它们就不再重判值域——同一份越界值，
  // 判定的分叉只由「这次动没动过」决定，与尺寸上界从哪读无关。
  it("inherited 面把这两个字段标成沿用存量后，同一份越界值不再重判（双轨在判据这一侧）", () => {
    const outbound = [
      { ...WEBHOOK, auth: "none", template: "x".repeat(WEBHOOK_TEMPLATE_MAX_CHARS + 1) },
      { ...BARK, id: "bark:pad", levels: { "kind-extra": "active" } },
    ];
    const channels = withBuiltins(outbound);
    const merged = {
      channels,
      // 前两条是内置（无尺寸判据），第三条 webhook、第四条 bark 各自认一个 inherited 字段。
      inherited: [new Set<string>(), new Set<string>(), new Set(["template"]), new Set(["levels"])],
    };
    expect(validateSettingsWithMerge({ channels }, merged).ok).toBe(true);
  });
});
