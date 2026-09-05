/**
 * dsh-mem0 — Python 环境探测、虚拟环境管理与依赖自愈机制。
 *
 * 核心设计：
 * 1. probePythonEnvironment: 检查候选 Python（用户指定 / ~/.dsh/mem0/venv / 系统 python3）；
 * 2. autoInstallDependencies: 优先尝试虚拟环境，若无 python3-venv 则自动降级使用 pip install --user；
 * 3. 采用国内高可用阿里镜像源（https://mirrors.aliyun.com/pypi/simple/），杜绝清华源 WAF 拦截；
 * 4. 零阻塞异步执行，状态全程透明上报。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dshHome } from "../../../shared/dsh-home.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_VENV_DIR = join(dshHome(), "mem0/venv");
export const VENV_PYTHON = process.platform === "win32"
  ? join(DEFAULT_VENV_DIR, "Scripts/python.exe")
  : join(DEFAULT_VENV_DIR, "bin/python3");

export const ALIYUN_PYPI_INDEX = "https://mirrors.aliyun.com/pypi/simple/";
export const REQUIRED_PACKAGES = [
  "mem0ai==2.0.20",
  "mcp>=1.8,<2",
  "fastembed==0.8.0",
  "qdrant-client",
];

export interface PythonProbeResult {
  ok: boolean;
  pythonBin: string;
  reason?: "python_not_found" | "dependency_missing" | "ready";
  detail?: string;
}

/**
 * 探测指定的 Python 解释器或候选路径是否满足运行时要求。
 */
export async function probePythonEnvironment(preferredBin?: string): Promise<PythonProbeResult> {
  const candidates: string[] = [];

  const trimmedPreferred = preferredBin?.trim();
  if (trimmedPreferred && trimmedPreferred !== "auto") {
    candidates.push(trimmedPreferred);
  }
  if (existsSync(VENV_PYTHON)) {
    candidates.push(VENV_PYTHON);
  }
  candidates.push("python3");
  candidates.push("python");

  let foundPython = false;
  let lastDetail = "";

  for (const bin of candidates) {
    try {
      // 1. 测试 python 命令本身是否存在
      await execFileAsync(bin, ["--version"]);
      foundPython = true;

      // 2. 测试关键依赖是否已装
      await execFileAsync(bin, ["-c", "import mem0, mcp"]);
      return {
        ok: true,
        pythonBin: bin,
        reason: "ready",
      };
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        continue;
      }
      // python 存在但 import 失败
      foundPython = true;
      lastDetail = err?.stderr || err?.message || String(err);
    }
  }

  if (!foundPython) {
    return {
      ok: false,
      pythonBin: preferredBin || "python3",
      reason: "python_not_found",
      detail: "No python executable found in system or ~/.dsh/mem0/venv",
    };
  }

  return {
    ok: false,
    pythonBin: candidates[0] || "python3",
    reason: "dependency_missing",
    detail: lastDetail || "Required packages (mem0ai, mcp) are missing.",
  };
}

/**
 * 执行依赖一键自动安装（双重自愈策略）：
 * 优先创建 ~/.dsh/mem0/venv 虚拟环境并安装；
 * 若系统缺 python3-venv (ensurepip 报错)，自动回退执行 python3 -m pip install --user。
 */
export async function autoInstallDependencies(
  pythonBin = "python3",
  onLog?: (line: string) => void,
): Promise<{ ok: boolean; pythonBin: string; error?: string }> {
  mkdirSync(join(dshHome(), "mem0"), { recursive: true });

  const log = (msg: string) => {
    if (onLog) onLog(msg);
  };

  // 策略 A：尝试创建虚拟环境
  let useVenv = false;
  try {
    log("正在尝试创建专属虚拟环境 ~/.dsh/mem0/venv ...");
    await execFileAsync(pythonBin, ["-m", "venv", DEFAULT_VENV_DIR]);
    if (existsSync(VENV_PYTHON)) {
      useVenv = true;
      log("虚拟环境创建成功！");
    }
  } catch (err: any) {
    log("创建虚拟环境跳过（缺少系统 python3-venv 工具），自动转为用户级目录免提权安装 (--user)...");
    useVenv = false;
  }

  const targetPython = useVenv ? VENV_PYTHON : pythonBin;
  const pipArgs = useVenv
    ? ["-m", "pip", "install", "-i", ALIYUN_PYPI_INDEX, ...REQUIRED_PACKAGES]
    : ["-m", "pip", "install", "--user", "-i", ALIYUN_PYPI_INDEX, ...REQUIRED_PACKAGES];

  log(`正在使用阿里镜像源下载并安装依赖: ${REQUIRED_PACKAGES.join(" ")} ...`);

  return new Promise((resolve) => {
    const proc = spawn(targetPython, pipArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrOutput = "";

    proc.stdout?.on("data", (chunk) => {
      log(chunk.toString("utf8"));
    });

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrOutput += text;
      log(text);
    });

    proc.on("close", async (code) => {
      if (code === 0) {
        log("依赖包安装成功，正在复核环境...");
        const probe = await probePythonEnvironment(targetPython);
        if (probe.ok) {
          log("环境验证通过，记忆服务就绪！");
          resolve({ ok: true, pythonBin: probe.pythonBin });
          return;
        }
      }
      resolve({
        ok: false,
        pythonBin: targetPython,
        error: stderrOutput || `pip install exited with code ${code}`,
      });
    });

    proc.on("error", (err) => {
      resolve({
        ok: false,
        pythonBin: targetPython,
        error: err.message,
      });
    });
  });
}
