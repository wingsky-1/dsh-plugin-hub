/** binding 域依赖声明：只声明「我需要外部什么」，声明面只有类型（共享层设施由实现块直接引）。 */
import type { LoggerPort } from "../shared/interface.ts";

/** 装配入参。本域**拿不到** ctx：落盘路径由组合根给出，域内不反推环境。 */
export interface BindingDeps {
  /** 失败出口。写盘失败是「保持内存不前移 + 出声」，不静默。 */
  readonly logger: LoggerPort;
  /** bindings.json 的完整路径（组合根决定 DSH_HOME 归属，域内不拼路径）。 */
  readonly file: string;
}
