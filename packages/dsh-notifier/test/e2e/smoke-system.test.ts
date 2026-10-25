import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pollUntil, withEnv } from "../helpers.ts";
import {
  LINUX_NOTIFY_ARGV,
  SYSTEM_ONLY,
  SYSTEM_SOUND,
  exitCodeOf,
  historyLines,
  mount,
  parseBody,
  realPath,
  sameArgv,
  seed,
  send,
  sharedApi,
  stubCalls,
  stubDir,
  stubLog,
  systemApi,
  systemDepsApi,
} from "./smoke-support.ts";

function registerLinuxStubDelivery(): void {
  it("平台相关（linux）：桩 notify-send 被探测命中，并以逐字 argv 收到通知", async (ctx) => {
    ctx.skip(process.platform !== "linux", "本用例守的是 buildSystemCommand 的 linux 分支");
    rmSync(stubLog, { force: true });
    // 本用例刚把桩日志清空，而平台探测在进程内只缓存一次：不复位缓存，`--version` 那一次就留在了
    // 前一个用例的日志窗口里，这条判据会变成「看谁先跑」（`/health` 的用例现在也会触发探测）。
    systemDepsApi.releaseSystemDeps();
    seed(SYSTEM_ONLY);
    const { port } = await mount();

    // 经真实 HTTP 面的测试按钮走同一条裁决管线，而不是直接调出口。
    const accepted = await send(port, "/api/dsh-notifier/test", {
      method: "POST",
      body: JSON.stringify({ channelId: "system" }),
    });
    expect(accepted.status).toBe(200);
    // 等的是**完整 argv**而不是「桩被碰过」：探测那一次也会写日志，而通知那一次是先写 `call` 行
    // 再逐行写 argv 的，只等前者会拿着半截 argv 去断言。
    await pollUntil(
      () => stubCalls().some((call) => sameArgv(call, LINUX_NOTIFY_ARGV)),
      "桩收到完整的通知 argv",
      15_000,
    );

    // 「--version 探测」只有非 darwin/win32 那一支才会发生，它同时是「探测命中」与「走了 Linux 分支」
    // 的证据；探测在进程内只缓存一次，故断言的是日志里存在过而不是它是第 0 次。
    expect(stubCalls()).toContainEqual(["--version"]);
    // argv 逐字：`-h boolean:suppress-sound:true <title> <body>`（DE 的 sound hint 不可依赖，
    // 发声一律由出口自播承担，故恒带 suppress-sound）。
    expect(stubCalls()).toContainEqual([...LINUX_NOTIFY_ARGV]);
  });
}

