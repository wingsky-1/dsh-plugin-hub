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
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";

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
  /**
   * 是否已解析出当前会话（#1028）。false = **未知**，与「已知但无 cwd」是两态：
   * 未知时不得向宿主上报 `cwd:""`，否则会把「读不到」变成「清空项目级绑定」。
   */
  sessionResolved: boolean;
  /** 未知态的一次性告警闸（可观测性：未知态无 UI 表现，不告警等于静默失效）。 */
  warnedUnknownSession: boolean;
  /**
   * 连续未知帧计数（#1028 告警口径）。官方会话快照要等 mainView 持有才就绪，
   * 故**首帧未知是竞态不是故障**（每次冷启动必现）；用它把噪声与真失联分开。
   */
  unknownSessionFrames: number;
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
    sessionResolved: false,
    warnedUnknownSession: false,
    unknownSessionFrames: 0,
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
 * locale 服务最小面：官方 `LocaleRuntime`（dsh-client-locale，宿主 ctx.locale）的 Pick。
 * 成员一律必选——官方类上本就是必选方法，服务本体缺失由 `ctx.get("locale")` 的
 * `| undefined` 表达；index.ts 里既有的 typeof 守卫（H4）是运行时防御，原样保留。
 *
 * 官方形状对齐说明：官方 `register` 两个重载都返回 disposer `() => void`，本包调用点
 * **既成事实地丢弃**该返回值（只把 subscribe 的 unsub 存进 effect 卸载），此处仅把返回
 * 类型按官方补齐，**不新增任何清理/生命周期逻辑**。`getSnapshot` 官方必返 `LocaleSnapshot`，
 * 本包只在 typeof 守卫里探测成员存在，从不读返回值，故面里只带方法类型不带结果。
 */
export type McpLocaleService = Pick<
  LocaleRuntime,
  "register" | "subscribe" | "getSnapshot" | "bind"
>;

/**
 * slots 服务最小面：官方 `SlotRegistry`（dsh-client-ui-renderer，宿主 ctx.slots）的
 * inject/register Pick，与 index.ts 的行配置装配面同源同形。
 *
 * 官方形状对齐说明：官方 `inject(key, callback)` 与 `register(options, component)` **都**
 * 返回 disposer `() => void`；本类型此前把 inject 误写成返回 void（index.ts 的局部声明
 * 反而写对了），此处一律以官方为准。成员不再 optional：服务本体缺失已由
 * `ctx.get("slots")` 的 `| undefined` 表达，调用点本就先判空再调（G2 零行为改动）。
 */
export type McpSlotsService = Pick<SlotRegistry, "inject" | "register">;

/**
 * 客户端上下文最小面（S2：get 重载 + effect + sessions?；H6 不反向依赖未清洁形状）。
 * get("locale"/"slots")返回上两个官方派生面，未声明服务时为 undefined；其余名回落 unknown。
 */
export interface McpClientContext {
  get(name: "locale"): McpLocaleService | undefined;
  get(name: "slots"): McpSlotsService | undefined;
  get(name: string): unknown;
  effect: (fn: () => () => void, label?: string) => void;
  /**
   * 官方会话服务（#1028：不再自建镜像面——rc.2 的 `SessionListState` 已无 `current`，
   * 自建形状会与官方静默分叉）。未注入时为 undefined。
   */
  sessions?: ISessions;
}

/**
 * 客户端 HTTP 请求选项最小面（P3-b/B6：api 二选一选 A 泛型）。
 * 继承 DOM RequestInit（method/headers/body/signal），仅增 timeoutMs 兜底预算。
 */
export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}
