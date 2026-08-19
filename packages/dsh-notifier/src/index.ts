/**
 * dsh-notifier — 审批/完成/错误事件通知（宿主端）。
 *
 * 事件源（均经源码核验）：
 * - 审批请求：approval/request waterfall（ApprovalService.request 派发；
 *   真实触发方为沙箱提权 / 动态插件激活等。tools/pre-execute 的 gate ask
 *   在当前 DSH 部署中无产生者，不可用）。在 next() 之前通知（next 阻塞到
 *   用户审批结束），不短路
 * - 任务完成：agent/status（scoped emit，{agent, status}，idle | running）
 *   running → idle 跃迁，per-agent 状态机，多会话互不误报；子代理
 *   （header.delegationDepth ≥ 1）走独立开关/事件类型 subagent-done；
 *   用户暂停/中断（turn/end reason aborted）固定静默
 * - 任务错误：agent/error（{agent, turn, step, error}），60 秒滚动窗口合并
 * - 轮结束：agent/turn-stopping（serial，{agent, turn}，仅宿主通知，不跑模型）
 * - 会话销毁：agent/disposed（清理 per-agent 状态）
 *
 * 通道：
 * - 系统通知：Windows PowerShell WinRT toast（lib/toast.ps1，零依赖）；
 *   Linux/macOS 用 notify-send（存在才调用）；均失败则仅记录日志
 * - 浏览器通知：SSE（text/event-stream，mcp-manager 同款模式）推帧，
 *   客户端 Notification API 展示（页面隐藏时）
 *
 * 配置：~/.dsh/dsh-notifier.json（PUT /config 可改，落盘）
 * 安全：通知文本只含工具名/会话标识/申请理由等元信息，不含工具参数（防敏感信息外泄）。
 */
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import type { PluginContext, DshRoute } from "../../../types/dsh.js";

/** 稳定的 cordis 插件名。 */
export const name = "notifier";

/** 需要的服务：webServer（路由）。 */
export const inject = ["webServer"];

/** 免打扰时段配置。 */
export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

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

/** 通知详情（不含工具参数等敏感信息）。 */
export interface NotifyDetail {
  tool?: string;
  taskTitle?: string;
  reason?: string;
  question?: string;
  durationMs?: number;
  turn?: number;
  step?: number;
  message?: string;
  mergedCount?: number;
  ts?: number;
}

/** Agent 对象最小面（事件 payload.agent；session.events 取会话标题与 turn/end）。 */
export interface AgentLite {
  id?: string;
  session?: {
    /** 子代理深度标记（dsh-subagent 写入：子代理 ≥1，主 agent 无此字段）。 */
    header?: { delegationDepth?: unknown };
    events?: Array<{
      type?: string;
      data?: { title?: unknown; turn?: unknown; reason?: { kind?: unknown } };
    }>;
  };
}

/** 与客户端共享的路由常量（smoke 断言两端一致）。 */
export const ROUTES = {
  config: "/api/dsh-notifier/config",
  events: "/api/dsh-notifier/events",
  health: "/api/dsh-notifier/health",
  test: "/api/dsh-notifier/test",
  history: "/api/dsh-notifier/history",
};

/** 通知历史滚动上限（行数；超出后从尾部截断重写）。 */
export const HISTORY_LIMIT = 200;

/** 通知历史文件路径（jsonl 追加；与配置同目录）。 */
export function historyFile() {
  return join(homedir(), ".dsh", "dsh-notifier-history.jsonl");
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
};

/** 布尔配置键（单一事实源：normalizeConfig 白名单与客户端渲染依赖它）。 */
export const CONFIG_KEYS: readonly BooleanKeys[] = ["notifyAsk", "notifyQuestion", "notifyTaskDone", "notifySubagentDone", "notifyTaskError", "notifyTurnEnd", "systemNotify", "browserNotify", "notifyWhenVisible", "notifySound"];

/** 配置存储路径。 */
export function configFile() {
  return join(homedir(), ".dsh", "dsh-notifier.json");
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
  if (Number.isFinite(src.errorMergeWindowMs) && (src.errorMergeWindowMs as number) > 0) {
    base.errorMergeWindowMs = Math.min(Math.round(src.errorMergeWindowMs as number), 3600000);
  }
  if (typeof src.quietHours === "object" && src.quietHours !== null) {
    const qh = src.quietHours as Record<string, unknown>;
    if (typeof qh.enabled === "boolean") base.quietHours.enabled = qh.enabled;
    // 时/分范围校验（0-23/0-59）：复用 parseHHMM，非法值（如 25:00）丢弃回默认，
    // 避免「配置保存成功但免打扰永不生效」的静默失败
    if (typeof qh.start === "string" && /^\d{2}:\d{2}$/u.test(qh.start) && parseHHMM(qh.start) >= 0) base.quietHours.start = qh.start;
    if (typeof qh.end === "string" && /^\d{2}:\d{2}$/u.test(qh.end) && parseHHMM(qh.end) >= 0) base.quietHours.end = qh.end;
  }
  // 未知键透传：白名单之外的键原样保留（此插件在旧版本运行或手改配置时会
  // 出现未来版本/第三方键），避免「降级丢键」——只归一化你认识的键。
  const out = base as NotifyConfig & Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    if (key === "quietHours" || key === "errorMergeWindowMs") continue;
    out[key] = src[key];
  }
  return out;
}

