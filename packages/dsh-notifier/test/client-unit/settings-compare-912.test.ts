/**
 * dsh-notifier — #912 症状3的比较回归集（对称化 + 键序无关 + 快照规范化）。
 *
 * 与 settings-diff.test.ts 的分工：那边钉“保存什么”的既有语义（本文件不动它的判据，
 * 只改了一条随 #912 退役的键序期望）；这里钉 #912 新增的语义——双侧同一规范形、
 * stableEqual 键序无关、snapshotBaseline 生命周期。离线、无凭据（掩码用字面量占位）。
 */
import { describe, expect, it } from "vitest";

import {
  canonicalSettingsForCompare,
  diffSettingsPayload,
  normalizeChannelForCompare,
  snapshotBaseline,
  stableEqual,
  stableJsonValue,
} from "../../src/client/settings/diff.ts";

describe("stableEqual/stableJsonValue：键序无关、数组保序", () => {
  it("嵌套对象键序不同视为未变（深层同样递归排序）", () => {
    expect(
      stableEqual({ a: { x: 1, y: [1, { p: 1, q: 2 }] } }, { a: { y: [1, { q: 2, p: 1 }], x: 1 } }),
    ).toBe(true);
  });

  it("数组顺序不同视为已变（频道顺序是内容的一部分）", () => {
    expect(stableEqual({ channels: [1, 2] }, { channels: [2, 1] })).toBe(false);
  });

  it("stableJsonValue 直测：递归排序、对象内 undefined 键丢弃、数组内记 null", () => {
    expect(stableJsonValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableJsonValue({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableJsonValue([undefined])).toBe("[null]");
    expect(stableJsonValue(undefined)).toBe("undefined");
  });

  it("undefined 与缺键同判（基线缺键读出 undefined、草稿显式写 undefined 是同一回事）", () => {
    expect(stableEqual({ a: undefined }, {})).toBe(true);
    expect(stableEqual([undefined], [null])).toBe(true);
  });

  it("标量与 null 按 JSON 语义比较", () => {
    expect(stableEqual(0, 0)).toBe(true);
    expect(stableEqual(0, "0")).toBe(false);
    expect(stableEqual(null, null)).toBe(true);
    expect(stableEqual(null, {})).toBe(false);
  });

  it("diff 里顶层对象键序打乱不脏（putAndCommit 与 rebase 的合并键序各不相同）", () => {
    const draft = { notifyAsk: true, quietHours: { enabled: false, start: "22:00" } };
    const base = { quietHours: { start: "22:00", enabled: false }, notifyAsk: true };
    expect(diffSettingsPayload(draft, base)).toEqual({});
  });
});

describe("normalizeChannelForCompare：双侧同一规范形", () => {
  it("反向 strip：base 侧残留空串、draft 侧缺键时不脏（旧单侧剥除的反例）", () => {
    const draft = { channels: [{ id: "bark-1", type: "bark", baseUrl: "https://x" }] };
    const base = { channels: [{ id: "bark-1", type: "bark", baseUrl: "https://x", token: "" }] };
    expect(diffSettingsPayload(draft, base)).toEqual({});
    expect(diffSettingsPayload(base, draft)).toEqual({});
  });

  it("levels 缺席与空对象同形（双向，bark 只补 bark 域）", () => {
    const bare = { id: "b", type: "bark", baseUrl: "https://x", deviceKey: "k" };
    // 按类型补：bark 只补 levels/timeoutMs，不把 webhook 的 headers/timeoutSec/preset/auth
    // 塞进提交形态（全量补会让 validateExtras 以对象值 400，见 normalize 注释）。
    expect(normalizeChannelForCompare(bare)).toEqual({
      ...bare,
      levels: {},
      timeoutMs: 0,
    });
    expect(
      diffSettingsPayload({ channels: [bare] }, { channels: [{ ...bare, levels: {} }] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, levels: {} }] }, { channels: [bare] }),
    ).toEqual({});
  });

  it("非空 levels 的真删除仍脏（双向，补齐不洗删除）", () => {
    const full = { id: "b", type: "bark", levels: { done: "active" } };
    const gone = { id: "b", type: "bark" };
    expect(diffSettingsPayload({ channels: [gone] }, { channels: [full] })).toEqual({
      channels: [gone],
    });
    expect(diffSettingsPayload({ channels: [full] }, { channels: [gone] })).toEqual({
      channels: [full],
    });
  });

  it("timeout 缺席与 0 同形（双向）；非 0 保留且不等", () => {
    const bare = { id: "b", type: "bark" };
    expect(
      diffSettingsPayload({ channels: [bare] }, { channels: [{ ...bare, timeoutMs: 0 }] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, timeoutMs: 0 }] }, { channels: [bare] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, timeoutMs: 10 }] }, { channels: [bare] }),
    ).toEqual({ channels: [{ ...bare, timeoutMs: 10 }] });
    const wbare = { id: "w", type: "webhook", url: "https://x", auth: "none" };
    expect(
      diffSettingsPayload({ channels: [wbare] }, { channels: [{ ...wbare, timeoutSec: 0 }] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...wbare, timeoutSec: 0 }] }, { channels: [wbare] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...wbare, timeoutSec: 10 }] }, { channels: [wbare] }),
    ).toEqual({ channels: [{ ...wbare, timeoutSec: 10 }] });
  });

  it("headers 缺席与空对象同形（双向）；非空保留", () => {
    const bare = { id: "w", type: "webhook", url: "https://x", auth: "none" };
    expect(
      diffSettingsPayload({ channels: [bare] }, { channels: [{ ...bare, headers: {} }] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, headers: {} }] }, { channels: [bare] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, headers: { x: "y" } }] }, { channels: [bare] }),
    ).toEqual({ channels: [{ ...bare, headers: { x: "y" } }] });
  });

  it("preset 缺席与 custom 同形（双向）；非默认保留", () => {
    const bare = { id: "w", type: "webhook", url: "https://x", auth: "none" };
    expect(
      diffSettingsPayload({ channels: [bare] }, { channels: [{ ...bare, preset: "custom" }] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, preset: "custom" }] }, { channels: [bare] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, preset: "gotify" }] }, { channels: [bare] }),
    ).toEqual({ channels: [{ ...bare, preset: "gotify" }] });
  });

  it("auth 缺席与 none 同形（双向）；bearer 保留；auth 空串保留不剥（由服务端 400）", () => {
    const bare = { id: "w", type: "webhook", url: "https://x" };
    expect(
      diffSettingsPayload({ channels: [bare] }, { channels: [{ ...bare, auth: "none" }] }),
    ).toEqual({});
    expect(
      diffSettingsPayload({ channels: [{ ...bare, auth: "bearer" }] }, { channels: [bare] }),
    ).toEqual({ channels: [{ ...bare, auth: "bearer" }] });
    expect(normalizeChannelForCompare({ ...bare, auth: "" })).toEqual({
      ...bare,
      auth: "",
      headers: {},
      timeoutSec: 0,
      preset: "custom",
    });
  });

  it("id/type/baseUrl/deviceKey 空串保留（必填，比较不替校验断案；未知类型不补）", () => {
    // type "" 不是 bark/webhook：不补任何域默认值，否则未知条目会被洗出跨域键。
    expect(normalizeChannelForCompare({ id: "", type: "", baseUrl: "", deviceKey: "" })).toEqual({
      id: "",
      type: "",
      baseUrl: "",
      deviceKey: "",
    });
  });

  it("按类型补：bark 不带 webhook 域、webhook 不带 bark 域、内置不补", () => {
    expect(normalizeChannelForCompare({ id: "b", type: "bark" })).toEqual({
      id: "b",
      type: "bark",
      levels: {},
      timeoutMs: 0,
    });
    expect(normalizeChannelForCompare({ id: "w", type: "webhook", url: "https://x" })).toEqual({
      id: "w",
      type: "webhook",
      url: "https://x",
      headers: {},
      timeoutSec: 0,
      preset: "custom",
      auth: "none",
    });
    expect(normalizeChannelForCompare({ id: "browser", type: "browser" })).toEqual({
      id: "browser",
      type: "browser",
    });
    // system 同属内置：不补任何域默认值
    expect(normalizeChannelForCompare({ id: "system", type: "system" })).toEqual({
      id: "system",
      type: "system",
    });
    // 未知类型：不补（跨域键会污染提交形态，见 normalize 注释）
    expect(normalizeChannelForCompare({ id: "u", type: "nope" })).toEqual({
      id: "u",
      type: "nope",
    });
    // 数组输入原样透传（防御分支：strip 与 normalize 双层守卫）
    const arr = [{ id: "b" }];
    expect(normalizeChannelForCompare(arr)).toBe(arr);
  });

  it("快照草稿编辑的提交形态不带跨域键（#912 回归：全量补曾让 bark 带 headers 空对象被 400）", () => {
    const base = snapshotBaseline({
      channels: [{ type: "bark", id: "b", enabled: true, baseUrl: "https://x", deviceKey: "k" }],
    });
    const draft = snapshotBaseline({
      channels: [
        { type: "bark", id: "b", enabled: true, baseUrl: "https://x", deviceKey: "k", name: "new" },
      ],
    });
    const payload = diffSettingsPayload(draft, base) as { channels: Record<string, unknown>[] };
    expect(payload.channels).toHaveLength(1);
    expect(payload.channels[0]).not.toHaveProperty("headers");
    expect(payload.channels[0]).not.toHaveProperty("timeoutSec");
    expect(payload.channels[0]).not.toHaveProperty("preset");
    expect(payload.channels[0]).not.toHaveProperty("auth");
  });

  it("掩码相等即未改、携带新值即脏（掩码语义在比较侧不断）", () => {
    const masked = { id: "b", type: "bark", baseUrl: "https://x", deviceKey: "********" };
    expect(diffSettingsPayload({ channels: [masked] }, { channels: [masked] })).toEqual({});
    expect(
      diffSettingsPayload(
        { channels: [{ ...masked, deviceKey: "new-key" }] },
        { channels: [masked] },
      ),
    ).toEqual({ channels: [{ ...masked, deviceKey: "new-key" }] });
  });

  it("非对象输入原样返回，且不改入参对象", () => {
    expect(normalizeChannelForCompare(null)).toBeNull();
    expect(normalizeChannelForCompare("s")).toBe("s");
    const input = { id: "b", token: "" };
    const out = normalizeChannelForCompare(input);
    expect(input).toEqual({ id: "b", token: "" });
    expect(out).not.toBe(input);
  });
});

