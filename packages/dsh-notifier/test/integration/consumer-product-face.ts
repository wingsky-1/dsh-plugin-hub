/**
 * dsh-notifier — 产物面消费方夹具（按包名取 `lib/index.d.ts`）。
 *
 * 为什么单列一个文件（#733 M2-3.2）：源码面导入（`../../src/index.ts`）会让 src 直接进编译程序，
 * 从而**掩盖**「声明合并只写进源 `.d.ts`、从未进产物」这类缺陷——那种情况下消费方按包名导入时
 * `ctx["wingsky.notifier"]` 与 `apply` / `inject` / `name` 全部失类型，而源码面用例照样绿。
 * 本文件经 `test/tsconfig.json` 的 `paths` 把包名映射到 `lib/index.d.ts`，判据是两条：
 * ① 声明合并对消费方可达；② 服务面与入口面按包名可命名。
 *
 * 与 `consumer-types.test.ts` 的分工：那个锚**类型体**（源码面），这个锚**可达性**（产物面）。
 * 不参与 `--min`：文件名不带 `.test.ts`，它是纯类型夹具，没有运行时断言——产物级的运行时判据属于
 * `pnpm pack:check` 的「声明合并可达性」（scripts/lib/dts-cordis-merge-lib.ts）。
 *
 * 前置：本文件被编译前必须先构建（`pnpm --filter @wingsky-1/dsh-notifier build`），
 * `paths` 指向的 `lib/index.d.ts` 才存在；CI / 本地门禁按 script-test-prereqs.mjs 的清单补建。
 */
import type { Context } from "@deepseek-ai/cordis";

import type { NotifierService } from "@wingsky-1/dsh-notifier";
import { apply, inject, name } from "@wingsky-1/dsh-notifier";

/** 入口值面可达：消费方经 cordis patch 挂载时要用到这三个导出。 */
export const entryFace = { apply, inject, name };

/** 挂载形态：第二个入参在产物声明里同样可命名、可省略。 */
export function mount(ctx: Context): void {
  apply(ctx);
  apply(ctx, { enabled: false });
}

/** 声明合并可达：这一行的类型来自 `lib/index.d.ts` 的 `declare module "@deepseek-ai/cordis"`。 */
export function serviceFromContext(ctx: Context): NotifierService {
  return ctx["wingsky.notifier"];
}

/** 服务面按包名可命名，且两个口都能调（消费方要写标注就得能命名它）。 */
export function callService(service: NotifierService): Promise<void> {
  service.registerKind({ id: "consumer-demo:report", label: "演示" });
  return service.send({ kind: "consumer-demo:report", body: "正文" });
}

/** apiVersion 是字面量 2：消费方按它分支时，服务面版本漂移即编译错误。 */
export function apiVersionOf(service: NotifierService): 2 {
  return service.apiVersion;
}

/** 授权边界（`@ts-expect-error` 指令本身受检：错误消失即报 unused）。 */
export function rejectedByType(service: NotifierService): void {
  // @ts-expect-error 确认只能由设置页经域契约发起
  service.confirmKind("consumer-demo:report", true);
  // @ts-expect-error 清单同理
  service.listKinds();
}

/** 未声明的服务键不可达（反向：`Context` 没有字符串索引签名，合并若整体失效上面那行也会红）。 */
export function rejectedUnknownKey(ctx: Context): void {
  // @ts-expect-error 服务名没有物理定义在这里，只有声明合并能提供它
  const missing = ctx["wingsky.notifier-typo"];
  void missing;
}
