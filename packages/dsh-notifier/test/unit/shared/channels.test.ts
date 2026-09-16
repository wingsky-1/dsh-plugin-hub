/**
 * dsh-notifier src/shared —— 频道对外 id 归一化的直连判据。
 *
 * 这一层是跨端契约的定义处：客户端勾选写进 `kindRoutes` 的字符串与宿主端投递池里的 `channelId`
 * 必须是同一个算法算出来的。故这里不只钉新实现，还把**收口前的两份实现**逐字抄进用例，对一张
 * 输入表机械比对——「语义零变化」因此是判据，而不是目测。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_CHANNELS,
  BUILTIN_CHANNEL_TYPES,
  channelIdFor,
  channelIdOf,
  isBuiltinChannelType,
} from "../../../src/shared/interface.ts";

const pkgDir = fileURLToPath(new URL("../../../", import.meta.url));

/** 收口前宿主端的实现（src/server/pipeline/impl/route/index.ts，逐字抄录）。 */
function hostChannelIdOfBefore(channel: { type: string; id: string }): string {
  return channel.type === "browser" || channel.type === "system"
    ? channel.type
    : `${channel.type}:${channel.id}`;
}

/** 收口前客户端的实现（src/client/index.tsx，逐字抄录）。 */
function clientChannelIdForBefore(cfg: { type?: unknown; id?: unknown }): string {
  return String(cfg.type || "") + ":" + String(cfg.id || "");
}

function clientChannelIdOfBefore(cfg: { type?: unknown; id?: unknown }): string {
  const type = String(cfg.type || "");
  return type === "browser" || type === "system" ? type : clientChannelIdForBefore(cfg);
}

describe("内置频道清单", () => {
  // 客户端「是不是内置频道」的内联判定与宿主端的内置清单此前各写一份；收口后两者同源，
  // 但仍要钉住它们指向同一个集合（`satisfies` 只保证一侧 ⊆ 另一侧）。
  it("类型清单与 id 表的键集双向相等、顺序一致", () => {
    expect([...BUILTIN_CHANNEL_TYPES]).toEqual(["browser", "system"]);
    expect(Object.keys(BUILTIN_CHANNELS)).toEqual([...BUILTIN_CHANNEL_TYPES]);
    expect(new Set(Object.keys(BUILTIN_CHANNELS))).toEqual(new Set(BUILTIN_CHANNEL_TYPES));
    for (const type of BUILTIN_CHANNEL_TYPES) expect(BUILTIN_CHANNELS[type]).toBe(type);
  });

  it("isBuiltinChannelType 只认那两个字面量（大小写、空白、原型键、非字符串一律判否）", () => {
    for (const type of BUILTIN_CHANNEL_TYPES) expect(isBuiltinChannelType(type), type).toBe(true);
    for (const value of [
      "bark",
      "webhook",
      "",
      "Browser",
      " browser",
      "system ",
      "toString",
      42,
      true,
      null,
      undefined,
      {},
      [],
    ]) {
      expect(isBuiltinChannelType(value), String(value)).toBe(false);
    }
  });
});

describe("channelIdOf：语义零变化", () => {
  // 宿主端可达输入（ChannelConfig 的 type 恒是非空字符串字面量）：新旧实现必须逐字一致。
  it("宿主端可达输入上与收口前的宿主实现逐字一致", () => {
    const channels: ReadonlyArray<{ type: string; id: string }> = [
      { type: "browser", id: "browser" },
      { type: "system", id: "system" },
      { type: "bark", id: "phone" },
      { type: "webhook", id: "w" },
      { type: "bark", id: "a:b" },
      { type: "webhook", id: "" },
    ];
    for (const channel of channels) {
      expect(channelIdOf(channel), JSON.stringify(channel)).toBe(hostChannelIdOfBefore(channel));
    }
  });

  // 任意输入（含脏值：磁盘/HTTP 传来的频道项不受编译期约束）：与收口前的客户端实现逐字一致
  // ——这是共享实现选择 `String(x || "")` 这条更防御性归一的理由（宿主端旧写法在脏值上会产出
  // `undefined:undefined`，而那条路径在宿主端不可达）。
  it("任意输入（含脏值）上与收口前的客户端实现逐字一致", () => {
    const inputs: ReadonlyArray<{ type?: unknown; id?: unknown }> = [
      { type: "browser", id: "browser" },
      { type: "system", id: "system" },
      { type: "bark", id: "phone" },
      { type: "webhook", id: "w" },
      { type: "browser", id: undefined },
      { type: "system" },
      { type: undefined, id: undefined },
      {},
      { type: "", id: "" },
      { type: null, id: null },
      { type: 0, id: 0 },
      { type: false, id: false },
      { id: "x" },
    ];
    for (const cfg of inputs) {
      expect(channelIdOf(cfg), JSON.stringify(cfg)).toBe(clientChannelIdOfBefore(cfg));
      expect(channelIdFor(cfg), JSON.stringify(cfg)).toBe(clientChannelIdForBefore(cfg));
    }
  });

  it("规则本身：内置取裸 type、实例取 type:id，两个集合不相交", () => {
    expect(channelIdOf({ type: "browser", id: "browser" })).toBe("browser");
    expect(channelIdOf({ type: "system", id: "system" })).toBe("system");
    expect(channelIdOf({ type: "bark", id: "phone" })).toBe("bark:phone");
    expect(channelIdOf({ type: "webhook", id: "w" })).toBe("webhook:w");
    for (const type of BUILTIN_CHANNEL_TYPES) {
      const id = channelIdOf({ type, id: type });
      expect(id, type).not.toContain(":");
    }
  });
});

describe("单点化：两端不再各写一份实现", () => {
  const read = (rel: string) => readFileSync(join(pkgDir, rel), "utf8");

  it("客户端消费共享面，不再本地声明 channelIdFor / channelIdOf", () => {
    // 消费点随频道卡搬到 settings/channels/*：逐个扫消费文件（字面量不变）——只判 index.tsx
    // 会让 channelIdFor 那半条判据落空（index.tsx 已不再引用它）。
    for (const rel of [
      "src/client/index.tsx",
      "src/client/settings/channels/builtin-card.tsx",
      "src/client/settings/channels/bark-card.tsx",
      "src/client/settings/channels/webhook-card.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/function channelIdOf/u);
      expect(src, rel).not.toMatch(/function channelIdFor/u);
    }
    const entry = read("src/client/index.tsx");
    expect(entry).toMatch(/channelIdOf,/u);
    expect(entry).toMatch(/from "\.\.\/shared\/interface\.ts"/u);
  });

  it("宿主路由块消费共享面，不再本地声明 id 规则与预设改名表", () => {
    const src = read("src/server/pipeline/impl/route/index.ts");
    expect(src).not.toMatch(/function channelIdOf/u);
    expect(src).not.toMatch(/const BUILTIN_CHANNELS/u);
    expect(src).not.toMatch(/PRESET_MAP/u);
    expect(src).toMatch(/deliveryPresetOf\(/u);
  });

  it("宿主配置闸门消费共享面的内置类型清单", () => {
    const src = read("src/server/config/impl/input/index.ts");
    expect(src).not.toMatch(/const BUILTIN_TYPES/u);
    expect(src).toMatch(/BUILTIN_CHANNEL_TYPES/u);
  });
});
