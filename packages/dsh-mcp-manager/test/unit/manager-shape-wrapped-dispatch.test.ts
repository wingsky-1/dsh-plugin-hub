/** Manager 方法面的自然职责测试与专属fixture。 */

import { describe, expect, it } from "vitest";

import { pollUntil } from "../helpers.ts";

import type { ServerConfig } from "../../src/server/config/interface.ts";

import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";

import { catalogDirectory } from "../../src/server/catalog/interface.ts";
import { setupManagerTestLifecycle } from "./manager-shape-support.ts";

import {
  directGuardFixture,
  eagerFilterFixture,
  mountCalls,
  registerWrappedDispatchHooks,
  wrappedFixture,
  wrappedTool,
} from "./manager-shape-wrapped-dispatch-fixture.ts";
setupManagerTestLifecycle();
describe("#767 S1-5b：封装定义条目恒交中间层（(c)'）", () => {
  registerWrappedDispatchHooks();

  for (const source of ["runtime", "store"]) {
    it(`[${source}] 虚拟连接建立且目录可见 @global/cg`, async () => {
      const { mw } = await wrappedFixture(source);
      expect(mw.units.get("@global")?.connections.get("cg")?.status).toBe("connected");
      expect(catalogDirectory.entryFor("@global", "cg")?.tools.has("cg_node")).toBe(true);
    });

    it(`[${source}] ws_mcp_call 转发执行的是调用方 execute`, async () => {
      const { log, calls } = await wrappedFixture(source);
      // 注册的是实现传入的真定义（ws_mcp_call 恒在内），此处按形状收窄。
      const wsCall = log.registered.find(
        (def) => (def as { name?: string }).name === "ws_mcp_call",
      ) as ToolDefinition | undefined;
      const result = await wsCall!.execute(
        { server: "@global/cg", tool: "cg_node", arguments: { symbol: "X" } },
        { signal: undefined, agent: undefined, callId: "call-1" } as unknown as ToolRunContext,
      );
      expect(calls).toEqual([{ symbol: "X" }]);
      expect(JSON.stringify(result)).toContain("node(X)");
    });

    it(`[${source}] 未发生官方装载（假 loader 零 mount）`, async () => {
      await wrappedFixture(source);
      expect(mountCalls()).toBe(0);
    });

    it(`[${source}] 注销后虚拟条目与目录条目一并移除`, async () => {
      const { manager, mw } = await wrappedFixture(source);
      // 两档的注销入口不同：runtime 注入走 unregisterServer，store 落盘条目走 remove。
      if (source === "store") await manager.remove("cg");
      else await manager.unregisterServer("cg");
      expect(mw.units.get("@global")?.connections.has("cg")).toBe(false);
      expect(catalogDirectory.entryFor("@global", "cg")).toBeUndefined();
      expect(manager.runtimeRegistry.has("cg")).toBe(false);
    });
  }

  it("建 @global 单元把同 root 的正常全局服务器一并拉进池（不再按所有权收窄）", async () => {
    const { mw } = await eagerFilterFixture();
    await pollUntil(
      "正常全局服务器同时进池",
      () => mw.units.get("@global")?.connections.has("gn") === true,
    );
    expect(mw.units.get("@global")?.connections.has("cg")).toBe(true);
    expect(mw.units.get("@global")?.connections.has("gn")).toBe(true);
    expect(mountCalls() > 0).toBe(true);
  });

  it("重复 start 不重复装载（同 root 两台各只一条条目）", async () => {
    const { manager, mw } = await eagerFilterFixture();
    await pollUntil(
      "正常全局服务器进池",
      () => mw.units.get("@global")?.connections.has("gn") === true,
    );
    const mountsBefore = mountCalls();
    manager.start("gn", "global");
    manager.start("cg", "global");
    expect(mw.units.get("@global")!.connections.size).toBe(2);
    expect(mountCalls()).toBe(mountsBefore);
  });

  it("直呼 mcp__<id>__<禁用工具> 命中禁用面（guard 反解回 @global/g1）", async () => {
    const { entry, guard } = await directGuardFixture();
    // guard 回调返回裁决对象（kind/reason 面）：此处按测试读取面收窄。
    const decision = (await guard(
      { name: `mcp__${entry.id}__echo`, agent: { session: { header: {} } } },
      async () => ({ kind: "allow" }),
    )) as { kind: unknown; reason?: unknown };
    // 反解不到 (root, 裸名) 就会把 id 当服务器名查表 → 恒 miss → 这条会红。
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toContain("@@global/g1/echo");
  });

  // #1014 B5：语义从「未禁用即放行」翻成「mcp__ 直呼一律拒」。断 nexted=false 是
  // 关键的一半——只断 kind 的话，「先 next 再 deny」也能过这条。
  it("直呼 mcp__<id>__<未禁用工具> 一律拒（内部注册名不可直呼）", async () => {
    const { entry, guard } = await directGuardFixture();
    let nexted = false;
    const decision = (await guard(
      { name: `mcp__${entry.id}__other`, agent: { session: { header: {} } } },
      async () => {
        nexted = true;
        return { kind: "allow" };
      },
    )) as { kind: unknown; reason?: unknown };
    expect(nexted).toBe(false);
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toContain("ws_mcp_call");
  });

  it("无 transport 的封装条目（直传配置）同样只经虚拟连接，不派官方实例", async () => {
    // normalizeServer 要求 transport，故这条走 start 的直传配置路径：判定的是「封装定义条目
    // 不走官方装载」本身，与配置里有没有 transport 无关。
    const { manager, mw } = await wrappedFixture("runtime");
    const calls: unknown[] = [];
    const bare = { name: "cg2", enabled: true, toolDefinitions: [wrappedTool(calls)] };
    // 无 transport 是本用例的测试输入（直传配置路径），按意图收窄。
    manager.runtimeRegistry.set("cg2", bare as unknown as ServerConfig);
    manager.start("cg2", "global");
    await pollUntil("虚拟连接建立", () => mw.units.get("@global")?.connections.has("cg2") === true);
    expect("supervisors" in manager, "supervisors 字段已删").toBe(false);
    expect(mountCalls()).toBe(0);
  });
});
