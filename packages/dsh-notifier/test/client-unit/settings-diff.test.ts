/**
 * dsh-notifier — 设置草稿纯逻辑的判据（#769 阶段 1）。
 *
 * 这些函数决定「保存什么」：提交哪些键、什么时候整组带走 channels、清空输入写 null 还是删键。
 * 它们此前住在 index.tsx 内（node 无法导入），因此没有任何行为判据——本文件把每条语义钉住，
 * 尤其是那些「看起来等价、实际不是」的分支：删键与写 null（#1016 S2 之后这两条路通向完全不同的
 * 必填键不参与空串剥除、未知保存入口 fail-closed、键序无关（#912，stableEqual）。
 */
import { describe, expect, it } from "vitest";

import {
  assignChannelFields,
  diffSettingsPayload,
  domainPayload,
  rebaseSettings,
  stripChannelEmpties,
} from "../../src/client/settings/diff.ts";

describe("diffSettingsPayload：只提交真正变了的键", () => {
  it("基线为 null 时一律空 patch（没有基线就没有可比的差异）", () => {
    expect(diffSettingsPayload({ a: 1 }, null)).toEqual({});
  });

  it("未变更的键不进 patch", () => {
    expect(diffSettingsPayload({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual({});
  });

  it("值不同的键进 patch；基线里没有的新增键同样进 patch", () => {
    expect(diffSettingsPayload({ a: 1, b: "y", c: true }, { a: 1, b: "x" })).toEqual({
      b: "y",
      c: true,
    });
  });

  it("基线里有、草稿里没有的键不提交删除（增量 merge patch 无删除语义）", () => {
    // 否则「删掉一个键」会被误表成一次写入，而服务端按 merge 语义只会保留旧值
    expect(diffSettingsPayload({ a: 1 }, { a: 1, gone: "old" })).toEqual({});
  });

  // #912 改为键序无关（参照服务端 stableJson 递归排序）：Object.assign 浅拷贝与合并处的键序
  // 取决于写路径（load/discard/rebase/putAndCommit 各不相同），与用户是否改过东西无关。
  it("相等判定走 stableEqual：同名键序不同视为未变（#912，旧“视为已变”判据随语义退役）", () => {
    expect(diffSettingsPayload({ o: { x: 1, y: 2 } }, { o: { y: 2, x: 1 } })).toEqual({});
  });

  it("只认自有键（原型链上的属性不参与 diff）", () => {
    const draft = Object.create({ inherited: "from-proto" }) as Record<string, unknown>;
    draft.own = "v";
    expect(diffSettingsPayload(draft, {})).toEqual({ own: "v" });
  });
});

describe("channels 空串剥除：读面 normalize 的写面对偶", () => {
  it("草稿里空串的可选字段先剥除再比：与基线同形时不算变更（400 死锁的修复本身）", () => {
    const draft = { channels: [{ id: "bark-1", type: "bark", baseUrl: "https://x", token: "" }] };
    const base = { channels: [{ id: "bark-1", type: "bark", baseUrl: "https://x" }] };
    expect(diffSettingsPayload(draft, base)).toEqual({});
  });

  it("剥除后确实不同则整组提交，且提交里的实例已不含空串残留", () => {
    const draft = { channels: [{ id: "b", type: "bark", token: "", name: "改过" }] };
    const base = { channels: [{ id: "b", type: "bark", name: "旧" }] };
    expect(diffSettingsPayload(draft, base)).toEqual({
      channels: [{ id: "b", type: "bark", name: "改过" }],
    });
  });

  it("url 在剥除清单内（bark 的可选端点覆写）；空串被剥掉而不是原样提交", () => {
    expect(stripChannelEmpties({ id: "b", type: "bark", url: "" })).toEqual({
      id: "b",
      type: "bark",
    });
  });

  // 判据 #1 的客户端一半（服务端那一半在 test/unit/config/service.test.ts）：清空走的是**显式
  // 删除**手势。服务端按字段合并后「键缺席 = 不动」，删键会让磁盘上的旧 url 留在原地——
  // 而用户清空它就是要删掉它。null 是这条手势在线上的形态。
  it("清空 webhook 的 url：提交的是 `url: null`（显式删除）而不是空串、更不是删键", () => {
    const edited = assignChannelFields(
      { id: "w", type: "webhook", url: "https://x", auth: "none" },
      { url: "" },
    );
    expect(edited).toEqual({ id: "w", type: "webhook", url: null, auth: "none" });
    // diff 侧的剥除只处理空串，null 原样带走（它不是空串，也不是键缺席）。
    const submitted = diffSettingsPayload(
      { channels: [edited] },
      { channels: [{ id: "w", type: "webhook", url: "https://x", auth: "none" }] },
    );
    expect(submitted).toEqual({
      channels: [{ id: "w", type: "webhook", url: null, auth: "none" }],
    });
  });

  it("id/type/auth 不在剥除清单内：空串原样提交给服务端拦", () => {
    expect(stripChannelEmpties({ id: "", type: "", auth: "" })).toEqual({
      id: "",
      type: "",
      auth: "",
    });
  });

  // baseUrl / deviceKey **在**剥除清单内（#1016 P2-1）：它们是**另一种频道类型**里的可选字段，清单跨类型
  // 取并集。剥掉之后键缺席，落进写面 preexisting 的放行路径——半坏条目不再让每一次保存都 400。
  //
  // 改坏方向（把它们移出清单）：客户端把空串原样交上去 → 写面判「删必填键」→ 400，用户改别的频道都存不下。
  it("baseUrl/deviceKey 的空串被剥成键缺席（跨类型并集：webhook 那边它们是投递必需键）", () => {
    expect(stripChannelEmpties({ id: "b", type: "bark", baseUrl: "", deviceKey: "" })).toEqual({
      id: "b",
      type: "bark",
    });
    // 比较规范形同源：两侧都剥，空串与缺席不再被算成「用户改过」（首屏恒脏的一处来源）。
    expect(
      diffSettingsPayload(
        { channels: [{ id: "b", type: "bark", baseUrl: "" }] },
        { channels: [{ id: "b", type: "bark" }] },
      ),
    ).toEqual({});
  });

  it("非 string 字段不剥除：number/boolean/对象即便“空”也照原样参与比较", () => {
    const draft = {
      channels: [{ id: "b", type: "bark", badge: 0, enabled: false, levels: {} }],
    };
    const base = { channels: [{ id: "b", type: "bark" }] };
    expect(diffSettingsPayload(draft, base)).toEqual({
      channels: [{ id: "b", type: "bark", badge: 0, enabled: false, levels: {} }],
    });
  });

  it("非对象条目原样穿过（防御 null/数组/标量，不抛也不改）", () => {
    expect(stripChannelEmpties(null)).toBeNull();
    expect(stripChannelEmpties([1])).toEqual([1]);
    expect(stripChannelEmpties("s")).toBe("s");
    expect(stripChannelEmpties(undefined)).toBeUndefined();
  });

  it("剥除返回浅拷贝：不改入参对象", () => {
    const input = { id: "b", token: "" };
    const out = stripChannelEmpties(input);
    expect(input).toEqual({ id: "b", token: "" });
    expect(out).toEqual({ id: "b" });
  });

  it("非 channels 键不做剥除（剥除只对 channels 生效）", () => {
    expect(diffSettingsPayload({ quietHours: { start: "" } }, {})).toEqual({
      quietHours: { start: "" },
    });
  });
});

describe("domainPayload：域保存只交该域的键，未知入口 fail-closed", () => {
  it("all 原样返回（含空对象）", () => {
    const diff = { channels: [], notifyAsk: true };
    expect(domainPayload(diff, "all")).toBe(diff);
    const empty = {};
    expect(domainPayload(empty, "all")).toBe(empty);
  });

  it("channels 只保留 channels 键：事件域的草稿不随频道域保存一起提交", () => {
    expect(domainPayload({ channels: [1], notifyAsk: true }, "channels")).toEqual({
      channels: [1],
    });
  });

  it("channels 域没有脏时返回空对象（而不是 undefined 或全量）", () => {
    expect(domainPayload({ notifyAsk: true }, "channels")).toEqual({});
  });

  it("未知入口返回空对象（写错枚举只会少提交，不会多提交）", () => {
    expect(domainPayload({ channels: [1] }, "everything")).toEqual({});
    expect(domainPayload({ channels: [1] }, "")).toEqual({});
  });
});

describe("assignChannelFields：空串与 undefined 写成 null（显式删除），其余浅覆盖", () => {
  it("空串写 null：删键会被服务端读成「不动」，旧凭据留在磁盘上继续投递（#1016 安全修复）", () => {
    expect(assignChannelFields({ id: "b", token: "old" }, { token: "" })).toEqual({
      id: "b",
      token: null,
    });
  });

  it("undefined 写 null：数字/下拉清空走同一条路（「这个字段不要了」是同一个手势）", () => {
    expect(assignChannelFields({ id: "b", badge: 3 }, { badge: undefined })).toEqual({
      id: "b",
      badge: null,
    });
  });

  it("null 原样写入（本函数不再对它做任何转换）", () => {
    expect(assignChannelFields({ id: "b" }, { level: null })).toEqual({ id: "b", level: null });
    expect(assignChannelFields({ id: "b", level: "active" }, { level: null })).toEqual({
      id: "b",
      level: null,
    });
  });

  it("0 / false / 空对象照常写入（假值不等于未配置）", () => {
    expect(assignChannelFields({}, { badge: 0, enabled: false, levels: {} })).toEqual({
      badge: 0,
      enabled: false,
      levels: {},
    });
  });

  it("返回新对象，不改 target", () => {
    const target = { id: "b", token: "old" };
    const out = assignChannelFields(target, { token: "new" });
    expect(target).toEqual({ id: "b", token: "old" });
    expect(out).toEqual({ id: "b", token: "new" });
  });

  it("part 为空时等价于浅拷贝", () => {
    expect(assignChannelFields({ a: 1 }, {})).toEqual({ a: 1 });
  });
});

describe("rebaseSettings：以服务端最新为基底、本地变更键覆盖", () => {
  it("本地变更键胜出，远端其它键保留", () => {
    expect(
      rebaseSettings({ notifyAsk: false }, { notifyAsk: true, quietHours: { enabled: 1 } }),
    ).toEqual({ notifyAsk: false, quietHours: { enabled: 1 } });
  });

  it("本地无变更时等于远端快照的浅拷贝，且不改远端对象", () => {
    const remote = { a: 1 };
    const out = rebaseSettings({}, remote);
    expect(out).toEqual({ a: 1 });
    expect(out).not.toBe(remote);
  });
});
