/**
 * dsh-mcp-manager servers/lifecycle 域（装载生命周期）端口持有者 —— 三条装配守卫。
 *
 * 判据面（这三条错误路径是本域端口持有者上的存活变异体来源）：未装配时 `get()` 抛错而不是
 * 回落默认值、重复 `install()` 当场抛错、`release()` 复位装配标记。判词逐字取自
 * `impl/service/index.ts` 的 throw 实参——改坏即红。
 *
 * 装配/卸载走门面（`installLifecycle`/`releaseLifecycle`），只有 `get()` 直连持有者：门面不导出
 * `get()`，而 unit 层白盒直连 `src/server/<域>/impl/**` 是 I8 允许的。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LifecycleDeps } from "../../../src/server/servers/lifecycle/deps.ts";
import { lifecyclePorts } from "../../../src/server/servers/lifecycle/impl/service/index.ts";
import {
  installLifecycle,
  releaseLifecycle,
} from "../../../src/server/servers/lifecycle/interface.ts";

/** 本用例只验装配守卫、不消费任何 Port 成员，故给最小对象字面量而非逐个成员造假体。 */
const deps = {} as LifecycleDeps;

// 持有者是模块级单例：不复位会让「只能装配一次」连坐后续用例。
afterEach(() => {
  releaseLifecycle();
});

describe("servers/lifecycle 域端口持有者装配守卫", () => {
  it("未装配时 get() 抛错，判词指向组合根漏装 installLifecycle", () => {
    expect(() => lifecyclePorts.get()).toThrow(
      /servers\/lifecycle 域未装配——组合根未在入口调用 installLifecycle/,
    );
  });

  it("重复 install() 当场抛错，且不换掉已装配的端口", () => {
    installLifecycle(deps);

    expect(() => installLifecycle(deps)).toThrow(/servers\/lifecycle 域只能装配一次/);
    expect(lifecyclePorts.get()).toBe(deps);
  });

  it("release() 复位标记：get() 复归抛错，且可重新装配", () => {
    installLifecycle(deps);
    releaseLifecycle();

    expect(() => lifecyclePorts.get()).toThrow(/servers\/lifecycle 域未装配/);
    expect(() => installLifecycle(deps)).not.toThrow();
    expect(lifecyclePorts.get()).toBe(deps);
  });
});
