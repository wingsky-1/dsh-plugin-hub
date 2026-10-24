// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 客户端 C 类修复哨兵族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的「阶段 7 C 类修复哨兵断言」it 族整块迁入本文件
// （C1 编辑保存链路 / C2 SSE 轮询探测恢复 / C3 超长名溢出防护 / C4 keydown 泄漏 /
// C5 设置卡 setTimeout 清理 / C6 tool-disable 全名形态 / C7 浮窗操作带 cwd /
// C8 checkbox 折叠态 / C10 showPanel 主动刷新 / C13 未知状态投影 / C11 迁移式保存）。
// fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// ---- 阶段 7 C 类修复哨兵断言（先红后绿：断言先行，修复随 commit 转绿）----
it("C1 编辑保存链路修复：fillForm 不再清空 editingName（PATCH 分支可达）+ enabled 回填", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 链路修复：fillForm 函数体（到 saveForm 为止）不得再调用会清空 editingName 的 resetForm。
  const fillFormStart = clientSrc.indexOf("function fillForm");
  const saveFormStart = clientSrc.indexOf("function saveForm");
  expect(
    fillFormStart >= 0 && saveFormStart > fillFormStart,
    "产物含 fillForm/saveForm 标识符",
  ).toBeTruthy();
  expect(
    !clientSrc.slice(fillFormStart, saveFormStart).includes("resetForm("),
    "fillForm 内不再调用 resetForm（清空 editingName 的链路修复）",
  ).toBeTruthy();
  // enabled 回填：编辑 enabled:false 服务器时表单 checkbox 不得被强制勾选（C1 附带回填）。
  expect(
    clientSrc.includes("fill.enabled"),
    "enabled 回填进产物（formEnabled.checked = fill.enabled !== false）",
  ).toBeTruthy();
});
it("C2 SSE 轮询探测恢复：eventsRetired 后周期性探测重连（非永久轮询）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(
    clientSrc.includes("tryResumeEvents"),
    "轮询恢复探测入口 tryResumeEvents 进产物",
  ).toBeTruthy();
  expect(clientSrc, "轮询计数周期性触发探测（pollTicks % N）").toMatch(/pollTicks\s*%/);
});
/**
 * style.css 的排版归 Prettier（该文件在格式化面内），而下面多处判据是按「无空格」的紧凑
 * 形态写的。这里把声明两侧的空白归一化，让判据只认声明内容、不认排版形态。
 */
function styleCssCompact() {
  return readFileSync(new URL("../../src/client/style.css", import.meta.url), "utf8").replace(
    /\s*([{}:;,])\s*/g,
    "$1",
  );
}

it("C3 超长名溢出防护：服务器名/工具名 CSS overflow-wrap", () => {
  const css = styleCssCompact();
  expect(css, "管理面板服务器名 overflow-wrap").toMatch(
    /\.dm-server \.dm-name\{[^}]*overflow-wrap:anywhere/,
  );
  expect(css, "浮窗工具 checkbox 名 overflow-wrap").toMatch(
    /\.dm-float-tool,\.dm-tool\{[^}]*overflow-wrap:anywhere/,
  );
});
it("C4 keydown 泄漏修复：Escape 监听具名 + 卸载配对移除", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(
    clientSrc.includes('addEventListener("keydown", onKeyDown)'),
    "keydown 监听具名 onKeyDown 进产物",
  ).toBeTruthy();
  expect(
    clientSrc.includes('removeEventListener("keydown", onKeyDown)'),
    "配对 removeEventListener 进产物",
  ).toBeTruthy();
});
it("C5 设置卡成功提示 setTimeout 清理（卸载不 setState）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("msgTimer"), "msgTimer ref 进产物").toBeTruthy();
  expect(clientSrc, "卸载/重复保存前清理 msgTimer").toMatch(/clearTimeout\(msgTimer\.current\)/);
});
it("C6 tool-disable 全名形态：projectRoot 缺失防御性不提交非法 @/name", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(
    clientSrc.includes("toolDisableServerKey"),
    "tool-disable 全名拼装 helper 进产物",
  ).toBeTruthy();
  // esbuild 保留模板串形态：helper 返回 `@@global/${server.name}`。
  expect(
    clientSrc.includes("`@@global/${server.name}`"),
    "global 形态 @@global/<name> 进产物（helper 模板串）",
  ).toBeTruthy();
});
it("C7 浮窗操作带 cwd：float connect/enable/disable 与 servers 对齐（#412 自愈）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // esbuild 保留模板串形态：float `&scope=${server.scope}${cwdQuery}`；servers `${scopeQuery}${cwdQuery}`。
  expect(
    clientSrc.includes("${server.scope}${cwdQuery}"),
    "float 操作 URL 拼接 cwdQuery 进产物",
  ).toBeTruthy();
  expect(
    clientSrc.includes("${scopeQuery}${cwdQuery}"),
    "servers disconnect/disable 补齐 cwdQuery 进产物",
  ).toBeTruthy();
});
it("C8 checkbox 折叠态保留：details 按 server 记录并恢复 open", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("openTools"), "渲染前记录展开的折叠组（openTools）进产物").toBeTruthy();
  expect(clientSrc, "重建后恢复 details.open 进产物").toMatch(/details\.open\s*=/);
});
it("C10 showPanel 主动刷新：面板打开即拉最新数据（中间层热切换错配）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const showStart = clientSrc.indexOf("function showPanel");
  expect(showStart >= 0, "showPanel 标识符在产物中").toBeTruthy();
  // 主动补一次 → ≥2 次（断言区分于 onclick 单次，防误绿）。
  const showBody = clientSrc.slice(showStart, showStart + 2500);
  const refreshCount = (showBody.match(/refresh\(state, actions\)/g) ?? []).length;
  expect(
    refreshCount >= 2,
    "showPanel 内 refresh 出现≥2 次（onclick + 打开主动刷新）",
  ).toBeTruthy();
});
it("C13 未知状态按 stopped 投影：servers 列表不静默丢卡（与 float 一致）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc.includes("renderServers"), "renderServers 标识符在产物中").toBeTruthy();
  // 才命中——函数体一变长就失效。改为直接锚 bucketByStatus 的回落读取，契约更准也更稳。
  expect(
    clientSrc.includes("function bucketByStatus"),
    "bucketByStatus 分桶函数进产物（C13 锚点）",
  ).toBeTruthy();
  expect(
    /function bucketByStatus[\s\S]{0,600}get\("stopped"\)/.test(clientSrc),
    '未知状态回落 stopped 桶（byStatus.get(status) ?? byStatus.get("stopped")，不丢卡）',
  ).toBeTruthy();
});
it("C11 编辑改 name/scope 迁移式保存：POST 新条目 + DELETE 旧条目（宿主 PATCH 不支持改名/scope）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 这一行为，锚点随之从局部变量名改为具名谓词——不回退拆解去迁就旧标识符。
  expect(
    clientSrc.includes("isMigratedEdit"),
    "迁移分支判定谓词 isMigratedEdit 进产物",
  ).toBeTruthy();
  expect(
    clientSrc.includes("isEditing"),
    "编辑态判定谓词 isEditing 进产物（state.editing → state.editingName）",
  ).toBeTruthy();
});
