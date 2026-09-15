/**
 * dsh-mcp-manager — connection/runtime 中间层连接池类型落点（#767 W11b2a）。
 *
 * 供中间层池（runtime/middleware.ts）与其宿主面取用；目录外消费经
 * connection/runtime/interface.ts → connection/interface.ts 的门面链（type-only，编译期擦除）。
 */

import type { ServerConfig } from "../../../../config/interface.ts";
import type { CatalogServer } from "../../../../catalog/interface.ts";
import type { MCPClient, StdioTransport, HttpTransport } from "../../interface.ts";

/** 连接池条目（每工作空间一套）。 */
export interface ProjectUnit {
  root: string;
  /** server 名（裸名）→ 连接条目。 */
  connections: Map<string, ConnectionEntry>;
  /** 目录缓存（last-good：连接断不丢）。 */
  catalog: Map<string, CatalogServer>;
  /** 用户禁用集合（持久化）。 */
  userDisabled: Set<string>;
  /** 最近触达时间（LRU 淘汰依据）。 */
  lastTouchedAt: number;
  /** 连接/发现 in-flight 去重（server 名 → Promise）。 */
  inFlight: Map<string, Promise<unknown>>;
}

/** 单服务器连接条目。 */
export interface ConnectionEntry {
  server: ServerConfig;
  client: MCPClient | undefined;
  transport: StdioTransport | HttpTransport | undefined;
  /** 连接状态：connecting / connected / failed / disabled。 */
  status: string;
  error: unknown;
  connectedAt: number | undefined;
  /** 后台重连定时器。 */
  reconnectTimer: NodeJS.Timeout | undefined;
  /** 代际断开清理。 */
  disposed: boolean;
  /** 连续失败次数（有界指数退避依据；连接成功后清零）。 */
  failedAttempts: number;
  /** 防双进程探测命中后的重试已排（#382 F5：只重试一次；连接成功后复位）。 */
  probeRetried?: boolean;
}
