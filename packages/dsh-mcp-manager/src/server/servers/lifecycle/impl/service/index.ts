/**
 * dsh-mcp-manager — servers/lifecycle/impl/service/index.ts：装载生命周期域端口持有者。
 *
 * 域内实现经 `lifecyclePorts.get()` 取数，写入只发生在组合根入口顶层的 `installLifecycle`
 * （本片不接线，见 767-v6-STAGED-PLAN §3 阶段表）。形态照 `pipeline/impl/service/` 与
 * `connection/runtime/impl/service/`：模块级只有一个 `const` 实例、状态收进实例字段（I9），
 * 装配与复位只经方法（方法内赋值）。
 */
import type { LifecycleDeps } from "../../deps.ts";

/** 装载生命周期域端口表：装配一次、域内多处读。 */
class LifecyclePorts {
  /** 未装配时保持 undefined——「没装配」与「装配了空实现」必须可区分（I6）。 */
  private deps: LifecycleDeps | undefined;

  /** 装配：组合根递入静态模块引用；重复装配是编程错误，当场暴露。 */
  install(deps: LifecycleDeps): void {
    if (this.deps !== undefined)
      throw new Error("dsh-mcp-manager: servers/lifecycle 域只能装配一次");
    this.deps = deps;
  }

  /** 卸载：只复位装配标记，本域的活资源（装载账本）由 `releaseLifecycle` 另行回收。 */
  release(): void {
    this.deps = undefined;
  }

  /**
   * 域内取数的唯一入口。未装配即抛错而不是回落默认值：默认值会让「组合根漏装」表现成
   * 装载静默失败在没有 loader 的空实现上，症状与本插件毫无字面关联。
   */
  get(): LifecycleDeps {
    const deps = this.deps;
    if (deps === undefined) {
      throw new Error(
        "dsh-mcp-manager: servers/lifecycle 域未装配——组合根未在入口调用 installLifecycle（src/index.ts）",
      );
    }
    return deps;
  }
}

/** 本域唯一的装配实例：类不外放，外部 new 不出第二份端口表。 */
export const lifecyclePorts = new LifecyclePorts();
