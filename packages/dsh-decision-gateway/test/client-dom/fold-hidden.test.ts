// @vitest-environment happy-dom
/** 折叠回归：hidden 属性行为 + CSS 规则双锁（happy-dom，全离线 fetch 桩）。
 *
 * 守的是三处折叠（明文/高级/历史过滤）的开合：.dj-foldBody{ display:flex } 曾覆盖
 * UA 的 [hidden] display:none 导致全部常开。CSS 缺规则或开合失灵，本文件必红。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { ConnectionPane } from "../../src/client/settings/connection.tsx";
import { baseStub, installStub, mountPane, pollUntil } from "../client-helpers.ts";
import { setLang } from "../../src/client/locale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "..", "src", "client", "style.css");

const unmounts: Array<() => void> = [];
let restore: (() => void) | null = null;
beforeEach(() => {
  document.body.innerHTML = "";
  setLang("zh");
});
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()?.();
  document.body.innerHTML = "";
  restore?.();
  restore = null;
});

function foldBody(head: HTMLElement): HTMLElement | null {
  return head.parentElement?.querySelector<HTMLElement>(".dj-foldBody") ?? null;
}

describe("折叠 hidden 双锁", () => {
  it("style.css 含 .dj-foldBody[hidden] 覆盖规则", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".dj-foldBody[hidden]");
  });
  it("高级折叠默认闭合，点击开合切换 hidden", async () => {
    restore = installStub(baseStub).restore;
    const { pane, unmount } = mountPane(React.createElement(ConnectionPane));
    unmounts.push(unmount);
    await pollUntil(() => (pane.textContent ?? "").includes("已加载配置"), "连接已加载");
    const head = Array.from(pane.querySelectorAll<HTMLElement>(".dj-foldHead")).find((h) =>
      (h.textContent ?? "").includes("高级"),
    );
    expect(head).not.toBe(undefined);
    expect(foldBody(head!)?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(head!);
    expect(foldBody(head!)?.hasAttribute("hidden")).toBe(false);
    fireEvent.click(head!);
    expect(foldBody(head!)?.hasAttribute("hidden")).toBe(true);
  });
});
