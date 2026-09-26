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

function stringConstants(src) {
  const out = {};
  if (src == null) return out;
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function identifierProperty(src, property) {
  if (src == null) return null;
  const m = new RegExp("\\b" + property + ":\\s*([A-Za-z_$][\\w$]*)").exec(src);
  return m?.[1] ?? null;
}

function templateProperty(src, property, constants) {
  if (src == null) return null;
  const m = new RegExp("\\b" + property + ":\\s*`([^`]*)`").exec(src);
  if (m == null) return null;
  let complete = true;
  const value = m[1].replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_expr, name) => {
    const replacement = constants[name];
    if (replacement == null) {
      complete = false;
      return "";
    }
    return replacement;
  });
  return complete ? value : null;
}

function patchRow(src) {
  if (src == null) return null;
  const m = /^\s*-\s+id:\s*["']?([^"'#\s]+)["']?\s*\r?\n\s+name:\s*["']([^"']+)["']/m.exec(src);
  return m == null ? null : { id: m[1], name: m[2] };
}

/** `register(` 之后第一个 `{` 的闭括号位置；中间只容空白与注释，否则不是对象实参。 */
function registerBlockEnd(src, from) {
  const skip = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/;
  const sk = skip.exec(src.slice(from));
  let i = from + (sk ? sk[0].length : 0);
  if (src[i] !== "{") return null;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function registerOptionBlocks(src) {
  if (src == null) return [];
  const blocks = [];
  const rx = /(?:slots|slotHost)\.register\(/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const end = registerBlockEnd(src, m.index + m[0].length);
    if (end === null) continue;
    blocks.push(src.slice(m.index, end + 1));
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

// ---- 2) 目标 runtime 的客户端设置注册（row config + 独立 section） ----
const ROW_CONFIG_SOURCES = [
  {
    file: "packages/dsh-lan-proxy/src/client/index.ts",
    identityFile: "packages/dsh-lan-proxy/src/shared/interface.ts",
    patchFile: "packages/dsh-lan-proxy/cordis.patch.yml",
    identity: "LAN_PROXY_IDENTITY",
    slotConstant: "ROW_CONFIG_SLOT",
  },
  {
    file: "packages/dsh-mcp-manager/src/client/index.ts",
    identityFile: "packages/dsh-mcp-manager/src/shared/constants.ts",
    patchFile: "packages/dsh-mcp-manager/cordis.patch.yml",
    identity: "MCP_MANAGER_IDENTITY",
    slotConstant: "ROW_CONFIG_SLOT",
  },
];
const SECTION_SLOT_FILES = [
  "packages/dsh-notifier/src/client/index.tsx",
  "packages/dsh-provider-usage/src/client/index.tsx",
];
const slots = [];
for (const source of ROW_CONFIG_SOURCES) {
  const client = read(source.file);
  const identity = read(source.identityFile);
  if (client == null || identity == null) continue;
  const clientConstants = stringConstants(client);
  const identityConstants = stringConstants(identity);
  const slot = clientConstants[source.slotConstant] ?? null;
  const bundlePackageName = identifierProperty(identity, "bundlePackage");
  const rowIdName = identifierProperty(identity, "rowId");
  const settingsNamespaceName = identifierProperty(identity, "settingsNamespace");
  const bundlePackage =
    bundlePackageName == null ? null : (identityConstants[bundlePackageName] ?? null);
  const rowId = rowIdName == null ? null : (identityConstants[rowIdName] ?? null);
  const settingsNamespace =
    settingsNamespaceName == null ? null : (identityConstants[settingsNamespaceName] ?? null);
  const key = templateProperty(identity, "rowConfigKey", identityConstants);
  const registered =
    slot != null &&
    client.includes("slots.inject(" + source.slotConstant) &&
    client.includes("slots.register(") &&
    client.includes("configForms.whileServed(") &&
    client.includes(source.identity + ".rowConfigKey");
  if (
    !registered ||
    slot == null ||
    bundlePackage == null ||
    rowId == null ||
    settingsNamespace == null ||
    key == null
  ) {
    continue;
  }
  const patch = patchRow(read(source.patchFile));
  slots.push({
    file: source.file,
    slot,
    bundlePackage,
    rowId,
    settingsNamespace,
    key,
    patch: patch == null ? null : { file: source.patchFile, ...patch },
  });
}
for (const f of SECTION_SLOT_FILES) {
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

// ---- 5) 唯一目标 runtime 与 SESSION_FORMAT 锚 ----
const workspace = read("pnpm-workspace.yaml") ?? "";
const catalog = {};
for (const m of workspace.matchAll(/"(@deepseek-ai\/[^"]+)"\s*:\s*([^\s#]+)/g)) {
  catalog[m[1]] = m[2];
}
const targetVersions = [
  ...new Set(
    Object.entries(catalog)
      .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
      .map(([, version]) => version),
  ),
];
const targetRuntime = targetVersions.length === 1 ? targetVersions[0] : null;
const providerApply = read("packages/dsh-provider-usage/src/apply/apply.ts") ?? "";
const sessionTypes = read("packages/dsh-provider-usage/src/server/collect/types.ts") ?? "";
const sessionCollector = read("packages/dsh-provider-usage/src/server/collect/collector.ts") ?? "";
const sessionEvent = scanAll(providerApply, /ctx\.on\(\s*["'](session\/event)["']/)[0] ?? null;
const settlementTypes = scanAll(
  sessionCollector,
  /case\s+["'](assistant\/(?:message|attempt))["']\s*:/,
);
const streamUsageInMessage =
  settlementTypes.includes("assistant/message") && /stream\?:\s*unknown/.test(sessionCollector);
const settlementLabels = settlementTypes.map((type) =>
  type === "assistant/message" && streamUsageInMessage ? type + "（内嵌 stream）" : type,
);
const chunkEventRegistered = /case\s+["']assistant\/chunk["']\s*:/.test(sessionCollector);
const sessionFormat = {
  targetRuntime,
  event: sessionEvent,
  settlementTypes,
  chunkEventRegistered,
  collectorMentionsChunkRemoval: sessionTypes.includes("assistant/chunk"),
  anchor:
    "唯一目标 runtime " +
    (targetRuntime ?? "未唯一锁定") +
    ' 的事实源为 ctx.on("' +
    (sessionEvent ?? "未派生") +
    '\")；结算类型为 ' +
    (settlementLabels.length === 0 ? "未派生" : settlementLabels.join("与 ")) +
    (chunkEventRegistered ? "；注册 assistant/chunk" : "；无 assistant/chunk"),
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

// ---- 五类形态缺口清单（只描述唯一目标 runtime 的当前 API） ----
const rowConfigSlots = slots.filter((slot) => slot.slot === "plugins.row.config");
const sectionSlots = slots.filter((slot) => slot.slot === "settings.section");
const gaps = [
  {
    类: "方法语义",
    现状:
      "MCP_SECTION_ORDER=160 派生为字面量（orderRangeOk=" +
      sectionOrder.orderRangeOk +
      "）；systemPrompt.section 调用点存在=" +
      sectionOrder.sectionCall,
    缺口: "唯一目标 runtime 的官方 SECTION_ORDERS（DEPLOYMENT_PERSONA_PREFIX/PLAN_POLICY）在本仓无符号级锚；当前区间由 smoke 锁定，宿主重排只能事后发现",
  },
  {
    类: "载荷版本",
    现状:
      "session/event 事件名与 assistant/message、assistant/attempt 结算分支派生自 " +
      targetRuntime +
      " 目标 catalog 与当前 collector",
    缺口: "assistant/message 内嵌 stream / attempt 的字段级载荷版本无独立类型快照可派生，上游加字段只能靠人工跟进",
  },
  {
    类: "slot 协议",
    现状:
      "slot 名派生 " +
      slots.length +
      " 条（plugins.row.config " +
      rowConfigSlots.length +
      " 条 canonical row；settings.section " +
      sectionSlots.length +
      " 条 id/order）",
    缺口: "只记录唯一目标 runtime 的当前注册 API；不从本仓源码推断其它 runtime 的挂载或兼容行为",
  },
  {
    类: "DOM 锚",
    现状:
      "DOM 选择器派生 " +
      domAnchors.length +
      " 条：" +
      [...new Set(domAnchors.map((d) => d.selector))].join(" / "),
    缺口: "data-* 锚与哈希类名（.pI_x6G_centerCol）均为宿主 DOM 私有约定，无版本锚；派生只能列出目标 runtime 当前在用的选择器",
  },
  {
    类: "类型版本锚",
    现状:
      "catalog 派生 " +
      Object.keys(catalog).length +
      " 个 @deepseek-ai/* 锁版（dsh-* 唯一目标 " +
      (targetRuntime ?? "未唯一锁定") +
      "，cordis 独立 " +
      (catalog["@deepseek-ai/cordis"] ?? "未知") +
      "）",
    缺口: "catalog 只锁目标类型版本；本派生不把本机其它 DSH 版本当作受支持目标，也不承诺兼容",
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
    targetRuntime: sessionFormat.targetRuntime,
    sessionAnchor: sessionFormat.anchor,
    slotCount: slots.length,
    rowConfigSlots: rowConfigSlots.map(
      ({ file, slot, bundlePackage, rowId, settingsNamespace, key }) => ({
        file,
        slot,
        bundlePackage,
        rowId,
        settingsNamespace,
        key,
      }),
    ),
    routeCount: routes.length,
    domCount: domAnchors.length,
  },
};

console.log(JSON.stringify(SAMPLE_ONLY ? result.sample : result, null, 2));
