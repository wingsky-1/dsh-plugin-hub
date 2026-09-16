/**
 * dsh-mcp-manager — connection/runtime 中间层连接池类型落点（#767 W11b2a）。
 *
 * 供中间层池（runtime/middleware.ts）与其宿主面取用；目录外消费经
 * connection/runtime/interface.ts → connection/interface.ts 的门面链（type-only，编译期擦除）。
 */

import type { ServerConfig } from "../../../../config/interface.ts";
import type { ServerState } from "../../../../../shared/interface.ts";
import type { MountedPlugin } from "../../../../shared/interface.ts";

/** 连接池条目（每工作空间一套）。 */
export interface ProjectUnit {
  root: string;
  /**
   * server 名（裸名）→ 连接条目。工具目录（last-good）自 #767 S1-3b 起归 catalog 域，
   * 本单元不再持目录——消费方改经 catalog 的读口（serversFor / entryFor）。
   */
  connections: Map<string, ConnectionEntry>;
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
  /**
   * 官方实例的账本键 = 交给官方的 serverName，也是注册名 `mcp__<id>__<tool>` 的前缀来源。
   * 虚拟连接单元（toolDefinitions，从不挂官方实例）恒为 undefined。
   */
  id: string | undefined;
  /** 我方账本里这一代际的句柄；`disposed` 是六态投影的输入面（虚拟单元恒 undefined）。 */
  handle: MountedPlugin | undefined;
  /** 连接状态（六态；换引擎后由 lifecycle 的投影写回，见 McpMiddleware.statusOf）。 */
  status: ServerState;
  error: unknown;
  connectedAt: number | undefined;
  /** 装载等待窗口是否已结算——成功、失败、异常都算（connecting 与后续态的判据）。 */
  readySettled: boolean;
  /** 本代际是否曾进入 connected（区分「首连就没成功」与「连上过又掉线」）。 */
  everConnected: boolean;
  /** 代际断开清理。 */
  disposed: boolean;
}
