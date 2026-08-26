// @ts-nocheck
/**
 * dsh-notifier — unit：通知文案与系统命令构造纯函数。
 *
 * 覆盖：formatDuration 人类可读耗时、prettyToolName（中文映射 / MCP 美化 /
 * 未知原样）、sessionTitleOf（标题提取/截断/容错）、buildSystemCommand
 * （Windows/macOS/Linux 参数形态）、isLoopbackRequest 围栏判定。
 */
import { assert, fakeReq } from "./helpers.ts";
import { formatDuration, prettyToolName, sessionTitleOf, buildSystemCommand, isLoopbackRequest } from "../lib/index.js";

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
// Windows（issue #238）：固定前缀 + 单一 base64 payload token；前缀用 deepEqual
// 全序列快照（includes 片段断言抓不住多余/错位 token）。
const decodePayload = (argv: string[]) => JSON.parse(Buffer.from(argv[argv.length - 1], "base64").toString("utf8"));
const winArgs = buildSystemCommand("win32", "标题", "内容 -x", { silent: true, toastScript: "t.ps1" });
assert.equal(winArgs[winArgs.length - 2], "-Payload", "payload 参数名成对出现在末尾");
assert.deepEqual(
  winArgs.slice(0, -2),
  ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "t.ps1"],
  "win32 argv 固定前缀快照（末两位为 -Payload + 值）"
);
assert.match(winArgs[winArgs.length - 1], /^[A-Za-z0-9+/=]+$/, "payload 仅含 base64 字符集（永不被误认成参数名/不被拆 token）");
assert.deepEqual(decodePayload(winArgs), { title: "标题", message: "内容 -x", silent: true }, "payload round-trip 深等于输入");
// 边界用例：dash 开头 / 双引号 / 换行 / emoji——payload 形态不变、内容无损往返
for (const c of [
  { title: "-TODO-fix", message: "- item", silent: true },
  { title: '说"话', message: "line\nbreak", silent: false },
  { title: "🚀任务完成", message: "🎉🎉🎉", silent: true },
]) {
  const a = buildSystemCommand("win32", c.title, c.message, { silent: c.silent, toastScript: "t.ps1" });
  assert.match(a[a.length - 1], /^[A-Za-z0-9+/=]+$/, "边界值下 payload 仍是纯 base64 token");
  assert.deepEqual(decodePayload(a), c, "边界值 round-trip 无损");
}
const macArgs = buildSystemCommand("darwin", "标题", '说"话', { silent: false, toastScript: "t.ps1" });
assert.equal(macArgs[0], "osascript");
assert.match(macArgs.join(" "), /display notification/);
assert.ok(macArgs.join(" ").includes('sound name "Glass"'), "非静默带 Glass 提示音");
assert.ok(!macArgs.join(" ").includes('说话"'), "消息内引号被转义");
assert.equal(buildSystemCommand("linux", "t", "m", { silent: true, notifySendAvailable: false, toastScript: "t.ps1" }), null, "notify-send 不可用返回 null");
assert.deepEqual(buildSystemCommand("linux", "t", "m", { silent: true, toastScript: "t.ps1" }), ["notify-send", "t", "m"]);

// sessionTitleOf：从 session.events 的 session/title 事件取标题
const titledAgent = {
  id: "session-1",
  session: { events: [{ type: "other", data: {} }, { type: "session/title", data: { title: "优化 notifier 插件" } }] },
};
assert.equal(sessionTitleOf(titledAgent), "优化 notifier 插件", "取最后一个标题事件");
assert.equal(sessionTitleOf({ id: "session-1", session: { events: [] } }), undefined, "无标题事件返回 undefined");
assert.equal(sessionTitleOf({ id: "session-1" }), undefined, "无 session 返回 undefined");
assert.equal(sessionTitleOf(undefined), undefined, "无 agent 返回 undefined");
assert.equal(sessionTitleOf({ id: "session-1", session: { events: "bad" } }), undefined, "events 非数组容错");
assert.equal(
  sessionTitleOf({ session: { events: [{ type: "session/title", data: { title: "优".repeat(80) } }] } }),
  "优".repeat(40),
  "标题截断 40 字符"
);

// sessionTitleOf 接入脱敏链（issue #30）：标题源自会话内容，进入通知与历史前
// 敏感片段必须打码；正常标题不含敏感特征、脱敏后原样透传保持可读
assert.ok(
  !sessionTitleOf({ session: { events: [{ type: "session/title", data: { title: `修复 ${"a".repeat(48)} 泄漏` } }] } })!.includes("aaaa"),
  "标题中长 hex 密钥片段被打码为 <token>"
);
assert.equal(
  sessionTitleOf({ session: { events: [{ type: "session/title", data: { title: `修复 ${"f".repeat(30)} 泄漏` } }] } }),
  "修复 <token> 泄漏",
  "≥24 位 hex 长串在标题中打码"
);
assert.ok(
  !sessionTitleOf({ session: { events: [{ type: "session/title", data: { title: "联系 admin@corp.example.com 处理部署" } }] } })!.includes("admin@"),
  "标题中邮箱地址被打码为 <email>"
);
assert.equal(
  sessionTitleOf(titledAgent),
  "优化 notifier 插件",
  "正常标题脱敏后原样透传（可读性不受影响）"
);

// loopback 围栏：回环放行、非回环拒绝
assert.equal(isLoopbackRequest(fakeReq()), true);
assert.equal(isLoopbackRequest(fakeReq({ socket: { remoteAddress: "10.0.0.2" } })), false);
