/** 包内跨域共享类型：只收「三个以上域使用、且无单一域归属」的协议级类型；域的所有物留在各自 `type.ts`。 */

/** 宿主日志出口的收窄面（config / stores / upgrade 三域的装配入参共用）。 */
export interface LoggerPort {
  warn(message: string): void;
}
