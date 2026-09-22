/** api 域出口：注入面（纯类型，零运行时）。 */
import type { ConfigV1, HistoryEntry } from "../../shared/interface.ts";

/** 最小日志面。 */
export interface LoggerPort {
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
}

/** 路由注册口（组合根唯一够得着 ctx.webServer 的地方转交）。 */
export interface RouteRegistration {
  (route: {
    readonly kind: "exact";
    readonly path: string;
    readonly handler: (req: unknown, res: unknown) => void;
  }): () => void;
}

/** 历史查询形（api  own 窄面，防腐：history 域签名演进不直接扩散）。 */
export interface HistoryQuery {
  readonly root?: string;
  readonly sessionId?: string;
  readonly limit?: number;
}

/** 预设清单项（api 回显面；出题规范随目录下发）。 */
export interface PresetListItem {
  readonly id: string;
  readonly enabled: boolean;
  readonly templateVersion: 1;
  readonly automationCap: number;
  readonly label: string;
  readonly description: string;
  readonly custom: boolean;
}

/** api 域运行所需注入（全部由组合根装配，域内无 ctx、无直接跨域引用）。 */
export interface ApiDeps {
  readonly logger: LoggerPort;
  readonly register: RouteRegistration;
  readonly version: () => string;
  readonly readConfig: () => ConfigV1;
  readonly writeConfig: (body: unknown) => ConfigV1;
  readonly readPresets: () => PresetListItem[];
  readonly readHistory: (query: HistoryQuery) => HistoryEntry[];
  readonly removeHistory: (query: HistoryQuery) => { readonly deleted: boolean };
  readonly probeConnection: (body: unknown) => Promise<
    | { readonly ok: true; readonly latencyMs: number }
    | {
        readonly ok: false;
        readonly errorCode: string;
        readonly category: string;
        readonly message: string;
      }
  >;
}
