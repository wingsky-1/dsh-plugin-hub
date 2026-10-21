// @vitest-environment happy-dom
/**
 * dsh-provider-usage — 胶囊「最后更新」DOM 接线（#1167 评审 P1-3）。
 *
 * 纪律：只用 happy-dom，不触网、不读真实凭据；未绑定 locale 时 t 回落 key 本体，
 * 断言因此与文案文案表解耦（文案本身由 float-view 用例覆盖）。
 */
import { describe, expect, it } from "vitest";
import { appendStaleAgeNote, STALE_AGE_CLASS } from "../../src/client/pill-note.ts";
import type { StatsResponseV2 } from "../../src/client/core.ts";

const stats = (over: Partial<StatsResponseV2> = {}): StatsResponseV2 => ({
  plugin: "dsh-provider-usage",
  version: 2,
  provider: "vendor-a",
  adapterName: "vendor-a-adapter",
  status: "stale",
  ok: false,
  configured: true,
  error: "no-api-key",
  fetchedAt: Date.now(),
  lastSuccessAt: Date.now() - 86_400_000,
  adapterVersion: 1,
  ...over,
});

const labelOf = (): HTMLElement => {
  const el = document.createElement("span");
  el.innerHTML = "<b>余额 ¥36.79</b>";
  return el;
};

describe("pill-note：胶囊最后更新 DOM 接线", () => {
  it("失败带旧值 → 追加标注且保留宿主 capsuleHtml", () => {
    const el = labelOf();
    expect(appendStaleAgeNote(el, stats())).toBe(true);
    expect(el.querySelector("b")?.textContent).toBe("余额 ¥36.79");
    expect(el.querySelector(`.${STALE_AGE_CLASS}`)?.textContent).toBe(" · pillLastSuccess");
  });

  it("无 error / 无 lastSuccessAt / 非法值 → no-op", () => {
    const el = labelOf();
    expect(appendStaleAgeNote(el, stats({ error: null }))).toBe(false);
    expect(appendStaleAgeNote(el, stats({ lastSuccessAt: null }))).toBe(false);
    expect(appendStaleAgeNote(el, stats({ lastSuccessAt: 0 }))).toBe(false);
    expect(el.querySelector(`.${STALE_AGE_CLASS}`)).toBeNull();
  });
});
