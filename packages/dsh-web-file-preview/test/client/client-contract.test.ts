// @ts-nocheck
/**
 * dsh-web-file-preview — 宿主入口与客户端产物契约（issue #698 重定位后）。
 *
 * 插件只剩一件事：把对话内「用默认应用打开」的文件请求改写成官方右侧栏预览。宿主不再
 * 注册路由、不读文件，故此处只覆盖：宿主入口契约、客户端产物契约与收口所需的字面量。
 * 收口逻辑本身的断言在 unit-present-open（纯函数）与 client-present-redirect（vm 夹具
 * 跑真实 lib/client.js）中。
 *
 * 本文件由脚本式断言迁为 vitest 结构化用例（#722 阶段 1）：原每条 assert 一个 it。
 * 加载方式保持原样——仍读 lib/ 构建产物（此处验证的正是产物形态），未改为直连 src。
 * 两处共享契约助手（assertClientSourceContract / assertClientProductContract）各自
 * 是一组自包含契约判定，保持为单个 it。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../lib/index.js";
import { assertClientProductContract, assertClientSourceContract } from "../../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

describe("dsh-web-file-preview 宿主入口与客户端产物契约（#698 重定位后）", () => {
  let client;
  let host;

  beforeAll(() => {
    client = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
    host = readFileSync(new URL("../../lib/index.js", import.meta.url), "utf8");
  });

  it("#698 宿主不再注册任何路由（自建数据面已随重定位删除）", () => {
    expect(ROUTES).toEqual({});
  });

  // 客户端产物契约（load id / IIFE 外壳 / apply+inject 装配 / factory 形态）
  it("client source contract（IIFE / use strict / load id / SymbolTag / factory / load once）", () => {
    assertClientSourceContract(pkgDir);
  });

  it("client product contract（执行断言：arrive 可解析 / apply / inject）", () => {
    assertClientProductContract(pkgDir);
  });

  // 收口依赖的三处官方契约字面量必须进产物：官方打开路由、官方地址前缀、官方卡片锚点。
  it("#698 client 含官方打开路由字面量", () => {
    expect(client.includes("/api/present.open")).toBeTruthy();
  });

  it("#698 client 含官方地址前缀", () => {
    expect(client.includes("dsh-resource://file/")).toBeTruthy();
  });

  it("#698 client 含官方卡片锚点", () => {
    expect(client.includes("data-presented-file")).toBeTruthy();
  });

  it("#698 client 引用官方右侧栏导航服务", () => {
    expect(client.includes("sidebarRight")).toBeTruthy();
  });

  // 宿主入口只保留契约面：不得再注入 webServer，也不得出现任何自建路由路径。
  it("#698 宿主入口保留 ROUTES 契约字面量（verify:npmlayout）", () => {
    expect(/ROUTES/.test(host)).toBeTruthy();
  });

  it("#698 宿主不再注入 webServer（无路由可注册）", () => {
    expect(!host.includes("webServer")).toBeTruthy();
  });

  it("#698 宿主不再含自建路由路径", () => {
    expect(!host.includes("/api/dsh-file-preview/")).toBeTruthy();
  });
});
