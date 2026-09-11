/**
 * dsh-notifier — unit：通知文案与系统命令构造纯函数。
 *
 * 覆盖：formatDuration 人类可读耗时、prettyToolName（中文映射 / MCP 美化 /
 * 未知原样）、sessionTitleOf（标题提取/截断/容错）、buildSystemCommand
 * （Windows/macOS/Linux 参数形态）、isLoopbackRequest 围栏判定。
 */
import type { IncomingMessage } from "node:http";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { assert, fakeReq } from "../helpers.ts";
import { type SystemTone, formatDuration, prettyToolName, sessionTitleOf, buildSystemCommand, buildSoundCommand, MAC_SOUND_NAMES, toneFileCandidates, isLoopbackRequest } from "../../lib/index.js";

assert.equal(formatDuration(45000), "45 秒");
assert.equal(formatDuration(135000), "2 分 15 秒");
assert.equal(formatDuration(3725000), "1 小时 2 分 5 秒");
assert.equal(formatDuration(0), "0 秒");

assert.equal(prettyToolName("pwsh"), "PowerShell 命令", "常见工具映射中文名");
assert.equal(prettyToolName("ssh_exec"), "SSH 远程执行");
assert.equal(prettyToolName("web_search"), "联网搜索");
assert.equal(prettyToolName("unknown_tool"), "unknown_tool", "未知工具原样");
assert.equal(prettyToolName("mcp__my-server__read_file"), 'MCP 服务器 "my-server" 的工具 "read_file"');
assert.equal(prettyToolName("mcp__srv__a__b"), 'MCP 服务器 "srv" 的工具 "a__b"');
assert.equal(prettyToolName(undefined), "?");

// buildSystemCommand：Windows/macOS/Linux 参数形态（smoke 断言 spawn 参数）
// Windows：固定前缀 + 单一 base64 payload token；前缀用 deepEqual
// 全序列快照（includes 片段断言抓不住多余/错位 token）。
const decodePayload = (argv: string[]) => JSON.parse(Buffer.from(argv[argv.length - 1], "base64").toString("utf8"));
const winArgs = buildSystemCommand("win32", "标题", "内容 -x", { sound: false, toastScript: "t.ps1" })!;
assert.equal(winArgs[winArgs.length - 2], "-Payload", "payload 参数名成对出现在末尾");
assert.deepEqual(
  winArgs.slice(0, -2),
  ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "t.ps1"],
  "win32 argv 固定前缀快照（末两位为 -Payload + 值）"
);
assert.match(winArgs[winArgs.length - 1], /^[A-Za-z0-9+/=]+$/, "payload 仅含 base64 字符集（永不被误认成参数名/不被拆 token）");
assert.deepEqual(decodePayload(winArgs), { title: "标题", message: "内容 -x", silent: true }, "payload round-trip 深等于输入（sound:false → silent）");
// 边界用例：dash 开头 / 双引号 / 换行 / emoji——payload 形态不变、内容无损往返
for (const c of [
  { title: "-TODO-fix", message: "- item", silent: true, sound: false },
  { title: '说"话', message: "line\nbreak", silent: false, sound: true },
  { title: "🚀任务完成", message: "🎉🎉🎉", silent: true, sound: false },
]) {
  const a = buildSystemCommand("win32", c.title, c.message, { sound: c.sound, toastScript: "t.ps1" })!;
  assert.match(a[a.length - 1], /^[A-Za-z0-9+/=]+$/, "边界值下 payload 仍是纯 base64 token");
  assert.deepEqual(decodePayload(a), { title: c.title, message: c.message, silent: c.silent }, "边界值 round-trip 无损");
}
// Windows 声音三态 × toast payload——false→silent、true→不 silent、
// SoundId+自播→silent（P0-2：应用自播时 toast 静音防双响）
const winTrue = buildSystemCommand("win32", "t", "m", { sound: true, toastScript: "t.ps1" })!;
assert.equal(decodePayload(winTrue).silent, false, "B1：win32 sound:true → toast 不 silent（默认系统音）");
const winTone = buildSystemCommand("win32", "t", "m", { sound: "ding", selfPlay: true, toastScript: "t.ps1" })!;
assert.equal(decodePayload(winTone).silent, true, "B1：win32 SoundId+自播 → toast silent（防双响）");
assert.equal(buildSystemCommand("win32", "t", "m", { sound: "ding", toastScript: "t.ps1" }) !== null, true, "win32 SoundId 命令仍构造（自播由 SystemNotifier 按平台能力另发）");

