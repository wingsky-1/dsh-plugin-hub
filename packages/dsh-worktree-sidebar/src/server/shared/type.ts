/** 包内共享的窄类型。这里不出现宿主上下文：域拿到的是能力，不是 `ctx`。 */

/** 日志出口。只有 warn 是必需的——本插件的所有失败路径都以「降级 + 出声」收场。 */
export interface LoggerPort {
  /** 记一条警告。实现方不得抛出。 */
  warn(message: string): void;
}
