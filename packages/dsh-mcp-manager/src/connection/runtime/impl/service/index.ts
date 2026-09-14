/**
 * dsh-mcp-manager — connection/runtime/impl/service/index.ts：连接域 runtime 子层端口持有者（#767 B2a-wire W8）。
 *
 * 子层内实现经 `runtimePorts.get()` 取数，写入只发生在组合根入口顶层的 `installRuntime`
 * （见 `src/index.ts`）。形态照 `catalog/impl/service/`、`pipeline/impl/service/`、
 * `inject/impl/service/` 与 `connection/orchestrator/impl/service/`：模块级只有一个 `const`
 * 实例、状态收进实例字段（I9），装配与复位只经方法（方法内赋值）。
 */
import type { RuntimeDeps } from "../../deps.ts";

/** 连接运行时子层端口表：装配一次、子层内多处读。 */
class RuntimePorts {
  /** 未装配时保持 undefined——「没装配」与「装配了空实现」必须可区分（I6）。 */
  private deps: RuntimeDeps | undefined;

  /** 装配：组合根递入静态模块引用；重复装配是编程错误，当场暴露。 */
  install(deps: RuntimeDeps): void {
    if (this.deps !== undefined)
      throw new Error("dsh-mcp-manager: connection/runtime 子层只能装配一次");
    this.deps = deps;
  }

  /** 卸载：只复位装配标记，本子层没有别的活资源要释放。 */
  release(): void {
    this.deps = undefined;
  }

  /**
   * 子层内取数的唯一入口。未装配即抛错而不是回落默认值：默认值会让「组合根漏装」表现成行为
   * 正常但参数不对（结果投影、策略裁决与全名解析静默换成别处的实现），症状与本插件毫无字面
   * 关联。`get()` 只在运行期方法内调用（不在模块求值期），故回调闭包（`errorText`）里取到的
   * 一定是装配后的能力。
   */
  get(): RuntimeDeps {
    const deps = this.deps;
    if (deps === undefined) {
      throw new Error(
        "dsh-mcp-manager: connection/runtime 子层未装配——组合根未在入口调用 installRuntime（src/index.ts）",
      );
    }
    return deps;
  }
}

/** 本子层唯一的装配实例：类不外放，外部 new 不出第二份端口表。 */
export const runtimePorts = new RuntimePorts();
