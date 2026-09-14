/**
 * dsh-mcp-manager — pipeline/impl/service/index.ts：执行管道域端口持有者（#767 B2a-wire W5）。
 *
 * 域内实现经 `pipelinePorts.get()` 取数，写入只发生在组合根入口顶层的 `installPipeline`
 * （见 `src/index.ts`）。形态照 `server/upgrade/impl/service/` 与 `catalog/impl/service/`：
 * 模块级只有一个 `const` 实例、状态收进实例字段（I9），装配与复位只经方法（方法内赋值）。
 */
import type { PipelineDeps } from "../../deps.ts";

/** 执行管道域端口表：装配一次、域内多处读。 */
class PipelinePorts {
  /** 未装配时保持 undefined——「没装配」与「装配了空实现」必须可区分（I6）。 */
  private deps: PipelineDeps | undefined;

  /** 装配：组合根递入静态模块引用；重复装配是编程错误，当场暴露。 */
  install(deps: PipelineDeps): void {
    if (this.deps !== undefined) throw new Error("dsh-mcp-manager: pipeline 域只能装配一次");
    this.deps = deps;
  }

  /** 卸载：只复位装配标记，本域没有别的活资源要释放。 */
  release(): void {
    this.deps = undefined;
  }

  /**
   * 域内取数的唯一入口。未装配即抛错而不是回落默认值：默认值会让「组合根漏装」表现成
   * 行为正常但参数不对（全名解析与裸名回落静默换实现），症状与本插件毫无字面关联。
   */
  get(): PipelineDeps {
    const deps = this.deps;
    if (deps === undefined) {
      throw new Error(
        "dsh-mcp-manager: pipeline 域未装配——组合根未在入口调用 installPipeline（src/index.ts）",
      );
    }
    return deps;
  }
}

/** 本域唯一的装配实例：类不外放，外部 new 不出第二份端口表。 */
export const pipelinePorts = new PipelinePorts();
