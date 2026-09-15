/**
 * dsh-mcp-manager catalog 域（目录）端口持有者 —— 三条装配守卫（#767 终态评审补测）。
 *
 * 判据面（这三条错误路径原先全仓零覆盖，是本域端口持有者上的存活变异体来源）：
 * 未装配时 `get()` 抛错而不是回落默认值、重复 `install()` 当场抛错、`release()` 复位装配
 * 标记。判词逐字取自 `impl/service/index.ts` 的 throw 实参——改坏即红。
 *
 * 装配/卸载走门面（`installCatalog`/`releaseCatalog`），只有 `get()` 直连持有者：门面不导出 `get()`，
 * 而 unit 层白盒直连 `src/server/<域>/impl/**` 是 I8 允许的。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogDeps } from "../../../src/server/catalog/deps.ts";
import { catalogPorts } from "../../../src/server/catalog/impl/service/index.ts";
import { installCatalog, releaseCatalog } from "../../../src/server/catalog/interface.ts";

/** 本用例只验装配守卫、不消费任何 Port 成员，故给最小对象字面量而非逐个成员造假体。 */
const deps = {} as CatalogDeps;

// 持有者是模块级单例：不复位会让「只能装配一次」连坐后续用例。
afterEach(() => {
  releaseCatalog();
});

describe("catalog 域端口持有者装配守卫", () => {
  it("未装配时 get() 抛错，判词指向组合根漏装 installCatalog", () => {
    expect(() => catalogPorts.get()).toThrow(/catalog 域未装配——组合根未在入口调用 installCatalog/);
  });

  it("重复 install() 当场抛错，且不换掉已装配的端口", () => {
    installCatalog(deps);

    expect(() => installCatalog(deps)).toThrow(/catalog 域只能装配一次/);
    expect(catalogPorts.get()).toBe(deps);
  });

  it("release() 复位标记：get() 复归抛错，且可重新装配", () => {
    installCatalog(deps);
    releaseCatalog();

    expect(() => catalogPorts.get()).toThrow(/catalog 域未装配/);
    expect(() => installCatalog(deps)).not.toThrow();
    expect(catalogPorts.get()).toBe(deps);
  });
});
