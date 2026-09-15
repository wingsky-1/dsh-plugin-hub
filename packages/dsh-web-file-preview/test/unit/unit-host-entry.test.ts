/**
 * dsh-web-file-preview — 宿主组合根的直连 src 契约（issue #698 重定位 + 技术债清理）。
 *
 * 组合根只剩 bundle 契约所需的最小面（name / ROUTES / apply）；这些符号是宿主装载与
 * verify:npmlayout 的判据输入，直连 src 断言以免它们被静默改动。
 */
import { describe, expect, it } from "vitest";
import { apply, name, ROUTES } from "../../src/index.ts";

describe("#698 宿主组合根契约", () => {
  it("#698 插件名稳定（bundle patch 以它定位）", () => {
    expect(name).toBe("web-file-preview");
  });

  it("#698 宿主路由表为空（重定位后不注册任何路由）", () => {
    expect(ROUTES).toEqual({});
  });

  it("#698 宿主 apply 可调用且无副作用", () => {
    expect(apply()).toBeUndefined();
  });
});
