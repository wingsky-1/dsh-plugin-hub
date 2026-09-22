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
import type { ClientUiConfig, McpServerListEntry, ServerState } from "../../shared/interface.ts";

export type { ClientUiConfig, McpServerListEntry } from "../../shared/interface.ts";

/** 各状态计数（六态键的物理定义在 shared/status.ts，宿主与客户端同一份）。 */
export type McpCounts = Partial<Record<ServerState, number>>;

/** MCP 管理器客户端全部可变状态。 */
export interface McpState {
  /** 模态面板遮罩层根元素。 */
  overlay: HTMLElement | undefined;
  /** 模态面板卡片根元素。 */
  card: HTMLElement | undefined;
  /** 模态面板 body 容器。 */
  bodyEl: HTMLElement | undefined;
  /** 模态面板是否打开。 */
  open: boolean;
  /** 打开面板时的焦点归属（R6 关还焦：close 时恢复；非元素/已卸载则跳过）。 */
  panelOpener: HTMLElement | undefined;
  /** 当前激活的 tab（servers / quick）。 */
  activeTab: string;
  /** 服务器列表。 */
  servers: McpServerListEntry[];
  /** 各状态计数。 */
  counts: McpCounts;
  /** 正在编辑的服务器名称（undefined 表示新建）。 */
  editingName: string | undefined;
  /** 正在编辑的服务器原始数据。 */
  editing: McpServerListEntry | undefined;

  // 表单 DOM 引用
  formName: HTMLInputElement | undefined;
  formScope: HTMLSelectElement | undefined;
  formTransport: HTMLSelectElement | undefined;
  formCommand: HTMLInputElement | undefined;
  formArgs: HTMLInputElement | undefined;
  formEnv: HTMLTextAreaElement | undefined;
  formCwd: HTMLInputElement | undefined;
  formUrl: HTMLInputElement | undefined;
  formHeaders: HTMLTextAreaElement | undefined;
  formEnabled: HTMLInputElement | undefined;

  // 浮窗状态
  floatPill: HTMLElement | undefined;
  floatPanel: HTMLElement | undefined;
  floatOpen: boolean;
  currentCwd: string | undefined;
  projectRoot: string | undefined;
  updateFloatState: (() => void) | undefined;
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
    panelOpener: undefined,
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
  beginEdit: (server: McpServerListEntry) => void;
  switchTab: (tab: string) => void;
  close: () => void;
  showPanel: () => void;
  toggleFloat: (force?: boolean) => void;
}

/**
 * 会话快照条目（S2 ctx 形状最小面：cwd/blank；H6 不反向依赖未清洁形状）。
 */
export interface McpSessionEntry {
  cwd?: string;
  blank?: boolean;
}

/**
 * 会话快照（S2：current/byId 最小面；成员一律 optional，调用侧 ?./typeof 守卫保留 H4）。
 */
export interface McpSessionSnapshot {
  current?: string;
  byId?: Record<string, McpSessionEntry>;
}

/** 会话列表服务最小面（成员一律 optional）。 */
export interface McpSessionList {
  getSnapshot?: () => McpSessionSnapshot | undefined;
  subscribe?: (listener: () => void) => () => void;
}

/** locale 服务最小面（成员一律 optional；调用前 typeof 守卫保留 H4）。 */
export interface McpLocaleService {
  register?: (ns: string, dict: unknown) => void;
  subscribe?: (listener: () => void) => () => void;
  getSnapshot?: () => unknown;
  bind?: (ns: string) => (key: string, params?: Record<string, unknown>) => string;
}

/** slots 服务最小面（成员一律 optional；调用侧 typeof/?. 守卫承接，G2 零行为改动）。 */
export interface McpSlotsService {
  inject?: (name: string, setup: () => unknown) => void;
  register?: (item: Record<string, unknown>, render: () => unknown) => unknown;
}

/**
 * 客户端上下文最小面（S2：get 重载 + effect + sessions?；H6 不反向依赖未清洁形状）。
 * get("locale"/"slots")返回 optional 视图，未声明服务时为 undefined；其余名回落 unknown。
 */
export interface McpClientContext {
  get(name: "locale"): McpLocaleService | undefined;
  get(name: "slots"): McpSlotsService | undefined;
  get(name: string): unknown;
  effect: (fn: () => () => void, label?: string) => void;
  sessions?: {
    list?: McpSessionList;
  };
}

/**
 * 客户端 HTTP 请求选项最小面（P3-b/B6：api 二选一选 A 泛型）。
 * 继承 DOM RequestInit（method/headers/body/signal），仅增 timeoutMs 兜底预算。
 */
export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}
