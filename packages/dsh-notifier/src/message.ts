/**
 * dsh-notifier — 通知消息构造（纯函数域）。
 *
 * 文案单表（NOTIFY_KINDS）、通知详情形状、耗时格式化、工具名美化、
 * 会话标题/turn 终态读取、错误文本脱敏与系统通知命令构造。
 * 全部无状态：smoke 可直接断言输出形态；安全语义（脱敏有序表）
 * 的顺序硬约束见 SANITIZE_RULES 注释。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TurnEndReason } from "@deepseek-ai/dsh-session/types";

/** turn/end reason.kind 的官方联合（TurnEndReasonMap；插件可经 declare module 扩展，
 * 运行时出现未知 kind 由调用方保守静默——见 agent/status 完成判定白名单）。 */
type TurnEndKind = TurnEndReason extends { kind: infer K } ? K : never;

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
  /** 审批超时提醒：已等待分钟数（NOTIFY_KINDS.ask 渲染）。 */
  remindMinutes?: number;
  /** 错误合并窗口内被吞掉的错误摘要（最近 2 条）。 */
  mergedErrors?: string[];
  ts?: number;
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
 * 脱敏规则有序表：顺序即数据（具体在前、泛化在后），消灭隐式语句序。
 * 顺序硬约束（对抗评审实测确立）：
 * - DSN 必须先于 JWT/通用长串/密钥赋值：否则 DSN 密码先被劣化为 <token>，
 *   DSN 字符类排除 <> 随即失配，用户名残留明文；
 * - 邮箱必须殿后且带双负向后行断言（词字符 + 字面 <redacted）界定：避免把
 *   DSN 掩码占位符 <redacted>@host 中的 "redacted@host" 再误判为邮箱产生
 *   <<email>>；不整体排除 <，使尖括号引用形态 <user@host> 正常打码。
 * 已证伪不收录（勿加回）：IPv4（UA 版本号 Chrome/120.0.0.0 形态不可区分，
 * 误伤高频）、手机号（订单号误伤、错误文本出现概率趋零）、信用卡
 * （13 位毫秒时间戳 100% 命中，Luhn 校验也救不了）。
 */
