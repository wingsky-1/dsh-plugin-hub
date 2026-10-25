/**
 * dsh-notifier channels capabilities real-port checks.
 *
 * The real deps and PATH stubs remain in this file so every CLI query is offline and cannot
 * discover a host-installed gdbus, dbus-send, or busctl.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readOsReleaseFile,
  releaseSystemDeps,
  systemDeps,
} from "../../../src/server/channels/impl/system/deps.ts";
import type { SystemDeps } from "../../../src/server/channels/impl/system/deps.ts";
import type { NotificationNameProbe } from "../../../src/server/channels/impl/system/type.ts";
import { withEnv } from "../../helpers.ts";

/** 桩 CLI 的固定输出。 */
interface StubTool {
  readonly bin: string;
  readonly stdout: string;
  readonly code?: number;
}

/** 单引号包裹：内容里的引号按 POSIX 规则转义，否则 stdout 里的 `'` 会把脚本自己截断。 */
const shQuote = (text: string): string => `'${text.replace(/'/gu, "'\\''")}'`;

/**
 * 桩 CLI：记录「谁被调用 + 逐字 argv」，再回放固定 stdout。
 * 只用 shell 内建（`echo`、`printf`、POSIX 参数展开取命令名）：用例把 PATH 收窄成只有桩目录，任何外部命令
 * 都会找不到，那样失败原因就变成了「测试自己写坏了」。
 */
const stubScript = (log: string, stdout: string, code: number): string =>
  `#!/bin/sh\n{ echo call; printf 'bin\\t%s\\n' "\${0##*/}"; for arg in "$@"; do printf 'arg\\t%s\\n' "$arg"; done; } >> ${shQuote(log)}\nprintf '%s' ${shQuote(stdout)}\nexit ${code}\n`;

/**
 * 真端口 + PATH 桩：解析与「只读、不激活」这条副作用纪律只有真实现能判。
 * PATH 只留桩目录——留了系统路径就会探到本机真的 `gdbus`/`busctl`，「都不可用」那条立刻假绿。
 */
