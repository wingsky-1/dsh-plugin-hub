/**
 * dsh-mcp-manager — inject/impl/service/index.ts：工具注册域端口持有者（#767 B2a-wire W6）。
 *
 * 域内实现经 `injectPorts.get()` 取数，写入只发生在组合根入口顶层的 `installInject`
 * （见 `src/index.ts`）。形态照 `catalog/impl/service/` 与 `pipeline/impl/service/`：
 * 模块级只有一个 `const` 实例、状态收进实例字段（I9），装配与复位只经方法（方法内赋值）。
 */
import type { InjectDeps } from "../../deps.ts";

/** 工具注册域端口表：装配一次、域内多处读。 */
class InjectPorts {
  /** 未装配时保持 undefined——「没装配」与「装配了空实现」必须可区分（I6）。 */
  private deps: InjectDeps | undefined;

  /** 装配：组合根递入静态模块引用；重复装配是编程错误，当场暴露。 */
  install(deps: InjectDeps): void {
    if (this.deps !== undefined) throw new Error("dsh-mcp-manager: inject 域只能装配一次");
    this.deps = deps;
  }

  /** 卸载：只复位装配标记，本域没有别的活资源要释放。 */
  release(): void {
    this.deps = undefined;
  }

  /**
   * 域内取数的唯一入口。未装配即抛错而不是回落默认值：默认值会让「组合根漏装」表现成行为
   * 正常但参数不对（检索族与策略裁决静默换实现），症状与本插件毫无字面关联。
   */
  get(): InjectDeps {
    const deps = this.deps;
    if (deps === undefined) {
      throw new Error(
        "dsh-mcp-manager: inject 域未装配——组合根未在入口调用 installInject（src/index.ts）",
      );
    }
    return deps;
  }
}

/** 本域唯一的装配实例：类不外放，外部 new 不出第二份端口表。 */
export const injectPorts = new InjectPorts();
