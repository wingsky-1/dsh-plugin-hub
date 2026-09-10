/**
 * dsh-notifier — sdk/interface.ts：SDK 契约域唯一对外引用面。
 *
 * 本域是包对外 ABI（'wingsky.notifier' 服务 + 消息模型 + Channel SPI）的
 * 类型与工厂收口：类型物理定义在本文件（§3-2：本域独有、需面外的类型在
 * interface.ts 定义），工厂/常量从 service.ts re-export；非本域原创类型
 * （NotifyConfig/NotifyDetail/SseHub 等）一律 import type 自依赖域（P2-11）。
 * 消费方（其他 hub 插件）与装配层（index.ts）都从这里引用（verify-dir-imports
 * 静态强制）。
 */
import type { NotifyConfig } from "../config/interface.ts";
import type { SseHub, SystemNotifier } from "../server/interface.ts";
import type { HistoryStore } from "../stores/interface.ts";
import type { NotifyDetail } from "../text/interface.ts";

// ---------------------------------------------------------------- 消息模型

/** 展示强度（severity 仅展示；过滤语义归 kind）。 */
export type NotifySeverity = "info" | "success" | "warning" | "failure";

/** 通知请求（外部调用方通用入口）。 */
export interface NotifyRequest {
  /** 调用方标识（source-short 与 kind 前缀同源，如 '@wingsky-1/dsh-notifier'）。 */
  source: string;
  /** kind：内置七 kind 或经 registerKind 注册的动态 kind（'<source-short>:<id>'）。 */
  kind: string;
  severity: NotifySeverity;
  /** 正文（调用方负责脱敏，中心兜底截断）。 */
  body: string;
  title?: string;
  /** 频道专有透传（MVP 仅 string 值、白名单字段见 config）。 */
  data?: Record<string, string>;
}

/** 单个频道的受理结果。 */
export interface NotifyResult {
  channelId: string;
  status: "ok" | "skipped" | "failed";
  error?: string;
}

/** 动态 kind 注册（仅 host 侧插件进程可调；模型工具不得注册）。 */
export interface KindRegistration {
  /** '<source-short>:<id>'，实现侧校验前缀与 source 归属，防冒认。 */
  id: string;
  /** 设置页展示名（展示层文本，非推送内容）。 */
  label: string;
  /** 建议路由（MVP 保留字段，未启用稀疏覆盖）。 */
  channels?: string[];
}

// ---------------------------------------------------------------- Channel SPI

/** 频道能力声明（框架据此做降级：标题并入 / 超长截断）。 */
export interface ChannelCapabilities {
  /** 标题最大码点数；<=0 表示不支持标题（并入正文）。 */
  titleMaxLen: number;
  /** 正文最大码点数（超长按此截断）。 */
  maxBodyLen: number;
}

/** 频道最小实现契约。 */
export interface NotifyChannel {
  /** 即 channelId，唯一。 */
  name: string;
  capabilities: ChannelCapabilities;
  /**
   * 投递一条已解析消息；同步抛错即该频道受理 failed；返回 promise 时其决议
   * 为投递终态（resolve=成功 / reject=失败，错误须已脱敏），调用方据此记录
   * status 与 sent 事件（受理结果不受终态影响——铁律 1）。
   */
  send(payload: { title: string; body: string; kind: string; ts: number; severity?: NotifySeverity }): void | Promise<void>;
}

// ---------------------------------------------------------------- Service 契约

/** 'wingsky.notifier' 服务面（消费方经 ctx['wingsky.notifier'] 调用）。 */
export interface NotifierService {
  readonly apiVersion: 1;
  /** 注册动态 kind（待确认；确认前 send 走 suppressed）。 */
  registerKind(reg: KindRegistration): void;
  /** 确认/撤销一个动态 kind（设置页调用；内置 kind 无需确认）。 */
  confirmKind(kind: string, confirmed: boolean): void;
  /** 查询动态 kind 注册与确认态（设置页渲染）。 */
  listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
  /** 注册一个插件贡献频道（MVP：进注册表待用户开启，未启用不投递）。 */
  registerChannel(ch: NotifyChannel): void;
  /** 通用发送入口：快速返回受理结果，投递终态经落盘/事件可见。 */
  send(req: NotifyRequest): Promise<NotifyResult[]>;
}

/** 内部服务面（装配层专用：内置事件源经 sendKind 走完整文案管线）。 */
export interface NotifierServiceInternal extends NotifierService {
  /**
   * 内置事件源入口（等价搬移前的 notify(kind, detail) 完整语义：kind 文案
   * 模板渲染 + 动态 kind 确认检查 + 免打扰 + fail-soft 分发 + 历史落盘）。
   * @returns 受理结果（调用方以 results.some(r => r.status === 'ok') 判定
   *   是否真正发出——与旧 notify() 的 boolean 语义逐点对齐）。
   */
  sendKind(kind: string, detail?: NotifyDetail, opts?: { bypassQuiet?: boolean; onlyChannel?: string }): NotifyResult[];
}

/** createNotifierService 的注入面（全部由 index.ts 装配层提供）。 */
export interface NotifierServiceDeps {
  /** 当前生效配置（settings 解析值；dispatch 时实时读取）。 */
  current(): NotifyConfig;
  /** 总开关（组合层 enabled；false 时 send 一律 skipped）。 */
  enabled(): boolean;
  /** SSE 推送枢纽（browser 频道）。 */
  sse: SseHub;
  /** 系统通知通道。 */
  system: SystemNotifier;
  /** 历史存储（落盘 fire-and-forget）。 */
  history: HistoryStore;
  /** 日志出口。 */
  logger: { warn: (m: string) => void; info: (m: string) => void };
  /** 配置驱动的出站频道（M2：bark 实例；enabled 过滤后返回，每次 dispatch 现取）。 */
  outboundChannels(): Array<{ id: string; channel: NotifyChannel }>;
  /** 频道投递终态落盘（status 文件；错误文本已由调用方脱敏）。 */
  recordStatus(channelId: string, status: "ok" | "failed", error?: string): void;
  /** 投递终态事件（'wingsky-notify/sent'；装配层 try/catch 包裹，缺服务静默跳过）。 */
  emitSent(payload: NotifySentEvent): void;
  /** 动态 kind 确认写入（持久化到配置 allowKinds；fire-and-forget）。 */
  setConfirm(kind: string, confirmed: boolean): void;
}

/** 投递终态事件负载（'wingsky-notify/sent'；旁观插件订阅面，铁律 1 的事件半边）。 */
export interface NotifySentEvent {
  kind: string;
  /** 消息标题（模板渲染后）。 */
  title: string;
  /** 消息正文（模板渲染后）。 */
  message: string;
  /** 投递频道 id。 */
  channelId: string;
  /** 投递终态。 */
  status: "ok" | "failed";
  /** 失败摘要（已脱敏；ok 时缺省）。 */
  error?: string;
  ts: number;
}

/** 内置频道 id。 */
export const BUILTIN_CHANNELS = {
  browser: "browser",
  system: "system",
} as const;

// 便捷访问与实现工厂（实现同目录 service.ts，本文件收口对外面）
export { createNotifierService, getNotifierService } from "./service.ts";