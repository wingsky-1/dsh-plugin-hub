// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project。
/**
 * dsh-notifier — 状态原子渲染判据（#769 .tsx 面第三个增量，parts/status.tsx）。
 *
 * 守的事实：一句话——把任一状态映射/类名/按钮接线改坏，对应用例必须红。
 * 假 t 只做可预测回声，中括号包 key 再拼竖线参数，不实现任何真实文案；
 * 时间字面量来自本地 Date 构造（构造与实现同走本地时区，故确定）。
 *
 * 时间纪律：本文件无定时器、无异步等待、无落盘。
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import * as React from "react";

import {
  failBadge,
  padTime,
  statusDotClass,
  statusText,
  testBtn,
} from "../../src/client/settings/parts/status.tsx";

/** 假翻译：可预测回声，不实现任何真实文案。只提供原始事实与记录。 */
function fakeT(key: string, params?: Record<string, unknown>): string {
  let out = "[" + key + "]";
  const entries = Object.entries(params ?? {});
  for (let i = 0; i < entries.length; i++) {
    const kv = entries[i]!;
    out += "|" + kv[0] + "=" + String(kv[1]);
  }
  return out;
}

function htmlOf(node: React.ReactNode): string {
  const result = render(React.createElement(() => node));
  return result.container.innerHTML;
}

/** 本地 03:04:05 的时间戳：构造与实现同走本地时区，字面量确定。 */
function ts030405(): number {
  return new Date(2024, 0, 2, 3, 4, 5).getTime();
}

function ts123045(): number {
  return new Date(2024, 0, 2, 12, 30, 45).getTime();
}

describe("padTime 零填充", () => {
  it("个位数补零：03:04:05", () => {
    expect(padTime(ts030405())).toBe("03:04:05");
  });

  it("两位数不补零：12:30:45", () => {
    expect(padTime(ts123045())).toBe("12:30:45");
  });
});

describe("statusText 状态摘要", () => {
  it("空表回落 chNeverSent", () => {
    expect(statusText("browser", {}, fakeT)).toBe("[chNeverSent]");
  });

  it("有记录但无 lastTs 回落 chNeverSent", () => {
    expect(statusText("browser", { browser: { lastStatus: "ok" } }, fakeT)).toBe("[chNeverSent]");
  });

  it("ok 拼接 chLastOk 与时间", () => {
    expect(
      statusText("browser", { browser: { lastTs: ts030405(), lastStatus: "ok" } }, fakeT),
    ).toBe("[chLastOk] · 03:04:05");
  });

  it("failed 对象理由穿透 params", () => {
    expect(
      statusText(
        "bark",
        {
          bark: {
            lastTs: ts030405(),
            lastStatus: "failed",
            lastError: { code: "reasonBarkHttp", params: { status: 503 } },
          },
        },
        fakeT,
      ),
    ).toBe("[chLastFail] · 03:04:05：[reasonBarkHttp]|status=503");
  });

  it("failed 散文理由原样拼接", () => {
    expect(
      statusText(
        "bark",
        { bark: { lastTs: ts030405(), lastStatus: "failed", lastError: "网关超时" } },
        fakeT,
      ),
    ).toBe("[chLastFail] · 03:04:05：网关超时");
  });

  it("failed 无可读理由回落 reasonUnknown", () => {
    expect(statusText("bark", { bark: { lastTs: ts030405(), lastStatus: "failed" } }, fakeT)).toBe(
      "[chLastFail] · 03:04:05：[reasonUnknown]",
    );
  });
});

describe("statusDotClass 状态点", () => {
  it("空表返回空串", () => {
    expect(statusDotClass("browser", {})).toBe("");
  });

  it("无 lastTs 返回空串", () => {
    expect(statusDotClass("browser", { browser: { lastStatus: "ok" } })).toBe("");
  });

  it("ok 映射 ok", () => {
    expect(statusDotClass("browser", { browser: { lastTs: ts030405(), lastStatus: "ok" } })).toBe(
      "ok",
    );
  });

  it("failed 映射 fail", () => {
    expect(statusDotClass("bark", { bark: { lastTs: ts030405(), lastStatus: "failed" } })).toBe(
      "fail",
    );
  });

  it("非 ok 非 failed 仍映射 fail", () => {
    expect(
      statusDotClass("system", { system: { lastTs: ts030405(), lastStatus: "skipped" } }),
    ).toBe("fail");
  });
});

describe("testBtn 测试按钮", () => {
  it("渲染 type 与类名与文案", () => {
    const html = htmlOf(testBtn("browser", () => {}, fakeT));
    expect(html).toContain('type="button"');
    expect(html).toContain('class="dn-set-btn dn-set-btnSmall"');
    expect(html).toContain("[chTest]");
  });

  it("点击透传 channelId", () => {
    const received: Array<string | undefined> = [];
    function sendTest(id?: string): void {
      received.push(id);
    }
    const result = render(React.createElement(() => testBtn("browser", sendTest, fakeT)));
    const btn = result.container.querySelector("button");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(received).toEqual(["browser"]);
  });

  it("点击透传 undefined", () => {
    const received: Array<string | undefined> = [];
    function sendTest(id?: string): void {
      received.push(id);
    }
    const result = render(React.createElement(() => testBtn(undefined, sendTest, fakeT)));
    const btn = result.container.querySelector("button");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(received).toEqual([undefined]);
  });
});

describe("failBadge 失败徽标", () => {
  it("无记录返回 null", () => {
    expect(failBadge("browser", {}, fakeT)).toBeNull();
  });

  it("ok 返回 null", () => {
    expect(
      failBadge("browser", { browser: { lastTs: ts030405(), lastStatus: "ok" } }, fakeT),
    ).toBeNull();
  });

  it("failed 但无时间返回 null", () => {
    expect(failBadge("bark", { bark: { lastStatus: "failed" } }, fakeT)).toBeNull();
  });

  it("failed 有时间渲染徽标类名与文案", () => {
    const html = htmlOf(
      failBadge("bark", { bark: { lastTs: ts030405(), lastStatus: "failed" } }, fakeT),
    );
    expect(html).toContain('class="dn-ch-failBadge"');
    expect(html).toContain("[chLastFail] · 03:04:05");
  });
});
