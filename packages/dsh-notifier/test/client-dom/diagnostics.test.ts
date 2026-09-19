// @vitest-environment happy-dom
//
// 环境声明必须落在文件里，不能只靠 vitest.config.ts 的 client-dom project。
/**
 * dsh-notifier — 诊断原子渲染判据（#769 .tsx 面第五个增量，parts/diagnostics.tsx）。
 *
 * 守的事实：一句话——把任一权限三态、平台映射、诊断投影或类名后缀改坏，对应用例必须红。
 * 假 t 只做可预测回声；诊断视图用手写字面量直投，不从实现 import。
 * Notification 按测试纪律例外用 window/globalThis 手写假对象替换，只带 permission。
 *
 * 时间纪律：本文件无定时器、无异步等待、无落盘。
 */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import * as React from "react";

import type {
  BrowserDiagnosticsView,
  ClientDiagnosticsView,
  HostDiagnosticsView,
} from "../../src/client/capabilities.ts";
import {
  browserDiagnosticsLine,
  browserPermLine,
  hostDiagnosticsBlock,
  systemPlatformHint,
} from "../../src/client/settings/parts/diagnostics.tsx";

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

/** 手写假 Notification：只带 permission，不实现任何通知语义。 */
function installNotification(permission: string): void {
  const fake = { permission };
  const g = globalThis as unknown as Record<string, unknown>;
  const w = window as unknown as Record<string, unknown>;
  g["Notification"] = fake;
  w["Notification"] = fake;
}

function removeNotification(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const w = window as unknown as Record<string, unknown>;
  if ("Notification" in g) delete g["Notification"];
  if ("Notification" in w) delete w["Notification"];
}

afterEach(() => {
  removeNotification();
});

function baseHost(): HostDiagnosticsView {
  return {
    verdict: "ok",
    tone: "ok",
    line: "HOST-LINE",
    unknownLine: "",
    remediationTitle: "REM-TITLE",
    remediationLines: [],
    detailsLabel: "DET-LBL",
    sourceLabel: "HOST-SRC",
    details: [],
  };
}

function baseBrowser(): BrowserDiagnosticsView {
  return { verdict: "ok", tone: "ok", line: "B-LINE", sourceLabel: "B-SRC" };
}

function diagWith(host?: HostDiagnosticsView): ClientDiagnosticsView {
  if (host === undefined) return { browser: baseBrowser() };
  return { host, browser: baseBrowser() };
}

describe("browserPermLine 权限行", () => {
  it("无 Notification API 返回 null", () => {
    removeNotification();
    expect(browserPermLine(fakeT, true, () => {})).toBeNull();
  });

  it("非安全上下文返回 null", () => {
    installNotification("granted");
    expect(browserPermLine(fakeT, false, () => {})).toBeNull();
  });

  it("granted 显示已授权无按钮", () => {
    installNotification("granted");
    const result = render(React.createElement(() => browserPermLine(fakeT, true, () => {})));
    expect(result.container.innerHTML).toContain("[permGranted]");
    expect(result.container.innerHTML).toContain('class="dn-ch-perm"');
    expect(result.container.innerHTML).toContain('class="dn-ch-permText"');
    expect(result.container.querySelector("button")).toBeNull();
  });

  it("denied 显示拒绝无按钮", () => {
    installNotification("denied");
    const result = render(React.createElement(() => browserPermLine(fakeT, true, () => {})));
    expect(result.container.innerHTML).toContain("[permDenied]");
    expect(result.container.querySelector("button")).toBeNull();
  });

  it("default 渲染待授权文案与按钮", () => {
    installNotification("default");
    const result = render(React.createElement(() => browserPermLine(fakeT, true, () => {})));
    expect(result.container.innerHTML).toContain("[permDefault]");
    expect(result.container.innerHTML).toContain('class="dn-set-btn dn-set-btnSmall"');
    expect(result.container.innerHTML).toContain("[requestPerm]");
  });

  it("点击请求按钮回调用", () => {
    installNotification("default");
    const calls: number[] = [];
    function onRequest(): void {
      calls.push(1);
    }
    const result = render(React.createElement(() => browserPermLine(fakeT, true, onRequest)));
    const btn = result.container.querySelector("button");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(calls).toEqual([1]);
  });
});

describe("systemPlatformHint 平台提示", () => {
  it("win32 映射 Windows 文案", () => {
    const html = htmlOf(systemPlatformHint("win32", fakeT));
    expect(html).toContain('class="dn-set-note-inline"');
    expect(html).toContain("[sysPlatformWin]");
  });

  it("darwin 映射 macOS 文案", () => {
    const html = htmlOf(systemPlatformHint("darwin", fakeT));
    expect(html).toContain("[sysPlatformMac]");
  });

  it("linux 映射 Linux 文案", () => {
    const html = htmlOf(systemPlatformHint("linux", fakeT));
    expect(html).toContain("[sysPlatformLinux]");
  });

  it("null 回落通用文案", () => {
    const html = htmlOf(systemPlatformHint(null, fakeT));
    expect(html).toContain("[sysPlatformOther]");
  });
});

