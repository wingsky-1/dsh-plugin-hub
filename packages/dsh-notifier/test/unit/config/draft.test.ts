/**
 * dsh-notifier config 域 draft 块 —— 草稿测试（dry-run）的输入闸门（提案 B1/B2）。
 *
 * 判据面：只认 draft.channels（顶层其它键与 revision 忽略）；逐项 validateChannel 但跳过
 * requireBuiltinsPresent（单条草稿不带内置也放行）；掩码按 id 还原（新频道无源 / 改名带掩码
 * → NEW_CHANNEL_MASK_HINT）；还原后残留掩码字面量（跨 type）整体拒绝。本块是 L1 纯函数块，
 * 直引 impl/draft/index.ts；掩码字面量独立写出（与 redact.test.ts 同一跨端契约）。
 */
import { describe, expect, it } from "vitest";

import { resolveDraftChannels } from "../../../src/server/config/impl/draft/index.ts";
import type { RawSettingValue } from "../../../src/server/config/impl/model/type.ts";

/** 掩码占位：与设置页共享的契约字面量（独立抄写，见 redact.test.ts 模块头）。 */
const MASK = "********";

/** 已存 bark 频道（还原原值来源）。 */
const STORED_BARK = {
  type: "bark",
  id: "bark-1",
  baseUrl: "https://api.day.app",
  deviceKey: "real-key",
  enabled: true,
};

/** 已存 webhook 频道。 */
const STORED_WEBHOOK = {
  type: "webhook",
  id: "webhook-1",
  url: "https://example.test/hook",
  auth: "bearer",
  token: "real-token",
  enabled: true,
};

function secretsOf(...channels: unknown[]): readonly RawSettingValue[] {
  return channels as readonly RawSettingValue[];
}

function hintOf(draft: unknown, secrets?: readonly RawSettingValue[]): string {
  const resolved = resolveDraftChannels(draft, secrets);
  if (resolved.ok) throw new Error("期望拒绝，实际通过");
  return resolved.hint;
}

describe("resolveDraftChannels：只认 channels（B1）", () => {
  it("顶层其它键与 revision 一律忽略：channels 合法即通过且原样带回", () => {
    const resolved = resolveDraftChannels(
      { channels: [STORED_BARK], revision: 99, kindRoutes: { test: ["x"] }, unknown: 1 },
      secretsOf(STORED_BARK),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.channels).toEqual([STORED_BARK]);
  });
  it("无掩码的新频道在无原值时也通过（fresh install 非掩码不拒）", () => {
    const fresh = {
      type: "bark",
      id: "bark-fresh",
      baseUrl: "https://api.day.app",
      deviceKey: "fresh-real-key",
      enabled: false,
    };
    const resolved = resolveDraftChannels({ channels: [fresh] }, undefined);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.channels).toEqual([fresh]);
  });

  it("draft 非对象 / channels 非数组 → 拒绝", () => {
    expect(hintOf(null, [])).toContain("draft 需要对象");
    expect(hintOf({}, [])).toContain("draft.channels 需要数组");
    expect(hintOf({ channels: "bark-1" }, [])).toContain("draft.channels 需要数组");
  });

  it("逐项校验：单条非法即整体拒绝（bark 缺 deviceKey）", () => {
    const bad = { type: "bark", id: "bark-1", baseUrl: "https://api.day.app", enabled: true };
    expect(hintOf({ channels: [bad] }, [])).toContain("缺少 deviceKey");
  });

  it("跳过 requireBuiltinsPresent：单条实例草稿不带内置也放行", () => {
    const resolved = resolveDraftChannels({ channels: [STORED_BARK] }, secretsOf(STORED_BARK));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.channels).toHaveLength(1);
  });
});

describe("resolveDraftChannels：掩码往返（B2）", () => {
  it("掩码按 id 还原：提交掩码即换回已存真凭据", () => {
    const draft = {
      type: "bark",
      id: "bark-1",
      baseUrl: "https://api.day.app",
      deviceKey: MASK,
      enabled: true,
    };
    const resolved = resolveDraftChannels({ channels: [draft] }, secretsOf(STORED_BARK));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.channels[0]).toMatchObject({ deviceKey: "real-key" });
    }
  });

  it("新频道无源带掩码 → NEW_CHANNEL_MASK_HINT 拒绝", () => {
    const draft = {
      type: "bark",
      id: "bark-new",
      baseUrl: "https://api.day.app",
      deviceKey: MASK,
      enabled: false,
    };
    expect(hintOf({ channels: [draft] }, secretsOf(STORED_BARK))).toContain(
      "新增频道不能提交掩码占位",
    );
  });

  it("id 改名带掩码同样拒绝：原值按 id 对齐，改名即无源", () => {
    const draft = {
      type: "bark",
      id: "bark-renamed",
      baseUrl: "https://api.day.app",
      deviceKey: MASK,
      enabled: true,
    };
    expect(hintOf({ channels: [draft] }, secretsOf(STORED_BARK))).toContain(
      "新增频道不能提交掩码占位",
    );
  });

  it("跨 type 残留掩码 → 整体拒绝（bark→webhook 残留 deviceKey 掩码）", () => {
    const draft = {
      type: "webhook",
      id: "webhook-1",
      url: "https://example.test/hook",
      auth: "none",
      deviceKey: MASK,
      enabled: true,
    };
    expect(hintOf({ channels: [draft] }, secretsOf(STORED_WEBHOOK))).toContain("未还原的掩码占位");
  });

  it("无原值来源时任何掩码都拒绝（fresh install 也 fail-closed）", () => {
    const draft = {
      type: "webhook",
      id: "webhook-1",
      url: "https://example.test/hook",
      auth: "bearer",
      token: MASK,
      enabled: true,
    };
    expect(hintOf({ channels: [draft] }, undefined)).toContain("新增频道不能提交掩码占位");
  });
});
