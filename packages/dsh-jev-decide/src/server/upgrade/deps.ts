/** upgrade 域出口：注入面（纯类型，零运行时）。落盘原语由组合根从 store 域装配，本域不直引他域实现。 */

/** 最小日志面。 */
export interface LoggerPort {
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}

/** 迁移所需落盘原语面。 */
export interface UpgradeIoPorts {
  readonly readJsonSync: (
    file: string,
  ) => { readonly ok: true; readonly value: unknown } | { readonly ok: false };
  readonly readTextSync: (
    file: string,
  ) => { readonly ok: true; readonly text: string } | { readonly ok: false };
  readonly atomicWrite0600Sync: (file: string, text: string) => void;
  readonly listFilesSync: (dir: string) => string[];
}

/** 种子文件内容（默认值唯一事实源在 config 域 model，组合根装配时传入，本域不直引）。 */
export interface SeedFiles {
  readonly configJson: string;
  readonly presetsJson: string;
  readonly secretsJson: string;
}

/** upgrade 域运行所需注入（home 缺席即 DSH home；targetOverride 仅单测定版）。 */
export interface UpgradeDeps {
  readonly io: UpgradeIoPorts;
  readonly logger: LoggerPort;
  readonly home?: string;
  readonly targetOverride?: string;
  readonly seedDefaults: () => SeedFiles;
}
