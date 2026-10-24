// dsh-mcp-manager 冒烟测试（vitest e2e project）—— 客户端 SSE 生命周期与样式族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 SSE/visibility/样式 it 族整块迁入本文件
// （客户端 watchdog、回前台重建 SSE、设置卡片样式对齐 #219、F1 浮窗重定位、
// Liquid Glass 失败优先 #938）。fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { styleCssCompact } from "./remaining-smoke-support.ts";

it("回前台重建 SSE + 可用性恢复（visibilitychange → rebindSession → forceReconnect + resume(cwd) + 补拉）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "visibilitychange 监听已挂").toMatch(
    /addEventListener\("visibilitychange",\s*onVisible\)/,
  );
  expect(clientSrc, "回前台路径先重建 SSE").toMatch(
    /onVisible\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(document\.hidden\)\s*return;\s*forceReconnect\(\)/,
  );
  // 再经 postResume 做可用性恢复（半开死连接卡 connected 时纯读 refresh 无法恢复）。
  expect(clientSrc, "回前台路径先重绑会话再 resume（#412 复报：宿主重启场景恢复）").toMatch(
    /rebindSession\(state\)\.then\(\(\)\s*=>\s*postResume\(\)\)/,
  );
  // 恢复节流覆盖 resume 并按 cwd 分键（不同 cwd 不互吞），失败清理本次节流记录。
  expect(clientSrc, "resume 请求体经 resumeBodyOf 拼装本次 cwd").toMatch(/resumeBodyOf\(state\)/);
  expect(clientSrc, "resume 节流按 cwd 分键").toMatch(/lastResumeCwd/);
  expect(clientSrc, "resume 失败清理本次节流记录（失败后可立即重试）").toMatch(
    /lastResumeAt\s*=\s*0/,
  );
  // 清理所有权是递增序号（同毫秒多 attempt 下 key+stamp 不唯一，序号才是身份）。
  expect(clientSrc, "resume 清理所有权用唯一 attempt 序号").toMatch(
    /lastResumeSeq\s*===\s*attempt/,
  );
  // iOS bfcache 恢复（pageshow persisted）等价切回前台，走同一恢复路径。
  expect(clientSrc, "pageshow 监听已挂（bfcache 恢复）").toMatch(
    /addEventListener\("pageshow",\s*onPageShow\)/,
  );
  expect(clientSrc, "pageshow persisted 才触发恢复").toMatch(
    /event\?\.persisted\s*===\s*true\s*\)\s*onVisible\(\)/,
  );
  // 会话状态（onopen → maybeRecoverSession → GET /servers 校验 projectRoot）。
  expect(clientSrc, "SSE 连接建立时挂 onopen 探测").toMatch(/es\.onopen\s*=\s*\(\)\s*=>\s*\{/);
  expect(clientSrc, "onopen 触发宿主会话恢复探测").toMatch(/maybeRecoverSession\(\)/);
});

