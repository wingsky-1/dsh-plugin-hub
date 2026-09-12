/**
 * dsh-notifier — L0 消费方类型用例（**产物面**；issue #733 M2-3.2）。
 *
 * 为什么单列且必须按包名导入：`lib/index.d.ts` 是外部插件唯一的类型入口，但
 * test/ 内既有用例（含 consumer-types.test.ts 的 28 条类型体锚）全部从
 * `../../src/index.ts` 导入——测的是**源码面**。源码面导入会让 `src/index.ts`
 * 直接进编译程序，于是「只写在源 `.d.ts`、从未进产物」的声明合并也能看起来生效
 * （#733 M2-3.1 修的正是这个缺陷），跨包类型可达性无从判定。本文件只做一件事：
 * 以真实消费方视角**按包名**取产物声明面，把跨包契约钉在编译期。
 *
 * 解析路径：`@wingsky-1/dsh-notifier` 由 test/tsconfig.json 的 `paths` 指向
 * `../lib/index.d.ts`（产物面）。全部导入均为 `import type`（运行时整体擦除），
 * 故 vitest 不执行本文件、也无运行时依赖；文件名不带 `.test.ts` 是有意的
 * （纯类型夹具不改变 `--min` 测试文件计数）。判据由
 * scripts/test/service-contract-wiring.test.ts 用真实 tsc 编译 test/tsconfig.json
 * 执行，前置条件是 `pnpm build` 已产出 lib/（与 test/client/** 读 lib 产物的既有先例一致）。
 *
 * 写死期望值的纪律：期望值必须是**独立字面量**。用 `T["m"]` 自引用、或 import
 * 包内未导出类型当期望值，会让两侧同步漂移、锚退化为恒真。
 */
import type { Context, Events } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-user-approval";
import type { NotifierService } from "@wingsky-1/dsh-notifier";

/** 双向类型相等（编译期判据：任一侧漂移即 false）。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** 编译期闸门：泛型实参不是 true 就报错。 */
type Expect<T extends true> = T;

/** 投递终态载荷（src/sdk/interface.ts NotifySentEvent；有意不进包导出面）——
 * 消费方无法命名它，故按结构独立写死期望值。 */
type NotifySentEventShape = {
  kind: string;
  title: string;
  message: string;
  channelId: string;
  status: "ok" | "failed";
  error?: string;
  ts: number;
};

// ---------------------------------------------------------------- 合并面：宿主 Events
// 直接断言事件签名（不经 `ctx.on`）：合并缺失时该属性不存在，是硬报错 TS2339，
// 判据不会退化成「any 对 any」的恒真比较。
type _SentEventSignature = Expect<Equal<Events["wingsky-notify/sent"], (payload: NotifySentEventShape) => void>>;
// 正向枚举断言（不写「不存在某 key」的反向式）：本包注入的 Events key 恰好这一个。
type _MergedEventKeys = Expect<Equal<Extract<keyof Events, `wingsky-notify/${string}`>, "wingsky-notify/sent">>;

// ---------------------------------------------------------------- 合并面：宿主 Context
type _ServiceFace = Expect<Equal<Context["wingsky.notifier"], NotifierService>>;
type _MergedContextKeys = Expect<Equal<Extract<keyof Context, "wingsky.notifier">, "wingsky.notifier">>;

/**
 * 真实消费方形态：外部 hub 插件经 cordis patch 挂载后，在 apply(ctx) 内使用通知
 * 中心。本函数**永不调用**（判据全在编译期），只用来把「消费方怎么用」钉死。
 */
export function consumerApply(ctx: Context): void {
  // inject 声明形态：cordis 据此解析依赖（服务缺失时插件停用而非裸崩）。
  const inject: string[] = ["wingsky.notifier"];
  void inject;

  // ① 服务面：ctx['wingsky.notifier'] 直接可用，类型即包导出面的 NotifierService。
  const svc = ctx["wingsky.notifier"];
  type _DirectFace = Expect<Equal<typeof svc, NotifierService>>;

  // ② 可选增强形态：探测式读取必须带 undefined（消费方据此降级）。
  const maybe = ctx.get("wingsky.notifier", false);
  type _MaybeFace = Expect<Equal<typeof maybe, NotifierService | undefined>>;

  // ③ provide 形态：提供方经同一合并面注册（值受 Context 约束，不接受任意值）。
  ctx.provide("wingsky.notifier", svc);

  // ④ 调用面：按包导出面的签名调用必须通过。
  void svc.send({ source: "@wingsky-1/example", kind: "example:ping", severity: "info", body: "hello" });
  void svc.listKinds();
  svc.registerKind({ id: "example:ping", label: "示例" });
  svc.confirmKind("example:ping", true);

  // ⑤ 事件面：订阅投递终态；payload 类型来自合并后的 Events 声明。
  //    实测（cordis 4.0.2 events.d.ts:88）：`Context.on` 只有
  //    `on<K extends keyof Events>(name, listener: Events[K], options?)` **一个**重载——
  //    宽松的 `on(name: string | symbol, listener: (...args: any) => any)`（同文件 :197）
  //    属于 `EventsService` 类、不在 `Context` 上。故合并缺失时此处是硬报错
  //    （实测 TS2345 事件名 + TS7006 隐式 any），不存在「退化成 any 而假绿」的路径。
  ctx.on("wingsky-notify/sent", (payload) => {
    type _PayloadFace = Expect<Equal<typeof payload, NotifySentEventShape>>;
    void payload.channelId;
  });
}
