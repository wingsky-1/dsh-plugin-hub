#!/usr/bin/env node
// 宿主契约派生：只读扫描源码字面量并输出机检事实；保证只读 stdout、不写文件、不接门禁。
// 只读：仅对仓库源码做同步读 + stdout 输出 JSON，不写任何文件，
// 不改 scripts/gate 现有文件，不注册进任何 gate 步骤。
// 离线：零依赖（仅 node:fs / node:path），无网络、无凭据。
// 用法：node scripts/derive/host-contract.mjs [--root <repo>] [--sample]
//   默认输出完整派生 JSON；--sample 只输出 sample 节（用于交付粘贴）。
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const ROOT = resolve(rootIdx >= 0 ? args[rootIdx + 1] : new URL("../..", import.meta.url).pathname);
const SAMPLE_ONLY = args.includes("--sample");

function read(p) {
  const f = join(ROOT, p);
  if (!existsSync(f)) return null;
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
}

// 文本扫描：取所有匹配组（去重保序），纯派生、无语义断言。
function scanAll(src, re) {
  if (src == null) return [];
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  while ((m = rx.exec(src)) !== null) {
    const v = m[1] ?? m[0];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function scanDomSelectors(src) {
  if (src == null) return [];
  const out = [];
  const rx = /querySelector(?:All)?\s*(?:<[^<>]*>)?\s*\(\s*(["'`])((?:(?!\1)[\s\S])*)\1/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const v = m[2];
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out;
}

function registerOptionBlocks(src) {
  if (src == null) return [];
  const blocks = [];
  const rx = /(?:slots|slotHost)\.register\(/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length;
    const skip = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;
    const tail = src.slice(i);
    const sk = skip.exec(tail);
    i += sk ? sk[0].length : 0;
    if (src[i] !== "{") continue;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(m.index, i + 1));
  }
  return blocks;
}

// ---- 1) ctx.on 事件名（按包取证：字面量派生） ----
const EVENT_FILES = {
  "dsh-notifier": ["packages/dsh-notifier/src/index.ts"],
  "dsh-mcp-manager": [
    "packages/dsh-mcp-manager/src/index.ts",
    "packages/dsh-mcp-manager/src/server/inject/middleware-register.ts",
    "packages/dsh-mcp-manager/src/server/shared/compose.ts",
  ],
  "dsh-provider-usage": ["packages/dsh-provider-usage/src/apply/apply.ts"],
  "dsh-lan-proxy": [
    "packages/dsh-lan-proxy/src/server/apply.ts",
    "packages/dsh-lan-proxy/src/client/index.ts",
  ],
};
const events = {};
for (const [pkg, files] of Object.entries(EVENT_FILES)) {
  const found = [];
  const sites = [];
  for (const f of files) {
    const src = read(f);
    if (src == null) continue;
    for (const e of scanAll(src, /ctx\.on\(\s*["']([^"']+)["']/)) {
      if (!found.includes(e)) found.push(e);
      sites.push(f + "::" + e);
    }
    // compose.ts 经能力面转发的事件名（onPreStep/agent-created 等映射的宿主事件字面量）
    for (const e of scanAll(src, /ctx\.on\(\s*["']([^"']+)["']\s*,/)) {
      if (!found.includes(e)) found.push(e);
    }
  }
  events[pkg] = { events: found, sites };
}

// ---- 2) settings slot key（settings.plugin.item / settings.section + id/key/order） ----
const SLOT_FILES = [
  "packages/dsh-lan-proxy/src/client/index.ts",
  "packages/dsh-mcp-manager/src/client/index.ts",
  "packages/dsh-notifier/src/client/index.tsx",
  "packages/dsh-provider-usage/src/client/index.tsx",
];
const slots = [];
for (const f of SLOT_FILES) {
  const src = read(f);
  if (src == null) continue;
  const regBlocks = registerOptionBlocks(src);
  const scoped = regBlocks.join("\n");
  for (const name of scanAll(
    src,
    /(?:slots|slotHost)\.(?:inject|register)\(\s*["'](settings\.[^"']+)["']/,
  )) {
    const id = scanAll(scoped, /\bid:\s*["']([^"']+)["']/);
    const key = scanAll(scoped, /\bkey:\s*["']([^"']+)["']/);
    const order = scanAll(scoped, /\border:\s*(\d+)/);
    slots.push({ file: f, slot: name, id, key, order });
  }
}

// ---- 3) server/api 路由注册（path 字面量 + ctx.webServer.register 站点） ----
const ROUTE_FILES = [
  "packages/dsh-lan-proxy/src/server/config/impl/routes.ts",
  "packages/dsh-lan-proxy/src/server/apply.ts",
  "packages/dsh-mcp-manager/src/index.ts",
  "packages/dsh-mcp-manager/src/shared/routes.ts",
  "packages/dsh-provider-usage/src/apply/apply.ts",
  "packages/dsh-notifier/src/server/api/impl/service/index.ts",
];
const routes = [];
const registerSites = [];
for (const f of ROUTE_FILES) {
  const src = read(f);
  if (src == null) continue;
  for (const p of scanAll(src, /["'](\/api\/dsh-[^"']*)["']/)) {
    if (!routes.includes(p)) routes.push(p);
  }
  if (/ctx\.webServer\.register|webServer\.register/.test(src)) registerSites.push(f);
}

// ---- 4) MCP_SECTION_ORDER=160 方法语义 ----
const mcpIndex = read("packages/dsh-mcp-manager/src/index.ts") ?? "";
const sectionOrder = {
  value: scanAll(mcpIndex, /export const MCP_SECTION_ORDER\s*=\s*(\d+)/)[0] ?? null,
  // 语义锚：注释称"紧随部署 persona 之后、计划策略之前（DEPLOYMENT_PERSONA_PREFIX=0 与 PLAN_POLICY=500 之间）"
  semantic:
    "紧随部署 persona 之后、计划策略之前（0 < 160 < 500 区间断言由 smoke 锁定，非 getSectionOrder 派生）",
  sectionCall: mcpIndex.includes("ctx.systemPrompt") && mcpIndex.includes("MCP_SECTION_ORDER"),
  orderRangeOk: (() => {
    const v = Number(scanAll(mcpIndex, /export const MCP_SECTION_ORDER\s*=\s*(\d+)/)[0]);
    return Number.isFinite(v) && v > 0 && v < 500;
  })(),
};

// ---- 5) SESSION_FORMAT 版本锚 ----
const collectTypes = read("packages/dsh-provider-usage/src/domain2/collect/types.ts") ?? "";
const adaptDoc = read("docs/archive/dsh-0.1.5-适配计划.md");
const sessionFormat = {
  // 仓库内无 SESSION_FORMAT_VERSION 符号（grep 仅命中适配计划文档）；事实源是注释口径：
  anchor:
    '0.1.5-rc.1 起唯一事实源 = ctx.on("session/event")；assistant/chunk 已删，assistant/message(+内嵌 stream)+assistant/attempt 为结算信号',
  versionBumpDoc: "SESSION_FORMAT_VERSION 0→3（docs/archive/dsh-0.1.5-适配计划.md）",
  docPresent: adaptDoc !== null,
  collectorMentionsChunkRemoval: collectTypes.includes("assistant/chunk"),
};

// ---- 6) 客户端 DOM 锚 ----
const DOM_FILES = [
  "packages/dsh-mcp-manager/src/client/float/float.ts",
  "packages/dsh-provider-usage/src/client/index.tsx",
];
const domAnchors = [];
for (const f of DOM_FILES) {
  const src = read(f);
  if (src == null) continue;
  for (const sel of scanDomSelectors(src)) {
    domAnchors.push({ file: f, selector: sel });
  }
}

// ---- 7) 类型版本锚（catalog 锁版） ----
const workspace = read("pnpm-workspace.yaml") ?? "";
const catalog = {};
for (const m of workspace.matchAll(/"(@deepseek-ai\/[^"]+)"\s*:\s*([^\s#]+)/g)) {
  catalog[m[1]] = m[2];
}

// ---- 五类形态缺口清单（派生能给什么、缺什么；不断言，只列 gap） ----
const gaps = [
  {
    类: "方法语义",
    现状:
      "MCP_SECTION_ORDER=160 派生为字面量（orderRangeOk=" +
      sectionOrder.orderRangeOk +
      "）；systemPrompt.section 调用点存在=" +
      sectionOrder.sectionCall,
    缺口: "官方 SECTION_ORDERS（DEPLOYMENT_PERSONA_PREFIX/PLAN_POLICY）在本仓无符号级锚，只有注释复述；宿主重排（如 0.1.5 的 -900/-800→10000/10100 类事件）只能靠 smoke 区间断言事后发现，无派生预警",
  },
  {
    类: "载荷版本",
    现状: "session/event 结算口径派生自注释（message+stream/attempt），事件名派生自 ctx.on 字面量",
    缺口: "SESSION_FORMAT_VERSION 无代码符号锚（仅存档文档提及 0→3）；assistant/message 内嵌 stream / attempt 的字段级载荷版本无类型快照可派生，官方加字段只能靠人工跟进",
  },
  {
    类: "slot 协议",
    现状:
      "slot 名派生 " +
      slots.length +
      " 条（含 settings.plugin.item keyed(key)+id 双写、settings.section order/label-thunk）",
    缺口: "宿主 slots.inject/register 的 keyed-vs-list 形态、settings.section label thunk 语义只存在于注释与对照表述（'参照用量统计 tab'），无宿主侧协议版本锚；旧运行时静默不挂载的降级分支不可派生",
  },
  {
    类: "DOM 锚",
    现状:
      "DOM 选择器派生 " +
      domAnchors.length +
      " 条：" +
      [...new Set(domAnchors.map((d) => d.selector))].join(" / "),
    缺口: "data-* 锚与哈希类名（.pI_x6G_centerCol）均为宿主 DOM 私有约定，无版本锚；宿主改壳即静默漂移，派生只能列出'当前在用'，给不出'是否仍有效'",
  },
  {
    类: "类型版本锚",
    现状:
      "catalog 派生 " +
      Object.keys(catalog).length +
      " 个 @deepseek-ai/* 锁版（dsh-* 均为 " +
      (catalog["@deepseek-ai/dsh-session"] ?? "未知") +
      "，cordis 独立 " +
      (catalog["@deepseek-ai/cordis"] ?? "未知") +
      "）",
    缺口: "锁版只是'期望版本'，宿主实际版本（本机 dsh 可能更高）与 SessionHeader/Agent.session 结构漂移无运行时派生；Session.fromRestore 第 5 参、EpochHeader.system 删除等破坏性点只活在存档文档里",
  },
];

const result = {
  tool: "scripts/derive/host-contract.mjs",
  note: "只读派生，不接门禁；全部事实来自源码字面量扫描，非宿主运行时实测",
  events,
  slots,
  routes: { paths: routes, registerSites },
  mcpSectionOrder: sectionOrder,
  sessionFormat,
  domAnchors,
  catalog,
  gaps,
  sample: {
    notifierEvents: events["dsh-notifier"]?.events ?? [],
    mcpSectionOrder: sectionOrder.value,
    sessionAnchor: sessionFormat.anchor,
    slotCount: slots.length,
    routeCount: routes.length,
    domCount: domAnchors.length,
  },
};

console.log(JSON.stringify(SAMPLE_ONLY ? result.sample : result, null, 2));
