/**
 * dsh-notifier — unit：通知文案与系统命令构造纯函数。
 *
 * 覆盖：formatDuration 人类可读耗时、prettyToolName（中文映射 / MCP 美化 /
 * 未知原样）、sessionTitleOf（标题提取/截断/容错）、buildSystemCommand
 * （Windows/macOS/Linux 参数形态）、isLoopbackRequest 围栏判定。
 */
import type { IncomingMessage } from "node:http";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { describe, expect, it } from "vitest";
import { fakeReq } from "../helpers.ts";
import { type SystemTone, formatDuration, prettyToolName, sessionTitleOf, buildSystemCommand, buildSoundCommand, MAC_SOUND_NAMES, toneFileCandidates, isLoopbackRequest } from "../../src/index.ts";

// buildSystemCommand：Windows/macOS/Linux 参数形态（smoke 断言 spawn 参数）
const decodePayload = (argv: string[]) => JSON.parse(Buffer.from(argv[argv.length - 1], "base64").toString("utf8"));
const winArgs = buildSystemCommand("win32", "标题", "内容 -x", { sound: false, toastScript: "t.ps1" })!;
const macArgs = buildSystemCommand("darwin", "标题", '说"话', { sound: true, toastScript: "t.ps1" })!;
const winSound = buildSoundCommand("win32", "ding", undefined)!;
const titledAgent = {
  id: "session-1",
  session: { snapshotEvents: () => [{ type: "other", data: {} }, { type: "session/title", data: { title: "优化 notifier 插件" } }] },
} as unknown as Agent;

describe("formatDuration 人类可读耗时", () => {
  it("45000 → 45 秒", () => {
    expect(formatDuration(45000)).toBe("45 秒");
  });

  it("135000 → 2 分 15 秒", () => {
    expect(formatDuration(135000)).toBe("2 分 15 秒");
  });

  it("3725000 → 1 小时 2 分 5 秒", () => {
    expect(formatDuration(3725000)).toBe("1 小时 2 分 5 秒");
  });

  it("0 → 0 秒", () => {
    expect(formatDuration(0)).toBe("0 秒");
  });
});

describe("prettyToolName（中文映射 / MCP 美化 / 未知原样）", () => {
  it("常见工具映射中文名", () => {
    expect(prettyToolName("pwsh")).toBe("PowerShell 命令");
  });

  it("ssh_exec → SSH 远程执行", () => {
    expect(prettyToolName("ssh_exec")).toBe("SSH 远程执行");
  });

  it("web_search → 联网搜索", () => {
    expect(prettyToolName("web_search")).toBe("联网搜索");
  });

  it("未知工具原样", () => {
    expect(prettyToolName("unknown_tool")).toBe("unknown_tool");
  });

  it("mcp__my-server__read_file → MCP 美化名", () => {
    expect(prettyToolName("mcp__my-server__read_file")).toBe('MCP 服务器 "my-server" 的工具 "read_file"');
  });

  it("mcp__srv__a__b → 只切前两段", () => {
    expect(prettyToolName("mcp__srv__a__b")).toBe('MCP 服务器 "srv" 的工具 "a__b"');
  });

  it("undefined → ?", () => {
    expect(prettyToolName(undefined)).toBe("?");
  });
});

