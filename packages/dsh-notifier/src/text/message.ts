/**
 * dsh-notifier — 文本域：通知文案单表与展示映射（纯函数）。
 *
 * NOTIFY_KINDS 是内置事件 kind → 标题/正文模板的单一事实源（isBuiltinKind
 * 判定与 /test 收敛都依赖此表）；KIND_SEVERITY 是 kind → 展示强度静态映射
 * （M1：与 NOTIFY_KINDS 同域，消除 severity 归属环）。全部无状态：smoke
 * 可直接断言输出形态。设计遵循业界通知惯例：标题即结论、正文结论先行、
 * 用用户可读的任务名（不暴露内部 session id）、末尾给行动建议。
 */
import type { NotifySeverity } from "../sdk/interface.ts";

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

/** 内置 kind → 展示强度 静态映射（契约测试锁定）。 */
export const KIND_SEVERITY: Readonly<Record<string, NotifySeverity>> = {
  ask: "warning",
  question: "info",
  done: "success",
  "subagent-done": "info",
  error: "failure",
  "turn-end": "info",
  test: "info",
};

/**
 * 通知文案单表（kind → {title, message}），收敛 TITLES 与 switch 双映射。
 * 时间由系统通知呈现，正文不重复时间戳。
 */
export const NOTIFY_KINDS: Record<string, { title: string; message: (detail: NotifyDetail) => string }> = {
  // test：M2 起纳入 service 管线（/test 收敛，isBuiltinKind 由此表判定）——
  // 之前 test 直连 sse/system 不经管线，收敛后缺条目会被误判动态 kind 抑制。
  test: {
    title: "DSH：测试通知",
    message: () => "通知链路工作正常（此通知来自测试按钮）",
  },
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