describe("snapshotBaseline 生命周期：load 空/discard 空/save 合并空/重拉一致", () => {
  const serverChannel = {
    type: "bark",
    id: "b",
    enabled: true,
    name: "旧",
    baseUrl: "https://x",
    deviceKey: "********",
    group: "",
    sound: "",
    icon: "",
    url: "",
    timeoutMs: 0,
    levels: {},
  };

  it("load 空：空 effective 快照后与空草稿无差异", () => {
    const base = snapshotBaseline({});
    expect(diffSettingsPayload(snapshotBaseline({}), base)).toEqual({});
  });

  it("首屏：同一 effective 的两次快照互相干净（含键序打乱）", () => {
    const raw = { notifyAsk: true, channels: [serverChannel] };
    const shuffled = { channels: [serverChannel], notifyAsk: true };
    expect(diffSettingsPayload(snapshotBaseline(raw), snapshotBaseline(shuffled))).toEqual({});
  });

  it("discard 空：基线快照回写草稿后无差异", () => {
    const base = snapshotBaseline({ notifyAsk: true, channels: [serverChannel] });
    const restored = snapshotBaseline(base);
    expect(diffSettingsPayload(restored, base)).toEqual({});
  });

  it("save 合并空：payload 并入基线再快照后，与提交后草稿无差异", () => {
    const base = snapshotBaseline({ notifyAsk: true, channels: [serverChannel] });
    const draft = snapshotBaseline({ notifyAsk: false, channels: [serverChannel] });
    const payload = diffSettingsPayload(draft, base);
    expect(payload).toEqual({ notifyAsk: false });
    const merged = snapshotBaseline(Object.assign({}, base, payload));
    expect(diffSettingsPayload(draft, merged)).toEqual({});
  });

  it("putAndCommit 只并入 payload 键：在途新编辑（非 payload 键）仍在 diff 中", () => {
    const base = snapshotBaseline({ notifyAsk: true, channels: [serverChannel] });
    const payload = { notifyAsk: false };
    const merged = snapshotBaseline(Object.assign({}, base, payload));
    const draftWithInflight = Object.assign({}, snapshotBaseline({ notifyAsk: false }), {
      channels: [serverChannel],
      notifyTurnEnd: true,
    });
    expect(diffSettingsPayload(draftWithInflight, merged)).toEqual({ notifyTurnEnd: true });
  });

  it("快照纯读：不变更入参对象（含 channels 数组引用）", () => {
    const input = { notifyAsk: true, channels: [{ id: "b", type: "bark" }] };
    const before = JSON.parse(JSON.stringify(input)) as unknown;
    const snap = snapshotBaseline(input);
    expect(input).toEqual(before);
    expect(snap).not.toBe(input);
    expect(snap.channels).not.toBe(input.channels);
  });

  it("快照缺 channels 时不补键、空数组保持（只收敛既有形态）", () => {
    expect(snapshotBaseline({ notifyAsk: true })).toEqual({ notifyAsk: true });
    expect(snapshotBaseline({ channels: [] })).toEqual({ channels: [] });
  });

  it("重拉一致：服务端等价形态（残留空串版）快照后与旧基线无差异", () => {
    const base = snapshotBaseline({ channels: [serverChannel] });
    const refetched = snapshotBaseline({
      channels: [{ ...serverChannel, group: "", sound: "", icon: "", url: "" }],
    });
    expect(diffSettingsPayload(refetched, base)).toEqual({});
    expect(canonicalSettingsForCompare({ a: 1 })).toEqual({ a: 1 });
  });
});
