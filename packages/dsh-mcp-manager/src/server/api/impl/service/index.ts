/**
 * dsh-mcp-manager — api/impl/service/index.ts：API 层域端口持有者（#767 B2a-wire W9）。
 *
 * 域内实现经 `apiPorts.get()` 取数，写入只发生在组合根入口顶层的 `installApi`
 * （见 `src/index.ts`）。形态照 `catalog/impl/service/`、`pipeline/impl/service/`、
 * `inject/impl/service/`、`connection/orchestrator/impl/service/` 与
 * `connection/runtime/impl/service/`：模块级只有一个 `const` 实例、状态收进实例字段
 * （I9），装配与复位只经方法（方法内赋值）。
 */
import type { ApiDeps } from "../../deps.ts";

/** API 层域端口表：装配一次、域内多处读。 */
class ApiPorts {
  /** 未装配时保持 undefined——「没装配」与「装配了空实现」必须可区分（I6）。 */
  private deps: ApiDeps | undefined;

  /** 装配：组合根递入静态模块引用；重复装配是编程错误，当场暴露。 */
  install(deps: ApiDeps): void {
    if (this.deps !== undefined) throw new Error("dsh-mcp-manager: api 域只能装配一次");
    this.deps = deps;
  }

  /** 卸载：只复位装配标记，本域没有别的活资源要释放。 */
  release(): void {
    this.deps = undefined;
  }

  /**
   * 域内取数的唯一入口。未装配即抛错而不是回落默认值：默认值会让「组合根漏装」表现成行为
   * 正常但参数不对（scope 归一化与 mcpServers 导入解析静默换实现），症状与本插件毫无字面关联。
   * 只在路由 handler 内调用（不在模块求值期），故取到的一定是装配后的能力。
   */
  get(): ApiDeps {
    const deps = this.deps;
    if (deps === undefined) {
      throw new Error(
        "dsh-mcp-manager: api 域未装配——组合根未在入口调用 installApi（src/index.ts）",
      );
    }
    return deps;
  }
}

/** 本域唯一的装配实例：类不外放，外部 new 不出第二份端口表。 */
export const apiPorts = new ApiPorts();
