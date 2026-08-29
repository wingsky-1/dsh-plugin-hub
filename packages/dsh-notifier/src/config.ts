/**
 * dsh-notifier — 配置契约与归一化。
 *
 * 内存单一事实源（NotifyConfig，与落盘 JSON 同构）、默认值、白名单归一化
 * 与配置/历史/toast 脚本路径。未知键透传、非法值丢弃回默认的语义都在
 * normalizeConfig 一处收敛。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUIET_ALLOW_KINDS, parseHHMM } from "./quiet-hours.ts";
import type { QuietHoursConfig } from "./quiet-hours.ts";

/** 通知配置（内存单一事实源，与落盘 JSON 同构）。 */
export interface NotifyConfig {
  notifyAsk: boolean;
  notifyQuestion: boolean;
  notifyTaskDone: boolean;
  /** 子代理完成通知（独立于主任务完成，默认关）。 */
  notifySubagentDone: boolean;
  notifyTaskError: boolean;
  notifyTurnEnd: boolean;
  systemNotify: boolean;
  browserNotify: boolean;
  notifyWhenVisible: boolean;
  /** 系统通知是否带提示音（false = silent，静默弹出）。 */
  notifySound: boolean;
  quietHours: QuietHoursConfig;
  errorMergeWindowMs: number;
  /** 审批等待超时二次提醒（分钟；0 = 关闭）。 */
  askRemindMin: number;
  /** 完成风暴聚合窗口（毫秒；0 = 关闭聚合，每条完成即时通知）。 */
  doneMergeWindowMs: number;
  /** 通知历史按天自动清理（0 = 不按时间清理，仅行数上限滚动）。 */
  historyMaxAgeDays: number;
  /** SSE 连接表上限（同机同时在线的服务端未释放句柄数；超限淘汰最老连接，
   *  防半开幽灵连接只增不减耗尽资源）。 */
  maxConnections: number;
}

/** 布尔配置键联合（normalizeConfig 白名单与客户端渲染依赖它）。 */
type BooleanKeys = { [K in keyof NotifyConfig]: NotifyConfig[K] extends boolean ? K : never }[keyof NotifyConfig];

/** apply 接收的配置（enabled / 路径覆盖）。 */
export interface NotifierApplyConfig {
  enabled?: boolean;
  configFile?: string;
  toastScript?: string;
  historyFile?: string;
}

/** 默认配置。 */
export const DEFAULT_CONFIG: NotifyConfig = {
  notifyAsk: true,
  /** 用户提问（ask_user_question / GUI 提问弹窗）时通知。 */
  notifyQuestion: true,
  notifyTaskDone: true,
  /** 子代理完成通知（独立开关，默认关：派生任务完成不打扰主流程）。 */
  notifySubagentDone: false,
  notifyTaskError: true,
  notifyTurnEnd: false,
  systemNotify: true,
  browserNotify: true,
  /** 页面可见（聚焦）时也弹浏览器通知；默认 false = 仅页面隐藏时弹（避免打扰）。 */
  notifyWhenVisible: false,
  /** 系统通知默认带提示音。 */
  notifySound: true,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  /** 同类错误合并窗口（毫秒）：窗口内后续错误不再单独通知，累计到下次一并提示。 */
  errorMergeWindowMs: 60000,
  /** 审批等待超时二次提醒（分钟，0=关闭；审批被卡是最高成本事件，值得重提醒）。 */
  askRemindMin: 5,
  /** 完成风暴聚合窗口（毫秒；0=关闭——并行子代理收尾防刷屏，代价是窗口内
   *  后续完成会延迟到窗口到点以聚合条补发）。 */
  doneMergeWindowMs: 3000,
  /** 通知历史按天自动清理（0=不按时间清理，仅靠行数上限滚动）。 */
  historyMaxAgeDays: 0,
  /** SSE 连接表上限默认 16：覆盖多设备×多页签 + 幽灵余量；超出淘汰最老连接，
   *  客户端断开后自动重连 + since 补拉，无感知。 */
  maxConnections: 16,
};