/** 毫秒 → 人类可读耗时（如 "45 秒" / "2 分 15 秒" / "1 小时 2 分 5 秒"）。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(" ");
}

/**
 * 错误文本脱敏：掩蔽常见敏感特征（用户路径、长令牌/密钥串、密钥赋值），再截断。
 * 用于 agent/error 进入通知与历史的文本，把「错误信息可能内嵌命令回显/路径/
 * 凭据片段」的外泄面收敛到可读的摘要。
 * @returns 脱敏并截断（默认 300 字符）后的错误文本。
 */
export function sanitizeErrorText(text: unknown, maxLen = 300): string {
  let s = String(text);
  // 用户路径（/home/xx、/Users/xx、C:\Users\xx）→ <path>（排除冒号/分号等后缀
  // 分隔符，避免吞掉紧随其后的文本：`/home/x: EACCES` 应保留冒号）
  s = s.replace(/(?:\/home\/[^\s"'`<>:;]+|\/Users\/[^\s"'`<>:;]+|C:\\Users\\[^\s"'`<>:;]+)/giu, "<path>");
  // 长令牌/密钥串（≥24 hex 或 ≥32 base64）→ <token>
  s = s.replace(/\b(?:[0-9a-fA-F]{24,}|[A-Za-z0-9+/]{32,}={0,2})\b/gu, "<token>");
  // 密钥字段赋值（password=/token=/api_key=…）→ 只留键名+掩码
  s = s.replace(/\b(password|passwd|token|api[_-]?key|secret|authorization)\b\s*[=:]?\s*["']?[^\s"'`,;<>]{3,}/giu, "$1=<redacted>");
  return s.slice(0, maxLen);
}

/**
 * 构造系统通知命令参数（纯函数，smoke 可直接断言参数形态）。
 * - win32：spawn powershell -File toast.ps1 -Title=<t> -Message=<m> [-Silent]
 *   单 token 传参：封掉「消息以 - 开头被解析成参数名」与含空格的歧义，
 *   依旧零 shell 拼接面
 * - darwin：osascript display notification（转义 \ 与 "，换行替换为空格防
 *   脚本语法；silent=false 时带系统提示音 "Glass"）
 * - 其余：notify-send（notifySendAvailable === false 时返回 null=通道不可用）
 * @returns spawn 参数数组（首元素为可执行文件），或 null（不可用）。
 */
export function buildSystemCommand(
  platform: string,
  title: string,
  message: string,
  options: { silent: boolean; notifySendAvailable?: boolean; toastScript: string }
): string[] | null {
  if (platform === "win32") {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.toastScript, `-Title=${title}`, `-Message=${message}`];
    if (options.silent) args.push("-Silent");
    return ["powershell", ...args];
  }
  if (platform === "darwin") {
    const esc = (s: string) => s.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, " ");
    const script = `display notification "${esc(message)}" with title "${esc(title)}"` + (options.silent ? "" : ' sound name "Glass"');
    return ["osascript", "-e", script];
  }
  if (options.notifySendAvailable === false) return null;
  return ["notify-send", title, message];
}

/** 常见工具名 → 中文可读名（业界通知惯例：用用户看得懂的动作描述，而非内部标识）。 */
const TOOL_LABELS: Record<string, string> = {
  pwsh: "PowerShell 命令",
  bash: "终端命令",
  "web_search": "联网搜索",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "搜索文件内容",
  glob: "查找文件",
  subagent: "子代理任务",
  subagent_fork: "子代理任务",
  ssh_exec: "SSH 远程执行",
  ssh_upload: "SSH 上传文件",
  ssh_download: "SSH 下载文件",
  ssh_tunnel: "SSH 端口转发",
  ssh_cluster: "SSH 集群执行",
  ask_user_question: "向你提问",
  todo_write: "更新任务清单",
  job_list: "查看后台任务",
  job_output: "查看任务输出",
  job_kill: "停止后台任务",
  workflow: "工作流编排",
  ralph: "Ralph 循环执行",
  memory_add: "写入项目记忆",
  memory_search: "检索项目记忆",
  skill: "加载技能",
  create_goal: "创建目标",
  get_goal: "查看目标",
  update_goal: "更新目标",
};

/**
 * 工具名美化（业界惯例：可读的动作描述优先）：
 * - 常见工具映射表 → 中文名（如 pwsh → "PowerShell 命令"）
 * - `mcp__server__raw` → `MCP 服务器 "server" 的工具 "raw"`
 * - 其余原样
 */