const SANITIZE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 用户路径（/home/xx、/Users/xx、/root/xx、/etc/xx、C:\Users\xx）→ <path>
  // （排除冒号/分号等后缀分隔符，避免吞掉紧随其后的文本：`/home/x: EACCES` 应保留冒号）
  [/(?:\/home\/[^\s"'`<>:;]+|\/Users\/[^\s"'`<>:;]+|\/root\/[^\s"'`<>:;]+|\/etc\/[^\s"'`<>:;]+|C:\\Users\\[^\s"'`<>:;]+)/giu, "<path>"],
  // PEM 私钥完整块（RSA/EC/OPENSSH/ENCRYPTED…）→ <private-key>
  // 窗口上限 {0,4096}：真实私钥块 ≤ 数 KB；无窗口时每个 BEGIN 起点都会惰性扫到
  // 文本尾找 END，k 个 BEGIN 即 O(k·n)，1MB 高密度输入可阻塞宿主事件循环数秒
  // （评审实测）。超窗视为无 END，交由下一条孤立 BEGIN 兜底规则接住。
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z ]*PRIVATE KEY-----/g, "<private-key>"],
  // PEM 孤立 BEGIN 兜底：错误消息常只贴出头几行就被截断，无 END 行；
  // 吃到文本尾即可（尾部反正受 maxLen 截断）
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "<private-key>"],
  // 数据库/消息队列连接串凭据 → 只留 scheme://<redacted>@host
  // 用户名允许为空（redis://:pass@host 是最常见带密码形态）；i flag 兼容大写 scheme；
  // amqps?：AMQPS 同端口语义，漏收会产生「密码被邮箱规则侥幸掩掉、用户名明文残留」
  // 的半脱敏误导形态；jdbc 不收录：JDBC 凭据在 query 参数（?password=），密钥赋值规则已覆盖。
  // 已知局限（评审记录）：密码含 <>/引号等 URL 应编码字符时整条失配、明文残留——
  // 错误消息中的未编码形态不罕见，但放宽字符类会引入占位符/引号边界歧义，暂记录不改。
  [/\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql):\/\/([^\s:@\/"'`<>]*):([^\s@\/"'`<>]+)@/giu, "$1://<redacted>@"],
  // GitHub PAT classic（ghp/gho/ghu/ghs/ghr + 36 位字母数字；业界共识写死长度）
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/gu, "<token>"],
  // GitHub fine-grained PAT（github_pat_ 强前缀锚定，长度取区间吸收未来调整）
  [/\bgithub_pat_[A-Za-z0-9]{20,30}_[A-Za-z0-9]{50,80}\b/gu, "<token>"],
  // JWT（eyJ JWT：header.payload.signature 三段，base64url 字符集含 - _）→ <token>
  // 精确匹配三段（每段 ≥1 字符，含 - _），避免误伤普通长串（对抗评审建议：勿盲目放宽
  // 通用 base64 正则到 base64url，那会误伤 URL/长串）。
  [/\beyJ[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2}\b/gu, "<token>"],
  // AWS 访问密钥前缀（AKIA 20 字符，不满足通用 ≥24hex/≥32base64 阈值）→ <token>
  [/\bAKIA[A-Z0-9]{16}\b/gu, "<token>"],
  // 长令牌/密钥串（≥24 hex 或 ≥32 base64）→ <token>
  [/\b(?:[0-9a-fA-F]{24,}|[A-Za-z0-9+/]{32,}={0,2})\b/gu, "<token>"],
  // 密钥字段赋值（password=/token=/api_key=…）→ 只留键名+掩码
  // 分隔符 [=:] 必须显式：可选版会把 "token expired"/"password policy" 等自然语言
  // 高频误伤成 token=<redacted>（审批理由/提问文本接入后误伤面被放大，评审实测）
  [/\b(password|passwd|token|api[_-]?key|secret|authorization)\b\s*[=:]\s*["']?[^\s"'`,;<>]{3,}/giu, "$1=<redacted>"],
  // 邮箱（严格版：域名首标签须字母开头，排除 image@2x.png / pkg@1.2.3 误伤）→ <email>
  // 双负向后行断言：① 词字符——防止从占位符/单词中间起配；② 字面 <redacted
  // ——防止把 DSN 掩码占位符 <redacted>@host 再误判为邮箱产生 <<email>>。
  // 不整体排除 <：否则尖括号引用形态 <user@host> 整体漏网明文泄漏（issue #30）；
  // 占位符顺序约束由断言②单独保住。
  [/(?<![A-Za-z0-9._%+-])(?<!<redacted)[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z]{2,}/gu, "<email>"],
];

/**
 * 错误文本脱敏：按 SANITIZE_RULES 有序表掩蔽常见敏感特征（用户路径、私钥、
 * 连接串凭据、各类令牌、密钥赋值、邮箱），再截断。
 * 用于 agent/error 与审批理由/提问文本进入通知与历史前的处理，把「文本可能
 * 内嵌命令回显/路径/凭据片段」的外泄面收敛到可读的摘要。
 * @returns 脱敏并截断（默认 300 字符）后的错误文本。
 */
export function sanitizeErrorText(text: unknown, maxLen = 300): string {
  let s = String(text);
  for (const [pattern, replacement] of SANITIZE_RULES) {
    s = s.replace(pattern, replacement);
  }
  return s.slice(0, maxLen);
}

/**
 * 构造系统通知命令参数（纯函数，smoke 可直接断言参数形态）。
 * - win32：spawn powershell -File toast.ps1 -Payload <base64>。标题/正文/silent
 *   打包为 base64(UTF-8 JSON) 单 token 传递（issue #238）——PS 5.1 的 -File 模式
 *   对 `-Name=Value` 等号形式不做命名参数绑定，空格形式的裸 dash token 又会被
 *   误认成下一个参数名；base64 字母表 [A-Za-z0-9+/=] 永不出现在 token 首、无空格
 *   无引号，彻底脱离命令行 tokenizer 的歧义面，依旧零 shell 拼接面。
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
    const payload = Buffer.from(JSON.stringify({ title, message, silent: options.silent }), "utf8").toString("base64");
    return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.toastScript, "-Payload", payload];
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
 * 标题源自会话内容、可携带敏感片段（凭据/路径/邮箱等），返回前经
 * sanitizeErrorText 脱敏再截断 40 字符（先打码后截断：避免长敏感串被腰斩成
 * 不满足规则阈值的残段漏网）；本函数是全部 taskTitle 的唯一来源，在此单点
 * 接入即覆盖 NOTIFY_KINDS 全部模板拼接与历史落盘（issue #30）。正常标题
 * 不含敏感特征、脱敏后原样透传，可读性不受影响。
 * @param agent Agent 对象（事件 payload.agent）。
 * @returns 脱敏并截断 40 字符的标题。
 */
export function sessionTitleOf(agent: Agent | undefined): string | undefined {
  try {
    // 运行时防御保留（payload 跨宿主边界，不受信）：显式收窄而非 Array.isArray
    // （后者会把 readonly SessionEvent[] 压成 any[]，令 typecheck 对 events 访问失明）。
    const events = agent?.session?.events as ReadonlyArray<{ type: unknown; data?: { title?: unknown } }> | undefined;
    if (events === undefined) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i] as { type: unknown; data?: { title?: unknown } } | undefined;
      if (ev?.type === "session/title" && typeof ev.data?.title === "string") {
        const title = ev.data.title.trim();
        return title.length > 0 ? sanitizeErrorText(title, 40) : undefined;
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
export function lastTurnEndOf(agent: Agent | undefined): { turn: number; kind: TurnEndKind } | undefined {
  try {
    // 运行时防御同 sessionTitleOf：显式收窄，不用 Array.isArray（any 化陷阱）
    const events = agent?.session?.events as ReadonlyArray<{ type: unknown; data?: { turn?: unknown; reason?: unknown } }> | undefined;
    if (events === undefined) return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i] as { type: unknown; data?: { turn?: unknown; reason?: unknown } } | undefined;
      if (ev?.type !== "turn/end") continue;
      const reason = ev.data?.reason;
      if (reason === undefined || reason === null || typeof reason !== "object") continue;
      const turn = typeof ev.data?.turn === "number" ? ev.data.turn : NaN;
      const kind = String((reason as { kind?: unknown }).kind ?? "") as TurnEndKind;
      return { turn, kind };
    }
  } catch {
    // 事件日志读取失败不影响通知主流程
  }
  return undefined;
}

/**
 * 运行时归属查询面（issue #49）：对齐宿主 ctx.agents（AgentRegistry）判定所需
 * 的最小结构子集——get 查活体父 agent 存在性、isOwnedBy 断言「该子 agent 确由
 * 该父 agent 的作用域创建」。仅 import type 官方 Agent，不引入运行时依赖。
 */
export interface SubagentOwnership {
  get(id: string): Agent | undefined;
  isOwnedBy(id: string, owner: Agent): boolean;
}

/**
 * agent 是否为子代理：双信号判定（origin 命中即子代理；未命中才查运行时归属；
 * 两信号皆否一律走主任务分支——恰为两信号，无第三信号）。
 *
 * 三类会话 header 形态差异（DSH SessionHeader，均经官方类型层核验）：
 * - spawn 型子代理：origin === 'subagent'（SessionHeader 校验强制唯一合法值，
 *   packages/core/session/src/index.ts:125：origin 非 undefined 就必须是
 *   'subagent'），通常带 parentSession + delegationDepth=父+1。信号一即命中。
 * - fork 型委派子代理：parentSession + seedLength > 0、**无 origin**、
 *   delegationDepth = 0（Session.fork() session/src/index.ts:1091 与 apiproxy
 *   lineage 场景写 parentSession 但不带 origin）。信号一不命中，须查信号二。
 * - headless CLI 会话：header 仅 { cwd }（无 origin 无 parentSession），两信号
 *   皆否 → 主任务分支；其分类保持现状不在 notifier 变更面内。
 *
 * 为何需要信号二（运行时归属）：fork 型委派与用户 fork 主线在持久化 header 上
 * **不可区分**（两者都只落 parentSession + seedLength、无 origin）——单看 header
 * 要么漏报 fork 委派（现状 bug：委派 worker 完成被误报主任务 kind=done），要么
 * 把用户 fork 主线误静默（#7 的镜像回归）。唯一可靠区分点是**运行时归属**：
 * ctx.agents.get(parentSession) 非 undefined 且 isOwnedBy(该 agent id, 父 agent)
 * === true 时，该 fork 会话确由父 agent 作用域创建（委派 worker）；归属不成立
 * （父 id 不在 live registry / isOwnedBy false / agents 服务不可用）则视为用户
 * fork 主线，保守走主任务分支——宁可多报一条 done，不静默用户自己的任务。
 *
 * 已知保守边界（冷 resume）：实例重启后脱离父作用域续跑的 fork worker 不在
 * live registry，归属不成立 → 退报 done。与宿主 apiproxy 冷路径 fence 行为一致
 * （attached/inspect 检查点 agent 参数为 void 0 时仅 origin 生效），属已确认的
 * 接受边界（issue #49 2026-08-22 评论源码级确认），不做持久化推断补齐。
 *
 * @param agent Agent 对象（事件 payload.agent）。
 * @param ownership 运行时归属查询面（ctx.agents）。缺省（undefined，如测试
 *   fake ctx 未装配 agents 服务）时跳过信号二：仅 origin 判定，行为与本修复
 *   前一致。
 */
export function isSubagentOf(agent: Agent | undefined, ownership?: SubagentOwnership): boolean {
  // 信号一：spawn 型（origin 由 header 校验强制唯一合法值，零误判面）
  if (agent?.session?.header?.origin === "subagent") return true;
  // 信号二：fork 型委派——仅 parentSession 不能作判据（用户 fork 主线同形态），
  // 必须运行时归属确凿成立才算子代理；任一环节不成立都保守走主任务分支。
  const parentId = agent?.session?.header?.parentSession;
  const selfId = agent?.id;
  if (parentId === undefined || ownership === undefined || selfId === undefined) return false;
  const parent = ownership.get(String(parentId));
  if (parent === undefined) return false;
  return ownership.isOwnedBy(String(selfId), parent) === true;
}

/**
 * 通知文案单表（kind → {title, message}），收敛 TITLES 与 switch 双映射。
 * 设计遵循业界通知惯例：标题即结论、正文结论先行、用用户可读的任务名与
 * 动作描述（不暴露内部 session id）、末尾给行动建议；时间由系统通知呈现，
 * 正文不重复时间戳。
 */
export const NOTIFY_KINDS: Record<string, { title: string; message: (detail: NotifyDetail) => string }> = {
  ask: {
    title: "DSH：等待审批",
    message: (detail) => {
      const lines = [];
      if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」等待审批（工具「${prettyToolName(detail.tool)}」）`);
      else lines.push(`工具「${prettyToolName(detail.tool)}」等待审批`);
      if (detail.reason) lines.push(`理由：${detail.reason}`);
      if (detail.remindMinutes) lines.push(`已等待 ${detail.remindMinutes} 分钟，仍在等待你的审批`);
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
      if (detail.mergedCount) {
        return `另有 ${detail.mergedCount} 个任务已完成（最近：${detail.taskTitle ?? "—"}）`;
      }
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
      if (detail.mergedCount) {
        return `另有 ${detail.mergedCount} 个子任务已完成（最近：${detail.taskTitle ?? "—"}）`;
      }
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
      if (detail.mergedErrors && detail.mergedErrors.length > 0) lines.push(`窗口内其他错误：${detail.mergedErrors.join(" / ")}`);
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
