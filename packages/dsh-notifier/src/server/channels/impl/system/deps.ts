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
import { existsSync, readFileSync } from "node:fs";
import type { NotificationNameProbe, OsReleaseProbe, PlatformProbe } from "./type.ts";

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
  /**
   * 通知守护进程名的具名探测（语义端口，不是通用命令执行口）。
   *
   * 为什么不做成 `{code, stdout}` 这种通用形状：`NameHasOwner` 的答案在 stdout 而 exit 恒 0，
   * `ListActivatableNames` 的输出是名字数组——通用形状会把三种 CLI 的格式差异外泄给每个调用方，
   * 且逼调用方按字节数截断（截断即漏项）。这里只回结论，格式与解析留在实现内。
   */
  probeNotificationName(): Promise<NotificationNameProbe>;
  /** 读发行版标识（只取 `ID=`）。never-throw：缺文件与读失败都回 `{ ok: false }`。 */
  readOsRelease(): OsReleaseProbe;
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

/** 通知守护进程名。 */
const NOTIFICATION_NAME = "org.freedesktop.Notifications";
/** 会话总线地址缺失即无会话总线：此时连探测都不该起（起了必然失败，白白多一条子进程与一条 stderr）。 */
const SESSION_BUS_ENV = "DBUS_SESSION_BUS_ADDRESS";
/** 发行版标识文件。 */
const OS_RELEASE_PATH = "/etc/os-release";
/** 只读查询的 stdout 上限：`ListActivatableNames` 在真实桌面总线上常有上百项，按字节截断会把
 * 可激活的服务漏判成不存在（假警报），故超限一律报失败而不是截断。 */
const QUERY_STDOUT_LIMIT = 64 * 1024;
/**
 * 单条只读查询的超时。**比平台命令探测的 3s 短**：这是本机总线上的两次问答，正常是毫秒级；总线地址在
 * 而 socket 已死时我们想尽快换下一条 CLI，而不是每条都等满 3 秒——那台机器上能力面会等十几秒。
 */
const QUERY_TIMEOUT_MS = 1200;

/** 一条只读查询的结论。启动失败、超时、非零退出、stdout 超限四种成因对本端口是同一个答案
 * 「这条路径问不出来」，区分它们只会让调用方多一层用不上的分支。 */
type QueryOutcome = { ok: true; stdout: string } | { ok: false };

function query(bin: string, args: readonly string[], done: (outcome: QueryOutcome) => void): void {
  execFile(
    bin,
    [...args],
    { timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_STDOUT_LIMIT, encoding: "utf8" },
    (cause, stdout) => {
      done(cause === null ? { ok: true, stdout } : { ok: false });
    },
  );
}

/**
 * 一种 CLI 的探测命令与解析。三种输出格式的差异只活在这张表里：换一台机器装的是哪一个不由本插件决定，
 * 因此三条路径都要能用，且**只允许问 `org.freedesktop.DBus`**（`NameHasOwner` / `ListActivatableNames`）
 * ——`busctl status`/`list` 与 `StartServiceByName` 会触发服务激活，那是副作用。
 */
interface NameQuery {
  readonly bin: string;
  readonly hasOwner: readonly string[];
  readonly activatable: readonly string[];
  /** 该格式下「有 owner」的判据。 */
  readonly ownerIsTrue: (stdout: string) => boolean;
  /** 该格式下列表里出现目标名的判据（按引号形态匹配，不做全表解析）。 */
  readonly listsName: (stdout: string) => boolean;
}

const listed = (stdout: string, quote: string): boolean =>
  stdout.includes(`${quote}${NOTIFICATION_NAME}${quote}`);

const NAME_QUERIES: readonly NameQuery[] = [
  {
    bin: "gdbus",
    hasOwner: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.NameHasOwner",
      NOTIFICATION_NAME,
    ],
    activatable: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus.ListActivatableNames",
    ],
    ownerIsTrue: (stdout) => /\(\s*true\s*,?\s*\)/u.test(stdout),
    listsName: (stdout) => listed(stdout, "'"),
  },
  {
    bin: "dbus-send",
    hasOwner: [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.NameHasOwner",
      `string:${NOTIFICATION_NAME}`,
    ],
    activatable: [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.ListActivatableNames",
    ],
    ownerIsTrue: (stdout) => /boolean\s+true/u.test(stdout),
    listsName: (stdout) => listed(stdout, '"'),
  },
  {
    bin: "busctl",
    hasOwner: [
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      NOTIFICATION_NAME,
    ],
    activatable: [
      "--user",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListActivatableNames",
    ],
    ownerIsTrue: (stdout) => /^b\s+true\b/mu.test(stdout),
    listsName: (stdout) => listed(stdout, '"'),
  },
];

function runQuery(bin: string, args: readonly string[]): Promise<QueryOutcome> {
  return new Promise((resolve) => {
    query(bin, args, resolve);
  });
}

/** 逐个 CLI 尝试。可激活只说明「有服务文件、总线愿意拉起它」，不等于拉起后能用，故与有 owner 分列两态。 */
async function probeNotificationNameReal(): Promise<NotificationNameProbe> {
  if ((process.env[SESSION_BUS_ENV] ?? "") === "") return { kind: "no-session-bus" };
  for (const attempt of NAME_QUERIES) {
    const owned = await runQuery(attempt.bin, attempt.hasOwner);
    if (!owned.ok) continue;
    if (attempt.ownerIsTrue(owned.stdout)) return { kind: "owner" };
    const activatable = await runQuery(attempt.bin, attempt.activatable);
    // 已知无 owner 却问不出可激活清单：这一格没有可信答案，报失败而不是猜成 absent
    if (!activatable.ok)
      return { kind: "probe-failed", detail: `${attempt.bin} 可激活清单读取失败` };
    return { kind: attempt.listsName(activatable.stdout) ? "activatable" : "absent" };
  }
  return { kind: "probe-failed", detail: "gdbus/dbus-send/busctl 均不可用" };
}

/**
 * 只取 `ID=` 一行：整份文件是宿主原文，任何一行都不该进响应体。
 *
 * 路径是入参而不是闭包里的常量：**never-throw 是端口的契约**（调用侧没有 `try/catch`），而这份契约
 * 只有「文件缺失」与「读取抛错」两条路都能被注入才判得住——写死路径的那一版在 CI 上永远读到真文件，
 * 把 `try/catch` 整段删掉都没有一条用例会红。
 */
export function readOsReleaseFile(path: string): OsReleaseProbe {
  try {
    const matched = /^ID=(.*)$/mu.exec(readFileSync(path, "utf8"))?.[1] ?? "";
    const id = matched.trim().replace(/^"|"$/gu, "");
    return id === "" ? { ok: false } : { ok: true, id };
  } catch {
    return { ok: false };
  }
}

/** 生产默认端口：一律取真实进程事实。 */
const REAL_DEPS: SystemDeps = {
  platform: process.platform,
  spawn: spawnChild,
  execFile: probeWithExecFile,
  existsSync: (path) => existsSync(path),
  probeNotificationName: probeNotificationNameReal,
  readOsRelease: () => readOsReleaseFile(OS_RELEASE_PATH),
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

  probeNotificationName(): Promise<NotificationNameProbe> {
    return this.port.probeNotificationName();
  }

  readOsRelease(): OsReleaseProbe {
    return this.port.readOsRelease();
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
