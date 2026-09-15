/**
 * dsh-notifier — 凭据掩码编辑语义的判据（#769 阶段 0）。
 *
 * 要锁的不是「函数返回值对不对」，而是**掩码永远不会作为可编辑字面量进入输入框**：旧实现把
 * 服务端掩码直接渲染成 value，用户在圆点后追加一个字符就得到「掩码+新字符」，提交时不再等于
 * 掩码，服务端把它当新凭据落盘（redact 的还原判据是严格相等）。
 */
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_MASK_PLACEHOLDER,
  credentialFieldKey,
  credentialFieldView,
  isCredentialConfigured,
  maskedFieldValue,
} from "../../src/client/settings/mask.ts";

const MASK_FROM_SERVER = "********";

describe("凭据字段：已配置判定", () => {
  it("服务端掩码与非空新值都算已配置", () => {
    expect(isCredentialConfigured(MASK_FROM_SERVER)).toBe(true);
    expect(isCredentialConfigured("device-key-abc")).toBe(true);
  });

  it("缺失与空串都算未配置（读面把空串剥成缺键）", () => {
    expect(isCredentialConfigured(undefined)).toBe(false);
    expect(isCredentialConfigured(null)).toBe(false);
    expect(isCredentialConfigured("")).toBe(false);
    expect(isCredentialConfigured(42)).toBe(false);
  });
});

describe("凭据字段：渲染值", () => {
  it("未编辑时渲染空值——掩码不得成为可编辑字面量", () => {
    expect(maskedFieldValue(MASK_FROM_SERVER, false)).toBe("");
    expect(maskedFieldValue("device-key-abc", false)).toBe("");
  });

  it("编辑后渲染草稿值（含用户清空的情形）", () => {
    expect(maskedFieldValue("new-key", true)).toBe("new-key");
    expect(maskedFieldValue("", true)).toBe("");
  });

  it("已配置且未编辑时：值空、占位为掩码提示（用户不会打在掩码上）", () => {
    const view = credentialFieldView(MASK_FROM_SERVER, false, "访问令牌");
    expect(view).toEqual({
      value: "",
      placeholder: CREDENTIAL_MASK_PLACEHOLDER,
      configured: true,
    });
  });

  it("未配置时：值空、占位回落到字段自己的说明", () => {
    expect(credentialFieldView(undefined, false, "访问令牌")).toEqual({
      value: "",
      placeholder: "访问令牌",
      configured: false,
    });
  });

  it("编辑后：值取草稿、占位仍按已配置与否决定", () => {
    expect(credentialFieldView(MASK_FROM_SERVER, true, "访问令牌")).toEqual({
      value: MASK_FROM_SERVER,
      placeholder: CREDENTIAL_MASK_PLACEHOLDER,
      configured: true,
    });
    expect(credentialFieldView("", true, "访问令牌").value).toBe("");
  });

  it("瞬态键按频道与字段区分：同名字段在不同实例上互不串味", () => {
    expect(credentialFieldKey("bark-1", "deviceKey")).toBe("bark-1:deviceKey");
    expect(credentialFieldKey("bark-1", "deviceKey")).not.toBe(
      credentialFieldKey("bark-2", "deviceKey"),
    );
    expect(credentialFieldKey("wh-1", "token")).not.toBe(credentialFieldKey("wh-1", "password"));
  });

  it("占位提示不承载真实凭据值，也不等于服务端掩码字面量", () => {
    expect(CREDENTIAL_MASK_PLACEHOLDER).not.toBe(MASK_FROM_SERVER);
    // 精确值锚：空串能通过上面的 not.toBe（它不等于任何非空掩码），却让「已配置」的提示整体
    // 消失，用户看不出这一格已经有值。占位形态要改就在这条判据里显式改。
    expect(CREDENTIAL_MASK_PLACEHOLDER).toBe("••••••••");
  });
});