/** 布尔配置键（单一事实源：normalizeConfig 白名单与客户端渲染依赖它）。 */
export const CONFIG_KEYS: readonly BooleanKeys[] = ["notifyAsk", "notifyQuestion", "notifyTaskDone", "notifySubagentDone", "notifyTaskError", "notifyTurnEnd", "systemNotify", "browserNotify", "notifyWhenVisible", "notifySound"];

/** 配置存储路径。 */
export function configFile() {
  return join(homedir(), ".dsh", "dsh-notifier.json");
}

/** 通知历史文件路径（jsonl 追加；与配置同目录）。 */
export function historyFile() {
  return join(homedir(), ".dsh", "dsh-notifier-history.jsonl");
}

/** toast 脚本路径（本插件 lib 下）。 */
export function toastScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "toast.ps1");
}

/** 合并配置（未知键丢弃，默认值兜底；深拷贝防默认值被污染）。 */
export function normalizeConfig(input: unknown): NotifyConfig {
  const base: NotifyConfig = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours } };
  if (typeof input !== "object" || input === null) return base;
  const src = input as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (typeof src[key] === "boolean") base[key] = src[key];
  }
  if (Number.isFinite(src.errorMergeWindowMs) && (src.errorMergeWindowMs as number) >= 0 && (src.errorMergeWindowMs as number) <= 3600000) {
    base.errorMergeWindowMs = Math.round(src.errorMergeWindowMs as number);
  }
  if (Number.isFinite(src.askRemindMin) && (src.askRemindMin as number) >= 0 && (src.askRemindMin as number) <= 600) {
    base.askRemindMin = Math.round(src.askRemindMin as number);
  }
  if (Number.isFinite(src.doneMergeWindowMs) && (src.doneMergeWindowMs as number) >= 0 && (src.doneMergeWindowMs as number) <= 60000) {
    base.doneMergeWindowMs = Math.round(src.doneMergeWindowMs as number);
  }
  if (Number.isFinite(src.historyMaxAgeDays) && (src.historyMaxAgeDays as number) >= 0 && (src.historyMaxAgeDays as number) <= 3650) {
    base.historyMaxAgeDays = Math.round(src.historyMaxAgeDays as number);
  }
  if (Number.isFinite(src.maxConnections) && (src.maxConnections as number) >= 1 && (src.maxConnections as number) <= 1024) {
    base.maxConnections = Math.round(src.maxConnections as number);
  }
  if (typeof src.quietHours === "object" && src.quietHours !== null) {
    const qh = src.quietHours as Record<string, unknown>;
    if (typeof qh.enabled === "boolean") base.quietHours.enabled = qh.enabled;
    // 时/分范围校验（0-23/0-59）：复用 parseHHMM，非法值（如 25:00）丢弃回默认，
    // 避免「配置保存成功但免打扰永不生效」的静默失败
    if (typeof qh.start === "string" && /^\d{2}:\d{2}$/u.test(qh.start) && parseHHMM(qh.start) >= 0) base.quietHours.start = qh.start;
    if (typeof qh.end === "string" && /^\d{2}:\d{2}$/u.test(qh.end) && parseHHMM(qh.end) >= 0) base.quietHours.end = qh.end;
    // 紧急例外 kind 白名单过滤
    if (Array.isArray(qh.allowKinds)) {
      base.quietHours.allowKinds = qh.allowKinds.filter((k): k is string => typeof k === "string" && (QUIET_ALLOW_KINDS as readonly string[]).includes(k));
    }
  }
  // 未知键透传：白名单之外的键原样保留（此插件在旧版本运行或手改配置时会
  // 出现未来版本/第三方键），避免「降级丢键」——只归一化你认识的键。
  const out = base as NotifyConfig & Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    // 已归一化过的键不再透传（否则非法值会以原样覆盖归一化结果）
    if (key === "quietHours" || key === "errorMergeWindowMs" || key === "askRemindMin" || key === "doneMergeWindowMs" || key === "historyMaxAgeDays" || key === "maxConnections") continue;
    out[key] = src[key];
  }
  return out;
}
