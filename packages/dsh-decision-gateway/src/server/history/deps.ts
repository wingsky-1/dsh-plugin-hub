/** history 域出口：注入面（纯类型，零运行时）。 */

/** 最小日志面。 */
export interface LoggerPort {
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}

/** 落盘原语面（组合根用 store 域实现装配）。 */
export interface HistoryIoPorts {
  readonly readTextSync: (
    file: string,
  ) => { readonly ok: true; readonly text: string } | { readonly ok: false };
  readonly atomicWrite0600Sync: (file: string, text: string) => void;
  readonly listFilesSync: (dir: string) => string[];
  readonly mtimeMs: (file: string) => number;
  readonly removeFileSync: (file: string) => void;
  readonly ensureDir0700: (dir: string) => void;
}

/** history 域运行所需注入。 */
export interface HistoryDeps {
  readonly io: HistoryIoPorts;
  readonly logger: LoggerPort;
}
