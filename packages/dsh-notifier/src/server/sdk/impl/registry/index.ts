/**
 * dsh-notifier sdk 域 —— 动态种类注册表。
 *
 * 表里只有**插件进程报上来的声明**（id → 展示名），确认态不在这里：它属于用户，落在
 * 设置的 `allowKinds` 里。两者分开是因为生命周期不同——注册表随进程生灭（插件重载后
 * 重新登记），确认态跨重启保留（用户点过的「允许」不该因为一次重启而作废）。
 *
 * 按 id 覆盖而不是拒绝重复：同一个插件重载后改了展示名，或者同一 id 被重新声明，需要的
 * 都是「以最新一次为准」。表是插入有序的，因此它同时决定了设置页上的展示顺序。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { KindRegistration, RegisteredKind } from "./type.ts";

/** 注册表：谁登记过哪些种类。确认态经参数传入，本表不持有它。 */
class KindRegistry {
  private readonly labels = new Map<string, string>();

  /** 登记一个动态种类。重复登记同 id 覆盖展示名。 */
  register(registration: KindRegistration): void {
    this.labels.set(registration.id, registration.label);
  }

  /** 是否登记过。确认动作只对登记过的种类成立。 */
  has(id: string): boolean {
    return this.labels.has(id);
  }

  /** 清单：登记项合并已确认名单（确认名单来自设置）。 */
  list(confirmed: readonly string[]): RegisteredKind[] {
    const allowed = new Set(confirmed);
    return [...this.labels].map(([id, label]) => ({ id, label, confirmed: allowed.has(id) }));
  }
}

/** 本域唯一的注册表：类不外放，外面 `new` 不出第二份。 */
export const kindRegistry = new KindRegistry();
