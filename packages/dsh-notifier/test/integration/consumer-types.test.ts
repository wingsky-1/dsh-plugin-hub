/**
 * dsh-notifier — 消费方类型编译用例（源码面类型体锚）。
 *
 * 为什么存在：导出面快照门禁（scripts/data/dsh-notifier-export-surface.json）只比对
 * `export declare const/function/class` 块，对 `interface` / `type` 体**零覆盖**（门禁自述的盲区①）
 * ——给 `NotifierService` 加一个方法、改一个字段类型，快照不会红。类型体因此由本文件的锚兜住：
 * 逐个 `Equal` / `Same<T, 独立字面量>`，成员增删与类型漂移即 tsc 红。本文件的编译期锚共 **6 条**。
 *
 * 判据在编译期：本文件由 `test/tsconfig.json`（noEmit）经
 * `scripts/test/service-contract-wiring.test.ts` 的真实 `tsc -p` 编译；Node 直跑（type stripping）
 * 会擦掉类型断言，故下面的运行时断言只是「用例没被绕开」的护栏，不构成判据。
 *
 * 写死期望值的纪律：期望值必须是**独立字面量**。用 `T["m"]` 自引用、或 import 包内未导出的类型当
 * 期望值，会让锚与被测类型同步漂移、退化成恒真。
 *
 * 面口径（#733 M2-3.2）：本文件按**源码面**（`../../src/index.ts`）导入，锚的是类型体；**产物面**
 * （按包名取 `lib/index.d.ts`）的跨包可达性单列在 `consumer-product-face.ts`——声明合并只写进源
 * `.d.ts`、从未进产物这类缺陷只有在产物面才可见（源码面导入会让 `src/index.ts` 直接进编译程序）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Context } from "@deepseek-ai/cordis";

import * as entry from "../../src/index.ts";
import type { NotifierApplyConfig, NotifierService } from "../../src/index.ts";
import { apply, inject, name } from "../../src/index.ts";

// ---------------------------------------------------------------- 编译期类型原语

/** 精确相等（含可选性/联合分布）。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/**
 * 结构互含（双向子型）。interface 与匿名对象字面量之间存在 TypeScript 表示层边界，`Equal` 会把
 * 语义等价的两者判为不等（误红），故对象结构与函数类型用「双向 extends」替代：删字段 / 改字段类型 /
 * 改联合 / 改方法签名任意单向漂移都会破坏某一方向的子型关系。可选性的等价边缘形态
 * （`a?: T` 与 `a: T | undefined`）不区分，属非破坏性漂移。
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** 编译期闸门：泛型实参不是 true 就报错。 */
type Expect<T extends true> = T;

// ---------------------------------------------------------------- 期望值（独立字面量）

/** 通知种类词汇表：内置七种 + 外部注册的 `<命名空间>:<id>`。 */
type NotifyKindShape =
  | "ask"
  | "question"
  | "done"
  | "subagent-done"
  | "error"
  | "turn-end"
  | "test"
  | `${string}:${string}`;

/** 展示强度词汇表。 */
type NotifySeverityShape = "info" | "success" | "warning" | "failure";

// ---------------------------------------------------------------- 类型体锚

/** 类型 1/6：NotifierService —— 本插件对兄弟插件开放的全部能力面。 */
type _NotifierServiceShape = Expect<
  Same<
    NotifierService,
    {
      readonly apiVersion: 2;
      registerKind(registration: { id: `${string}:${string}`; label: string }): void;
      send(request: {
        kind: NotifyKindShape;
        severity?: NotifySeverityShape;
        title?: string;
        body: string;
      }): Promise<void>;
    }
  >
>;

/** 类型 2/6：NotifierApplyConfig —— 组合层入口配置（interface，快照门禁的盲区①，靠本文件兜住）。 */
type _NotifierApplyConfigShape = Expect<Same<NotifierApplyConfig, { enabled?: boolean }>>;

/** 类型 3/6：apply 签名 —— 消费方经 cordis patch 调用的那个入口。 */
type _ApplyShape = Expect<
  Same<typeof apply, (ctx: Context, config?: { enabled?: boolean }) => void>
>;

/** 类型 4/6：inject —— 依赖的宿主服务清单。 */
type _InjectShape = Expect<Equal<typeof inject, string[]>>;

/** 类型 5/6：name —— 稳定的 cordis 插件名。 */
type _NameShape = Expect<Equal<typeof name, "notifier">>;

/** 类型 6/6：声明合并的槽位类型就是服务面（改一面不改另一面即红）。 */
type _ServiceSlotShape = Expect<Equal<Context["wingsky.notifier"], NotifierService>>;

// ---------------------------------------------------------------- 编译期语句探针
// 只在编译期存在：运行时不调用它们（`declare` / 未调用函数体），故不会在 vitest 里执行到。

/** 消费方视角的读法：`ctx` 上的服务槽必须直接可用。 */
function serviceFromContext(ctx: Context): NotifierService {
  return ctx["wingsky.notifier"];
}

/** 授权边界（`@ts-expect-error` 指令本身受检：错误消失即报 unused）。 */
function rejectedByType(service: NotifierService): void {
  // @ts-expect-error 确认是设置页的授权动作，不在对外服务面上
  service.confirmKind("demo:report", true);
  // @ts-expect-error 清单同理
  service.listKinds();
}

// ---------------------------------------------------------------- 运行时护栏与自述自检

describe("运行时护栏：导出面确实可从包入口取到", () => {
  const baseline: { exports: Array<{ name: string; isType: boolean }> } = JSON.parse(
    readFileSync(
      new URL("../../../../scripts/data/dsh-notifier-export-surface.json", import.meta.url),
      "utf8",
    ),
  );
  const self = readFileSync(new URL("./consumer-types.test.ts", import.meta.url), "utf8");

  it("包入口的运行时导出恰好是快照基线的非类型导出（增删即 ABI 变化）", () => {
    const expected = baseline.exports
      .filter((item) => !item.isType)
      .map((item) => item.name)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(Object.keys(entry).sort()).toEqual(expected);
  });

  it("宿主依赖清单由运行时值锁定（类型只管它是 string[]，管不到内容）", () => {
    expect(inject).toContain("webServer");
  });

  it("每个导出面类型导出都有一条 <名字>Shape 类型体锚（逐个覆盖不变式）", () => {
    const typeExports = baseline.exports.filter((item) => item.isType).map((item) => item.name);
    expect(typeExports.length).toBeGreaterThan(0);
    expect(typeExports.filter((typeName) => !self.includes(`type _${typeName}Shape = `))).toEqual(
      [],
    );
  });

  it("头部自述与实际一致：锚条数与声明相符", () => {
    const declared = /本文件的编译期锚共 \*\*(\d+) 条\*\*/u.exec(self);
    expect(declared).not.toBeNull();
    const anchors = self.match(/^type _[A-Za-z]+ = Expect</gmu) ?? [];
    // 编号连续性与分母一致性（原先另两条断言）是**自涉**判据：它读的是这份文件自己的注释，
    // 产品代码坏掉也不会红。锚条数这一条才是有效的（漏写一个锚 = 少一条编译期判据）。
    expect(anchors.length).toBe(Number(declared![1]));
  });
});