describe("buildSystemCommand win32：固定前缀 + 单 base64 payload token", () => {
  // Windows：固定前缀 + 单一 base64 payload token；前缀用深比较
  // 全序列快照（includes 片段断言抓不住多余/错位 token）。
  it("payload 参数名成对出现在末尾", () => {
    expect(winArgs[winArgs.length - 2]).toBe("-Payload");
  });

  it("win32 argv 固定前缀快照（末两位为 -Payload + 值）", () => {
    expect(winArgs.slice(0, -2)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "t.ps1"]);
  });

  it("payload 仅含 base64 字符集（永不被误认成参数名/不被拆 token）", () => {
    expect(winArgs[winArgs.length - 1]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("payload round-trip 深等于输入（sound:false → silent）", () => {
    expect(decodePayload(winArgs)).toEqual({ title: "标题", message: "内容 -x", silent: true });
  });
});

describe("buildSystemCommand win32 边界用例：dash 开头 / 双引号 / 换行 / emoji", () => {
  // 边界用例：dash 开头 / 双引号 / 换行 / emoji——payload 形态不变、内容无损往返
  for (const c of [
    { title: "-TODO-fix", message: "- item", silent: true, sound: false },
    { title: '说"话', message: "line\nbreak", silent: false, sound: true },
    { title: "🚀任务完成", message: "🎉🎉🎉", silent: true, sound: false },
  ]) {
    it(`边界值下 payload 仍是纯 base64 token（${JSON.stringify(c.title)}）`, () => {
      const a = buildSystemCommand("win32", c.title, c.message, { sound: c.sound, toastScript: "t.ps1" })!;
      expect(a[a.length - 1]).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it(`边界值 round-trip 无损（${JSON.stringify(c.title)}）`, () => {
      const a = buildSystemCommand("win32", c.title, c.message, { sound: c.sound, toastScript: "t.ps1" })!;
      expect(decodePayload(a)).toEqual({ title: c.title, message: c.message, silent: c.silent });
    });
  }
});

describe("buildSystemCommand win32 声音三态 × toast payload", () => {
  // false→silent、true→不 silent、SoundId+自播→silent（P0-2：应用自播时 toast 静音防双响）
  it("B1：win32 sound:true → toast 不 silent（默认系统音）", () => {
    const winTrue = buildSystemCommand("win32", "t", "m", { sound: true, toastScript: "t.ps1" })!;
    expect(decodePayload(winTrue).silent).toBe(false);
  });

  it("B1：win32 SoundId+自播 → toast silent（防双响）", () => {
    const winTone = buildSystemCommand("win32", "t", "m", { sound: "ding", selfPlay: true, toastScript: "t.ps1" })!;
    expect(decodePayload(winTone).silent).toBe(true);
  });

  it("win32 SoundId 命令仍构造（自播由 SystemNotifier 按平台能力另发）", () => {
    expect(buildSystemCommand("win32", "t", "m", { sound: "ding", toastScript: "t.ps1" }) !== null).toBe(true);
  });
});

describe("buildSystemCommand darwin（macOS）参数形态", () => {
  it("argv[0] = osascript", () => {
    expect(macArgs[0]).toBe("osascript");
  });

  it("命令含 display notification", () => {
    expect(macArgs.join(" ")).toMatch(/display notification/);
  });

  it("B1：darwin sound:true 带 Glass 提示音（现状保留）", () => {
    expect(macArgs.join(" ").includes('sound name "Glass"')).toBeTruthy();
  });

  it("消息内引号被转义", () => {
    expect(!macArgs.join(" ").includes('说话"')).toBeTruthy();
  });

  it("B1：darwin sound:false 无 sound", () => {
    const macSilent = buildSystemCommand("darwin", "t", "m", { sound: false, toastScript: "t.ps1" })!;
    expect(!macSilent.join(" ").includes("sound name")).toBeTruthy();
  });

  it("B1：darwin 静音仍弹通知实体", () => {
    const macSilent = buildSystemCommand("darwin", "t", "m", { sound: false, toastScript: "t.ps1" })!;
    expect(macSilent.join(" ").includes('display notification "m"')).toBeTruthy();
  });

  it("B1：ding→Glass 映射", () => {
    expect(MAC_SOUND_NAMES.ding).toBe("Glass");
  });

  it("B1：darwin SoundId → 映射名", () => {
    expect(buildSystemCommand("darwin", "t", "m", { sound: "pop", toastScript: "t.ps1" })!.join(" ").includes(`sound name "${MAC_SOUND_NAMES.pop}"`)).toBeTruthy();
  });

  it("B1：darwin 自播时通知静音（防双响）", () => {
    const macSelf = buildSystemCommand("darwin", "t", "m", { sound: "ding", selfPlay: true, toastScript: "t.ps1" })!;
    expect(!macSelf.join(" ").includes("sound name")).toBeTruthy();
  });
});

describe("buildSystemCommand linux：不可用 null 与 suppress-sound 参数形态", () => {
  it("notify-send 不可用返回 null", () => {
    expect(buildSystemCommand("linux", "t", "m", { sound: true, notifySendAvailable: false, toastScript: "t.ps1" })).toBe(null);
  });

  it("B1：linux sound:false → suppress-sound 不自播", () => {
    expect(buildSystemCommand("linux", "t", "m", { sound: false, toastScript: "t.ps1" })).toEqual(["notify-send", "-h", "boolean:suppress-sound:true", "t", "m"]);
  });

  it("B1：linux sound:true → suppress-sound（自播另发，防 DE 双响）", () => {
    expect(buildSystemCommand("linux", "t", "m", { sound: true, toastScript: "t.ps1" })).toEqual(["notify-send", "-h", "boolean:suppress-sound:true", "t", "m"]);
  });

  it("B1：linux SoundId → 同样 suppress-sound（宿主自播音色文件）", () => {
    expect(buildSystemCommand("linux", "t", "m", { sound: "chime", toastScript: "t.ps1" })).toEqual(["notify-send", "-h", "boolean:suppress-sound:true", "t", "m"]);
  });
});

describe("buildSoundCommand 自播命令纯函数", () => {
  // Linux 播放器数组传参 + 白名单路径；macOS afplay 系统声音文件；
  // Windows SoundPlayer + 路径独立 argv 元素
  it("B2：linux ding → pw-play + 事件文件（数组传参，白名单路径）", () => {
    expect(buildSoundCommand("linux", "ding", "pw-play")).toEqual(["pw-play", "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"]);
  });

  it("B2：linux default → 默认事件文件（message-new-instant）", () => {
    expect(buildSoundCommand("linux", "default", "paplay")).toEqual(["paplay", "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"]);
  });

  it("B2：无播放器 → null（缺失静默）", () => {
    expect(buildSoundCommand("linux", "ding", undefined)).toBe(null);
  });

  it("B2：darwin pop → afplay 系统声音文件（无需播放器探测）", () => {
    expect(buildSoundCommand("darwin", "pop", undefined)).toEqual(["afplay", "/System/Library/Sounds/Pop.aiff"]);
  });

  it("B2：win32 SoundPlayer 走 powershell", () => {
    expect(winSound[0]).toBe("powershell");
  });

  it("B2：win32 路径独立 argv 元素（无命令拼接面）", () => {
    expect(!winSound[winSound.length - 1].includes(";")).toBeTruthy();
  });

  it("B2：win32 ding → 白名单 wav 路径", () => {
    expect(winSound[winSound.length - 1].endsWith("Windows Ding.wav")).toBeTruthy();
  });

  it("B2：路径不拼进 -Command 骨架（最后元素才含路径）", () => {
    expect(winSound.slice(0, 7).every((s) => !s.includes("C:\\"))).toBeTruthy();
  });

  it("B2：win32 default → 默认通知音候选 wav", () => {
    // win32 true（跟随系统默认）：弹窗开由 toast 默认音承担（无自播）；只响不弹场景
    // 自播命令取「默认通知音」候选（Windows Notify System Generic.wav）
    const winDefault = buildSoundCommand("win32", "default", undefined);
    expect(winDefault !== null && winDefault[winDefault.length - 1].endsWith("Windows Notify System Generic.wav")).toBeTruthy();
  });
});

describe("toneFileCandidates linux 事件文件映射表锁定", () => {
  // 映射表锁定：freedesktop 事件文件在 sound-theme-freedesktop 基线包内确定存在
  // （ding→message-new-instant、bell→bell、chime→complete、pop→message）
  for (const [tone, file] of [["ding", "message-new-instant.oga"], ["bell", "bell.oga"], ["chime", "complete.oga"], ["pop", "message.oga"]] as Array<[SystemTone, string]>) {
    it(`B2：linux ${tone} 事件文件确定存在（基线包）`, () => {
      expect(toneFileCandidates("linux", tone)[0]).toBe(file);
    });
  }
});

describe("sessionTitleOf：从 session.snapshotEvents() 的 session/title 事件取标题", () => {
  // 0.1.2-rc.1 起 session.events getter 移除，fake 与真实宿主同形态
  it("取最后一个标题事件", () => {
    expect(sessionTitleOf(titledAgent)).toBe("优化 notifier 插件");
  });

  it("无标题事件返回 undefined", () => {
    expect(sessionTitleOf({ id: "session-1", session: { snapshotEvents: () => [] } } as unknown as Agent)).toBe(undefined);
  });

  it("snapshotEvents 返回非数组容错", () => {
    expect(sessionTitleOf({ id: "session-1", session: { snapshotEvents: () => "bad" } } as unknown as Agent)).toBe(undefined);
  });

  it("无 session 返回 undefined", () => {
    expect(sessionTitleOf({ id: "session-1" } as unknown as Agent)).toBe(undefined);
  });

  it("无 agent 返回 undefined", () => {
    expect(sessionTitleOf(undefined)).toBe(undefined);
  });

  it("session 无 snapshotEvents 方法返回 undefined", () => {
    // 迁移回归：snapshotEvents 方法缺失（旧宿主形态/未挂方法）不得抛错，静默返回 undefined
    expect(sessionTitleOf({ id: "session-1", session: {} } as unknown as Agent)).toBe(undefined);
  });
});

describe("sessionTitleOf 截断语义（脱敏已移交 sendKind 统一时点）", () => {
  it("标题截断 40 字符", () => {
    expect(
      sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: "优".repeat(80) } }] } } as unknown as Agent)
    ).toBe("优".repeat(40));
  });

  it("长标题仅 40 字符截断（脱敏已移交 sendKind 统一时点）", () => {
    expect(
      sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: `修复 ${"a".repeat(48)} 泄漏` } }] } } as unknown as Agent)
    ).toBe(`修复 ${"a".repeat(37)}`);
  });

  it("≤40 字符标题原样透传（无打码）", () => {
    expect(
      sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: `修复 ${"f".repeat(30)} 泄漏` } }] } } as unknown as Agent)
    ).toBe(`修复 ${"f".repeat(30)} 泄漏`);
  });

  it("邮箱明文透传（脱敏移交统一时点）", () => {
    expect(
      sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: "联系 admin@corp.example.com 处理部署" } }] } } as unknown as Agent)
    ).toBe("联系 admin@corp.example.com 处理部署");
  });

  it("正常标题原样透传（可读性不受影响）", () => {
    expect(sessionTitleOf(titledAgent)).toBe("优化 notifier 插件");
  });
});

describe("isLoopbackRequest 围栏判定", () => {
  it("回环放行", () => {
    expect(isLoopbackRequest(fakeReq() as unknown as IncomingMessage)).toBe(true);
  });

  it("非回环拒绝", () => {
    expect(isLoopbackRequest(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }) as unknown as IncomingMessage)).toBe(false);
  });
});
