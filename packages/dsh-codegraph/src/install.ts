/**
 * codegraph CLI 探测与引导安装（幂等容错）。
 *
 * 安全语义（与 README「安全模型」一节对齐）：
 * - **不自动执行安装命令**（供应链风险，评审④ P1 修正）：autoInstall 默认 false，
 *   插件只探测 + 注入引导（输出安装命令），由用户/agent 显式执行；
 * - autoInstall=true 时：安装前**再探测一次**（用户可能已手动装，避免重复安装），
 *   安装失败仅 warn（不抛、不重试风暴）；
 * - 安装命令默认 `npm install -g @colbymchenry/codegraph`（npm 全局，幂等），
 *   可用 config.installCommand 覆盖（如 install.sh 直链）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** codegraph CLI 是否在 PATH（探测）。 */
export function isCodegraphInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCodegraphPath(env) !== undefined;
}

/** 解析 codegraph CLI 绝对路径（PATH 逐目录探测；未找到返回 undefined）。
 * 供 guard 等执行方使用绝对路径调用，避免裸 `codegraph` 受 dsh 进程 PATH
 * 与用户 shell PATH 差异影响。Windows 分隔符（;）一并处理。 */
export function resolveCodegraphPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.PATH ?? process.env.PATH ?? "";
  const dirs = path.split(path.includes(";") ? ";" : ":");
  for (const dir of dirs) {
    if (dir === "") continue;
    try {
      if (existsSync(join(dir, "codegraph"))) return join(dir, "codegraph");
      if (existsSync(join(dir, "codegraph.exe"))) return join(dir, "codegraph.exe");
    } catch {
      // 目录不可读/权限问题：跳过该目录继续探测。
    }
  }
  return undefined;
}

/** 执行安装命令（autoInstall=true 时）。返回是否成功。 */
export function runInstall(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise((resolve) => {
    // 安装命令按 shell 执行（npm/curl 是 shell 命令形态，可能含引号/管道/
    // 多个参数——execFile 直接 split 会切错，用 sh -c 交给 shell 解析）。
    const child = spawn("sh", ["-c", command], { env, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** 引导安装提示（注入给 agent 的文本，不自动执行）。 */
export function installGuidance(installCommand: string): string {
  return [
    "codegraph CLI 未安装。请执行以下命令安装（codegraph 是本地代码图谱，",
    "安装后本插件才能注册 MCP 服务器与纪律工具）：",
    "",
    `  ${installCommand}`,
    "",
    "安全说明：安装命令来自第三方（@colbymchenry/codegraph），执行前请知悉",
    "供应链风险；安装完成后重启 dsh web 或重连会话生效。",
  ].join("\n");
}
