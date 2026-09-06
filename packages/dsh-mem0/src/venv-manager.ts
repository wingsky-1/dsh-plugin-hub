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
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  const trimmedPreferred = preferredBin?.trim();
  const isCustomUserBin = Boolean(trimmedPreferred && trimmedPreferred !== "auto" && trimmedPreferred !== "python3");

  // 1. 若用户显式配置了自定义 Python 路径，仅严格探测该路径，不隐式降级（显式意图优于隐式推断）
  if (isCustomUserBin && trimmedPreferred) {
    try {
      await execFileAsync(trimmedPreferred, ["--version"]);
    } catch (err: any) {
      return {
        ok: false,
        pythonBin: trimmedPreferred,
        reason: "python_not_found",
        detail: `Custom python binary '${trimmedPreferred}' not found: ${err?.message || String(err)}`,
      };
    }
    try {
      await execFileAsync(trimmedPreferred, ["-c", "import mem0, mcp"]);
      return {
        ok: true,
        pythonBin: trimmedPreferred,
        reason: "ready",
      };
    } catch (err: any) {
      return {
        ok: false,
        pythonBin: trimmedPreferred,
        reason: "dependency_missing",
        detail: err?.stderr || err?.message || "Required packages (mem0ai, mcp) are missing in custom python environment.",
      };
    }
  }

  // 2. 缺省或 auto 模式：按优先级候选探测（首选就绪环境）
  const candidates: string[] = [];
  if (existsSync(VENV_PYTHON)) {
    candidates.push(VENV_PYTHON);
  }
  candidates.push("python3");
  candidates.push("python");

  let foundPython = false;
  let firstValidPython = "";
  let lastDetail = "";

  for (const bin of candidates) {
    try {
      // 1. 测试 python 命令本身是否存在
      await execFileAsync(bin, ["--version"]);
      if (!firstValidPython) firstValidPython = bin;
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
      if (!firstValidPython) firstValidPython = bin;
      lastDetail = err?.stderr || err?.message || String(err);
    }
  }

  if (!foundPython) {
    return {
      ok: false,
      pythonBin: "python3",
      reason: "python_not_found",
      detail: "No python executable found in system or ~/.dsh/mem0/venv",
    };
  }

  return {
    ok: false,
    pythonBin: firstValidPython || "python3",
    reason: "dependency_missing",
    detail: lastDetail || "Required packages (mem0ai, mcp) are missing.",
  };
}

/**
 * 强校验 venv 可用性：不仅要存在 VENV_PYTHON，还必须带可用的 pip 模块。
 *
 * #612：ensurepip 失败会留下"有 python 软链和 pyvenv.cfg 但无 pip 无 site-packages"
 * 的残缺 venv；旧逻辑仅 existsSync 判定成功，随后 `python -m pip install` 必然
 * "No module named pip" 失败，且 `python -m venv` 对已存在目录幂等不重建——
 * 一键安装从此死循环。强校验失败时由调用方清理重建。
 */
export async function isVenvUsable(): Promise<boolean> {
  if (!existsSync(VENV_PYTHON)) return false;
  try {
    await execFileAsync(VENV_PYTHON, ["-m", "pip", "--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理残缺 venv 目录（幂等：目录不存在时静默成功）。
 */
export function removeBrokenVenv(): void {
  try {
    rmSync(DEFAULT_VENV_DIR, { recursive: true, force: true });
  } catch {
    // 清理失败不阻塞主流程：后续 venv 创建若因残留目录失败会走 --user 降级
  }
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
  // #612：残缺 venv（无 pip）必须先清理，否则幂等 venv 创建不会补 pip，一键安装死循环
  if (existsSync(VENV_PYTHON) && !(await isVenvUsable())) {
    log("检测到残缺虚拟环境（缺少 pip），先清理后重建...");
    removeBrokenVenv();
  }
  try {
    log("正在尝试创建专属虚拟环境 ~/.dsh/mem0/venv ...");
    await execFileAsync(pythonBin, ["-m", "venv", DEFAULT_VENV_DIR]);
    // 强校验：有 python 还必须带 pip（#612），否则视同创建失败走 --user 降级
    if (existsSync(VENV_PYTHON) && (await isVenvUsable())) {
      useVenv = true;
      log("虚拟环境创建成功！");
    } else if (existsSync(VENV_PYTHON)) {
      log("虚拟环境创建不完整（ensurepip 失败），清理残壳并转为用户级目录免提权安装 (--user)...");
      removeBrokenVenv();
      useVenv = false;
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
