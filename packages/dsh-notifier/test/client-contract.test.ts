// @ts-nocheck
/**
 * dsh-notifier — e2e：客户端契约与两端路由一致性。
 *
 * 覆盖：assertClientSourceContract / assertClientProductContract（共享
 * smoke-lib，与 contract-check 同源）；lib/client.js 中出现的路由字面量
 * 与宿主 ROUTES 常量双向一致；issue #76 客户端清理契约（B1-B6 移除侧边栏
 * 入口/浮层/角标、C 组通知半区保留——SSE/租约/看门狗/音频解锁仍存在且不
 * 依赖任何插件 DOM）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert } from "./helpers.ts";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { ROUTES } from "../lib/index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

{
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const literals = [...client.matchAll(/\/api\/dsh-notifier\/[a-z-]+/g)].map((m) => m[0]);
  const expected = Object.values(ROUTES);
  for (const literal of literals) assert.ok(expected.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expected) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);
}

// ---- issue #76：客户端清理契约（B1-B6 / C 组）----
{
  const src = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // B1-B6：侧边栏入口/浮层/角标/拖拽全部移除（源码无对应符号）
  for (const banned of ["createSidebarEntry", "renderPanel", "attachDrag", "restorePanelPos", "bumpUnread", "initUnread", "data-dsh-notifier-badge", "dsh-notifier-panel", "data-dsh-notifier-entry"]) {
    assert.ok(!src.includes(banned), `B 组：客户端源码不得出现 ${banned}`);
    assert.ok(!client.includes(banned), `B 组：客户端产物不得含 ${banned}`);
  }
  // B6：客户端 entry 不再引用侧边栏注册（DOM 定位锚点移除）
  assert.ok(!src.includes("sidebarCol"), "B6：无侧边栏 DOM 锚点");
  // 未读/角标相关 storage 键不再写入（B4：localStorage 'dsh-notifier:panel:pos' 不再写）
  assert.ok(!src.includes("panel:pos"), "B4：拖拽位置持久化已移除");

  // C1-C9：通知半区保留（SSE/租约/看门狗/音频解锁/事件展示），不依赖任何插件 DOM
  for (const kept of ["startEvents", "WATCHDOG_MS", "claimMaster", "unlockAudio", "EventSource", "new Notification", "showNotification"]) {
    assert.ok(src.includes(kept), `C 组：通知半区保留 ${kept}`);
    assert.ok(client.includes(kept), `C 组：产物保留 ${kept}`);
  }
  // C6：SSE 启动不依赖任何插件 DOM（apply 直接 startEvents，无 mount 等待）
  assert.ok(src.includes("startEvents()"), "C6：apply 直接启动 SSE（不依赖侧边栏挂载）");
  // 卡片挂载经 slots（官方设置页 settings.plugin.item 插槽，id+key 双写）
  assert.ok(src.includes("settings.plugin.item"), "A 组：卡片注册到官方设置页插槽");
}

// lib/toast.ps1 发布物完整性（issue #238）：必须带 UTF-8 BOM 且与源文件逐字节一致。
// pwsh 7 在 CI 上解析通过抓不住 5.1 的 ANSI 码页问题，字节级断言是唯一机器兜底；
// 构建期 copyClientResources 已强制补写，此处防回归（编辑器去 BOM / 复制链变更）。
{
  const stripBom = (buf) => (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
  const libBuf = readFileSync(new URL("../lib/toast.ps1", import.meta.url));
  assert.ok(libBuf[0] === 0xef && libBuf[1] === 0xbb && libBuf[2] === 0xbf, "lib/toast.ps1 必须带 UTF-8 BOM（PS 5.1 按 ANSI 解码无 BOM 文件）");
  const srcBuf = readFileSync(new URL("../src/toast.ps1", import.meta.url));
  assert.deepEqual(stripBom(libBuf), stripBom(srcBuf), "lib/toast.ps1 剥离 BOM 后应与 src 源文件逐字节一致");
}