export function prettyToolName(name: unknown): string {
  const text = String(name ?? "?");
  if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, text)) return TOOL_LABELS[text];
  const parts = text.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") {
    return `MCP 服务器 "${parts[1]}" 的工具 "${parts.slice(2).join("__")}"`;
  }
  return text;
}

/**
 * 提取会话标题（用户可读的任务名，替代内部 session id）。
 * 数据源：agent.session.events 中最后一个 session/title 事件（dsh-session-title
 * 官方插件维护，与 GUI 会话列表同源）。无标题（新会话/未生成）返回 undefined。
 * @param agent Agent 对象（事件 payload.agent）。
 * @returns 截断 40 字符的标题。
 */
export function sessionTitleOf(agent: AgentLite | undefined): string | undefined {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === "session/title" && typeof events[i].data?.title === "string") {
        const title = (events[i] as { data: { title: string } }).data.title.trim();
        return title.length > 0 ? title.slice(0, 40) : undefined;
      }
    }
  } catch {
    // 事件日志读取失败不影响通知主流程
  }
  return undefined;
}

/**
 * 取 agent 会话日志中最新一条 turn/end（倒序扫描；session.events 是混合
 * 日志，turn/end 后可能尾随 session/title、inbox、user/message 等，不能
 * 取 events 末尾——照 sessionTitleOf 同款倒序）。
 * 用于中断抑制：running→idle 时若本轮未闭合新的 turn/end（如 abort 早于
 * turn/start 落盘，dsh-agent-loop turn() 首行 throwIfAborted 在 try 外），
 * 读到的 turn/end 是上一次运行的，不可作为本轮结束依据。
 * @param agent Agent 对象（事件 payload.agent）。
 * @returns {turn, kind}（kind 为 turn/end reason.kind，如 completed /
 *   aborted / error / max-tokens）；无 turn/end 或读取失败返回 undefined。
 */
export function lastTurnEndOf(agent: AgentLite | undefined): { turn: number; kind: string } | undefined {
  try {
    const events = agent?.session?.events;
    if (!Array.isArray(events)) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.type !== "turn/end") continue;
      const reason = ev.data?.reason;
      if (reason === undefined || reason === null || typeof reason !== "object") continue;
      const turn = typeof ev.data?.turn === "number" ? ev.data.turn : NaN;
      const kind = String((reason as { kind?: unknown }).kind ?? "");
      return { turn, kind };
    }
  } catch {
    // 事件日志读取失败不影响通知主流程
  }
  return undefined;
}

/**
 * agent 是否为子代理：session.header.delegationDepth ≥ 1
 * （dsh-subagent 创建子代理时写入 childDepth = parent+1；主 agent 无此
 * 字段/为 0）。先规约数字再比较（strict 下 unknown 不能直接参与比较）。
 */
export function isSubagentOf(agent: AgentLite | undefined): boolean {
  const depth = Number(agent?.session?.header?.delegationDepth ?? 0);
  return Number.isFinite(depth) && depth >= 1;
}

/** "HH:MM" → 分钟数（校验 0-23 时 / 0-59 分）。 */
export function parseHHMM(text: string): number {
  const m = /^(\d{2}):(\d{2})$/u.exec(text);
  if (m === null) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return NaN;
  return hours * 60 + minutes;
}