const macArgs = buildSystemCommand("darwin", "标题", '说"话', { sound: true, toastScript: "t.ps1" })!;
assert.equal(macArgs[0], "osascript");
assert.match(macArgs.join(" "), /display notification/);
assert.ok(macArgs.join(" ").includes('sound name "Glass"'), "B1：darwin sound:true 带 Glass 提示音（现状保留）");
assert.ok(!macArgs.join(" ").includes('说话"'), "消息内引号被转义");
// B1：darwin 三态——false 无 sound；SoundId → MAC_SOUND_NAMES 映射名
const macSilent = buildSystemCommand("darwin", "t", "m", { sound: false, toastScript: "t.ps1" })!;
assert.ok(!macSilent.join(" ").includes("sound name"), "B1：darwin sound:false 无 sound");
assert.ok(macSilent.join(" ").includes('display notification "m"'), "B1：darwin 静音仍弹通知实体");
assert.equal(MAC_SOUND_NAMES.ding, "Glass", "B1：ding→Glass 映射");
assert.ok(buildSystemCommand("darwin", "t", "m", { sound: "pop", toastScript: "t.ps1" })!.join(" ").includes(`sound name "${MAC_SOUND_NAMES.pop}"`), "B1：darwin SoundId → 映射名");
const macSelf = buildSystemCommand("darwin", "t", "m", { sound: "ding", selfPlay: true, toastScript: "t.ps1" })!;
assert.ok(!macSelf.join(" ").includes("sound name"), "B1：darwin 自播时通知静音（防双响）");

// B1：Linux——不可用 null；false 与 true/SoundId 均带 suppress-sound hint；参数形态
assert.equal(buildSystemCommand("linux", "t", "m", { sound: true, notifySendAvailable: false, toastScript: "t.ps1" }), null, "notify-send 不可用返回 null");
assert.deepEqual(buildSystemCommand("linux", "t", "m", { sound: false, toastScript: "t.ps1" }), ["notify-send", "-h", "boolean:suppress-sound:true", "t", "m"], "B1：linux sound:false → suppress-sound 不自播");
assert.deepEqual(buildSystemCommand("linux", "t", "m", { sound: true, toastScript: "t.ps1" }), ["notify-send", "-h", "boolean:suppress-sound:true", "t", "m"], "B1：linux sound:true → suppress-sound（自播另发，防 DE 双响）");
assert.deepEqual(buildSystemCommand("linux", "t", "m", { sound: "chime", toastScript: "t.ps1" }), ["notify-send", "-h", "boolean:suppress-sound:true", "t", "m"], "B1：linux SoundId → 同样 suppress-sound（宿主自播音色文件）");

// B2：自播命令纯函数（buildSoundCommand）——Linux 播放器数组传参 + 白名单路径；
// macOS afplay 系统声音文件；Windows SoundPlayer + 路径独立 argv 元素
assert.deepEqual(
  buildSoundCommand("linux", "ding", "pw-play"),
  ["pw-play", "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"],
  "B2：linux ding → pw-play + 事件文件（数组传参，白名单路径）"
);
assert.deepEqual(
  buildSoundCommand("linux", "default", "paplay"),
  ["paplay", "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"],
  "B2：linux default → 默认事件文件（message-new-instant）"
);
assert.equal(buildSoundCommand("linux", "ding", undefined), null, "B2：无播放器 → null（缺失静默）");
assert.deepEqual(
  buildSoundCommand("darwin", "pop", undefined),
  ["afplay", "/System/Library/Sounds/Pop.aiff"],
  "B2：darwin pop → afplay 系统声音文件（无需播放器探测）"
);
const winSound = buildSoundCommand("win32", "ding", undefined)!;
assert.equal(winSound[0], "powershell", "B2：win32 SoundPlayer 走 powershell");
assert.ok(!winSound[winSound.length - 1].includes(";"), "B2：win32 路径独立 argv 元素（无命令拼接面）");
assert.ok(winSound[winSound.length - 1].endsWith("Windows Ding.wav"), "B2：win32 ding → 白名单 wav 路径");
assert.ok(winSound.slice(0, 7).every((s) => !s.includes("C:\\")), "B2：路径不拼进 -Command 骨架（最后元素才含路径）");
// win32 true（跟随系统默认）：弹窗开由 toast 默认音承担（无自播）；只响不弹场景
// 自播命令取「默认通知音」候选（Windows Notify System Generic.wav）
const winDefault = buildSoundCommand("win32", "default", undefined);
assert.ok(winDefault !== null && winDefault[winDefault.length - 1].endsWith("Windows Notify System Generic.wav"), "B2：win32 default → 默认通知音候选 wav");
// 映射表锁定：freedesktop 事件文件在 sound-theme-freedesktop 基线包内确定存在
// （ding→message-new-instant、bell→bell、chime→complete、pop→message）
for (const [tone, file] of [["ding", "message-new-instant.oga"], ["bell", "bell.oga"], ["chime", "complete.oga"], ["pop", "message.oga"]] as Array<[SystemTone, string]>) {
  assert.equal(toneFileCandidates("linux", tone)[0], file, `B2：linux ${tone} 事件文件确定存在（基线包）`);
}

