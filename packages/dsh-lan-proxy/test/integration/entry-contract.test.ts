/**
 * dsh-lan-proxy — 包入口（src/index.ts）的 cordis 插件契约。
 *
 * 集成层（docs/ARCHITECTURE-METHOD.md §8 导入面矩阵）：矩阵把「包产物入口 + `apply()`」
 * 列为集成层的许可导入面，单元层只许同域白盒直连 impl。本文件的两条断言的被测对象**就是包入口
 * 自身**——`name` 与 `inject` 在 src/index.ts 内就地定义（全仓无第二个定义点，见该文件
 * `export const name = "lan-proxy"`），任何域门面都取不到它们，故它们天生不属于单元层。
 *
 * 断言从 test/unit/unit-apply.test.ts 原样迁来（逐字未改）：那两条判据的失效形态是
 * 「插件静默不加载」——cordis 靠 name/inject 定位与调度插件，写错不抛错、不进日志。
 */
import { describe, expect, it } from "vitest";

import { inject, name } from "../../src/index.ts";

// 包入口契约：cordis 靠这两个符号定位与调度本插件，写错即插件静默不加载。
describe("包入口契约（src/index.ts）", () => {
  it("插件名与 cordis.patch.yml 的挂载行一致", () => expect(name).toBe("lan-proxy"));
  it("只声明注入 webServer（回环服务器就绪后才启动）", () => expect(inject).toEqual(["webServer"]));
});
