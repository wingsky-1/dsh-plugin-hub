/** store 域出口：本域对上游声明的注入面（纯类型，零运行时）。 */

/** 最小日志面（宿主 ctx.logger 的结构子集）。 */
export interface LoggerPort {
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}
