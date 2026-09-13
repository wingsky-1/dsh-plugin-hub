/**
 * dsh-notifier config 域 redact 块 —— 凭据的掩码往返（安全模块）。
 *
 * 为什么单独成文件：这条对称（读出去掩码、写回来按 id 还原）是凭据不掉明文的**唯一**保证，
 * 而它泄漏或毁掉凭据的方式都是静默的——没有这条对称，凭据只有两种结局：明文出到界面与日志，
 * 或被掩码字面量覆盖成 `********` 从此再也发不出去。故两个方向各守一遍。
 *
 * 掩码字面量在测试里独立写出，不从源码导入：设置页把它渲染进 password 输入框并把用户没改动的
 * 值原样提交回来（`src/client/index.tsx` 的 `placeholder: "********"`），两侧一旦不一致，界面
 * 回填的那份就会被当成**新凭据**写进文件。故这里断言的是跨端契约，不是实现细节。
 *
 * 本块是 L1 纯函数块，直引 `impl/redact/index.ts`。
 */
import { describe, expect, it } from "vitest";

import { redactConfig, unmaskChannels } from "../../../src/server/config/impl/redact/index.ts";
import type { NotifyConfig, RawSettingValue } from "../../../src/server/config/impl/model/type.ts";

/** 掩码占位：与设置页共享的契约字面量。 */
const MASK = "********";

/** 两个实例的 bark 频道：id 对齐用例需要「有原值可还原」的第二个实例。`as const` 保住判别键的字面量类型。 */
const BARK_A = {
  type: "bark",
  id: "bark:a",
  baseUrl: "https://api.day.app",
  deviceKey: "key-a",
  name: "A",
  enabled: true,
} as const;
const BARK_B = {
  type: "bark",
  id: "bark:b",
  baseUrl: "https://api.day.app",
  deviceKey: "key-b",
  name: "B",
  enabled: true,
} as const;

/** 完整 webhook 频道：三类密钥字段齐全。 */
const WEBHOOK = {
  type: "webhook",
  id: "webhook:hook",
  url: "https://example.test/hook",
  enabled: true,
  auth: "bearer",
  token: "t-1",
  username: "u-1",
  password: "p-1",
  headerName: "X-Token",
  headerValue: "h-1",
} as const;

/** 裸值：构造存储层里真实可能存在、契约类型却排除掉的形态（如 channels 是字符串）。 */
function bare(value: unknown): RawSettingValue {
  return value as RawSettingValue;
}

/** 取还原后的频道数组；被拒即当场失败（否则断言会落在一个不存在的数组上）。 */
function restoredOf(
  patch: RawSettingValue,
  existing?: RawSettingValue,
): Array<Record<string, RawSettingValue>> {
  const result = unmaskChannels(patch, existing);
  if (!result.ok) throw new Error(`期望还原成功，实际被拒：${JSON.stringify(patch)}`);
  return result.channels as Array<Record<string, RawSettingValue>>;
}

