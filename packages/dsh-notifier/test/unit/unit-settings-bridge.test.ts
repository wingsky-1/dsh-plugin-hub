
/**
 * dsh-notifier — unit：settings-bridge 工厂直测（L1 层内直测补盲）。
 *
 * 覆盖 createSettingsBridge 工厂直测：attach/降级语义与
 * confirmKindToConfig CAS 重试 ≤2（SETTINGS_CONFLICT 重读重试、耗尽 reject、
 * SETTINGS_UNAVAILABLE 直拒）。工厂在包导出面内，但直测本域
 * interface.ts（Node strip-types 原生执行）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeFakeCtx, makeFakeSettings } from "../helpers.ts";
import { createSettingsBridge } from "../../src/config/interface.ts";

type Bridge = ReturnType<typeof createSettingsBridge>;
type FakeSettings = ReturnType<typeof makeFakeSettings>;

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-unit-bridge-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** attach 态桥（fake settings 已 provide）。 */
function attachBridge(configFile: string): { bridge: Bridge; fakeSettings: FakeSettings } {
  const fakeSettings = makeFakeSettings({ base: {} });
  const { ctx } = makeFakeCtx({});
  ctx.provide("settings", fakeSettings.service);
  const bridge = createSettingsBridge(ctx, { configFile: join(work, configFile) });
  return { bridge, fakeSettings };
}

describe("attach 态——readUser/writable 生效 + confirmKindToConfig 写 allowKinds", () => {
  let bridge: Bridge;

  beforeEach(() => {
    bridge = attachBridge("a.json").bridge;
  });

  it("attach 态 writable=true", () => {
    expect(bridge.isWritable()).toBe(true);
  });

  it("attach 态 user 初始为空", () => {
    expect(bridge.readUser().user).toEqual({});
  });

  it("attach 态 revision 可读", () => {
    expect(bridge.readUser().revision).toBe(0);
  });

  it("确认写入 allowKinds", async () => {
    await bridge.confirmKindToConfig("ext:alpha", true);
    const after = bridge.readUser().user as { allowKinds?: string[] };
    expect(Array.isArray(after.allowKinds) && after.allowKinds.includes("ext:alpha")).toBeTruthy();
  });

  it("撤销确认从 allowKinds 删除", async () => {
    await bridge.confirmKindToConfig("ext:alpha", true);
    await bridge.confirmKindToConfig("ext:alpha", false);
    const revoked = bridge.readUser().user as { allowKinds?: string[] };
    expect((revoked.allowKinds ?? []).includes("ext:alpha")).toBe(false);
  });
});

describe("CAS 冲突重试 ≤2——首次冲突重读后成功", () => {
  let bridge: Bridge;
  let fakeSettings: FakeSettings;
  let conflictCalls: number;

  beforeEach(async () => {
    const attached = attachBridge("b.json");
    bridge = attached.bridge;
    fakeSettings = attached.fakeSettings;
    const origUpdate = fakeSettings.service.update;
    let conflictOnce = true;
    conflictCalls = 0;
    fakeSettings.service.update = async (ns, patch, expectedRevision) => {
      if (conflictOnce) {
        conflictOnce = false;
        conflictCalls += 1;
        throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
      }
      return origUpdate(ns, patch, expectedRevision);
    };
    await bridge.confirmKindToConfig("ext:beta", true);
  });

  it("第一次 update 触发 SETTINGS_CONFLICT", () => {
    expect(conflictCalls).toBe(1);
  });

  it("冲突后重读重试并成功写入", () => {
    const calls = fakeSettings.getUpdateCalls().filter((c) => c.via === "service");
    expect(calls.length >= 1).toBe(true);
  });

  it("重试成功后确认态落盘", () => {
    const persisted = bridge.readUser().user as { allowKinds?: string[] };
    expect((persisted.allowKinds ?? []).includes("ext:beta")).toBe(true);
  });
});

describe("CAS 冲突耗尽（恒冲突）→ reject SETTINGS_CONFLICT（尝试 = 1 + 重试上限 2）", () => {
  let conflictCalls: number;
  let rejected: { code?: string } | null;

  beforeEach(async () => {
    const { bridge, fakeSettings } = attachBridge("c.json");
    conflictCalls = 0;
    rejected = null;
    fakeSettings.service.update = async () => {
      conflictCalls += 1;
      throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
    };
    try {
      await bridge.confirmKindToConfig("ext:gamma", true);
    } catch (err) {
      rejected = err as { code?: string };
    }
  });

  it("冲突耗尽后 reject SETTINGS_CONFLICT", () => {
    expect(rejected?.code).toBe("SETTINGS_CONFLICT");
  });

  it("CAS 尝试 = 首次 + 重试 ≤2 = 3 次后放弃", () => {
    expect(conflictCalls).toBe(3);
  });
});

describe("未 attach（settings 服务缺失）→ 降级语义", () => {
  let bridge: Bridge;

  beforeEach(() => {
    const { ctx } = makeFakeCtx({}); // 未 provide settings
    bridge = createSettingsBridge(ctx, { configFile: join(work, "d.json") });
  });

  it("未 attach writable=false（降级）", () => {
    expect(bridge.isWritable()).toBe(false);
  });

  it("未 attach readUser 降级 {user:{},revision:undefined}", () => {
    expect(bridge.readUser()).toEqual({ user: {}, revision: undefined });
  });

  it("未 attach update 直拒 SETTINGS_UNAVAILABLE", async () => {
    let rejected: { code?: string } | null = null;
    try {
      await bridge.updateConfig({ maxConnections: 8 });
    } catch (err) {
      rejected = err as { code?: string };
    }
    expect(rejected?.code).toBe("SETTINGS_UNAVAILABLE");
  });
});

describe("entry 归一化（getCurrent/getSource 反映组合层配置）", () => {
  let bridge: Bridge;

  beforeEach(() => {
    const { ctx } = makeFakeCtx({});
    bridge = createSettingsBridge(ctx, { maxConnections: 99, notifyTurnEnd: true });
  });

  it("entry 归一化进 current", () => {
    expect(bridge.getCurrent().maxConnections).toBe(99);
  });

  it("entry 布尔键透传", () => {
    expect(bridge.getCurrent().notifyTurnEnd).toBe(true);
  });

  it("getSource 同源形态", () => {
    expect(bridge.getSource().maxConnections).toBe(99);
  });
});
