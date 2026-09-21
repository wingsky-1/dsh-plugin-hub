/**
 * config 域出口：本域对上游（组合根）声明的注入面（纯类型，零运行时）。
 *
 * 跨域运行时能力一律经此注入：落盘原语由组合根从 store 域取来传入，
 * 本域不直引 store 实现（跨域值边零新增）。
 */

/** 最小日志面（宿主 ctx.logger 的结构子集）。 */
export interface LoggerPort {
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}

/** 落盘原语面（组合根用 store 域实现装配）。 */
export interface FileIoPorts {
  readonly readJsonSync: (
    file: string,
  ) => { readonly ok: true; readonly value: unknown } | { readonly ok: false };
  readonly readTextSync: (
    file: string,
  ) => { readonly ok: true; readonly text: string } | { readonly ok: false };
  readonly atomicWrite0600Sync: (file: string, text: string) => void;
}

/** config 域运行所需注入（io + 日志）。 */
export interface ConfigDeps {
  readonly io: FileIoPorts;
  readonly logger: LoggerPort;
}