function registerLinuxSoundWarning(): void {
  it("平台相关（linux）：弹窗成功但无播放器 ⇒ 真实链路 ok + soundWarning 落史落态（不宣称听音）", async (ctx) => {
    ctx.skip(process.platform !== "linux", "本用例守的是 sendSystem 的 linux 自播分支");
    // PATH 只留桩目录：播放器探测全落空（与本机装没装 ffplay 无关），自播需要但无可执行声音
    // ⇒ skipEnvironment 警告；桩 notify-send 照常弹，总体仍 ok。不断言任何音频事实。
    const restorePath = withEnv({ PATH: stubDir });
    try {
      rmSync(stubLog, { force: true });
      systemDepsApi.releaseSystemDeps();
      seed(SYSTEM_SOUND);
      const { port } = await mount();

      // 时间锚：前一个用例的迟到写入（fire-and-forget 落盘队列）可能此刻才落盘，
      // 以下只认 ts 在本轮之后的记录，不数它。
      expect((await send(port, "/api/dsh-notifier/history", { method: "DELETE" })).status).toBe(
        200,
      );
      const t0 = Date.now();

      // dry-run 先行：同步返回 ok + 警告，且零落盘（与广播的 fire-and-forget 时序无关）。
      const dry = await send(port, "/api/dsh-notifier/test", {
        method: "POST",
        body: JSON.stringify({
          channelId: "system",
          draft: {
            channels: [{ type: "system", id: "system", enabled: true, popup: true, sound: "ding" }],
          },
        }),
      });
      expect(dry.status).toBe(200);
      expect(parseBody<unknown>(dry.body)).toEqual({
        ok: true,
        channelId: "system",
        status: "ok",
        soundWarning: { code: "reasonSkipEnvironment" },
      });
      const dryDeadline = Date.now() + 800;
      for (;;) {
        expect(
          historyLines().filter((line) => (line.ts ?? 0) >= t0),
          "dry-run 不落历史",
        ).toEqual([]);
        const probe = await send(port, "/api/dsh-notifier/status");
        expect(probe.status).toBe(200);
        // 状态同样只认本轮的新条目：上一个用例迟到的在途投递可能此刻才结算进镜像。
        const fresh = Object.values(
          parseBody<{ channels: Record<string, { lastTs?: number }> }>(probe.body).channels,
        ).filter((entry) => (entry.lastTs ?? 0) >= t0);
        expect(fresh, "dry-run 不写频道状态").toEqual([]);
        if (Date.now() >= dryDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // 广播走真实裁决管线：弹窗经桩 notify-send 真起进程，警告经真实 stores 落盘。
      const t1 = Date.now();
      const accepted = await send(port, "/api/dsh-notifier/test", {
        method: "POST",
        body: JSON.stringify({ channelId: "system" }),
      });
      expect(accepted.status).toBe(200);
      await pollUntil(
        () =>
          historyLines().filter((line) => line.kind === "test" && (line.ts ?? 0) >= t1).length > 0,
        "测试通知落史",
        15_000,
      );
      const records = historyLines().filter((line) => line.kind === "test" && (line.ts ?? 0) >= t1);
      expect(records).toHaveLength(1);
      expect(records[0]?.channels).toEqual([
        { channelId: "system", status: "ok", soundWarning: { code: "reasonSkipEnvironment" } },
      ]);

      const status = await send(port, "/api/dsh-notifier/status");
      expect(status.status).toBe(200);
      const systemStatus = parseBody<{ channels: Record<string, Record<string, unknown>> }>(
        status.body,
      ).channels.system;
      expect(systemStatus?.lastStatus).toBe("ok");
      expect(systemStatus?.failStreak).toBe(0);
      expect(systemStatus?.lastSoundWarning).toEqual({ code: "reasonSkipEnvironment" });
    } finally {
      restorePath();
      systemDepsApi.releaseSystemDeps();
    }
  });
}

function registerLinuxRealHost(): void {
  it("平台相关（linux 真机）：真实 notify-send 且 D-Bus 会话可用时真实调用一次并断言退出码", async (ctx) => {
    ctx.skip(process.platform !== "linux", "非 Linux 平台没有 notify-send 这一支");

    // PATH 先还原成系统的那一份：上面的桩只会让这条用例假绿。
    const restore = withEnv({ PATH: realPath });
    try {
      const probe = await systemApi.probePlatform(sharedApi.toastScriptPath());
      ctx.skip(!probe.notifySendAvailable, "系统 PATH 里没有真实 notify-send");
      const command = systemApi.buildSystemCommand(probe, "DSH：真机冒烟", "平台相关用例", {
        sound: false,
        selfPlay: false,
        toastScript: sharedApi.toastScriptPath(),
      });
      ctx.skip(command.length === 0, "本平台给不出系统通知命令（notify-send 探测未命中）");
      // D-Bus 会话不可用时 notify-send 必然非零退出，那测到的是环境而不是本插件，故显式跳过并写明原因。
      const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
      const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
      const sessionBus =
        busAddress !== "" || (runtimeDir !== "" && existsSync(join(runtimeDir, "bus")));
      ctx.skip(
        !sessionBus,
        "D-Bus 会话不可用（无 DBUS_SESSION_BUS_ADDRESS 且无 $XDG_RUNTIME_DIR/bus）",
      );

      expect(command[0]).toBe("notify-send");
      // 真实调用一次：退出码 0 就是这次系统通知真的发出去了。
      const code = await exitCodeOf(command[0], command.slice(1));
      expect(code, `真实 notify-send 退出码（argv: ${command.join(" ")}）`).toBe(0);
    } finally {
      restore();
    }
  });
}

describe("Linux 系统通知（平台相关）", () => {
  registerLinuxStubDelivery();
  registerLinuxSoundWarning();
  registerLinuxRealHost();
});