it("设置卡片样式对齐官方风格（#219：12px 圆角 / bg-layer-3 底 / border-l2 / 15px 名称字 / 13px 描述字 / 14 16 padding / gap 4）", () => {
  const css = styleCssCompact();
  expect(css, "卡片圆角对齐官方 12px").toMatch(/border-radius:12px/);
  expect(css, "卡片底色对齐官方 bg-layer-3").toMatch(
    /background:var\(--dsw-alias-bg-layer-3,#fbfbfc\)/,
  );
  expect(css, "卡片边框对齐官方 border-l2").toMatch(
    /border:1px solid var\(--dsw-alias-border-l2,#e2e5ea\)/,
  );
  expect(css, "head padding 对齐官方 14px 16px").toMatch(
    /\.dm-set-head\{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px/,
  );
  expect(css, "headText gap 对齐官方 4px").toMatch(
    /\.dm-set-headText\{display:flex;flex-direction:column;gap:4px/,
  );
  expect(css, "名称字号对齐官方 15px").toMatch(
    /\.dm-set-name\{display:block;font-size:15px;font-weight:600;line-height:1\.4/,
  );
  expect(css, "描述字号对齐官方 13px").toMatch(
    /\.dm-set-description\{display:block;font-size:13px;line-height:1\.5/,
  );
  expect(css, "描述用 tertiary 层级（与官方同款）").toMatch(/--dsw-alias-label-tertiary,#8a919c/);
});

it("F1（qa 实测 #128）：浮窗面板内容更新后重定位 + toggleFloat 先渲染后定位", () => {
  const src = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 不重排会稳定向下溢出视口（375x667 bottom-left 实测 y=561/bottom=1082 稳态）。
  const renderStart = src.indexOf("function renderFloatPanel");
  const toggleStart = src.indexOf("function toggleFloat");
  expect(
    renderStart >= 0 && toggleStart > renderStart,
    "产物含 renderFloatPanel/toggleFloat 标识符",
  ).toBeTruthy();
  expect(
    src.slice(renderStart, toggleStart).includes("placePanel(state)"),
    "renderFloatPanel 内容渲染完成即触发 placePanel 重定位（bottom 锚点防溢出）",
  ).toBeTruthy();
  // toggleFloat 内先渲染后定位：以真实内容高度定位，消除首帧小高度错位。
  const tf = src.slice(toggleStart);
  expect(
    tf.indexOf("renderFloatPanel(state, actions)") >= 0 &&
      tf.indexOf("renderFloatPanel(state, actions)") < tf.indexOf("placePanel(state)"),
    "toggleFloat 先 renderFloatPanel 后 placePanel",
  ).toBeTruthy();
});

it("Liquid Glass 失败优先 + 浮窗 Esc + 关窗时序 + 降级存在性（#938）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  // 失败优先：renderFloatPanel 内先挂 attention 分组（groupAttention），再走 scope 分组。
  const renderStart = clientSrc.indexOf("function renderFloatPanel");
  const toggleStart = clientSrc.indexOf("function toggleFloat");
  expect(renderStart >= 0, "renderFloatPanel 标识符在产物中").toBeTruthy();
  const renderBody = clientSrc.slice(renderStart, toggleStart);
  expect(
    renderBody.includes("groupAttention"),
    "attention 分组（失败优先置顶）进产物",
  ).toBeTruthy();
  expect(
    renderBody.indexOf("groupAttention") < renderBody.indexOf('["project", "global"]'),
    "attention 分组挂载先于 scope 分组（失败优先）",
  ).toBeTruthy();
  // 浮窗 Esc：与模态同语义，守卫 floatOpen（M3：宣称 Esc/焦点须有实现）。
  expect(
    clientSrc.includes('event.key === "Escape"') && clientSrc.includes("state.floatOpen"),
    "浮窗 Esc 关闭守卫进产物",
  ).toBeTruthy();
  // 关窗时序：JS setTimeout 300ms 与 CSS closing 300ms 对齐（源头不断即砍掉收尾动画）。
  expect(
    clientSrc.includes("setTimeout(finish, 300)"),
    "关窗 hidden 延迟 300ms 进产物",
  ).toBeTruthy();
  const css = styleCssCompact();
  expect(css, "浮窗关闭动画 300ms").toMatch(/dm-float-out 300ms/);
  expect(css, "模态关闭动画 300ms").toMatch(/dm-modal-out 300ms/);
  // 降级三件套存在（M2：缺一即红，防后续重构静默删 media 块）。
  expect(css.includes("prefers-reduced-motion"), "reduced-motion 降级存在").toBeTruthy();
  expect(css.includes("prefers-contrast"), "对比度降级存在").toBeTruthy();
  expect(css.includes("prefers-reduced-transparency"), "减透明降级存在").toBeTruthy();
  expect(css.includes('[data-color-mode="dark"]'), "深色三选择器含 data-color-mode").toBeTruthy();
  // 双主题 wash：变量定义 + 深色覆写存在（M1：深色下禁止写死浅色 wash）。
  expect(css.includes("--dm-wash:"), "主题跟随 wash 变量存在").toBeTruthy();
  expect(css.includes("--dm-card-bg:"), "卡片底变量存在").toBeTruthy();
  expect(css.includes("--dm-row-hover:"), "行 hover 变量存在").toBeTruthy();
});

it("客户端 watchdog：60s 失活重建 + 建连前先关旧（0.1.8 同款防泄漏）", () => {
  const clientSrc = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  expect(clientSrc, "60s watchdog 常量存在").toMatch(/WATCHDOG_MS\s*=\s*(?:60_?000|6e4|60000)/);
  expect(clientSrc.includes("forceReconnect"), "受控重建入口 forceReconnect 存在").toBeTruthy();
  expect(clientSrc.includes("closeEvents"), "关旧连接入口 closeEvents 存在").toBeTruthy();
  // 关旧建新：new EventSource 前必先关旧——覆盖 source 引用不 close 会耗尽
  // 浏览器同源并发连接（dsh-notifier 0.1.8 同款事故）。
  expect(
    clientSrc.indexOf("closeEvents()") >= 0 &&
      clientSrc.indexOf("closeEvents()") < clientSrc.indexOf("new EventSource"),
    "建连前先执行关旧兜底",
  ).toBeTruthy();
  expect(clientSrc, "收到数据帧即喂狗").toMatch(/lastActivity\s*=\s*Date\.now\(\)/);
  // 心跳 ping 帧喂狗后早退，不得落入 else 触发 scheduleRefresh（否则 SSE 退化为隐性 30s 轮询）。
  // #767 B1.5a：帧名的物理定义在 src/shared/frames.ts，客户端产物须引用该常量而非自带字面量
  // （帧名取值与两端一致由 test/e2e/cross-end-lock.test.ts 的冻结表判据盯）。
  expect(clientSrc, "ping 帧仅喂狗即早退（帧名取自 shared 单点）").toMatch(
    /===\s*SSE_FRAMES\.ping\)\s*return/,
  );
  // 卸载清理：watchdog 定时器与 SSE 连接都要收掉（esbuild 产物 undefined 折叠为 void 0）。
  expect(clientSrc, "卸载清 watchdog").toMatch(
    /if\s*\(watchdog\s*!==\s*(?:void 0|undefined)\)\s*clearTimeout\(watchdog\)/,
  );
  expect(clientSrc, "卸载关 SSE 并摘监听").toMatch(
    /closeEvents\(\);\s*document\.removeEventListener\("visibilitychange"/,
  );
});
