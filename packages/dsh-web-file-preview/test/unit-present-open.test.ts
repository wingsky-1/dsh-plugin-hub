// @ts-nocheck
/**
 * dsh-web-file-preview — 「打开文件」重定向纯逻辑（issue #698）。
 *
 * 地址构造的 golden 表与官方 @deepseek-ai/dsh-util-workspace-path@0.1.5-rc.1 的
 * `fileAddressFor` 逐条对拍一致（18/18，实施期以真实官方包实测）。官方右侧栏 tab
 * 以完整地址作 contentId 去重，任一条漂移都会让同一文件出现两个 tab，故此处锁死。
 */
import assert from "node:assert/strict";
import {
  PRESENT_OPEN_PATH,
  PENDING_TTL_MS,
  isOpenRequest,
  sessionIdOf,
  fileAddressFor,
  looksLikeFilePath,
  usablePending,
} from "../lib/index.js";

const S = "s1";
const PREFIX = "dsh-resource://file/session/s1/";

// ---------------------------------------------------------------- 地址构造

assert.equal(PRESENT_OPEN_PATH, "/api/present.open", "#698：官方打开路由常量");

/** [cwd, path, 期望地址]；与官方实现对拍通过。 */
const addressCases = [
  ["/w", "a/b.md", `${PREFIX}a/b.md`],
  ["/w", "/w/a/b.md", `${PREFIX}a/b.md`],
  ["/w", "/w", `${PREFIX}`],
  ["/w/", "/w/a.md", `${PREFIX}a.md`],
  [undefined, "a/b.md", `${PREFIX}a/b.md`],
  ["", "/abs/x.md", `${PREFIX}/abs/x.md`],
  [undefined, "C:\\Users\\me\\a.ts", `${PREFIX}C:/Users/me/a.ts`],
  ["C:\\proj", "C:\\proj\\a.ts", `${PREFIX}a.ts`],
  [undefined, "\\\\server\\share\\a.txt", `${PREFIX}//server/share/a.txt`],
  ["/w", "src\\a.ts", `${PREFIX}src/a.ts`],
  ["/w", "./a/b.md", `${PREFIX}a/b.md`],
  ["/w", "dir/", `${PREFIX}dir/`],
  ["/w", "a b/中文#1?2.md", `${PREFIX}a%20b/%E4%B8%AD%E6%96%87%231%3F2.md`],
  ["/w", "a/../b.md", `${PREFIX}a/../b.md`],
  ["/w", "/other/abs.md", `${PREFIX}/other/abs.md`],
  ["/w", "", `${PREFIX}`],
  ["/w", "a%b.md", `${PREFIX}a%25b.md`],
  ["/w", "@a.md", `${PREFIX}%40a.md`],
];
for (const [cwd, path, expected] of addressCases) {
  assert.equal(
    fileAddressFor(S, cwd, path),
    expected,
    `#698 地址构造 cwd=${JSON.stringify(cwd)} path=${JSON.stringify(path)}`,
  );
}
assert.equal(
  fileAddressFor("s 1/x", "/w", "a.md"),
  "dsh-resource://file/session/s%201%2Fx/a.md",
  "#698 会话 id 逐段编码",
);

// ---------------------------------------------------------------- 请求识别

assert.equal(
  isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0", { method: "POST" }),
  true,
  "#698 命中打开请求",
);
assert.equal(
  isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0", { method: "post" }),
  true,
  "#698 method 大小写归一",
);
assert.equal(
  isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0&action=reveal", { method: "POST" }),
  false,
  "#698 reveal 刻意放行（决策 1）",
);
assert.equal(
  isOpenRequest("/api/present.open?sessionId=s1&seq=1&index=0&action=open", { method: "POST" }),
  true,
  "#698 显式 action=open 仍命中",
);
assert.equal(isOpenRequest("/api/present.open?sessionId=s1", undefined), false, "#698 无 init 视为 GET");
assert.equal(isOpenRequest("/api/present.open?sessionId=s1", { method: "GET" }), false, "#698 非 POST");
assert.equal(isOpenRequest("/api/present.host", { method: "POST" }), false, "#698 路径全等");
assert.equal(
  isOpenRequest("/api/present.open.bak?sessionId=s1", { method: "POST" }),
  false,
  "#698 前缀相似不误拦",
);
assert.equal(
  isOpenRequest("http://127.0.0.1:3080/api/present.open?sessionId=s1", { method: "POST" }),
  true,
  "#698 绝对 URL",
);
// 官方调用点是字符串 URL，但包装器必须对 Request 实例同样稳健。
assert.equal(
  isOpenRequest({ url: "http://127.0.0.1:3080/api/present.open?sessionId=s1", method: "POST" }, undefined),
  true,
  "#698 Request 实例",
);
assert.equal(
  isOpenRequest({ url: "http://127.0.0.1:3080/api/present.open?sessionId=s1", method: "GET" }, { method: "POST" }),
  true,
  "#698 init.method 优先于 Request.method",
);
assert.equal(isOpenRequest(42, { method: "POST" }), false, "#698 非 URL 入参不炸");

assert.equal(sessionIdOf("/api/present.open?sessionId=abc&seq=1"), "abc", "#698 取会话 id");
assert.equal(sessionIdOf("/api/present.open?seq=1"), null, "#698 缺 sessionId");
assert.equal(sessionIdOf("/api/present.open?sessionId="), null, "#698 空 sessionId");
assert.equal(sessionIdOf("totally not a url path"), null, "#698 不可解析");

// ------------------------------------------------------------ 点击路径采集

assert.equal(looksLikeFilePath("src/a.ts"), true, "#698 相对路径");
assert.equal(looksLikeFilePath("/abs/a.ts"), true, "#698 绝对路径");
assert.equal(looksLikeFilePath("C:\\proj\\a.ts"), true, "#698 Windows 路径");
assert.equal(looksLikeFilePath("README.md"), true, "#698 裸文件名带扩展名");
assert.equal(looksLikeFilePath("  pkg/index.ts  "), true, "#698 前后空白容忍");
assert.equal(looksLikeFilePath(""), false, "#698 空串");
assert.equal(looksLikeFilePath("   "), false, "#698 纯空白");
assert.equal(looksLikeFilePath("https://example.com/a.ts"), false, "#698 URL 不是本地路径");
assert.equal(looksLikeFilePath("打开"), false, "#698 非路径文本");
assert.equal(looksLikeFilePath("a\nb"), false, "#698 多行不采信");
assert.equal(looksLikeFilePath("x".repeat(2000)), false, "#698 超长不采信");

const NOW = 1_000_000;
assert.equal(usablePending({ path: "src/a.ts", at: NOW }, NOW), "src/a.ts", "#698 pending 可用");
assert.equal(usablePending({ path: " src/a.ts ", at: NOW }, NOW), "src/a.ts", "#698 pending 归一");
assert.equal(usablePending(undefined, NOW), null, "#698 未点击");
assert.equal(
  usablePending({ path: "src/a.ts", at: NOW - PENDING_TTL_MS - 1 }, NOW),
  null,
  "#698 过期 pending 不采信",
);
assert.equal(usablePending({ path: "打开", at: NOW }, NOW), null, "#698 非路径 title 不采信");
assert.equal(usablePending({ path: "src/a.ts", at: Number.NaN }, NOW), null, "#698 非法时间戳");