describe("hostDiagnosticsBlock 宿主自检块", () => {
  it("host 缺席返回 null", () => {
    expect(hostDiagnosticsBlock(diagWith(undefined))).toBeNull();
  });

  it("ok tone 投影类名与结论行", () => {
    const host = baseHost();
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).toContain('class="dn-ch-diag dn-ch-diag-ok"');
    expect(html).toContain('class="dn-ch-diagText"');
    expect(html).toContain("HOST-LINE");
  });

  it("error tone 投影后缀", () => {
    const host = baseHost();
    host.tone = "error";
    host.line = "HOST-ERR";
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).toContain('class="dn-ch-diag dn-ch-diag-error"');
    expect(html).toContain("HOST-ERR");
  });

  it("warn tone 投影后缀", () => {
    const host = baseHost();
    host.tone = "warn";
    host.line = "HOST-WARN";
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).toContain('class="dn-ch-diag dn-ch-diag-warn"');
    expect(html).toContain("HOST-WARN");
  });

  it("有 unknownLine 时渲染第二段", () => {
    const host = baseHost();
    host.unknownLine = "UNKNOWN-XYZ";
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).toContain("UNKNOWN-XYZ");
  });

  it("无 unknownLine 时仅一段 diagText", () => {
    const host = baseHost();
    host.unknownLine = "";
    const result = render(React.createElement(() => hostDiagnosticsBlock(diagWith(host))));
    const texts = result.container.querySelectorAll("span.dn-ch-diagText");
    expect(texts.length).toBe(1);
  });

  it("remediation 为空无标题与列表", () => {
    const host = baseHost();
    host.remediationLines = [];
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).not.toContain('dn-ch-diagCap"');
    expect(html).not.toContain('dn-ch-diagItems"');
  });

  it("remediation 非空渲染标题与条目", () => {
    const host = baseHost();
    host.remediationTitle = "REM-TITLE";
    host.remediationLines = ["FIX-A", "FIX-B"];
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).toContain('class="dn-ch-diagCap"');
    expect(html).toContain('class="dn-ch-diagItems"');
    expect(html).toContain("FIX-A");
    expect(html).toContain("FIX-B");
  });

  it("明细折叠投影来源与行", () => {
    const host = baseHost();
    host.detailsLabel = "DET-LBL";
    host.sourceLabel = "HOST-SRC";
    host.details = [{ label: "LBL-A", value: "VAL-A" }];
    const html = htmlOf(hostDiagnosticsBlock(diagWith(host)));
    expect(html).toContain('class="dn-ch-reasonRaw"');
    expect(html).toContain('class="dn-ch-reasonRawText"');
    expect(html).toContain('class="dn-ch-diagSrc"');
    expect(html).toContain("HOST-SRC");
    expect(html).toContain('class="dn-ch-diagDetail"');
    expect(html).toContain('class="dn-ch-diagDetailCap"');
    expect(html).toContain("LBL-A");
    expect(html).toContain("VAL-A");
  });
});

describe("browserDiagnosticsLine 浏览器自检行", () => {
  it("ok tone 行投影", () => {
    const diag: ClientDiagnosticsView = { browser: baseBrowser() };
    const html = htmlOf(browserDiagnosticsLine(diag));
    expect(html).toContain('class="dn-ch-diag dn-ch-diag-ok"');
    expect(html).toContain('class="dn-ch-diagText"');
    expect(html).toContain("B-LINE");
    expect(html).toContain('class="dn-ch-diagSrc"');
    expect(html).toContain("B-SRC");
  });

  it("error tone 后缀投影", () => {
    const browser = baseBrowser();
    browser.tone = "error";
    browser.line = "B-ERR";
    const diag: ClientDiagnosticsView = { browser };
    const html = htmlOf(browserDiagnosticsLine(diag));
    expect(html).toContain('class="dn-ch-diag dn-ch-diag-error"');
    expect(html).toContain("B-ERR");
  });

  it("unknown tone 后缀投影", () => {
    const browser = baseBrowser();
    browser.tone = "unknown";
    browser.line = "B-UNK";
    const diag: ClientDiagnosticsView = { browser };
    const html = htmlOf(browserDiagnosticsLine(diag));
    expect(html).toContain('class="dn-ch-diag dn-ch-diag-unknown"');
    expect(html).toContain("B-UNK");
  });
});
