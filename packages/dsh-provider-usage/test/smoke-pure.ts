/**
 * dsh-provider-usage — 纯函数 smoke（v2 契约重构版）。
 *
 * 覆盖：esc / 契约校验 / 净化器 / HistoryStore（JSONL 分片）/ safe 守卫 /
 * normalizeConfig / provider-config 配置链 / opencode-go v2 解析 / 热更新加载校验。
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
console.error("EVAL-ORDER-TAG: PURE");
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  ROUTES,
  DEFAULT_CONFIG,
  ADAPTER_CONTRACT_VERSION,
  esc,
  isUsageStatsAdapter,
  describeUsageStatsAdapterShape,
  sanitizeHtml,
  HistoryStore,
  parseJsonl,
  startOfDay,
  migrateLegacyV3,
  legacySampleToData,
  safeFetchData,
  safeFormat,
  normalizeConfig,
  resolveProviderConfig,
  credentialsFile,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  openCodeGoAdapter,
  parseUsageResponse,
  fetchOpenCodeGoV2,
  loadAndValidateAdapter,
  readStamp,
  stampEqual,
  makeAdapterRegistry,
  normalizeUiConfig,
  DEFAULT_UI_CONFIG,
  panelAnchorForPlacement,
  panelTopForAnchor,
} from "../lib/index.js";

// ---------------------------------------------------------------- esc

assert.equal(esc("<script>"), "&lt;script&gt;");
assert.equal(esc(`a"b'c&d`), "a&quot;b&#39;c&amp;d");
assert.equal(esc(null), "");
assert.equal(esc(undefined), "");
assert.equal(esc(123), "123");

// ---------------------------------------------------------------- v2 契约校验

const validAdapter = {
  version: 2,
  name: "my-stats",
  providers: ["p1"],
  fetchData: async () => ({}),
  formatCapsule: () => "<span>x</span>",
  formatPanel: () => "<table></table>",
};

assert.equal(ADAPTER_CONTRACT_VERSION, 2, "新契约版本必须是 2");
assert.equal(isUsageStatsAdapter(validAdapter), true);
assert.equal(isUsageStatsAdapter({ ...validAdapter, version: 1 }), false);
assert.equal(isUsageStatsAdapter({ ...validAdapter, name: "bad name!" }), false);
assert.equal(isUsageStatsAdapter({ ...validAdapter, name: "a" }), false); // 长度 < 2
assert.equal(isUsageStatsAdapter({ ...validAdapter, fetchData: "x" }), false);
assert.equal(isUsageStatsAdapter({ ...validAdapter, formatCapsule: undefined }), false);
assert.equal(isUsageStatsAdapter(null), false);

const shape = describeUsageStatsAdapterShape({ version: 1 });
assert.ok(shape !== null && shape.includes("version"), "形状诊断应包含 version 缺失");
assert.equal(describeUsageStatsAdapterShape(validAdapter), null);

// ---------------------------------------------------------------- sanitize

assert.equal(sanitizeHtml("<script>alert(1)</script><b>ok</b>"), "<b>ok</b>");
assert.equal(sanitizeHtml('<img src="x" onerror="alert(1)">'), '<img src="x">');
assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a href="alert(1)">x</a>');
assert.equal(sanitizeHtml('<iframe src="x"></iframe>y'), "y");
// #198 D5/I2 净化契约：SVG 图表结构存活且净化面干净（错误文案含 <script> 注入面同样被双层防护）
{
  const svgOut = sanitizeHtml('<svg role="img"><rect onmouseover="evil()" fill="#fff"></rect><title>ok</title></svg>');
  assert.ok(svgOut.includes("<svg") && svgOut.includes("role=\"img\""), "sanitize 后 SVG 结构存活");
  assert.ok(!svgOut.includes("onmouseover"), "SVG 内 on* 事件属性被移除");
  const injected = sanitizeHtml('<span>&lt;script&gt;alert(1)&lt;/script&gt;</span><script>alert(2)</script>');
  assert.ok(!injected.includes("<script"), "脚本标签被移除（esc 实体化文本不受影响）");
}

// ------------------------------------------------- sanitize：实体编码变体封闭（#105③）

// 统一判定标准 v2 判据引自 test/helpers.ts 单一事实源（P2③）——
// 禁止在测试文件内再镜像复制解码器/危险模式/判定函数
import { judgeContained as sanContained, judgePad as pad } from "./helpers.ts";

// A1 [硬性] 十六进制带分号实体拼写的协议被封（issue 原例）
{
  const out = sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>');
  assert.ok(sanContained(out), "A1: hex 带分号 javascript: 封闭");
  assert.equal(out, '<a href="alert(1)">x</a>', "A1: 危险区间自原文删除，其余字符保留");
}

// A2 [硬性] 十进制数字实体变体被封（含前导零形态）
{
  for (const payload of [
    '<a href="&#106;avascript:alert(1)">x</a>',       // 词首 j = 106
    '<a href="&#0000106;avascript:alert(1)">x</a>',   // 前导零形态
    '<a href="jav&#97;script:alert(1)">x</a>',        // a = 97
  ]) {
    assert.ok(sanContained(sanitizeHtml(payload)), `A2: 十进制实体变体封闭 ${payload}`);
  }
  // issue 清单字面样例：解码一轮为 "javjascript:"，本就不构成载体（浏览器同样
  // 不执行）——按统一判定标准属安全文本，修复必须保持其原样而非误解码升级
  const literal = sanitizeHtml('<a href="jav&#106;ascript:alert(1)">x</a>');
  assert.ok(sanContained(literal), "A2: 字面样例满足统一判定标准");
  assert.equal(literal, '<a href="jav&#106;ascript:alert(1)">x</a>', "A2: 安全文本零损伤");
}

// A3 [硬性] 无分号数字实体变体被封（HTML5 允许数字实体省略分号）
{
  assert.ok(
    sanContained(sanitizeHtml('<a href="jav&#x61script:alert(1)">x</a>')),
    "A3: hex 无分号（解码即 javascript:）封闭",
  );
  assert.ok(
    sanContained(sanitizeHtml('<a href="&#106avascript:alert(1)">x</a>')),
    "A3: 十进制无分号（词首 j）封闭",
  );
  // 清单字面样例 jav&#106ascript: 解码一轮为 "javjascript:"（安全文本）→ 判定 PASS
  const literal = sanitizeHtml('<a href="jav&#106ascript:alert(1)">x</a>');
  assert.ok(sanContained(literal), "A3: 字面样例满足统一判定标准");
  assert.equal(literal, '<a href="jav&#106ascript:alert(1)">x</a>', "A3: 安全文本零损伤");
}

// A4 [硬性] 大小写混合变体被封（前缀 X 大写 / hex 字母大小写混排）
{
  for (const payload of [
    '<a href="&#X6A;avascript:alert(1)">x</a>',   // 前缀 X 大写
    '<a href="&#X6a;avascript:alert(1)">x</a>',   // 前缀大写 + 数字小写混排
    '<a href="jav&#X61;script:alert(1)">x</a>',   // hex 字母大写混排（X61）
  ]) {
    assert.ok(sanContained(sanitizeHtml(payload)), `A4: 大小写混合变体封闭 ${payload}`);
  }
  // &#X3c;（= '<'）构造的部分编码开标签
  const tagOut = sanitizeHtml("&#X3c;script>alert(1)</script>x");
  assert.ok(sanContained(tagOut), "A4: &#X3c; 开标签变体封闭");
  assert.equal(tagOut, "alert(1)x", "A4: 部分编码标签 token 自原文移除，其间文本保留（同 B3 语义）");
}

// A5 [硬性] 具名实体变体被封（HTML5 具名冒号实体）
{
  const out = sanitizeHtml('<a href="javascript&colon;alert(1)">c</a>');
  assert.ok(sanContained(out), "A5: javascript&colon; 封闭");
  assert.equal(out, '<a href="alert(1)">c</a>', "A5: 具名实体危险区间删除");
}

// A6 [硬性] 事件属性名部分实体编码被封（保守封堵，issue 原例）
{
  const out = sanitizeHtml('<img src=x o&#110;click="alert(1)">');
  assert.ok(sanContained(out), "A6: o&#110;click 封闭（issue 原例）");
  assert.equal(out, "<img src=x>", "A6: 部分编码属性整段删除");
  assert.ok(
    sanContained(sanitizeHtml('<img src=x oncli&#99;k="alert(1)">')),
    "A6: oncli&#99;k 形态封闭",
  );
}

// A7 [硬性] 封闭面覆盖全部载体类别：data:text/html 与 expression( 同类实体变体同封
{
  assert.ok(
    sanContained(sanitizeHtml('<a href="data&colon;text/html;base64,x">c</a>')),
    "A7: data&colon;text/html 封闭",
  );
  assert.ok(
    sanContained(sanitizeHtml('<div style="width:expression&#40;alert(1))">x</div>')),
    "A7: expression&#40; 封闭",
  );
}

// A8 [硬性] 双重编码安全语义保持 + 净化幂等
{
  // (a) 双重编码：浏览器仅解码一层，其本身属安全文本；断言点是修复不得将其
  //     误解码升级为新载体（输出经单轮解码不含可执行载体，且字节零损伤）
  const dblIn = '<a href="&amp;#106;avascript:alert(1)">c</a>';
  const dblOut = sanitizeHtml(dblIn);
  assert.ok(sanContained(dblOut), "A8a: 双重编码输出经单轮解码无可执行载体");
  assert.equal(dblOut, dblIn, "A8a: 双重编码安全文本零损伤");
  assert.ok(!dblOut.includes("javascript:"), "A8a: 未被误解码升级为明文载体");

  // (b) 幂等不动点：sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x)
  const idemSamples = [
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<img src=x o&#110;click="alert(1)">',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    dblIn,
    "data:text/htexpression(ml",           // 删除拼接出新载体的收敛样本
    '<SCRIPT>a</SCRIPT><iframe src=x></iframe>',
    '<p>plain <b>text</b> &amp; more</p>',
    '<a href="/api/x?a=1&amp;b=2">n</a>',
  ];
  for (const s of idemSamples) {
    assert.equal(sanitizeHtml(sanitizeHtml(s)), sanitizeHtml(s), `A8b: 幂等不动点 ${s}`);
  }
}

// A9 [硬性][判定标准 v2] 协议词 Tab/LF/CR 实体族被封（复核 P1-1）：
// WHATWG URL basic parser 解析入口剥除全部 \t\n\r，jav&#9;ascript: 剥后还原
// javascript:——v1 判据与实现曾共盲穿透，现实现按 URL 语义在剥除视图定位
{
  const t1 = [
    '<a href="jav&#9;ascript:alert(1)">x</a>',    // 十进制 tab
    '<a href="jav&#x09;ascript:alert(1)">x</a>',  // hex tab
    '<a href="jav&#10;ascript:alert(1)">x</a>',   // LF
    '<a href="jav&#13;ascript:alert(1)">x</a>',   // CR
    '<a href="jav&Tab;ascript:alert(1)">x</a>',   // 具名 Tab
    '<a href="dat&#9;a:text/html;base64,x">c</a>', // data:text/html 同族
  ];
  for (const payload of t1) {
    const out = sanitizeHtml(payload);
    assert.ok(sanContained(out), `A9: v2 判据下封闭 ${payload}`);
    assert.ok(!out.includes("&#9;") && !out.includes("&#x09;") && !out.includes("&Tab;")
      && !out.includes("&#10;") && !out.includes("&#13;"), `A9: 危险实体区间自输出移除 ${payload}`);
  }
  // 明文 tab 混入协议词同样封闭（URL 剥除语义不区分实体/字面来源）
  assert.ok(sanContained(sanitizeHtml('<a href="jav\tascript:alert(1)">x</a>')), "A9: 字面 tab 变体封闭");
  // 正常文本中的 tab/newline 不受影响（剥除仅用于检测视图，不改写输出）
  const normal = '<p>a\tb\nc</p>';
  assert.equal(sanitizeHtml(normal), normal, "A9: 正常空白字符零损伤");
}

// A10 [硬性][判定标准 v2] 深嵌套收敛与幂等（复核 P1-2）：
// pad(k) 每轮仅暴露一层 <meta>（删除拼接出下一层），k 层需 k 轮——
// 实现迭代至收敛，pad(15..25) 均在 64 轮宽松上限内全净收敛且幂等
{
  for (const depth of [15, 16, 17, 18, 25]) {   // 覆盖旧 16 轮上限两侧
    const x = pad(depth);
    const y = sanitizeHtml(x);
    assert.equal(sanitizeHtml(y), y, `A10: pad(${depth}) 幂等不动点`);
    assert.ok(!/<meta\b|<met\b/i.test(y), `A10: pad(${depth}) 无危险 token 残留`);
    assert.ok(sanContained(y), `A10: pad(${depth}) v2 判据安全`);
  }
  // 深垫刀 + 部分编码开标签混合构造
  const mixed = pad(18) + "&#X3c;script>alert(1)</script>z";
  const mOut = sanitizeHtml(mixed);
  assert.equal(sanitizeHtml(mOut), mOut, "A10: 混合深嵌套幂等");
  assert.ok(sanContained(mOut), "A10: 混合深嵌套 v2 判据安全");
}

// A11 [硬性][判定标准 v2.1] 迭代上限 fail-closed 与性能有界（复核 P1-3）
{
  // a) 超限触底：pad(70) 需 >64 轮 → fail-closed 返回空串；
  //    f('')==='' 使幂等在超限分支仍构造成立
  const deep = pad(70) + "&#X3c;script>alert(1)</script>z";
  const out = sanitizeHtml(deep);
  assert.equal(out, "", "A11a: 超深嵌套触底 fail-closed 返回空串");
  assert.equal(sanitizeHtml(out), out, "A11a: fail-closed 后 f(f(x))===f(x)");

  // b) 性能有界：60KB 级最坏构造不得冻结事件循环。
  //    阈值依据：修复前同规模嵌套输入实测 ~29.5s；本机实测修复后 60KB
  //    最坏构造 ~4ms / 62KB 正常文档 ~20ms，500ms 为实测 ×20+ 余量，
  //    覆盖慢速 CI 环境（冻结级回归即可判红）
  const evil = ("<met<meta>a>".repeat(3000)).slice(0, 60000);
  const t0 = Date.now();
  sanitizeHtml(evil);
  const cost = Date.now() - t0;
  assert.ok(cost < 500, `A11b: 60KB 最坏构造 ${cost}ms < 500ms（P1-3 性能有界）`);

  // c) 正常内容远离上限：合法深嵌套标签/实体文档零损伤（未触发 fail-closed
  //    的直接证据——触发即返回 ''，而此处逐字符原样返回）
  const doc = "<div>".repeat(50) + "text &amp; more &#x2713;" + "</div>".repeat(50);
  assert.equal(sanitizeHtml(doc), doc, "A11c: 合法深嵌套文档零损伤（远离 64 轮上限）");
}

// B 组：合法内容不误伤

// B1 [硬性] 合规适配器输出零损伤：esc() 五种实体产出形态组成的正常片段逐字符返回
{
  const frag = `<p>${esc("<b>bold</b>")} &amp; ${esc(`a"b'c&d`)} tail</p>`;
  // esc 五形态齐备：&lt; &gt; &amp; &#39; &quot;
  assert.ok(frag.includes("&lt;") && frag.includes("&gt;") && frag.includes("&amp;")
    && frag.includes("&#39;") && frag.includes("&quot;"), "B1: 片段含 esc 全部五种产出形态");
  assert.equal(sanitizeHtml(frag), frag, "B1: 正常片段逐字符原样返回");
}

// B2 [硬性] 正常业务 URL query 保留
{
  const b2 = '<a href="/api/x?a=1&amp;b=2">n</a>';
  assert.equal(sanitizeHtml(b2), b2, "B2: 标签与 href 值不变");
}

// B3 [硬性] 显示型实体文本不被升级为真标签
{
  const b3 = sanitizeHtml("&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.ok(!b3.includes("<script"), "B3: 不含真 <script> 开标签（不升级）");
  assert.ok(sanContained(b3), "B3: 满足统一判定标准");
  assert.equal(b3, "alert(1)", "B3: 实体化标签 token 移除，其间文本原样保留");
}

// ---------------------------------------------------------------- HistoryStore（JSONL 按天分片）

{
  const dir = mkdtempSync(join(tmpdir(), "dou-hist-"));
  const store = new HistoryStore({ root: dir, maxAgeMs: 30 * 86400000, maxSizeBytes: 1024 * 1024 });
  const now = Date.now();
  await store.append("prov", "adp", { time: now - 1000, data: { v: 1 } });
  await store.append("prov", "adp", { time: now, data: { v: 2 } });

  const last = await store.last("prov", "adp");
  assert.ok(last !== null && (last.data as Record<string, unknown>).v === 2, "last() 应返回最新一条");

  const q = await store.query("prov", "adp", { start: now - 2000, end: now + 1 });
  assert.equal(q.entries.length, 2, "全量返回不截断");
  assert.equal((q.entries[1].data as Record<string, unknown>).v, 2, "末条为最新采样");

  const none = await store.last("nope", "nope");
  assert.equal(none, null);

  // 坏行跳过
  const dayDir = join(dir, "prov", "adp");
  const files = await import("node:fs/promises").then((m) => m.readdir(dayDir));
  const fp = join(dayDir, files[0]);
  const raw = await import("node:fs/promises").then((m) => m.readFile(fp, "utf8"));
  await import("node:fs/promises").then((m) => m.writeFile(fp, "{broken\n" + raw, "utf8"));
  const afterRaw = await import("node:fs/promises").then((m) => m.readFile(fp, "utf8"));
  assert.equal(parseJsonl(afterRaw).length, 2, "坏行应被跳过不抛错");

  rmSync(dir, { recursive: true, force: true });
}

// startOfDay
{
  const t = new Date(2025, 0, 15, 13, 45).getTime();
  const s = new Date(startOfDay(t));
  assert.equal(s.getHours(), 0);
  assert.equal(s.getDate(), 15);
}

// ---------------------------------------------------------------- v3 旧格式迁移

{
  // legacySampleToData：余额型裸值 + 三窗口 percent
  const rjkData = legacySampleToData([{ key: "balance", name: "余额" }], [1787000000000, 10.1365]);
  assert.deepEqual(rjkData, { balance: 10.1365 }, "balance 列产出裸数值");
  const ogData = legacySampleToData(
    [{ key: "rolling" }, { key: "weekly" }, { key: "monthly" }],
    [1787000000000, 2, 1, 0],
  );
  assert.deepEqual(ogData, { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } }, "三窗口列产出 percent 对象");
  // 无列声明 → colNN 通用装配
  const generic = legacySampleToData(undefined, [1787000000000, 5, 6]);
  assert.deepEqual(generic, { col1: 5, col2: 6 }, "无列声明产出 colNN");

  // migrateLegacyV3：构造 v3 桶 → 迁移 → 校验 JSONL 与 .bak
  const dir = mkdtempSync(join(tmpdir(), "dou-legacy-"));
  const histDir = join(dir, "history", "prov1");
  await import("node:fs/promises").then((m) => m.mkdir(histDir, { recursive: true }));
  const ts = Date.now() - 3600000;
  await import("node:fs/promises").then((m) => m.writeFile(
    join(histDir, "adp1.json"),
    JSON.stringify({
      version: 3,
      provider: "prov1",
      adapterId: "adp1",
      columns: [{ key: "balance", name: "余额" }],
      samples: [[ts - 600000, 9.5], [ts, 9.2]],
    }),
  ));
  const store2 = new HistoryStore({ root: dir, maxAgeMs: 30 * 86400000, maxSizeBytes: 1024 * 1024 });
  const migratedCount = await migrateLegacyV3(dir, store2);
  assert.equal(migratedCount, 2, "迁移 2 个采样点");
  // 新格式可查询（balance 裸值）
  const q = await store2.query("prov1", "adp1", { start: ts - 600000, end: ts + 1 }, 10);
  assert.equal(q.entries.length, 2);
  assert.deepEqual(q.entries[0].data, { balance: 9.5 }, "迁移后 data 形态正确");
  // 旧文件已重命名 .bak
  const filesAfter = await import("node:fs/promises").then((m) => m.readdir(histDir));
  assert.ok(filesAfter.some((f) => f.endsWith(".v3.bak")), "旧桶重命名为 .bak");
  // 幂等：二次迁移不重复
  const again = await migrateLegacyV3(dir, store2);
  assert.equal(again, 0, "二次迁移幂等（.bak 不再扫描）");
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- safe 守卫

{
  // 正常路径
  const okR = await safeFetchData(async () => ({ a: 1 }), 2000);
  assert.deepEqual(okR.data, { a: 1 });

  // 抛错 → error 不外抛
  const errR = await safeFetchData(async () => { throw new Error("boom"); }, 2000);
  assert.ok(errR.error !== undefined && errR.error.includes("boom"));

  // 数组 → 校验失败（必须对象）
  const badR = await safeFetchData(async () => [1, 2], 2000);
  assert.ok(badR.error !== undefined && badR.error.includes("对象"));

  // 循环引用 → 序列化失败隔离
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  const cycR = await safeFetchData(async () => cyc, 2000);
  assert.ok(cycR.error !== undefined);

  // 超时（挂起 → 快速超时，不阻塞）
  const t0 = Date.now();
  const toR = await safeFetchData(() => new Promise(() => {}), 300);
  assert.ok(toR.error !== undefined && toR.error.includes("超时"));
  assert.ok(Date.now() - t0 < 1500, "超时应快速返回，不挂起");
}

{
  const okF = await safeFormat(() => "<b>x</b>", "formatCapsule", 2000);
  assert.equal(okF.html, "<b>x</b>");

  const errF = await safeFormat(() => { throw new Error("fmt-boom"); }, "formatCapsule", 2000);
  assert.ok(errF.error !== undefined && errF.error.includes("fmt-boom"));

  const typeF = await safeFormat(() => 42 as unknown as string, "formatCapsule", 2000);
  assert.ok(typeF.error !== undefined && typeF.error.includes("字符串"));
}

// ---------------------------------------------------------------- normalizeConfig

{
  const c = normalizeConfig(undefined);
  assert.equal(c.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs);
  assert.equal(c.provider, "opencode-go");
  assert.equal(c.autoReload, true, "autoReload 默认开启：编辑适配器 mjs 后自动热更新");
  const m = normalizeConfig({ adapter: "/tmp/a.mjs", staticPath: "/v1/usage", provider: "deepseek", apiKey: "sk-x", fetchTimeoutMs: 99999, maxAgeDays: 9999 });
  assert.equal(m.adapter, "/tmp/a.mjs");
  assert.equal(m.provider, "deepseek");
  assert.equal(m.apiKey, "sk-x");
  assert.equal(m.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs, "fetchTimeoutMs 固定 5s 不可配置（#206 配套）");
  assert.equal(m.maxAgeDays, 365, "保留天数上限 clamp");
}

// ---------------------------------------------------------------- normalizeUiConfig

{
  const d = normalizeUiConfig(undefined);
  assert.deepEqual(d, DEFAULT_UI_CONFIG, "默认配置 top-right/0/48/10");
  // 默认垂直偏移 48：让胶囊位于 MCP 浮窗（默认 top-right/offsetY=8）下方，两胶囊默认不重叠（issue #116）
  assert.equal(DEFAULT_UI_CONFIG.offsetY, 48, "默认 offsetY 48（避让 MCP 胶囊默认位置）");
  assert.equal(DEFAULT_UI_CONFIG.offsetX, 0, "默认 offsetX 0（右侧对齐贴右缘）");
  const clamped = normalizeUiConfig({ placement: "bottom-left", offsetX: 99999, offsetY: -3, panelOffsetY: 0.6 });
  assert.equal(clamped.placement, "bottom-left", "合法 placement 透传");
  assert.equal(clamped.offsetX, 2000, "offsetX 上限 clamp");
  assert.equal(clamped.offsetY, 0, "offsetY 下限 clamp");
  assert.equal(clamped.panelOffsetY, 1, "panelOffsetY 取整");
  const bad = normalizeUiConfig({ placement: "middle", offsetX: "abc", offsetY: null, panelOffsetY: 44 });
  assert.equal(bad.placement, DEFAULT_UI_CONFIG.placement, "非法 placement 回退默认");
  assert.equal(bad.offsetX, DEFAULT_UI_CONFIG.offsetX, "非法 offsetX 回退默认");
}

// ---------------------------------------------------------------- 面板定位翻转规则

{
  // 底部锚点（bottom-*）→ 向上弹出；顶部锚点（top-*）→ 向下弹出
  assert.equal(panelAnchorForPlacement("bottom-right"), "bottom", "bottom-right → 上弹");
  assert.equal(panelAnchorForPlacement("bottom-left"), "bottom", "bottom-left → 上弹");
  assert.equal(panelAnchorForPlacement("top-right"), "top", "top-right → 下弹（历史行为）");
  assert.equal(panelAnchorForPlacement("top-left"), "top", "top-left → 下弹（历史行为）");
  assert.equal(panelAnchorForPlacement(undefined), "top", "缺省按顶部锚点");

  // 底部锚点：面板向上，下缘贴近 pill 上缘；顶部锚点：向下（pillBottom + gap）
  assert.equal(panelTopForAnchor("bottom", 600, 640, 200, 10), 390, "底部锚点向上弹出");
  assert.equal(panelTopForAnchor("top", 40, 80, 200, 10), 90, "顶部锚点向下弹出");
  // clamp：底部锚点面板过高时钳到视口上缘（不溢出）
  assert.equal(panelTopForAnchor("bottom", 30, 70, 2000, 10), 6, "底部锚点 clamp 到视口内");
}

// ---------------------------------------------------------------- provider-config 配置链

{
  // 显式 key 优先（ctx 缺席回落 V1 链）
  const r1 = await resolveProviderConfig("myprov", undefined, { apiKey: "explicit", apiEndpoint: "https://x" });
  assert.equal(r1.apiKey, "explicit");
  assert.equal(r1.apiEndpoint, "https://x");

  // env 回落：provider myprov-test → 环境变量 MYPROV_TEST_API_KEY
  process.env.MYPROV_TEST_API_KEY = "from-env";
  const r2 = await resolveProviderConfig("myprov-test", undefined, {});
  assert.equal(r2.apiKey, "from-env");
  delete process.env.MYPROV_TEST_API_KEY;

  // 无密钥
  const r3 = await resolveProviderConfig("never-exists-prov", undefined, {});
  assert.equal(r3.apiKey, undefined);

  // DSH 凭据 seam：fake ctx 提供 configurable provider + settings.get + credentials.resolve
  const fakeCtx = {
    llm: {
      listConfigurableProviders: () => [
        { provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
      ],
    },
    get: (name: string) => {
      if (name === "settings") return { get: (ns: string) => (ns === "llm-deepseek" ? { apiKeyEnv: "DEEPSEEK_API_KEY" } : undefined) };
      if (name === "credentials") return { resolve: async (ref: string) => (ref === "DEEPSEEK_API_KEY" ? { value: "sk-seam-test" } : undefined) };
      return undefined;
    },
  };
  const r4 = await resolveProviderConfig("deepseek-official", fakeCtx);
  assert.equal(r4.apiKey, "sk-seam-test", "seam 经 settings.get(apiKeyEnv) + credentials.resolve 取到 key");

  // seam：settingsPath 下钻（pi-ai 类嵌套命名空间）
  const fakeCtxNested = {
    llm: {
      listConfigurableProviders: () => [
        { provider: "pi-ai-r", settingsNs: "llm-pi-ai", settingsPath: ["providers", "pi-ai-r"] },
      ],
    },
    get: (name: string) => {
      if (name === "settings") return { get: (ns: string) => (ns === "llm-pi-ai" ? { providers: { "pi-ai-r": { apiKeyEnv: "RJK_API_KEY" } } } : undefined) };
      if (name === "credentials") return { resolve: async (ref: string) => (ref === "RJK_API_KEY" ? { value: "sk-nested" } : undefined) };
      return undefined;
    },
  };
  const r5 = await resolveProviderConfig("pi-ai-r", fakeCtxNested);
  assert.equal(r5.apiKey, "sk-nested", "seam 沿 settingsPath 下钻取 apiKeyEnv");

  // seam 缺席（ctx 无 llm / provider 不在目录）→ 回落 V1 链
  const r6 = await resolveProviderConfig("opencode-go", {}, { apiKey: "sk-explicit" });
  assert.equal(r6.apiKey, "sk-explicit", "seam 缺席时回落 V1 链");

  // credentials 文件路径
  assert.ok(credentialsFile("/tmp/dsh").endsWith(".credentials.yaml"));
}

// ---------------------------------------------------------------- opencode-go v2

{
  // parseUsageResponse 兼容两种形状
  const p1 = parseUsageResponse({ usage: { rolling: { percent: 2 } } });
  assert.ok(p1 !== null && p1.rolling.percent === 2);
  const p2 = parseUsageResponse({ rolling: { percent: 3 } });
  assert.ok(p2 !== null && p2.rolling.percent === 3);
  assert.equal(parseUsageResponse("junk"), null);

  // fetchOpenCodeGoV2：成功
  const fakeRes = (status: number, body: unknown): Response =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
  const okF = await fetchOpenCodeGoV2(
    { apiEndpoint: "https://x", staticPath: "/usage", apiKey: "sk-1", provider: OPENCODE_GO_PROVIDER, timeoutMs: 2000 },
    (async () => fakeRes(200, { usage: { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } } })) as unknown as typeof fetch,
  );
  assert.ok(okF.rolling !== undefined);

  // 401 → 抛 unauthorized（由 safeFetchData 在管道层隔离）
  await assert.rejects(
    () => fetchOpenCodeGoV2(
      { apiEndpoint: "https://x", staticPath: "/u", apiKey: "sk-1", provider: "p", timeoutMs: 2000 },
      (async () => fakeRes(401, {})) as unknown as typeof fetch,
    ),
    /unauthorized/,
  );

  // 缺 key
  await assert.rejects(
    () => fetchOpenCodeGoV2({ apiEndpoint: "", staticPath: "", provider: "p", timeoutMs: 2000 }),
    /no-api-key/,
  );

  // 内置适配器契约自检
  assert.equal(isUsageStatsAdapter(openCodeGoAdapter), true, "内置适配器必须通过 v2 契约校验");
  assert.deepEqual(openCodeGoAdapter.providers, ["opencode-go"]);
  assert.equal(openCodeGoAdapter.name, OPENCODE_GO_ADAPTER_ID);

  // formatCapsule 返回 HTML 字符串（含窗口短名）
  const html = openCodeGoAdapter.formatCapsule({
    time: Date.now(),
    data: { rolling: { percent: 5 }, weekly: { percent: 1 }, monthly: { percent: 0 } },
    status: "fresh",
    esc,
  });
  assert.ok(html.includes("5h"), "胶囊文案应含窗口短名");

  // formatPanel 返回三窗口迷你图卡片 HTML（SVG 图表，与 v1 展示逻辑一致）
  const panel = openCodeGoAdapter.formatPanel({
    entries: [
      { time: Date.now() - 600000, data: { rolling: { percent: 2 }, weekly: { percent: 1 }, monthly: { percent: 0 } } },
      { time: Date.now(), data: { rolling: { percent: 5 }, weekly: { percent: 3 }, monthly: { percent: 1 } } },
    ],
    range: { start: Date.now() - 1000, end: Date.now() },
    truncated: false,
    esc,
  });
  assert.ok(panel.includes("dou-card"), "面板应含卡片");
  assert.ok(panel.includes("5h 滚动") && panel.includes("每周") && panel.includes("每月"), "面板含三窗口名称");
  assert.ok(panel.includes("<svg"), "面板含 SVG 迷你图");
  assert.ok(panel.includes("dou-cardCur"), "卡片头含当前百分比");
  // 空历史 → 空态文案
  const emptyPanel = openCodeGoAdapter.formatPanel({
    entries: [],
    range: { start: 0, end: 1 },
    truncated: false,
    esc,
  });
  assert.ok(emptyPanel.includes("暂无"), "空历史应有空态提示");
  // 单点历史 → 采集中提示（≥2 点才显示趋势）
  const onePanel = openCodeGoAdapter.formatPanel({
    entries: [{ time: Date.now(), data: { rolling: { percent: 5 }, weekly: { percent: 3 }, monthly: { percent: 1 } } }],
    range: { start: Date.now() - 1000, end: Date.now() },
    truncated: false,
    esc,
  });
  assert.ok(onePanel.includes("dou-chartEmpty"), "单点历史显示采集中提示");
}

// ---------------------------------------------------------------- registry v2

{
  const reg = makeAdapterRegistry();
  reg.register(validAdapter as never, "user-file", "/tmp/x.mjs");
  assert.ok(reg.get("p1") !== undefined);
  assert.ok(reg.enabledProviders().includes("p1"));
  const snap = reg.snapshot();
  assert.equal(snap.infos.length, 1);
  assert.equal(snap.errors.length, 0);
  reg.recordError("test", "exec", "oops");
  assert.equal(reg.snapshot().errors.length, 1);
  assert.equal(reg.select("p1", null), true);
  assert.equal(reg.get("p1"), undefined);
}

// ---------------------------------------------------------------- 热更新加载校验

{
  const dir = mkdtempSync(join(tmpdir(), "dou-hot-"));

  // 合法适配器
  const okFile = join(dir, "adapter-ok.mjs");
  writeFileSync(okFile, `
export const version = 2;
export const name = "hot-adapter";
export const providers = ["hp"];
export async function fetchData() { return {}; }
export function formatCapsule() { return ""; }
export function formatPanel() { return ""; }
`, "utf8");
  const stamp = await readStamp(okFile);
  assert.ok(stamp !== null);
  const loaded = await loadAndValidateAdapter(okFile, stamp);
  assert.ok(loaded.adapter !== undefined && loaded.adapter.name === "hot-adapter");
  assert.equal(stampEqual(stamp, stamp), true);
  assert.equal(stampEqual(stamp, null), false);

  // 非法适配器（缺导出）→ fail-fast 拒收
  // （用独立文件：同文件快速重写可能落同一 mtimeMs，?t= 缓存键相同会命中旧模块）
  const badFile = join(dir, "adapter-bad.mjs");
  writeFileSync(badFile, `export const version = 2; export const name = "x2";`, "utf8");
  const stamp2 = await readStamp(badFile);
  assert.ok(stamp2 !== null && !stampEqual(stamp, stamp2));
  const bad = await loadAndValidateAdapter(badFile, stamp2);
  assert.ok(bad.error !== undefined && bad.error.includes("契约校验失败"));
  assert.equal(bad.adapter, undefined);

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 路由表形状

assert.equal(typeof ROUTES.stats, "string");
assert.ok(ROUTES.stats.startsWith("/api/"));
assert.ok(ROUTES.health.startsWith("/api/"));

console.log("[smoke-pure] 全部断言通过 ✓ (v2)");