/** 是否处于免打扰时段（支持跨午夜：start > end）。 */
export function isInQuietHours(now: Date, quietHours: QuietHoursConfig | undefined): boolean {
  if (quietHours?.enabled !== true) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

// 辅助函数统一来自仓库共享层（loopback 围栏 / writeJson / readBody / errorMessage）。
import { isLoopbackRequest } from "../../../shared/loopback.js";
import { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";
export { isLoopbackRequest } from "../../../shared/loopback.js";
export { writeJson, readBody, errorMessage } from "../../../shared/host-utils.js";

/** SSE 帧。 */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 挂载 dsh-notifier。
 * @param ctx 宿主插件上下文。
 * @param config 配置（enabled / configFile 覆盖 / toastScript 覆盖）。
 */
export async function apply(ctx: PluginContext, config: NotifierApplyConfig = {}): Promise<void> {
  if (config.enabled === false) return;
  const storeFile = typeof config.configFile === "string" ? config.configFile : configFile();
  const toastScript = typeof config.toastScript === "string" ? config.toastScript : toastScriptPath();
  const historyStore = typeof config.historyFile === "string" ? config.historyFile : historyFile();

  /** 当前配置（内存单一事实源，PUT 后落盘）。 */
  let current = normalizeConfig(undefined);

  async function loadConfig() {
    try {
      if (!existsSync(storeFile)) return;
      const data = JSON.parse(await readFile(storeFile, "utf8"));
      current = normalizeConfig(data);
    } catch (error) {
      ctx.logger.warn(`dsh-notifier: 配置读取失败（使用默认）: ${errorMessage(error)}`);
    }
  }

  async function saveConfig() {
    try {
      await mkdir(dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, JSON.stringify(current, null, 2), "utf8");
      await rename(tmp, storeFile);
    } catch (error) {
      ctx.logger.warn(`dsh-notifier: 配置落盘失败: ${errorMessage(error)}`);
    }
  }

  // ------------------------------------------------------------ 系统通知

  /** 系统通知节流间隔：防连发（生产密集事件/连点测试按钮）造成 spawn 风暴。 */
  const SYSTEM_NOTIFY_THROTTLE_MS = 1000;
  let lastSystemNotifyAt = 0;

  /**
   * 系统原生 toast（fire-and-forget + 30s 超时杀进程；全部失败静默）。
   * 命令构造走顶层纯函数 buildSystemCommand（smoke 断言参数形态）：
   * Windows：PowerShell WinRT toast；macOS：osascript display notification；
   * 其他：notify-send（可用才调用）。
   */
  function systemNotify(title: string, message: string) {
    // 1s 节流：桌面通知连发只保留第一个，避免子进程风暴
    const now = Date.now();
    if (now - lastSystemNotifyAt < SYSTEM_NOTIFY_THROTTLE_MS) return;
    lastSystemNotifyAt = now;
    const safeTitle = String(title).slice(0, 64);
    const safeMessage = String(message).slice(0, 256);
    let child: ChildProcess | undefined;
    try {
      const argv = buildSystemCommand(process.platform, safeTitle, safeMessage, {
        silent: current.notifySound === false,
        notifySendAvailable,
        toastScript,
      });
      if (argv === null) return; // Linux：notify-send 已探测不可用，静默跳过
      child = spawn(argv[0], argv.slice(1), process.platform === "win32" ? { windowsHide: true, stdio: "ignore" } : { stdio: "ignore" });
    } catch (error) {
      ctx.logger.warn(`dsh-notifier: 系统通知启动失败: ${errorMessage(error)}`);
      return;
    }
    const killer = setTimeout(() => {
      try {
        child!.kill();
      } catch {
        // 忽略
      }
    }, 30000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        ctx.logger.warn(`dsh-notifier: 系统通知失败（exit ${code}）`);
      }
    });
    child.on("error", (error) => {
      clearTimeout(killer);
      if (process.platform !== "win32") notifySendAvailable = false;
      ctx.logger.warn(`dsh-notifier: 系统通知不可用: ${errorMessage(error)}`);
    });
  }

  /** notify-send 可用性探测（非 Windows，异步，只探一次）。 */
  let notifySendAvailable: boolean | undefined = undefined;
  if (process.platform !== "win32") {
    execFile("notify-send", ["--version"], { timeout: 3000 }, (error) => {
      notifySendAvailable = error === null;
    });
  }

  // ------------------------------------------------------------ SSE 推送

  const sseConnections = new Set<ServerResponse>();

  /** SSE 已派发帧的滚动缓冲（断线回补用；上限 RECENT_LIMIT，独立于 /history 的
   *  200 条截断，避免补拉时尾部事件被截掉）。 */
  const RECENT_LIMIT = 600;
  let notifySeq = 0;
  const recentFrames: Array<Record<string, unknown> & { seq: number }> = [];

  function broadcast(payload: Record<string, unknown>) {
    const frame: Record<string, unknown> & { seq: number } = Object.assign({}, payload, { seq: ++notifySeq });
    recentFrames.push(frame);
    if (recentFrames.length > RECENT_LIMIT) recentFrames.shift();
    const text = sseData(frame);
    for (const res of sseConnections) {
      try {
        res.write(text);
      } catch {
        // 连接已断，等待 close 清理
      }
    }
  }

  /**
   * SSE 心跳：每 30s 发一条 data 型 ping 帧。必须用 data 而非注释帧——注释帧
   * 既不触发客户端 onmessage 也不触发 onerror，半开连接（断网/合盖/NAT 静默
   * 掐断）时客户端零事件，无法自愈；data 帧让客户端的 watchdog 能检测失活。
   */
  const HEARTBEAT_MS = 30000;
  const heartbeatTimer = setInterval(() => {
    const frame = sseData({ type: "ping" });
    for (const res of sseConnections) {
      try {
        res.write(frame);
      } catch {
        // 等待 close 清理
      }
    }
  }, HEARTBEAT_MS);
  // unref：心跳不阻止进程退出（服务端有主循环；测试/无连接时不会被句柄吊死）
  heartbeatTimer.unref();

  // ------------------------------------------------------------ 通知主入口

  // 通知文案单表（kind → {title, message}），收敛 TITLES 与 switch 双映射。
  // 设计遵循业界通知惯例：标题即结论、正文结论先行、用用户可读的任务名与
  // 动作描述（不暴露内部 session id）、末尾给行动建议；时间由系统通知呈现，
  // 正文不重复时间戳。
  const NOTIFY_KINDS: Record<string, { title: string; message: (detail: NotifyDetail) => string }> = {
    ask: {
      title: "DSH：等待审批",
      message: (detail) => {
        const lines = [];
        if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」等待审批（工具「${prettyToolName(detail.tool)}」）`);
        else lines.push(`工具「${prettyToolName(detail.tool)}」等待审批`);
        if (detail.reason) lines.push(`理由：${detail.reason}`);
        lines.push("请到 DSH 界面确认或拒绝");
        return lines.join("\n");
      },
    },
    question: {
      title: "DSH：向你提问",
      message: (detail) => {
        const lines = [];
        if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」需要你回答`);
        else lines.push("有提问需要你回答");
        if (detail.question) lines.push(`问题：${detail.question}`);
        lines.push("请到 DSH 界面回答");
        return lines.join("\n");
      },
    },
    done: {
      title: "DSH：任务完成",
      message: (detail) => {
        const lines = [];
        if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」已完成`);
        else lines.push("后台任务已完成");
        lines.push(`耗时：${formatDuration(detail.durationMs ?? 0)}`);
        return lines.join("\n");
      },
    },
    "subagent-done": {
      title: "DSH：子任务完成",
      message: (detail) => {
        const lines = [];
        if (detail.taskTitle) lines.push(`子任务「${detail.taskTitle}」已完成`);
        else lines.push("子任务已完成");
        lines.push(`耗时：${formatDuration(detail.durationMs ?? 0)}`);
        return lines.join("\n");
      },
    },
    error: {
      title: "DSH：任务出错",
      message: (detail) => {
        const lines = [];
        if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」执行出错`);
        else lines.push("任务执行出错");
        if (detail.turn) lines.push(`第 ${detail.turn} 轮${detail.step ? `第 ${detail.step} 步` : ""}：${detail.message ?? ""}`);
        else if (detail.message) lines.push(`错误：${detail.message}`);
        if (detail.mergedCount) lines.push(`（窗口内另有 ${detail.mergedCount} 条同类错误）`);
        return lines.join("\n");
      },
    },
    "turn-end": {
      title: "DSH：轮次完成",
      message: (detail) => {
        const turn = detail.turn ? `第 ${detail.turn} 轮` : "";
        if (detail.taskTitle) return `任务「${detail.taskTitle}」${turn}工作已完成`;
        return `${turn}工作已完成`;
      },
    },
  };

  /**
   * 通知历史落盘（jsonl 追加，滚动上限 HISTORY_LIMIT，tmp+rename 原子写）。
   * fire-and-forget：不阻塞通知主流程；失败仅记 warn。
   * 写队列串行化：多个事件并发触发时防止「读-改-写」竞态互相覆盖丢记录。
   * 记录内容与通知文案同源（不含工具参数等敏感信息）。
   */
  let historyWriteChain: Promise<void> = Promise.resolve();
  function appendHistory(entry: { ts: number; kind: string; title: string; message: string }) {
    historyWriteChain = historyWriteChain.then(async () => {
      try {
        let lines: string[] = [];
        try {
          const text = await readFile(historyStore, "utf8");
          lines = text.split("\n").filter(Boolean);
        } catch {
          // 文件不存在：从空列表开始
        }
        lines.push(JSON.stringify(entry));
        if (lines.length > HISTORY_LIMIT * 2) lines = lines.slice(-HISTORY_LIMIT);
        const tmp = `${historyStore}.${process.pid}.${Date.now().toString(36)}.tmp`;
        await writeFile(tmp, lines.join("\n") + "\n", "utf8");
        await rename(tmp, historyStore);
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: 历史记录写入失败: ${errorMessage(error)}`);
      }
    });
  }

  /**
   * 通知入口：免打扰检查 → 系统通知 → SSE 广播 → 历史落盘。
   * @param kind ask / done / error / turn-end。
   * @param detail {tool?, taskTitle?, reason?, durationMs?, turn?, step?, message?, mergedCount?}（不含工具参数）。
   */
  function notify(kind: string, detail: NotifyDetail = {}) {
    if (isInQuietHours(new Date(), current.quietHours)) return;
    const spec = NOTIFY_KINDS[kind];
    const ts = Date.now();
    const title = spec?.title ?? "DSH 通知";
    const message = spec?.message({ ...detail, ts }) ?? detail.message ?? "";
    const payload = { type: "notify", kind, title, message, ts };
    if (current.systemNotify) systemNotify(title, message);
    if (current.browserNotify) broadcast(payload);
    ctx.logger.info(`dsh-notifier: ${kind} ${message.replace(/\n/g, " / ")}`);
    appendHistory({ ts, kind, title, message });
  }

  // ------------------------------------------------------------ 事件监听

  const disposers: Array<() => void> = [];

  /**
   * 任务完成状态机（per-agent）：见到某会话 running 记 pendingDone，下次该会话
   * idle 时判定是否通知（带耗时）。多会话/子代理各自独立跟踪，互不误报。
   * 子代理（header.delegationDepth ≥ 1）走独立开关 notifySubagentDone 与
   * 独立事件类型 subagent-done；用户暂停/中断（turn/end reason aborted）固定静默。
   */
  const agentStates = new Map<string, { runningSeen: boolean; startedAt: number; lastEndedTurn?: number }>(); // agentId -> { runningSeen, startedAt, lastEndedTurn }

  /**
   * 审批请求：approval/request waterfall（源码核验：真实审批由 dsh-sandbox
   * 提权 / 动态插件激活等调用 ApprovalService.request 触发；tools/pre-execute
   * 的 gate ask 在当前 DSH 部署中无产生者，故不挂那里）。在 await next()
   * 之前通知——next() 会阻塞到用户审批结束，这正是"等待审批"提醒的时机；
   * 不短路，返回 next() 结果。
   */
  disposers.push(
    ctx.on("approval/request", async (req: { toolName?: unknown; agent?: AgentLite; reason?: unknown } | undefined, next: () => unknown) => {
      if (!current.notifyAsk) return next();
      try {
        notify("ask", {
          tool: req?.toolName as string | undefined,
          taskTitle: sessionTitleOf(req?.agent),
          reason: req?.reason ? String(req.reason).slice(0, 120) : undefined,
        });
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: approval/request 通知失败: ${errorMessage(error)}`);
      }
      return next();
    })
  );

  /**
   * 用户提问通知：dsh-user-questions 的 service 不发出任何 cordis 事件
   * （ask() 直连 UI provider），故包装 service 的 ask 方法补发通知。
   * 热重载安全：svc.ask 上若残留上一 fiber 的包装（__dshNotifierWrapped），
   * 先解包取原始实现再包装——保证包装始终指向当前 fiber 的 SSE 连接，
   * 避免旧包装广播到已失效连接导致「历史有记录但收不到提醒」。
   */
  /** userQuestions service 的 ask 方法（含热重载解包字段）。 */
  interface AskFunction {
    (request: unknown): Promise<unknown>;
    __dshNotifierWrapped?: boolean;
    __dshNotifierOriginal?: AskFunction;
  }

  function hookUserQuestions() {
    let svc: { ask?: unknown } | undefined;
    try {
      svc = typeof ctx.get === "function" ? (ctx.get("userQuestions", false) as { ask?: unknown } | undefined) : undefined;
    } catch {
      svc = undefined;
    }
    if (!svc || typeof svc.ask !== "function") return;
    // 解包：跳过上一 fiber 的残留包装，取原始 ask
    let original: AskFunction = svc.ask as AskFunction;
    if (typeof original.__dshNotifierWrapped === "boolean" && typeof original.__dshNotifierOriginal === "function") {
      original = original.__dshNotifierOriginal;
    }
    // ⚠️ ask 是依赖 this 的类方法：必须 bind 到 service 实例，
    // 否则调用时 this 为 undefined（"Cannot read properties of undefined"）。
    // __dshNotifierOriginal 存已 bind 版本，热重载解包后直接可调用。
    const callOriginal: AskFunction = original.bind(svc);
    const wrapped = (async (request: unknown) => {
      try {
        if (current.notifyQuestion) {
          const first = Array.isArray(request && (request as { questions?: unknown[] }).questions) ? (request as { questions?: unknown[] }).questions![0] : undefined;
          notify("question", {
            tool: "ask_user_question",
            taskTitle: sessionTitleOf((request as { agent?: AgentLite } | null | undefined)?.agent),
            question: first && (first as { question?: unknown }).question ? String((first as { question?: unknown }).question).slice(0, 120) : undefined,
          });
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: 提问通知失败: ${errorMessage(error)}`);
      }
      return callOriginal(request);
    }) as AskFunction;
    wrapped.__dshNotifierWrapped = true;
    wrapped.__dshNotifierOriginal = callOriginal;
    svc.ask = wrapped;
  }

  // 启动时若 service 已注册则立即包装；未注册则等 internal/service 事件兜底。
  hookUserQuestions();
  disposers.push(
    ctx.on("internal/service", (name) => {
      if (name === "userQuestions") hookUserQuestions();
    })
  );

  /**
   * 任务完成：agent/status running → idle 跃迁（按 agent 分组）。
   * 分支不再被 notifyTaskDone 门控（否则 notifyTaskDone=false +
   * notifySubagentDone=true 时子代理完成被拦下）：进入即先取耗时并
   * 无条件重置状态，再做中断抑制与主/子分流。
   */
  disposers.push(
    ctx.on("agent/status", ({ agent, status }: { agent?: AgentLite; status?: string }) => {
      try {
        const agentId = agent?.id ?? "?";
        let state = agentStates.get(agentId);
        if (state === undefined) {
          state = { runningSeen: false, startedAt: 0 };
          agentStates.set(agentId, state);
        }
        if (status === "idle" && state.runningSeen) {
          const durationMs = state.startedAt > 0 ? Date.now() - state.startedAt : 0;
          // 无条件重置（顺带修复既有 bug：notifyTaskDone=false 时 runningSeen
          // 不重置，之后重开开关会误报很久以前的「完成」）。
          state.runningSeen = false;
          state.startedAt = 0;
          // 中断抑制（S1）：本轮 idle 必须闭合了新的 turn/end 才判定结束。
          // 「abort 早于本轮 turn/start 落盘」时本轮无 turn/end（loop turn()
          // 首行 throwIfAborted 在 try 外），读到的 turn/end 是上一次运行的
          // ——无新 closure 宁可静默，不误报完成。
          const ended = lastTurnEndOf(agent);
          const hasNewEnd = ended !== undefined && (state.lastEndedTurn === undefined || ended.turn > state.lastEndedTurn);
          if (ended !== undefined) state.lastEndedTurn = ended.turn;
          // 非正常结束不判「完成」：本轮 turn/end 无新 closure（hasNewEnd）
          // 或 kind 属于 aborted/interrupted/error/blocked 时静默——失败由
          // agent/error 单独负责「任务出错」通知，被阻塞由对应事件负责，
          // 避免同一轮既报异常又误报「任务完成」。
          // - aborted：用户停止生成（agent.cancel {kind:"user"}）与中断
          //   interrupt_agent 均落此值；interrupted 为未来兼容保留。
          // - error：任务运行失败（dsh-agent-loop turn 的 catch 分支写入）。
          // - blocked：本轮被阻塞（preStep reject，如等待用户问题）提前结束。
          // 完成判定用白名单：仅 kind === "completed" 才通知「任务完成」。
          // max-tokens（输出被截断）与一切未知 kind 一律静默——避免把非正常
          // 结束误报为完成（与 DSH accountsForClaim 对未知 kind 保守不成功的
          // 语义对齐；失败由 agent/error 单独负责「任务出错」）。
          if (!hasNewEnd || ended === undefined || ended.kind !== "completed") return;
          if (isSubagentOf(agent)) {
            if (current.notifySubagentDone) {
              notify("subagent-done", { taskTitle: sessionTitleOf(agent), durationMs });
            }
          } else if (current.notifyTaskDone) {
            notify("done", { taskTitle: sessionTitleOf(agent), durationMs });
          }
        } else if (status === "running") {
          state.runningSeen = true;
          state.startedAt = Date.now();
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: agent/status 处理失败: ${errorMessage(error)}`);
      }
    })
  );

  /** 会话销毁时清理其状态机条目（含错误合并窗口，防 Map 无界增长）。 */
  disposers.push(
    ctx.on("agent/disposed", ({ agent }: { agent?: AgentLite }) => {
      if (agent?.id !== undefined) {
        agentStates.delete(agent.id);
        errorMerge.delete(agent.id);
      }
    })
  );

  /** 错误合并表：per-agent 滚动窗口，窗口内后续错误不单独通知。 */
  const errorMerge = new Map<string, { count: number; since: number }>(); // agentId -> { count, since }

  /** 任务错误（60 秒滚动窗口内合并同类错误，防刷屏）。 */
  disposers.push(
    ctx.on("agent/error", (payload: { agent?: AgentLite; error?: unknown; turn?: unknown; step?: unknown }) => {
      try {
        if (!current.notifyTaskError) return;
        const agentId = payload?.agent?.id;
        const key = agentId ?? "?";
        const now = Date.now();
        const prev = errorMerge.get(key);
        if (prev !== undefined && now - prev.since < current.errorMergeWindowMs) {
          prev.count += 1;
          prev.since = now;
          return;
        }
        const mergedCount = prev !== undefined ? prev.count : 0;
        errorMerge.set(key, { count: 0, since: now });
        const rawMessage = payload?.error instanceof Error ? payload.error.message : errorMessage(payload?.error);
        notify("error", {
          message: sanitizeErrorText(rawMessage),
          taskTitle: sessionTitleOf(payload?.agent),
          turn: typeof payload?.turn === "number" ? payload.turn : undefined,
          step: typeof payload?.step === "number" ? payload.step : undefined,
          mergedCount,
        });
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: agent/error 处理失败: ${errorMessage(error)}`);
      }
    })
  );

  /** 轮结束（默认关）。cordis serial 事件签名是 cb(payload)，无 next——调用 next() 会 TypeError 且污染整轮。 */
  disposers.push(
    ctx.on("agent/turn-stopping", async (payload: { agent?: AgentLite; turn?: unknown }) => {
      try {
        if (current.notifyTurnEnd) {
          notify("turn-end", {
            turn: typeof payload?.turn === "number" ? payload.turn : undefined,
            taskTitle: sessionTitleOf(payload?.agent),
          });
        }
      } catch (error) {
        ctx.logger.warn(`dsh-notifier: turn-stopping 处理失败: ${errorMessage(error)}`);
      }
    })
  );

  // ------------------------------------------------------------ 路由

  const configRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.config,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method === "GET") {
        writeJson(res, 200, current);
        return;
      }
      if (req.method === "PUT") {
        let body: unknown;
        try {
          body = await readBody(req, 16 * 1024);
        } catch (error) {
          const message = errorMessage(error);
          if (message.includes("invalid JSON body")) {
            // 非法 JSON：连接尚存，返回可读 400，避免请求「无响应挂起」
            writeJson(res, 400, { error: `invalid JSON body: ${message}` });
            return;
          }
          // 超限路径：readBody 已 reject 并 destroy 连接（防超大 body 占内存），
          // socket 已断开无法再写响应——记录日志即可（shared/host-utils.js 语义）
          ctx.logger.warn(`dsh-notifier: 配置请求体读取失败: ${message}`);
          return;
        }
        current = normalizeConfig(body);
        await saveConfig();
        writeJson(res, 200, current);
        return;
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };

  const eventsRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.events,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET") {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      // ?since=<seq>：断线补拉——先回放滚动缓冲中 seq 更大的帧，再进入实时；
      // 补拉独立于 /history（200 条截断），不丢尾部事件。
      let since = 0;
      try {
        const raw = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("since");
        const parsed = raw === null ? 0 : Number(raw);
        since = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      } catch {
        since = 0;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      if (since > 0) {
        for (const frame of recentFrames) {
          if (frame.seq > since) {
            try {
              res.write(sseData(frame));
            } catch {
              break; // 连接已断
            }
          }
        }
      }
      sseConnections.add(res);
      res.on("close", () => {
        sseConnections.delete(res);
      });
    },
  };

  /** 健康检查：插件是否加载、配置摘要、SSE 连接数。 */
  const healthRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.health,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      writeJson(res, 200, {
        ok: true,
        plugin: "dsh-notifier",
        config: {
          notifyAsk: current.notifyAsk,
          notifyQuestion: current.notifyQuestion,
          notifyTaskDone: current.notifyTaskDone,
          notifySubagentDone: current.notifySubagentDone,
          notifyTaskError: current.notifyTaskError,
          systemNotify: current.systemNotify,
          browserNotify: current.browserNotify,
          notifyWhenVisible: current.notifyWhenVisible,
          notifySound: current.notifySound,
          quietHours: current.quietHours,
        },
        sseConnections: sseConnections.size,
      });
    },
  };

  /**
   * 测试通知：POST 触发一条测试通知（绕过免打扰，测试意图是验证通道本身）。
   * 系统通知 + SSE 广播同时走一遍，客户端收到 kind=test 的帧无条件弹窗。
   */
  const testRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.test,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const title = "DSH：测试通知";
      const message = "通知链路工作正常（此通知来自测试按钮）";
      const payload = { type: "notify", kind: "test", title, message, ts: Date.now() };
      if (current.systemNotify) systemNotify(title, message);
      if (current.browserNotify) broadcast(payload);
      ctx.logger.info("dsh-notifier: test 测试通知已发送");
      appendHistory({ ts: payload.ts, kind: "test", title, message });
      writeJson(res, 200, { ok: true, sseConnections: sseConnections.size });
    },
  };

  /** 通知历史：GET 返回最近记录（jsonl 尾部最多 HISTORY_LIMIT 条）。 */
  const historyRoute: DshRoute = {
    kind: "exact",
    path: ROUTES.history,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if (req.method !== "GET") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      const records = [];
      try {
        const text = await readFile(historyStore, "utf8");
        for (const line of text.split("\n").filter(Boolean).slice(-HISTORY_LIMIT)) {
          try {
            records.push(JSON.parse(line));
          } catch {
            // 损坏行跳过
          }
        }
      } catch {
        // 无历史文件：返回空列表
      }
      writeJson(res, 200, { ok: true, records });
    },
  };

  // 关键：路由注册必须在 ctx.effect 内执行——apply 主体直接调用 ctx 服务
  // （webServer.register）会在 cordis isolate 链就绪前访问服务，触发
  // "Cyclic __proto__ value"（loader isolate 处理），导致插件激活失败。
  const disposeRoutes = ctx.effect(
    () => {
      const routeDisposers = [configRoute, eventsRoute, healthRoute, testRoute, historyRoute].map((route) => ctx.webServer.register(route));
      return () => {
        for (const dispose of routeDisposers) {
          try {
            dispose();
          } catch {
            // 忽略
          }
        }
      };
    },
    "dsh-notifier: routes"
  );

  // ------------------------------------------------------------ 启动与清理

  await loadConfig();

  // ⚠️ 清理必须放在 effect **返回的 disposer** 里，不能写在 fn 主体：
  // ctx.effect(fn) 的 fn 在 apply 时立即同步执行，只有返回值才在 fiber
  // 卸载时调用。若把 disposeRoutes() 写在 fn 主体，等于注册完立刻注销。
  ctx.effect(
    () => () => {
      clearInterval(heartbeatTimer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 忽略
        }
      }
      disposeRoutes();
    },
    "dsh-notifier"
  );
}
