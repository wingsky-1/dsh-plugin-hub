/**
 * dsh-notifier channels 域 system 块 —— 进程事实端口。
 *
 * 为什么有这个接缝：本块原先直接读进程全局与 Node（`process.platform` / `spawn` / `execFile` /
 * `existsSync`），于是三条平台分支在宿主平台上只有一条可达，探测失败、杀进程超时、退出码异常
 * 这些出口在单测里根本走不到。端口把这四样收成块级依赖，默认值就是真实进程事实——生产路径
 * 逐字未变。
 *
 * 为什么装与卸都要复位探测缓存：缓存存的是「本进程的平台事实」，只换端口而不复位，第二个用例
 * 就会拿到上一个用例探到的平台结论（症状是单跑绿、连跑红）。
 *
 * 端口只在本块 impl 内可达：不 re-export 到包的导出面（见 `src/index.ts` 的导出面快照门禁）。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { PlatformProbe } from "./type.ts";

/** 子进程退出事实。`exited` 为假 = 被信号杀死（多数是我们自己的超时兜底），是主动行为不是异常。 */
export type ProcessExit =
  { readonly exited: true; readonly code: number } | { readonly exited: false };

/** 子进程句柄：只暴露本块用得着的四样。 */
export interface ChildHandle {
  /** stderr 数据；stdio 没接管道时不会有回调。 */
  onStderr(handler: (chunk: Buffer) => void): void;
  onExit(handler: (exit: ProcessExit) => void): void;
  /** 启动失败（二进制缺失、权限不足）。没人接住的 error 事件会把宿主进程打挂。 */
  onError(handler: (cause: Error) => void): void;
  kill(): void;
}

/** 起进程的选项：本块只关心要不要接 stderr（Windows 的 PS 诊断只在 stderr 上）。 */
export interface SpawnOptions {
  readonly collectStderr: boolean;
}

/** 进程事实端口：本块对进程与 Node 的全部依赖。 */
export interface SystemDeps {
  /** 当前平台（`process.platform` 的取值）。 */
  readonly platform: string;
  /** 起一条命令；同步抛错即启动失败。 */
  spawn(command: readonly string[], options: SpawnOptions): ChildHandle;
  /** 探测一条命令是否可用：只回答成败，`failed` 即执行失败。 */
  execFile(
    bin: string,
    args: readonly string[],
    options: { readonly timeout: number },
    done: (failed: boolean) => void,
  ): void;
  existsSync(path: string): boolean;
}

/** 真实子进程句柄：`exit` 的 `code` 只有「有值」与「被信号杀死」两态，收窄在本端口完成。 */
function spawnChild(command: readonly string[], options: SpawnOptions): ChildHandle {
  const child = spawn(
    command[0],
    command.slice(1),
    options.collectStderr
      ? { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
      : { stdio: "ignore" },
  );
  return {
    onStderr(handler) {
      child.stderr?.on("data", handler);
    },
    onExit(handler) {
      child.on("exit", (code) => {
        handler(code === null ? { exited: false } : { exited: true, code });
      });
    },
    onError(handler) {
      child.on("error", handler);
    },
    kill() {
      child.kill();
    },
  };
}

/** 真实探测：`--version` 既不弹通知也不发声，只问这条命令跑不跑得起来。 */
function probeWithExecFile(
  bin: string,
  args: readonly string[],
  options: { readonly timeout: number },
  done: (failed: boolean) => void,
): void {
  execFile(bin, [...args], { timeout: options.timeout }, (cause) => {
    done(cause !== null);
  });
}

/** 生产默认端口：一律取真实进程事实。 */
const REAL_DEPS: SystemDeps = {
  platform: process.platform,
  spawn: spawnChild,
  execFile: probeWithExecFile,
  existsSync: (path) => existsSync(path),
};

/** 平台能力缓存：探一次即复用（同进程内通知脚本路径固定）。 */
class ProbeCache {
  private probe?: Promise<PlatformProbe>;

  /** 取本进程的平台能力；`probe` 只在首次调用时使用。 */
  get(
    toastScript: string,
    probe: (toastScript: string) => Promise<PlatformProbe>,
  ): Promise<PlatformProbe> {
    this.probe ??= probe(toastScript);
    return this.probe;
  }

  reset(): void {
    this.probe = undefined;
  }
}

export const platformCapabilities = new ProbeCache();

/** 端口槽：当前端口收进实例字段（模块级 `let`/`var` 是门禁红线：状态跨实例共享）。 */
class SystemDepsSlot implements SystemDeps {
  private port: SystemDeps = REAL_DEPS;

  get platform(): string {
    return this.port.platform;
  }

  spawn(command: readonly string[], options: SpawnOptions): ChildHandle {
    return this.port.spawn(command, options);
  }

  execFile(
    bin: string,
    args: readonly string[],
    options: { readonly timeout: number },
    done: (failed: boolean) => void,
  ): void {
    this.port.execFile(bin, args, options, done);
  }

  existsSync(path: string): boolean {
    return this.port.existsSync(path);
  }

  install(port: SystemDeps): void {
    this.port = port;
  }
}

const systemDepsSlot = new SystemDepsSlot();

/** 本块的进程事实：调用点每次现取，装/卸之后即刻生效。 */
export function systemDeps(): SystemDeps {
  return systemDepsSlot;
}

/** 装载进程事实端口（只给测试用；生产不调用——默认值就是真实进程事实）。 */
export function installSystemDeps(deps: SystemDeps): void {
  systemDepsSlot.install(deps);
  platformCapabilities.reset();
}

/** 复位端口与探测缓存，与 `installSystemDeps` 配对；重复调用无害。 */
export function releaseSystemDeps(): void {
  systemDepsSlot.install(REAL_DEPS);
  platformCapabilities.reset();
}
