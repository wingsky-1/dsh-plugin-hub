/**
 * dsh-notifier config input validateSettingsWithMerge 自然块。
 */
import { describe, expect, it } from "vitest";

import {
  validateSettings,
  validateSettingsWithMerge,
} from "../../../src/server/config/impl/input/index.ts";
import type { RawSettingValue } from "../../../src/server/config/impl/model/type.ts";
import { BARK, BUILTINS, WEBHOOK, withBuiltins } from "./input-input-support.ts";

describe("validateSettingsWithMerge：判据对象是合并后的条目（#1016 S2）", () => {
  /** 一条 webhook 的合并结果 + 它的 inherited 清单 + 两条内置（内置在场是形状判据，别让它盖住要断的那条）。 */
  function webhookMerge(extra: Record<string, RawSettingValue>, inherited: string[]) {
    const entry = { ...WEBHOOK, auth: "none", ...extra };
    return {
      channels: [...BUILTINS, entry] as RawSettingValue[],
      inherited: [new Set<string>(), new Set<string>(), new Set(inherited)],
    };
  }

  // 「不动存量」的方向：磁盘上那份 9000 字符的 template 原样带回来，不重新判它超没超上限。
  it("inherited 里的字段不重判值域：存量越界值不因一次无关保存被拒", () => {
    const long = { template: "x".repeat(9000) };
    // 不带 inherited（= 草稿路径的老行为）：照样 400——本次提交就要为这个值负责。
    const bare = validateSettingsWithMerge({ channels: webhookMerge(long, []).channels });
    expect(bare.ok).toBe(false);
    expect(bare.ok ? "" : bare.error.hint).toContain("template");
    // 声明它沿用存量：放行。
    const kept = validateSettingsWithMerge(
      { channels: webhookMerge(long, []).channels },
      webhookMerge(long, ["template"]),
    );
    expect(kept.ok).toBe(true);
  });

  // 同一个字段、同样的值，只要**本次真的改了**它（不在 inherited 里）就重新判——
  // 「不动存量」不是「不看值」。
  it("同一个越界值不在 inherited 里时照样 400（不动存量 ≠ 不看值）", () => {
    const long = { template: "x".repeat(9000) };
    const checked = validateSettingsWithMerge(
      { channels: webhookMerge(long, []).channels },
      webhookMerge(long, []),
    );
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error.hint).toContain("template");
  });

  // 陌生键同理：存量条目上已有的陌生键由合并沿用，不该被一次无关保存追责；本次新交的拒。
  it("inherited 里的陌生键放行：存量条目上那个键一次无关保存不追责", () => {
    const extra = { myCustom: "kept" };
    const kept = validateSettingsWithMerge(
      { channels: webhookMerge(extra, []).channels },
      webhookMerge(extra, ["myCustom"]),
    );
    expect(kept.ok).toBe(true);
    // 不在 inherited 里 = 本次新交的：400。
    const fresh = validateSettingsWithMerge(
      { channels: webhookMerge(extra, []).channels },
      webhookMerge(extra, []),
    );
    expect(fresh.ok).toBe(false);
    expect(fresh.ok ? "" : fresh.error.hint).toContain("myCustom");
  });

  // 形状判据不让：必填键在合并后为空一律 400，哪怕那条键沿用自存量。
  it("形状判据不看 inherited：必填键在合并结果里为空就 400", () => {
    const entry = { type: "bark", id: "bark:1", baseUrl: "", deviceKey: "" };
    const checked = validateSettingsWithMerge(
      { channels: [...BUILTINS, entry] as RawSettingValue[] },
      {
        channels: [...BUILTINS, entry],
        inherited: [new Set<string>(), new Set<string>(), new Set(["baseUrl", "deviceKey"])],
      },
    );
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error.hint).toContain("baseUrl");
  });

  // 两条入口的**结论**逐字相同：合并面多收的那张 inherited 清单一个字都没多判，判定与不带它
  // 时完全一致（合法与非法都试）。这正是「删掉 scope 面之后仍是同一套判据」的证据面。
  it("多收 inherited 清单不改变判定结论：合法与非法都试", () => {
    const cases = [
      { channels: [{ ...BARK, name: "手机" }] },
      { channels: [{ ...BARK, level: "urgent" }] },
      { historyMaxAgeDays: -1 },
    ];
    for (const patch of cases) {
      const label = JSON.stringify(patch);
      // 不给 merged：退回「按草稿判」的旧行为。
      expect(validateSettingsWithMerge(patch), label).toEqual(validateSettings(patch));
      // 真实写面交的那一份：合并结果与草稿**同形**、inherited 全空（每个键都算本次提交）。
      // 两侧审的必须是同一份内容，否则比的不是「多收一张清单有没有多判」。
      const channels = (patch.channels ?? []) as RawSettingValue[];
      const sameShape = { channels, inherited: channels.map(() => new Set<string>()) };
      expect(validateSettingsWithMerge({ ...patch, channels }, sameShape), label).toEqual(
        validateSettings(patch),
      );
    }
  });

  // 提交体里带 null（客户端「显式删除」手势的线上形态）在**判据**这一侧由合并先消费掉。
  // 直调判据时它落进条目：必填键与陌生键都读得出拒绝，而**已知可选键**上的 null 判据不拦——
  // 那一格的责任在合并（它把 null 变成删键），判据不必也不该替它再判一遍。
  it("条目里带 null：必填键与陌生键都拒；已知可选键交给合并消费", () => {
    const required = validateSettings({ channels: withBuiltins([{ ...WEBHOOK, url: null }]) });
    expect(required.ok).toBe(false);
    expect(required.ok ? "" : required.error.hint).toContain("缺少 url");

    const unknown = validateSettings({ channels: withBuiltins([{ ...BARK, myCustom: null }]) });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.error.hint).toContain("myCustom");

    // 已知可选键上的 null：判据放行不是漏洞——写面上它早在合并那一步就被删掉了，
    // 落盘的是「键不存在」而不是 null。
    expect(validateSettings({ channels: withBuiltins([{ ...BARK, group: null }]) }).ok).toBe(true);
  });
});
// ---------------------------------------------------------------- 尺寸上界的事实源

/**
 * 尺寸判据的上界来自 src/shared/config-schema.ts（两端共享面），本块断言**分界线正好落在那个数上**。
 *
 * 为什么值得单列一块（service.test.ts 已经从写面端到端判过同一件事）：那边判的是「存量的越界值
 * 放行、本次改的越界值 400」这条**双轨**，夹具只需落在上界的某一侧；一旦 impl/input 里重新长出
 * 一个与共享值不同的就地字面量，双轨的两侧可能**同时**判对而整条分界线已经挪了——两侧恰好都落在
 * 上界的同一侧时看不出来。故这里把边界钉死在共享值上：
 *   - 就地字面量比共享值**小** → 「恰好等于共享值」本该放行却被打红；
 *   - 就地字面量比共享值**大** → 「共享值 +1」本该打红却被放行。
 * 两个方向都打红，故这块抓的是「写面与共享面各说一个上界」而不是只抓一半。
 *
 * 上界取自共享值本身而不是抄一份数字：上界一改，判据跟着改，判的仍是「分界线落在共享值上」这条语义。
 */
