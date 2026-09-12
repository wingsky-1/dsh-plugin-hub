/** stores 域依赖声明：只声明「我需要外部什么」，声明面**只有类型**；设置以**能力**而非装配期快照出现——快照会让
 * 用户之后改的值不再生效，症状是「历史清理不按设置来」。 */
import type * as configApi from "../config/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

/** config 域给下游的能力面：只 `Pick` 读当前生效设置——写面进来等于让历史存储具备改设置的能力。 */
export type ConfigPort = Pick<typeof configApi, "readConfig">;

export interface StoreDeps {
  /** 写入失败出口（写入是 fire-and-forget，没有同步返回值可承载失败）。 */
  logger: LoggerPort;
  /** 设置读面：保留天数每次读时现取，不在装配期取快照。 */
  config: ConfigPort;
}