describe("redactConfig：读出口只出掩码", () => {
  it("密钥字段换成掩码占位，非密钥字段保持明文（把用户名或头名一起掩掉，设置页就看不清自己填过什么）", () => {
    const masked = redactConfig({ channels: [BARK_A, WEBHOOK] });
    const [bark, webhook] = masked.channels ?? [];
    if (bark?.type !== "bark" || webhook?.type !== "webhook") throw new Error("夹具形状不对");

    expect(bark.deviceKey).toBe(MASK);
    expect(bark.name).toBe("A");
    expect(webhook.token).toBe(MASK);
    expect(webhook.password).toBe(MASK);
    expect(webhook.headerValue).toBe(MASK);
    expect(webhook.username).toBe("u-1");
    expect(webhook.headerName).toBe("X-Token");
    expect(webhook.url).toBe("https://example.test/hook");
  });

  it("原对象不被就地改写（同一份设置在域内还要以明文参与投递）", () => {
    const source = { channels: [{ ...BARK_A }] };
    redactConfig(source);
    expect(source.channels[0].deviceKey).toBe("key-a");
  });

  it("没有 channels 或 channels 不是数组时原样送出、不抛（用户层可能还没有频道；手改过的文件里它可能是字符串）", () => {
    expect(redactConfig({ notifyAsk: false })).toEqual({ notifyAsk: false });
    const broken = { channels: "oops" } as unknown as Partial<NotifyConfig>;
    expect(redactConfig(broken).channels).toBe("oops");
  });

  it("陌生频道类型原样送出、不抛（读出口报错时，用户看到的是设置页整页 500，而原因指向不了那个频道）", () => {
    const unknown = { type: "future", id: "future:a", note: "本版本不认识的频道" };
    // 存储层不受契约约束，构造这个形状必须绕过类型（这正是读出口要兜住的那一侧）。
    const stored = { channels: [unknown] } as unknown as Partial<NotifyConfig>;
    expect(redactConfig(stored).channels?.[0]).toEqual(unknown);
  });

  it("非对象项原样送出且不抛：字符串 / null / 数组都可能躺在存储层里（同一个对象守卫的两侧出口，读面原样送出、写面原样通过）", () => {
    for (const item of ["not-a-channel", null, []]) {
      const stored = { channels: [item] } as unknown as Partial<NotifyConfig>;
      expect(redactConfig(stored).channels?.[0], JSON.stringify(item)).toEqual(item);
      expect(restoredOf([bare(item)], []), JSON.stringify(item)).toEqual([item]);
    }
  });

  it("只掩字符串：非字符串值不是凭据，掩掉它等于把一个坏值换成另一个坏值（原文还在域内参与投递，改了就送不出去）", () => {
    const stored = { channels: [{ ...WEBHOOK, token: 42 }] } as unknown as Partial<NotifyConfig>;
    const channel = redactConfig(stored).channels?.[0];
    if (channel?.type !== "webhook") throw new Error("夹具形状不对");
    expect(channel.token).toBe(42);
  });
});

describe("unmaskChannels：写入口按 id 还原", () => {
  it("按 id 对齐而不是按下标（数组顺序一变，按下标就会把 A 的凭据回填进 B）", () => {
    const restored = restoredOf(
      [
        { ...BARK_B, deviceKey: MASK },
        { ...BARK_A, deviceKey: MASK },
      ],
      [BARK_A, BARK_B],
    );
    expect(restored[0].deviceKey).toBe("key-b");
    expect(restored[1].deviceKey).toBe("key-a");
  });

  it("只还原带了掩码的字段：同一次提交里新填的凭据照原样通过（用户就是要换掉旧值）", () => {
    const restored = restoredOf([{ ...BARK_A, deviceKey: "key-new" }], [BARK_A]);
    expect(restored[0].deviceKey).toBe("key-new");
  });

  it("没有密钥字段的提交整项原样通过（改个显示名不该被还原逻辑拦住）", () => {
    const restored = restoredOf([{ id: "bark:a", type: "bark", name: "改名" }], [BARK_A]);
    expect(restored[0]).toEqual({ id: "bark:a", type: "bark", name: "改名" });
    expect(restoredOf(["not-a-channel"], [BARK_A])[0]).toBe("not-a-channel");
  });

  it("掩码只能表达「未修改」：没有原值可还原的掩码一律被拒（否则等于凭空造出一个凭据）", () => {
    const rows: ReadonlyArray<readonly [RawSettingValue, RawSettingValue | undefined]> = [
      [[{ ...BARK_A, id: "bark:new", deviceKey: MASK }], [BARK_A]],
      [[{ ...BARK_A, deviceKey: MASK }], [{ id: "bark:a", type: "bark", name: "无密钥字段" }]],
      [[{ ...BARK_A, deviceKey: MASK }], undefined],
      [[{ ...BARK_A, id: 42, deviceKey: MASK }], [BARK_A]],
      // 空 id 与数字 id 都不是对齐键：不能与存储里同样「没写 id」「写了数字 id」的项对上，
      // 否则会把 A 的凭据回填进 B。
      [[{ ...BARK_A, id: "", deviceKey: MASK }], [{ id: "", type: "bark", deviceKey: "key-x" }]],
      [[{ ...BARK_A, id: 42, deviceKey: MASK }], [{ id: 42, type: "bark", deviceKey: "key-42" }]],
    ];
    for (const [patch, existing] of rows) {
      expect(unmaskChannels(patch, existing), JSON.stringify(patch)).toEqual({ ok: false });
    }
  });

  it("非数组 channels 给 ok:false 而不是抛（还原跑在校验之前，抛出去就是一次未捕获的写失败）", () => {
    expect(unmaskChannels("oops", [BARK_A])).toEqual({ ok: false });
    expect(unmaskChannels(bare({ id: "bark:a" }), [BARK_A])).toEqual({ ok: false });
  });
});
