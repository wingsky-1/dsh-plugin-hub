/**
 * dsh-notifier events 域 —— 通知文案单表（本域翻得出来的 6 个内置 kind），标题与正文逐字沿用旧实现。
 * `test` 不在这里：它不对应任何宿主事件，文案归唯一产出方（api 域的测试端点）。
 */
import type { KindText, NotifyDetail } from "./type.ts";

/** 毫秒 → 人类可读耗时（如 "45 秒" / "2 分 15 秒" / "1 小时 2 分 5 秒"）。
 *  导出是为了让这条口径可表驱动：它的产物是纯字符串，走宿主事件断言要造一整条事件链。 */
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

/** 常见工具名 → 中文可读名（用用户看得懂的动作描述，而不是内部标识）。 */
const TOOL_LABELS: Record<string, string> = {
  pwsh: "PowerShell 命令",
  bash: "终端命令",
  web_search: "联网搜索",
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
 * 工具名美化：常见工具查上表；`mcp__server__tool` 展开成「MCP 服务器 "server" 的工具 "tool"」；
 * 其余原样。导出是为了让映射表可表驱动：它不是事件的产物，而是文案口径。
 */
export function prettyToolName(name?: string): string {
  const text = name ?? "?";
  if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, text)) return TOOL_LABELS[text];
  const parts = text.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") {
    return `MCP 服务器 "${parts[1]}" 的工具 "${parts.slice(2).join("__")}"`;
  }
  return text;
}

/**
 * kind → 文案单表：杜绝「表 + switch 分支」双份维护的漂移；时间由系统通知呈现，正文不重复时间戳。
 */
export const NOTIFY_KINDS = {
  ask: {
    title: "DSH：等待审批",
    body: (detail: NotifyDetail) => {
      const lines: string[] = [];
      if (detail.taskTitle)
        lines.push(`任务「${detail.taskTitle}」等待审批（工具「${prettyToolName(detail.tool)}」）`);
      else lines.push(`工具「${prettyToolName(detail.tool)}」等待审批`);
      if (detail.reason) lines.push(`理由：${detail.reason}`);
      lines.push("请到 DSH 界面确认或拒绝");
      return lines.join("\n");
    },
  },
  question: {
    title: "DSH：向你提问",
    body: (detail: NotifyDetail) => {
      const lines: string[] = [];
      if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」需要你回答`);
      else lines.push("有提问需要你回答");
      if (detail.question) lines.push(`问题：${detail.question}`);
      lines.push("请到 DSH 界面回答");
      return lines.join("\n");
    },
  },
  done: {
    title: "DSH：任务完成",
    body: (detail: NotifyDetail) => {
      const lines: string[] = [];
      if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」已完成`);
      else lines.push("后台任务已完成");
      lines.push(`耗时：${formatDuration(detail.durationMs ?? 0)}`);
      return lines.join("\n");
    },
  },
  "subagent-done": {
    title: "DSH：子任务完成",
    body: (detail: NotifyDetail) => {
      const lines: string[] = [];
      if (detail.taskTitle) lines.push(`子任务「${detail.taskTitle}」已完成`);
      else lines.push("子任务已完成");
      lines.push(`耗时：${formatDuration(detail.durationMs ?? 0)}`);
      return lines.join("\n");
    },
  },
  error: {
    title: "DSH：任务出错",
    body: (detail: NotifyDetail) => {
      const lines: string[] = [];
      if (detail.taskTitle) lines.push(`任务「${detail.taskTitle}」执行出错`);
      else lines.push("任务执行出错");
      if (detail.turn)
        lines.push(
          `第 ${detail.turn} 轮${detail.step ? `第 ${detail.step} 步` : ""}：${detail.message ?? ""}`,
        );
      else if (detail.message) lines.push(`错误：${detail.message}`);
      return lines.join("\n");
    },
  },
  "turn-end": {
    title: "DSH：轮次完成",
    body: (detail: NotifyDetail) => {
      const turn = detail.turn ? `第 ${detail.turn} 轮` : "";
      if (detail.taskTitle) return `任务「${detail.taskTitle}」${turn}工作已完成`;
      return `${turn}工作已完成`;
    },
  },
} satisfies Record<string, KindText>;

/** 表里有的种类，也就是本域翻得出来的那些。 */
export type TranslatedKind = keyof typeof NOTIFY_KINDS;
