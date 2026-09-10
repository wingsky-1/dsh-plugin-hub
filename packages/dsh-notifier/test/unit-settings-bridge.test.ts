// @ts-nocheck
/**
 * dsh-notifier — unit：settings-bridge 工厂直测（L1 层内，S3-29 补盲）。
 *
 * 覆盖 N-5（requirements §7.3）：createSettingsBridge 的 attach/降级语义与
 * confirmKindToConfig CAS 重试 ≤2（SETTINGS_CONFLICT 重读重试、耗尽 reject、
 * SETTINGS_UNAVAILABLE 直拒）。工厂在包导出面内，但按 §11.2-1 纪律直测本域
 * interface.ts（Node strip-types 原生执行）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, makeFakeCtx, makeFakeSettings } from "./helpers.ts";
import { createSettingsBridge } from "../src/config/interface.ts";

const work = mkdtempSync(join(tmpdir(), "dnotify-unit-bridge-"));
try {
  // ── N-5a：attach 态——readUser/writable 生效 + confirmKindToConfig 写 allowKinds ──
  {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "a.json") });
    assert.equal(bridge.isWritable(), true, "attach 态 writable=true");
    const before = bridge.readUser();
    assert.deepEqual(before.user, {}, "attach 态 user 初始为空");
    assert.equal(before.revision, 0, "attach 态 revision 可读");
    await bridge.confirmKindToConfig("ext:alpha", true);
    const after = bridge.readUser().user;
    assert.ok(Array.isArray(after.allowKinds) && after.allowKinds.includes("ext:alpha"), "确认写入 allowKinds");
    await bridge.confirmKindToConfig("ext:alpha", false);
    assert.ok(!bridge.readUser().user.allowKinds.includes("ext:alpha"), "撤销确认从 allowKinds 删除");
  }

  // ── N-5b：CAS 冲突重试 ≤2——首次冲突重读后成功 ──
  {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "b.json") });
    const origUpdate = fakeSettings.service.update;
    let conflictOnce = true;
    let conflictCalls = 0;
    fakeSettings.service.update = async (ns, patch, expectedRevision) => {
      if (conflictOnce) {
        conflictOnce = false;
        conflictCalls += 1;
        throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
      }
      return origUpdate(ns, patch, expectedRevision);
    };
    await bridge.confirmKindToConfig("ext:beta", true);
    const calls = fakeSettings.getUpdateCalls().filter((c) => c.via === "service");
    assert.equal(conflictCalls, 1, "第一次 update 触发 SETTINGS_CONFLICT");
    assert.ok(calls.length >= 1, `冲突后重读重试并成功写入（成功 update ${calls.length} 次）`);
    assert.ok(bridge.readUser().user.allowKinds.includes("ext:beta"), "重试成功后确认态落盘");
  }

  // ── N-5c：CAS 冲突耗尽（恒冲突）→ reject SETTINGS_CONFLICT（尝试 = 1 + 重试上限 2）──
  {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "c.json") });
    let conflictCalls = 0;
    fakeSettings.service.update = async () => {
      conflictCalls += 1;
      throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
    };
    let rejected = null;
    try {
      await bridge.confirmKindToConfig("ext:gamma", true);
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected && rejected.code === "SETTINGS_CONFLICT", "冲突耗尽后 reject SETTINGS_CONFLICT");
    assert.equal(conflictCalls, 3, "CAS 尝试 = 首次 + 重试 ≤2 = 3 次后放弃");
  }

  // ── N-5d：未 attach（settings 服务缺失）→ 降级语义 ──
  {
    const { ctx } = makeFakeCtx({}); // 未 provide settings
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "d.json") });
    assert.equal(bridge.isWritable(), false, "未 attach writable=false（降级）");
    assert.deepEqual(bridge.readUser(), { user: {}, revision: undefined }, "未 attach readUser 降级 {user:{},revision:undefined}");
    let rejected = null;
    try {
      await bridge.updateConfig({ maxConnections: 8 });
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected && rejected.code === "SETTINGS_UNAVAILABLE", "未 attach update 直拒 SETTINGS_UNAVAILABLE");
  }

  // ── N-5e：entry 归一化（getCurrent/getSource 反映组合层配置）──
  {
    const { ctx } = makeFakeCtx({});
    const bridge = createSettingsBridge(ctx, { maxConnections: 99, notifyTurnEnd: true });
    assert.equal(bridge.getCurrent().maxConnections, 99, "entry 归一化进 current");
    assert.equal(bridge.getCurrent().notifyTurnEnd, true, "entry 布尔键透传");
    assert.equal(bridge.getSource().maxConnections, 99, "getSource 同源形态");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
