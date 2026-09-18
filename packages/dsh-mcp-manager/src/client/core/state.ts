/**
 * dsh-mcp-manager — 客户端状态类型与工厂。
 *
 * 所有可变状态收进单一 McpState 对象，在 apply() 内创建，经参数传递到各模块。
 * 禁止模块级全局变量，确保连续挂载/卸载无残留。
 *
 * 跨端 DTO 形状（服务器列表条目 / 浮窗 UI 配置）的物理定义在 src/shared/dto.ts
 * （D5）：这里只做薄 re-export，客户端不得自带等值副本——一致性锁
 * test/e2e/cross-end-lock.test.ts 与 test/integration/service-contract.test.ts 盯这条。
 */

import { API } from "./constants.ts";
import { DEFAULT_Z_INDEX_BASE } from "../../shared/interface.ts";
import type { ClientUiConfig, ServerState } from "../../shared/interface.ts";

export type { ClientUiConfig, McpServerListEntry } from "../../shared/interface.ts";

/** 各状态计数（六态键的物理定义在 shared/status.ts，宿主与客户端同一份）。 */
export type McpCounts = Partial<Record<ServerState, number>>;

/** MCP 管理器客户端全部可变状态。 */
export interface McpState {
  /** 模态面板遮罩层根元素。 */
  overlay: any;
  /** 模态面板卡片根元素。 */
  card: any;
  /** 模态面板 body 容器。 */
  bodyEl: any;
  /** 模态面板是否打开。 */
  open: boolean;
  /** 当前激活的 tab（servers / quick）。 */
  activeTab: string;
  /** 服务器列表。 */
  servers: any[];
  /** 各状态计数。 */
  counts: any;
  /** 正在编辑的服务器名称（undefined 表示新建）。 */
  editingName: any;
  /** 正在编辑的服务器原始数据。 */
  editing: any;

  // 表单 DOM 引用
  formName: any;
  formScope: any;
  formTransport: any;
  formCommand: any;
  formArgs: any;
  formEnv: any;
  formCwd: any;
  formUrl: any;
  formHeaders: any;
  formEnabled: any;

  // 浮窗状态
  floatPill: any;
  floatPanel: any;
  floatOpen: boolean;
  currentCwd: any;
  projectRoot: any;
  updateFloatState: any;
  mcpUiConfig: ClientUiConfig;

  // 路径表（单一来源 src/shared/routes.ts，经 client/core/constants.ts 投影）。
  API: typeof API;
}

/** 创建初始状态对象。 */
export function createState(): McpState {
  return {
    overlay: undefined,
    card: undefined,
    bodyEl: undefined,
    open: false,
    activeTab: "servers",
    servers: [],
    counts: {},
    editingName: undefined,
    editing: undefined,
    formName: undefined,
    formScope: undefined,
    formTransport: undefined,
    formCommand: undefined,
    formArgs: undefined,
    formEnv: undefined,
    formCwd: undefined,
    formUrl: undefined,
    formHeaders: undefined,
    formEnabled: undefined,
    floatPill: undefined,
    floatPanel: undefined,
    floatOpen: false,
    currentCwd: undefined,
    projectRoot: undefined,
    updateFloatState: undefined,
    mcpUiConfig: {
      position: "top-right",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: DEFAULT_Z_INDEX_BASE,
    },
    API: { ...API },
  };
}

/**
 * 跨模块动作回调集合。
 * index.ts 装配，避免 feature 模块间循环依赖——各模块通过 actions 调用
 * 其他模块的功能（如 servers.ts 调用 actions.refresh / actions.resetForm）。
 */
export interface UiActions {
  refresh: () => Promise<boolean>;
  resetForm: () => void;
  beginEdit: (server: any) => void;
  switchTab: (tab: string) => void;
  close: () => void;
  showPanel: () => void;
  toggleFloat: (force?: boolean) => void;
}