// sessionTitleOf：从 session.snapshotEvents() 的 session/title 事件取标题
// （0.1.2-rc.1 起 session.events getter 移除，fake 与真实宿主同形态）
const titledAgent = {
  id: "session-1",
  session: { snapshotEvents: () => [{ type: "other", data: {} }, { type: "session/title", data: { title: "优化 notifier 插件" } }] },
} as unknown as Agent;
assert.equal(sessionTitleOf(titledAgent), "优化 notifier 插件", "取最后一个标题事件");
assert.equal(sessionTitleOf({ id: "session-1", session: { snapshotEvents: () => [] } } as unknown as Agent), undefined, "无标题事件返回 undefined");
assert.equal(sessionTitleOf({ id: "session-1", session: { snapshotEvents: () => "bad" } } as unknown as Agent), undefined, "snapshotEvents 返回非数组容错");
assert.equal(sessionTitleOf({ id: "session-1" } as unknown as Agent), undefined, "无 session 返回 undefined");
assert.equal(sessionTitleOf(undefined), undefined, "无 agent 返回 undefined");
// 迁移回归：snapshotEvents 方法缺失（旧宿主形态/未挂方法）不得抛错，静默返回 undefined
assert.equal(sessionTitleOf({ id: "session-1", session: {} } as unknown as Agent), undefined, "session 无 snapshotEvents 方法返回 undefined");
assert.equal(
  sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: "优".repeat(80) } }] } } as unknown as Agent),
  "优".repeat(40),
  "标题截断 40 字符"
);

// sessionTitleOf 仅截断 40 字符、不再脱敏（/P1-4：脱敏统一到 sendKind 渲染后
// 单点承接，此层截断仅为展示语义；敏感片段明文透传是统一时点下的预期行为）
assert.equal(
  sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: `修复 ${"a".repeat(48)} 泄漏` } }] } } as unknown as Agent),
  `修复 ${"a".repeat(37)}`,
  "长标题仅 40 字符截断（脱敏已移交 sendKind 统一时点）"
);
assert.equal(
  sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: `修复 ${"f".repeat(30)} 泄漏` } }] } } as unknown as Agent),
  `修复 ${"f".repeat(30)} 泄漏`,
  "≤40 字符标题原样透传（无打码）"
);
assert.equal(
  sessionTitleOf({ session: { snapshotEvents: () => [{ type: "session/title", data: { title: "联系 admin@corp.example.com 处理部署" } }] } } as unknown as Agent),
  "联系 admin@corp.example.com 处理部署",
  "邮箱明文透传（脱敏移交统一时点）"
);
assert.equal(
  sessionTitleOf(titledAgent),
  "优化 notifier 插件",
  "正常标题原样透传（可读性不受影响）"
);

// loopback 围栏：回环放行、非回环拒绝
assert.equal(isLoopbackRequest(fakeReq() as unknown as IncomingMessage), true);
assert.equal(isLoopbackRequest(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }) as unknown as IncomingMessage), false);
