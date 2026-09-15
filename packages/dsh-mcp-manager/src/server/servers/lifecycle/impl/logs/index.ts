/**
 * dsh-mcp-manager — servers/lifecycle/impl/logs/index.ts：官方日志的归属与诊断文案（裁定 M）。
 *
 * 为什么本块存在：换引擎后官方不暴露任何状态 API——成功连接零日志，失败与放弃重连才在宿主日志
 * 上说话，且每条都带 `mcp-client(<serverName>)` 前缀。而 serverName **就是我方分配的 id**，
 * 所以归属是精确匹配而不是猜时间窗：没有这一块，「首连失败」在用户侧只剩我方那两段判词。
 *
 * 为什么不做成常驻订阅：日志的价值集中在装载窗口内（首连与首次发现都结算在官方 ready 之前），
 * 窗口结束即摘除——常驻订阅会让每个实例都挂一个导出器，而它唯一能多做的事是收事后噪音。
 *
 * 为什么截断：这些文案会进状态面（汇总 / /health / GUI），官方一次失败可能连打数条，原样透传
 * 会把一个状态字段撑成日志转储。
 */
import type { LogRecord, LogsPort } from "../../../../shared/interface.ts";
import { OFFICIAL_MCP_CLIENT_LOG_NAME } from "../../../../shared/interface.ts";

/** 进诊断文案的官方日志条数上限（取末 N 条）。 */
const MAX_DIAGNOSTIC_LINES = 3;
/** 单条官方日志进文案的字符上限。 */
const MAX_DIAGNOSTIC_CHARS = 240;

/**
 * 取一条日志记录的可读文本。
 *
 * 只认官方客户端这个记录名：域内导出器收的是**全宿主**的日志，不过滤就等于把别的插件的噪音
 * 记到本实例头上。官方把文案放在字符串参数里（其余参数是结构化上下文），故只拼字符串段。
 */
export function officialLogText(record: LogRecord): string | undefined {
  if (record.name !== OFFICIAL_MCP_CLIENT_LOG_NAME) return undefined;
  const text = record.args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();
  return text === "" ? undefined : text;
}

/**
 * 把一条官方日志归到某个实例：官方文案形如 `mcp-client(<serverName>): …`。
 *
 * 按**全等前缀**匹配而不是包含：id 是随机短串，但用户可能配出名字互为前缀的服务器，包含匹配会
 * 让 A 的话记到 B 头上——错归属比没有归属更坏（它会指向错误的排查对象）。
 */
export function attributeOfficialLog(text: string, serverName: string): string | undefined {
  const prefix = `${OFFICIAL_MCP_CLIENT_LOG_NAME}(${serverName})`;
  if (!text.startsWith(prefix)) return undefined;
  const rest = text
    .slice(prefix.length)
    .replace(/^[\s:：]*/u, "")
    .trim();
  return rest === "" ? undefined : rest;
}

/** 单条文案的形态收敛：折叠换行（状态面是单行字段）并按字符上限截断。 */
function trimLine(line: string): string {
  const flat = line.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_DIAGNOSTIC_CHARS ? `${flat.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : flat;
}

/**
 * 把收集到的官方原文拼成可挂进状态面的一段文案；一条都没有时返回 undefined（不占字段）。
 *
 * 报出总条数与实际取用条数：只给末 N 条而不说省略了多少，等于让读的人以为官方只说了这些。
 */
export function diagnosticText(lines: readonly string[]): string | undefined {
  const kept = lines
    .filter((line) => line.trim() !== "")
    .slice(-MAX_DIAGNOSTIC_LINES)
    .map(trimLine);
  if (kept.length === 0) return undefined;
  const omitted = lines.length - kept.length;
  const tail = omitted > 0 ? `（共 ${lines.length} 条，取末 ${kept.length} 条）` : "";
  return `官方日志${tail}：${kept.join(" | ")}`;
}

/** 一次装载窗口的日志收集面：窗口结束调 `stop()` 摘除导出器。 */
export interface OfficialLogCollector {
  /** 到目前为止归属到本实例的原文（按到达顺序）。 */
  lines(): readonly string[];
  /** 摘除导出器；可重复调用（第二次是空操作）。 */
  stop(): void;
}

/**
 * 装一个只服务于某个实例的收集器。
 *
 * 摘除失败一律吞掉：诊断功能的存在意义是**减少静默**，它自己绝不能变成新的失败源——装载窗口的
 * `finally` 里抛错会把一次已经结算好的装载改写成失败。
 */
export function collectOfficialLogs(logs: LogsPort, serverName: string): OfficialLogCollector {
  const lines: string[] = [];
  let stopped = false;
  const dispose = logs.capture((record) => {
    const text = officialLogText(record);
    if (text === undefined) return;
    const attributed = attributeOfficialLog(text, serverName);
    if (attributed === undefined) return;
    lines.push(attributed);
  });
  return {
    lines: () => lines,
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        dispose();
      } catch {
        // 见函数注释：诊断面不得把装载改写成失败。
      }
    },
  };
}