async function realProbe(config: {
  env: Record<string, string | undefined>;
  tools: readonly StubTool[];
}): Promise<{ calls: string[][]; result: NotificationNameProbe }> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-dbus-"));
  const log = join(dir, "calls.log");
  for (const tool of config.tools) {
    const path = join(dir, tool.bin);
    writeFileSync(path, stubScript(log, tool.stdout, tool.code ?? 0));
    chmodSync(path, 0o755);
  }
  const restore = withEnv({ ...config.env, PATH: dir });
  try {
    const result = await systemDepsOf().probeNotificationName();
    return { calls: readCalls(log), result };
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 真实端口：复位端口槽之后它就是生产默认值（`REAL_DEPS`）。 */
function systemDepsOf(): SystemDeps {
  releaseSystemDeps();
  return systemDeps();
}

/** 日志 → 逐次调用：`calls[i][0]` 是命令名，其余是逐字 argv。 */
function readCalls(log: string): string[][] {
  let text: string;
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const calls: string[][] = [];
  for (const line of text.split("\n")) {
    if (line === "call") calls.push([]);
    else if (line.startsWith("bin\t")) calls[calls.length - 1]!.push(line.slice(4));
    else if (line.startsWith("arg\t")) calls[calls.length - 1]!.push(line.slice(4));
  }
  return calls;
}

/** 桩产生的全部 argv（含命令名与子命令），供「不许触发服务激活」这类整体断言用。 */
const flatArgs = (calls: readonly string[][]): string[] => calls.flat();

const BUS = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" };

/**
 * 副作用纪律的公共判据：**三种 CLI 的每一条路径**都不得出现会触发服务激活的 argv。
 * 只在 gdbus 那条用例里断言是不够的——往 dbus-send/busctl 的骨架里塞 `list`/`status`，被测面上零红。
 */
function expectNoActivation(calls: readonly string[][]): void {
  const forbidden = flatArgs(calls).filter(
    (arg) => /^(status|list|--activate)$/u.test(arg) || arg.includes("StartServiceByName"),
  );
  expect(forbidden).toEqual([]);
}

describe("真端口：D-Bus 查询的解析与副作用纪律", () => {
  it("无会话总线时一次子进程都不起（起了必然失败，白等一次超时）", async () => {
    const { calls, result } = await realProbe({
      env: { DBUS_SESSION_BUS_ADDRESS: "" },
      tools: [
        { bin: "gdbus", stdout: "(true,)" },
        { bin: "dbus-send", stdout: "boolean true" },
        { bin: "busctl", stdout: "b true" },
      ],
    });
    expect(result.kind).toBe("no-session-bus");
    expect(calls).toEqual([]);
  });

  it("gdbus 命中 owner：只问 NameHasOwner，argv 里没有任何会触发服务激活的路径", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [{ bin: "gdbus", stdout: "(true,)" }],
    });
    expect(result.kind).toBe("owner");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("gdbus");
    expect(calls[0]!.some((arg) => arg.includes("NameHasOwner"))).toBe(true);
    expectNoActivation(calls);
  });

  it("gdbus 说没有 owner 时再问可激活清单，命中即 activatable（两种问法都要发出去）", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        {
          bin: "gdbus",
          stdout: "(['org.freedesktop.Notifications', 'org.freedesktop.systemd1'],)\n",
        },
      ],
    });
    expect(result.kind).toBe("activatable");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.some((arg) => arg.includes("ListActivatableNames"))).toBe(true);
    expectNoActivation(calls);
  });

  it("可激活清单里没有目标名 ⇒ absent", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [{ bin: "gdbus", stdout: "(['org.freedesktop.systemd1'],)\n" }],
    });
    expect(result.kind).toBe("absent");
    expectNoActivation(calls);
  });

  it("gdbus 问不出来时退到 dbus-send（`boolean true` 形态）", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 1 },
        { bin: "dbus-send", stdout: "method return\n   boolean true\n" },
      ],
    });
    expect(result.kind).toBe("owner");
    expect(calls[0]![0]).toBe("gdbus");
    expect(calls[1]![0]).toBe("dbus-send");
    expectNoActivation(calls);
  });

  it("dbus-send 说没有 owner 时，它自己的可激活清单那条命令也受同一条纪律约束", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 127 },
        {
          bin: "dbus-send",
          stdout:
            'method return\n   boolean false\n   array [\n      string "org.freedesktop.portal.Desktop"\n   ]\n',
        },
      ],
    });
    expect(result.kind).toBe("absent");
    // 第二条命令才是可激活清单：不走这一格，往 dbus-send 骨架里塞 `list` 就没有判据能红
    expect(calls.some((call) => call.some((arg) => arg.includes("ListActivatableNames")))).toBe(
      true,
    );
    expectNoActivation(calls);
  });

  it("busctl 形态（`b false` + `as` 列表）能判出 absent", async () => {
    const { calls, result } = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 127 },
        { bin: "dbus-send", stdout: "", code: 127 },
        { bin: "busctl", stdout: 'b false\nas 1 "org.freedesktop.portal.Desktop"\n' },
      ],
    });
    expect(result.kind).toBe("absent");
    expect(calls[calls.length - 1]![0]).toBe("busctl");
    expectNoActivation(calls);
  });

  it("三种 CLI 都不可用时报 probe-failed（不许猜成 absent）", async () => {
    const missing = await realProbe({ env: BUS, tools: [] });
    expect(missing.result.kind).toBe("probe-failed");

    const failing = await realProbe({
      env: BUS,
      tools: [
        { bin: "gdbus", stdout: "", code: 1 },
        { bin: "dbus-send", stdout: "", code: 1 },
        { bin: "busctl", stdout: "", code: 1 },
      ],
    });
    expect(failing.result.kind).toBe("probe-failed");
    expectNoActivation(failing.calls);
    // detail 只提命令名，不回显宿主原文（它要进 HTTP 响应）
    expect(JSON.stringify(failing.result)).not.toContain("\n");
  });
});

describe("os-release 端口：never-throw 与「只取一行」都要有判据", () => {
  it("文件缺失 ⇒ {ok:false}；目录路径（readFileSync 抛 EISDIR）⇒ 同样兜住，不冒泡", () => {
    // 调用侧没有 try/catch：这里抛出去就是一次未捕获拒绝
    expect(readOsReleaseFile(join(tmpdir(), "dsh-notifier-不存在/os-release"))).toEqual({
      ok: false,
    });
    expect(readOsReleaseFile(tmpdir())).toEqual({ ok: false });
  });

  it("只取 ID 一行：其余行是宿主原文，一个字符都不外泄", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-osrelease-"));
    try {
      const file = join(dir, "os-release");
      writeFileSync(file, 'NAME="Secret Distro"\nID=ubuntu\nVERSION="24.04 LTS"\n');
      expect(readOsReleaseFile(file)).toEqual({ ok: true, id: "ubuntu" });
      expect(JSON.stringify(readOsReleaseFile(file))).not.toContain("Secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没有 ID 行 ⇒ {ok:false}：认不出来就不给包管理器族，不猜一个发行版", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-osrelease-"));
    try {
      const file = join(dir, "os-release");
      writeFileSync(file, 'NAME="Whatever"\nID_LIKE=debian\n');
      expect(readOsReleaseFile(file)).toEqual({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
