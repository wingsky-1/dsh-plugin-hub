// 客户端 bundle 注册契约：web shell 的 client-modules 要求脚本执行时通过
// window.__ModuleLoader__.load 注册自身 factory（id = 包名），factory 返回
// module.exports（导出 apply / inject）。缺少该注册会让整个插件条目
// （含宿主端）在加载器层面失败。
(function () {
  "use strict";

(window as any).__ModuleLoader__.load({
	id: "dsh-mcp-manager",
	factory: function (require: any) {
		var module: { exports: Record<string, any> } = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
/**
 * dsh-mcp-manager — 浏览器端。运行在 dsh web GUI 中，纯 DOM 实现
 * （无 React、无构建工具）：侧边栏注入「MCP」入口按钮，点击打开模态面板：
 *  - 「服务器」页：按状态分级展示 MCP 服务器（运行中 / 连接中 / 重连中 /
 *    已停用 / 未连接 / 失败），每台卡片显示传输、端点、工具数、可展开的
 *    工具名，以及 连接 / 断开 / 重连 / 编辑 / 删除 操作；
 *  - 「快速接入」页：手工表单（stdio / streamable-http）与粘贴
 *    mcpServers JSON 导入（仅支持 JSON 格式，不预设任何服务器）。
 *
 * 失败策略与 dsh-ssh / dsh-skill-explorer 一致：DOM 挂载问题只 warn 不抛。
 */

/** 与 host 端 ROUTES 一致的路径。 */
const API = {
  servers: "/api/dsh-mcp/servers",
  connect: "/api/dsh-mcp/servers/connect",
  disconnect: "/api/dsh-mcp/servers/disconnect",
  reconnect: "/api/dsh-mcp/servers/reconnect",
  importJson: "/api/dsh-mcp/import/json",
  session: "/api/dsh-mcp/session",
  events: "/api/dsh-mcp/events",
    health: "/api/dsh-mcp/health",
};

/** 面板样式（dm- 前缀避免与 shell / 其他插件样式冲突）。 */
const STYLE = `
[data-conversation-scroll]{position:relative}
[data-pane="conversation"]{position:relative}
.dm-float{position:absolute;top:8px;right:14px;z-index:40;display:flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-radius:99px;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.10);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.dm-float:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f8)}
.dm-float .dm-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dm-float-panel{position:fixed;top:44px;right:14px;width:min(400px,calc(100vw - 36px));max-height:min(70vh,560px);overflow:auto;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);border:1px solid var(--dsw-alias-border-l1,#e2e4ea);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18);z-index:70;padding:10px 12px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px}
.dm-float-panel[hidden]{display:none !important}
.dm-float-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dm-float-title{flex:1;font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-float-head button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer}
.dm-float-head button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dm-float-group{margin-bottom:8px}
.dm-float-group-title{font-size:10px;color:var(--dsw-alias-label-secondary,#8a8f9c);font-weight:600;margin:6px 0 4px}
.dm-float-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#eef0f3);border-radius:8px;margin-bottom:6px;background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.dm-float-row .dm-float-name{font-weight:600;font-family:ui-monospace,Consolas,monospace;font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-float-row .dm-float-meta{flex:1;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-float-actions{flex:none;display:flex;gap:4px}
.dm-float-action{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer}
.dm-float-action:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dm-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(8,10,16,.45));display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.dm-overlay[hidden]{display:none !important}
.dm-card{width:min(860px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden}
.dm-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dm-head h2{margin:0;font-size:15px;font-weight:600}
.dm-head .dm-counts{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-head button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.dm-head button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dm-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dm-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);padding:9px 14px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent}
.dm-tab[data-active]{color:var(--dsw-alias-label-primary,#1c1e26);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7)}
.dm-body{padding:14px 16px;overflow:auto;min-height:200px}
.dm-status{padding:26px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;text-align:center}
.dm-group{margin-bottom:18px}
.dm-group>h3{margin:0 0 2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#2f3542);display:flex;align-items:center;gap:8px}
.dm-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dm-group>.dm-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);margin:0 0 8px}
.dm-count{font-weight:400;color:var(--dsw-alias-label-secondary,#8a8f9c);margin-left:2px;font-size:11px}
.dm-server{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-base,#fff)}
.dm-server header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dm-server .dm-name{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,#111827);font-family:ui-monospace,Consolas,monospace}
.dm-badge{font-size:10px;padding:1px 7px;border-radius:99px;background:var(--dsw-alias-bg-layer-2,#f1f2f5);color:var(--dsw-alias-label-secondary,#525866);border:1px solid var(--dsw-alias-border-l2,#e2e4ea)}
.dm-badge.dm-http{background:var(--dsw-alias-state-business-secondary,#eef2ff);color:var(--dsw-alias-state-business-primary,#4353a3);border-color:var(--dsw-alias-state-business-tertiary,#dde3f8)}
.dm-badge.dm-stdio{background:var(--dsw-alias-bg-layer-2,#f5f0ff);color:var(--dsw-alias-label-secondary,#6d4bb8);border-color:var(--dsw-alias-border-l2,#e6dcf8)}
.dm-badge.dm-st-connected{background:var(--dsw-alias-state-success-secondary,#ecfdf5);color:var(--dsw-alias-state-success-primary,#0f7a50);border-color:var(--dsw-alias-state-success-tertiary,#c9f0dd)}
.dm-badge.dm-st-connecting,.dm-badge.dm-st-reconnecting{background:var(--dsw-alias-state-business-secondary,#eff6ff);color:var(--dsw-alias-state-business-primary,#1d66b8);border-color:var(--dsw-alias-state-business-tertiary,#d3e5fb)}
.dm-badge.dm-st-failed{background:var(--dsw-alias-state-error-secondary,#fef2f2);color:var(--dsw-alias-state-error-primary,#b42318);border-color:var(--dsw-alias-state-error-tertiary,#f8d3d0)}
.dm-badge.dm-st-disabled,.dm-badge.dm-st-stopped{background:var(--dsw-alias-bg-layer-2,#f1f2f5);color:var(--dsw-alias-label-secondary,#6b7280);border-color:var(--dsw-alias-border-l2,#e2e4ea)}
.dm-server .dm-endpoint{margin:5px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.dm-server .dm-err{margin:5px 0 0;font-size:11px;color:var(--dsw-alias-state-error-primary,#b42318)}
.dm-server .dm-tools{margin:6px 0 0}
.dm-server .dm-tools summary{font-size:11px;color:var(--dsw-alias-label-secondary,#525866);cursor:pointer;user-select:none}
.dm-server .dm-tools ul{margin:4px 0 0;padding-left:16px;font-size:11px;color:var(--dsw-alias-label-primary,#3a3f4b);font-family:ui-monospace,Consolas,monospace}
.dm-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.dm-actions button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer}
.dm-actions button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dm-actions button.dm-danger{color:var(--dsw-alias-state-error-primary,#b42318);border-color:var(--dsw-alias-state-error-tertiary,#f0c4c1)}
.dm-actions button.dm-primary{color:var(--dsw-alias-brand-primary,#1d4ed8);border-color:var(--dsw-alias-state-business-tertiary,#bcd1fb);background:var(--dsw-alias-state-business-secondary,#f5f8ff)}
.dm-actions button:disabled{opacity:.5;cursor:not-allowed}
.dm-section{margin-bottom:18px}
.dm-section>h3{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#2f3542)}
.dm-form{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;max-width:640px}
.dm-form .dm-full{grid-column:1/-1}
.dm-field{display:flex;flex-direction:column;gap:4px}
.dm-field label{font-size:11px;color:var(--dsw-alias-label-secondary,#525866);font-weight:600}
.dm-field input,.dm-field select,.dm-field textarea{border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-radius:6px;padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-primary,#1c1e26);background:var(--dsw-alias-bg-layer-1,#fff);font-family:ui-monospace,Consolas,monospace}
.dm-field textarea{min-height:64px;resize:vertical}
.dm-field input[type=checkbox]{width:auto}
.dm-check{flex-direction:row;align-items:center;gap:8px}
.dm-check label{margin:0}
.dm-form-actions{grid-column:1/-1;display:flex;gap:8px}
.dm-form-actions button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer}
.dm-form-actions button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dm-form-actions button.dm-primary{background:var(--dsw-alias-button-primary-fill,#4f6ef7);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:var(--dsw-alias-button-primary-fill,#4f6ef7)}
.dm-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c)}
.dm-paste-box{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:12px;background:var(--dsw-alias-bg-layer-1,#fafbfc);max-width:640px}
.dm-result{font-size:12px;color:var(--dsw-alias-state-success-primary,#0f7a50);margin-top:8px;line-height:1.6}
.dm-result .dm-skip{color:var(--dsw-alias-state-warn-primary,#b45309)}
`;

// ----------------------------------------------------------------- 状态

let overlay: any;
let card: any;
let bodyEl: any;
let open = false;
let activeTab = "servers";
let servers: any = [];
let counts: any = {};
let editingName: any = undefined;
let editing: any = undefined;

// ------------------------------------------------------------- DOM 工具

function el(tag: any, attrs: any = {}, children?: any) {
  // children 兼容两种传法：第三个位置参数，或 attrs.children（本插件调用点
  // 一直把 children 放进 attrs——早期版本只读第三参数导致子节点从未挂载）。
  if (children === undefined) children = attrs.children ?? [];
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "checked") node.checked = value;
    else if (key === "disabled") node.disabled = value;
    else if (key === "children") continue;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === undefined || child === null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

async function api(path: any, options = {}) {
  const response = await fetch(path, options);
  let body: any;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new Error(body?.error ?? `HTTP ${response.status}`);
  }
  return body;
}

// ------------------------------------------------------- 服务器列表页

const STATUS_ORDER = [
  { key: "connected", title: "运行中", dot: "var(--dsw-alias-state-success-primary,#0f9d6e)" },
  { key: "connecting", title: "连接中", dot: "var(--dsw-alias-state-business-primary,#2f7bf6)" },
  { key: "reconnecting", title: "重连中", dot: "var(--dsw-alias-state-warn-primary,#e08b1e)" },
  { key: "stopped", title: "未连接", dot: "var(--dsw-alias-label-tertiary,#9aa1ad)" },
  { key: "disabled", title: "已停用", dot: "var(--dsw-alias-label-tertiary,#9aa1ad)" },
  { key: "failed", title: "失败", dot: "var(--dsw-alias-state-error-primary,#e0483e)" },
];

const STATUS_TEXT: Record<string, string> = {
  connected: "运行中",
  connecting: "连接中",
  reconnecting: "重连中",
  stopped: "未连接",
  disabled: "已停用",
  failed: "失败",
};

function endpointOf(server: any) {
  if (server.transport === "streamable-http") return server.url ?? "";
  const args = Array.isArray(server.args) && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
  return `${server.command ?? ""}${args}`;
}

function renderServer(server: any) {
  const article = el("article", { class: "dm-server" });
  const header = el("header");
  header.appendChild(el("span", { class: "dm-name", text: server.name }));
  header.appendChild(el("span", {
    class: `dm-badge ${server.transport === "streamable-http" ? "dm-http" : "dm-stdio"}`,
    text: server.transport === "streamable-http" ? "HTTP" : "stdio",
  }));
  header.appendChild(el("span", { class: "dm-badge", text: server.scope === "project" ? "项目" : "全局" }));
  const statusBadge = el("span", { class: `dm-badge dm-st-${server.status}`, text: STATUS_TEXT[server.status] ?? server.status });
  header.appendChild(statusBadge);
  const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
  header.appendChild(el("span", { class: "dm-count", text: `${toolCount} 工具` }));
  article.appendChild(header);

  article.appendChild(el("div", { class: "dm-endpoint", text: endpointOf(server) }));
  if (server.error !== undefined && server.error !== "") {
    article.appendChild(el("div", { class: "dm-err", text: server.error }));
  }

  if (toolCount > 0) {
    const details = el("details", { class: "dm-tools" });
    details.appendChild(el("summary", { text: `工具（${toolCount}）` }));
    const list = el("ul");
    for (const tool of server.tools) list.appendChild(el("li", { text: tool }));
    details.appendChild(list);
    article.appendChild(details);
  }

  const actions = el("div", { class: "dm-actions" });
  const busy = server.status === "connecting" || server.status === "reconnecting";
  const scopeQuery = `&scope=${server.scope}`;
  if (server.status === "connected") {
    actions.appendChild(actionButton("断开", async () => {
      await api(`${API.disconnect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await refresh();
    }));
    actions.appendChild(actionButton("重连", async () => {
      await api(`${API.reconnect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await refresh();
    }));
  } else if (server.status === "disabled") {
    actions.appendChild(actionButton("启用并连接", async () => {
      await api(`${API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      await api(`${API.connect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await refresh();
    }, true));
  } else {
    actions.appendChild(actionButton("连接", async () => {
      await api(`${API.connect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await refresh();
    }, true));
  }
  // 禁用开关：非 disabled 状态可一键禁用（宿主断开并注销工具）
  if (server.status !== "disabled") {
    actions.appendChild(actionButton("禁用", async () => {
      await api(`${API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (editingName === server.name) resetForm();
      await refresh();
    }));
  }
  actions.appendChild(actionButton("编辑", () => beginEdit(server)));
  actions.appendChild(actionButton("删除", async () => {
    if (!window.confirm(`删除 MCP 服务器「${server.name}」？`)) return;
    await api(`${API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "DELETE" });
    if (editingName === server.name) resetForm();
    await refresh();
  }, false, true));
  actions.children[actions.children.length - 1].disabled = busy;
  article.appendChild(actions);
  return article;
}

function actionButton(label: any, onClick: any, primary = false, danger = false) {
  return el("button", {
    class: `${primary ? "dm-primary" : ""} ${danger ? "dm-danger" : ""}`.trim(),
    text: label,
    onclick: async () => {
      try {
        await onClick();
      } catch (error) {
        window.alert(`操作失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

function renderServers() {
  bodyEl.textContent = "";
  if (servers.length === 0) {
    bodyEl.appendChild(el("div", { class: "dm-status", text: "还没有配置 MCP 服务器。切到「快速接入」页添加，或粘贴 mcpServers JSON 导入。" }));
    return;
  }
  for (const group of STATUS_ORDER) {
    const list = servers.filter((server: any) => server.status === group.key);
    if (list.length === 0) continue;
    const section = el("section", { class: "dm-group" });
    const title = el("h3");
    title.appendChild(el("span", { class: "dm-dot", style: `background:${group.dot}` }));
    title.appendChild(document.createTextNode(group.title));
    title.appendChild(el("span", { class: "dm-count", text: `${list.length}` }));
    section.appendChild(title);
    for (const server of list.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      section.appendChild(renderServer(server));
    }
    bodyEl.appendChild(section);
  }
  const others = servers.filter((server: any) => !STATUS_ORDER.some((group) => group.key === server.status));
  if (others.length > 0) {
    const section = el("section", { class: "dm-group" });
    section.appendChild(el("h3", { text: "其他" }));
    for (const server of others) section.appendChild(renderServer(server));
    bodyEl.appendChild(section);
  }
}

// ------------------------------------------------------- 快速接入页

let formName: any;
let formScope: any;
let formTransport: any;
let formCommand: any;
let formArgs: any;
let formEnv: any;
let formCwd: any;
let formUrl: any;
let formHeaders: any;
let formEnabled: any;

function buildQuickAdd() {
  const page = el("div");

  // 表单
  const form = el("section", { class: "dm-section" });
  form.appendChild(el("h3", { id: "dm-form-title", text: "添加服务器" }));
  formName = el("input", { id: "dm-f-name", placeholder: "context7", value: editing?.name ?? "" });
  formScope = el("select", { id: "dm-f-scope" });
  formScope.appendChild(el("option", { value: "project", text: "项目级（<项目>/.dsh/mcp.json，随会话切换）" }));
  formScope.appendChild(el("option", { value: "global", text: "全局（~/.dsh/dsh-mcp.json）" }));
  formScope.value = editing?.scope ?? (projectRoot !== undefined && projectRoot !== "" ? "project" : "global");
  formTransport = el("select", { id: "dm-f-transport" });
  formTransport.appendChild(el("option", { value: "stdio", text: "stdio（本地子进程）" }));
  formTransport.appendChild(el("option", { value: "streamable-http", text: "streamable-http（远程）" }));
  formCommand = el("input", { id: "dm-f-command", placeholder: "npx" });
  formArgs = el("input", { id: "dm-f-args", placeholder: "-y, @context7/mcp-server" });
  formEnv = el("textarea", { id: "dm-f-env", placeholder: "每行 KEY=VALUE，如\nCONTEXT7_API_KEY=${CONTEXT7_API_KEY}" });
  formCwd = el("input", { id: "dm-f-cwd", placeholder: "可选工作目录" });
  formUrl = el("input", { id: "dm-f-url", placeholder: "https://mcp.context7.com/mcp" });
  formHeaders = el("textarea", { id: "dm-f-headers", placeholder: '每行 KEY: VALUE，支持 ${ENV} 引用，如\nAuthorization: Bearer ${CONTEXT7_API_KEY}' });
  formEnabled = el("input", { id: "dm-f-enabled", type: "checkbox", checked: true });

  const grid = el("div", { class: "dm-form" });
  grid.appendChild(el("div", { class: "dm-field", children: [el("label", { text: "服务器名称（唯一，作为 mcp__<name>__ 前缀）" }), formName] }));
  grid.appendChild(el("div", { class: "dm-field", children: [el("label", { text: "归属" }), formScope] }));
  grid.appendChild(el("div", { class: "dm-field", children: [el("label", { text: "传输类型" }), formTransport] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "命令（stdio）" }), formCommand] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "参数（逗号分隔）" }), formArgs] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "环境变量（每行 KEY=VALUE，支持 ${ENV} 引用，值为空则继承父环境）" }), formEnv] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "工作目录（可选）" }), formCwd] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "URL（streamable-http）" }), formUrl] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "请求头（每行 KEY: VALUE，支持 ${ENV} 引用）" }), formHeaders] }));
  grid.appendChild(el("div", { class: "dm-check dm-field dm-full", children: [formEnabled, el("label", { text: "启用（保存后立即连接）" })] }));
  const actions = el("div", { class: "dm-form-actions" });
  const save = el("button", { class: "dm-primary", text: "保存", onclick: () => void saveForm() });
  const cancel = el("button", { text: "取消编辑", onclick: () => resetForm(), disabled: true });
  cancel.dataset.dmCancel = "";
  actions.appendChild(save);
  actions.appendChild(cancel);
  grid.appendChild(actions);
  form.appendChild(grid);
  page.appendChild(form);

  // 传输类型切换显示/隐藏
  const syncTransport = () => {
    const isHttp = formTransport.value === "streamable-http";
    for (const field of [formCommand, formArgs, formEnv, formCwd]) {
      field.closest(".dm-field").style.display = isHttp ? "none" : "flex";
    }
    for (const field of [formUrl, formHeaders]) {
      field.closest(".dm-field").style.display = isHttp ? "flex" : "none";
    }
  };
  formTransport.addEventListener("change", syncTransport);

  // 粘贴 JSON 导入
  const paste = el("section", { class: "dm-section" });
  paste.appendChild(el("h3", { text: "粘贴 mcpServers JSON 导入" }));
  const pasteBox = el("div", { class: "dm-paste-box" });
  const textarea = el("textarea", {
    class: "dm-full",
    placeholder: '{"my-server":{"command":"npx","args":["-y","pkg"],"env":{"KEY":"value"}},"remote":{"url":"https://...","headers":{}}}',
    style: "width:100%;min-height:90px;border:1px solid #d7dae0;border-radius:6px;padding:6px 8px;font-size:12px;font-family:ui-monospace,Consolas,monospace;box-sizing:border-box",
  });
  pasteBox.appendChild(textarea);
  pasteBox.appendChild(el("div", { class: "dm-actions", children: [
    el("button", { class: "dm-primary", text: "导入 JSON", onclick: async () => {
      const result = pasteBox.querySelector(".dm-result");
      try {
        const payload = await api(API.importJson, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: textarea.value, scope: formScopeValue(), ...currentCwdBody() }),
        });
        result.textContent = `已导入：${payload.imported.join(", ") || "（无）"}`;
        if (payload.skipped.length > 0) {
          result.appendChild(el("div", { class: "dm-skip", text: `跳过（已存在）：${payload.skipped.join(", ")}` }));
        }
        await refresh();
      } catch (error) {
        result.textContent = `导入失败：${error instanceof Error ? error.message : String(error)}`;
      }
    } }),
  ] }));
  pasteBox.appendChild(el("div", { class: "dm-result" }));
  paste.appendChild(pasteBox);
  page.appendChild(paste);

  return page;
}

/** 表单数据 → 服务器配置对象（scope 由 formScope 决定）。 */
function readForm() {
  const server: any = {
    name: formName.value.trim(),
    transport: formTransport.value,
    enabled: formEnabled.checked,
  };
  if (server.transport === "stdio") {
    server.command = formCommand.value.trim();
    const args = formArgs.value.split(",").map((part: any) => part.trim()).filter(Boolean);
    if (args.length > 0) server.args = args;
    const env = parseKV(formEnv.value);
    if (Object.keys(env).length > 0) server.env = env;
    if (formCwd.value.trim() !== "") server.cwd = formCwd.value.trim();
  } else {
    server.url = formUrl.value.trim();
    const headers = parseKV(formHeaders.value);
    if (Object.keys(headers).length > 0) server.headers = headers;
  }
  return server;
}

/** 当前表单选择的归属（project/global）。 */
function formScopeValue() {
  if (formScope !== undefined && (formScope.value === "project" || formScope.value === "global")) {
    return formScope.value;
  }
  return projectRoot !== undefined && projectRoot !== "" ? "project" : "global";
}

/** 当前会话 cwd（POST body 携带，宿主据此切换项目级 MCP）。 */
function currentCwdBody() {
  return typeof currentCwd === "string" && currentCwd !== "" ? { cwd: currentCwd } : {};
}

/** 解析 "KEY: VALUE" / "KEY=VALUE" 多行文本为对象。 */
function parseKV(text: any) {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/);
    if (match === null) continue;
    const value = match[2].trim();
    if (value !== "") out[match[1]] = value;
    else out[match[1]] = "";
  }
  return out;
}

function fillForm(fill: any) {
  resetForm();
  if (fill.name !== undefined) formName.value = fill.name;
  formTransport.value = fill.transport ?? "stdio";
  if (fill.command !== undefined) formCommand.value = fill.command;
  if (Array.isArray(fill.args)) formArgs.value = fill.args.join(", ");
  if (fill.env !== undefined) {
    formEnv.value = Object.entries(fill.env).map(([key, value]) => `${key}=${value}`).join("\n");
  }
  if (fill.cwd !== undefined) formCwd.value = fill.cwd;
  if (fill.url !== undefined) formUrl.value = fill.url;
  if (fill.headers !== undefined) {
    formHeaders.value = Object.entries(fill.headers).map(([key, value]) => `${key}: ${value}`).join("\n");
  }
  formTransport.dispatchEvent(new Event("change"));
}

async function saveForm() {
  const server = readForm();
  try {
    const payload = { ...server, scope: formScopeValue(), ...currentCwdBody() };
    if (editingName !== undefined) {
      await api(`${API.servers}?name=${encodeURIComponent(editingName)}&scope=${formScopeValue()}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await api(API.servers, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    resetForm();
    await refresh();
  } catch (error) {
    window.alert(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function beginEdit(server: any) {
  editingName = server.name;
  editing = server;
  switchTab("quick");
  fillForm(server);
  if (formScope !== undefined && (server.scope === "project" || server.scope === "global")) {
    formScope.value = server.scope;
  }
  const title = document.getElementById("dm-form-title");
  if (title !== null) title.textContent = `编辑服务器：${server.name}`;
  const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
  if (cancel !== null) cancel.disabled = false;
}

function resetForm() {
  editingName = undefined;
  editing = undefined;
  if (formName === undefined) return;
  formName.value = "";
  formScope.value = projectRoot !== undefined && projectRoot !== "" ? "project" : "global";
  formTransport.value = "stdio";
  formCommand.value = "";
  formArgs.value = "";
  formEnv.value = "";
  formCwd.value = "";
  formUrl.value = "";
  formHeaders.value = "";
  formEnabled.checked = true;
  formTransport.dispatchEvent(new Event("change"));
  const title = document.getElementById("dm-form-title");
  if (title !== null) title.textContent = "添加服务器";
  const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
  if (cancel !== null) cancel.disabled = true;
}

// ------------------------------------------------------------- 面板

async function refresh() {
  try {
    const suffix = typeof currentCwd === "string" && currentCwd !== ""
      ? `?cwd=${encodeURIComponent(currentCwd)}`
      : "";
    const payload = await api(`${API.servers}${suffix}`);
    servers = payload.servers ?? [];
    counts = payload.counts ?? {};
    projectRoot = payload.projectRoot;
    renderPill();
    if (floatOpen) renderFloatPanel();
    const countsEl = document.querySelector(".dm-counts");
    if (countsEl !== null) {
      const parts = [];
      if (counts.connected > 0) parts.push(`运行中 ${counts.connected}`);
      if (counts.connecting > 0 || counts.reconnecting > 0) parts.push(`连接中 ${(counts.connecting ?? 0) + (counts.reconnecting ?? 0)}`);
      if (counts.failed > 0) parts.push(`失败 ${counts.failed}`);
      countsEl.textContent = parts.length > 0 ? `共 ${servers.length} 台 · ${parts.join(" · ")}` : `共 ${servers.length} 台`;
    }
    if (bodyEl !== undefined && activeTab === "servers") renderServers();
    return true;
  } catch (error) {
    if (bodyEl !== undefined && activeTab === "servers") {
      bodyEl.textContent = "";
      bodyEl.appendChild(el("div", { class: "dm-status", text: `加载失败：${error instanceof Error ? error.message : String(error)}` }));
    }
    return false;
  }
}

function switchTab(tab: any) {
  activeTab = tab;
  for (const tabEl of document.querySelectorAll<HTMLElement>(".dm-tab")) {
    tabEl.dataset.active = tabEl.dataset.tab === tab ? "true" : "";
  }
  bodyEl.textContent = "";
  if (tab === "servers") {
    if (servers.length === 0) void refresh();
    else renderServers();
  } else {
    const page = buildQuickAdd();
    bodyEl.appendChild(page);
  }
}

function close() {
  if (overlay === undefined) return;
  open = false;
  overlay.hidden = true;
}

function showPanel() {
  if (overlay === undefined) {
    overlay = el("div", { class: "dm-overlay", hidden: true });
    overlay.addEventListener("click", (event: any) => {
      if (event.target === overlay) close();
    });
    card = el("div", { class: "dm-card" });

    const head = el("div", { class: "dm-head" });
    head.appendChild(el("h2", { text: "MCP 管理器" }));
    head.appendChild(el("span", { class: "dm-counts", text: "" }));
    head.appendChild(el("button", { text: "刷新", onclick: () => void refresh() }));
    head.appendChild(el("button", { text: "关闭", onclick: () => close() }));
    card.appendChild(head);

    const tabs = el("div", { class: "dm-tabs" });
    tabs.appendChild(el("button", { class: "dm-tab", dataset: { tab: "servers" }, text: "服务器", onclick: () => switchTab("servers") }));
    tabs.appendChild(el("button", { class: "dm-tab", dataset: { tab: "quick" }, text: "快速接入", onclick: () => switchTab("quick") }));
    card.appendChild(tabs);

    bodyEl = el("div", { class: "dm-body" });
    card.appendChild(bodyEl);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && open) close();
    });
  }
  open = true;
  overlay.hidden = false;
  switchTab("servers");
}

// ------------------------------------------------------- 右上角浮窗

let floatPill: any;
let floatPanel: any;
let floatOpen = false;
let currentCwd: any = undefined;
let projectRoot: any = undefined;

/** 状态点的颜色（与 STATUS_ORDER 一致）。 */
function statusDot(status: any) {
  const group = STATUS_ORDER.find((entry) => entry.key === status);
  return group !== undefined ? group.dot : "var(--dsw-alias-label-tertiary,#9aa1ad)";
}

/** 渲染浮窗胶囊（状态点 + 摘要计数）。 */
function renderPill() {
  if (floatPill === undefined) return;
  const ok = counts.connected ?? 0;
  const bad = (counts.failed ?? 0) + (counts.reconnecting ?? 0);
  const dot = bad > 0
    ? "var(--dsw-alias-state-error-primary,#e0483e)"
    : ok > 0
      ? "var(--dsw-alias-state-success-primary,#0f9d6e)"
      : "var(--dsw-alias-label-tertiary,#9aa1ad)";
  const label = servers.length > 0 ? `MCP ${ok}/${servers.length}` : "MCP";
  floatPill.innerHTML = `<span class="dm-dot" style="background:${dot}"></span><span>${label}</span>`;
}

/** 渲染浮窗下拉面板（项目/全局分组 + 状态 + 快捷操作）。 */
function renderFloatPanel() {
  if (floatPanel === undefined) return;
  floatPanel.textContent = "";
  const head = el("div", { class: "dm-float-head" });
  const projectName = typeof projectRoot === "string" && projectRoot !== ""
    ? (projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? projectRoot)
    : "全局会话";
  head.appendChild(el("span", { class: "dm-float-title", text: projectName }));
  head.appendChild(el("button", { text: "管理", onclick: () => { toggleFloat(false); showPanel(); } }));
  floatPanel.appendChild(head);

  if (servers.length === 0) {
    floatPanel.appendChild(el("div", { class: "dm-status", text: "没有 MCP 服务器，点「管理」添加" }));
    return;
  }
  for (const scope of ["project", "global"]) {
    const list = servers.filter((server: any) => server.scope === scope);
    if (list.length === 0) continue;
    const section = el("section", { class: "dm-float-group" });
    section.appendChild(el("div", { class: "dm-float-group-title", text: scope === "project" ? "项目级" : "全局" }));
    for (const server of [...list].sort((a: any, b: any) => a.name.localeCompare(b.name))) {
      section.appendChild(renderFloatRow(server));
    }
    floatPanel.appendChild(section);
  }
}

/** 浮窗面板里的一行服务器。 */
function renderFloatRow(server: any) {
  const row = el("div", { class: "dm-float-row" });
  row.appendChild(el("span", { class: "dm-dot", style: `background:${statusDot(server.status)}` }));
  row.appendChild(el("span", { class: "dm-float-name", text: server.name, title: server.name }));
  const tools = Array.isArray(server.tools) ? server.tools.length : 0;
  row.appendChild(el("span", { class: "dm-float-meta", text: `${STATUS_TEXT[server.status] ?? server.status} · ${tools} 工具` }));
  const actions = el("div", { class: "dm-float-actions" });
  const action = el("button", { class: "dm-float-action" });
  if (server.status === "connected") {
    action.textContent = "断开";
    action.addEventListener("click", () => {
      void api(`${API.disconnect}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, { method: "POST" })
        .then(() => refresh())
        .catch((error) => console.warn("[dsh-mcp-manager] disconnect failed:", error));
    });
  } else if (server.status === "disabled") {
    action.textContent = "启用";
    action.addEventListener("click", () => {
      void api(`${API.servers}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }).then(() => refresh())
        .catch((error) => console.warn("[dsh-mcp-manager] enable failed:", error));
    });
  } else {
    action.textContent = "连接";
    action.addEventListener("click", () => {
      void api(`${API.connect}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, { method: "POST" })
        .then(() => refresh())
        .catch((error) => console.warn("[dsh-mcp-manager] connect failed:", error));
    });
  }
  actions.appendChild(action);
  // 禁用开关：非 disabled 状态可一键禁用（PATCH enabled:false → 宿主断开并注销工具）
  if (server.status !== "disabled") {
    const disable = el("button", { class: "dm-float-action" });
    disable.textContent = "禁用";
    disable.addEventListener("click", () => {
      void api(`${API.servers}?name=${encodeURIComponent(server.name)}&scope=${server.scope}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }).then(() => refresh())
        .catch((error) => console.warn("[dsh-mcp-manager] disable failed:", error));
    });
    actions.appendChild(disable);
  }
  row.appendChild(actions);
  return row;
}

function toggleFloat(force?: any) {
  if (floatPanel === undefined) return;
  const next = force !== undefined ? force : !floatOpen;
  floatOpen = next;
  floatPanel.hidden = !next;
  if (next) {
    placePanel();
    renderFloatPanel();
  }
}

/** 下拉面板定位（fixed 跟随胶囊，避免被滚动容器裁剪）。 */
function placePanel() {
  if (floatPill === undefined || floatPanel === undefined) return;
  const rect = floatPill.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  floatPanel.style.top = `${Math.max(6, rect.bottom + 6)}px`;
  floatPanel.style.right = `${Math.max(10, Math.round(window.innerWidth - rect.right))}px`;
  floatPanel.style.left = "auto";
}

/** 会话滚动容器：聊天消息实际滚动的区域（shell 的 data-conversation-scroll）。 */
function conversationHost() {
  return document.querySelector('[data-conversation-scroll]')
    ?? document.querySelector('[data-pane="conversation"]')
    ?? document.body;
}

/** 挂载浮窗：胶囊挂在会话滚动容器（scrollBody）内并钉住右上角，下拉面板 fixed 跟随。 */
function mountFloat() {
  const pill = el("button", {
    type: "button",
    class: "dm-float",
    "aria-label": "MCP 管理器",
    title: "MCP 管理器（点击展开）",
  });
  pill.dataset.dshMcpFloat = "";
  pill.addEventListener("click", () => toggleFloat());
  const panel = el("div", { class: "dm-float-panel" });
  panel.hidden = true;
  floatPill = pill;
  floatPanel = panel;
  // 面板挂 body（fixed 定位），胶囊挂滚动容器
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  let host: any;
  let listeners: any = [];
  const attachListeners = (target: any) => {
    for (const detach of listeners.splice(0)) detach();
    const onScroll = () => {
      const top = (target === document.body ? window.scrollY : target.scrollTop) + 8;
      pill.style.top = `${top}px`;
      if (floatOpen) placePanel();
    };
    const onResize = () => {
      if (floatOpen) placePanel();
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    listeners.push(() => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    });
    onScroll();
  };

  /**
   * 放置/迁移：每次调用都重新求最佳宿主（scrollBody 优先），浮窗永远跟着
   * 它走——即使初始化时 scrollBody 尚未渲染（退回 body），一旦出现就迁移。
   */
  const place = () => {
    const best = conversationHost();
    if (best === null || best === undefined) return false;
    if (host !== best || pill.parentElement !== best) {
      host = best;
      if (pill.parentElement !== null) pill.remove();
      best.appendChild(pill);
      attachListeners(best);
    }
    return true;
  };
  const observer = new MutationObserver(() => {
    place();
  });
  if (place()) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    const wait = new MutationObserver(() => {
      if (place()) {
        wait.disconnect();
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    wait.observe(document.body, { childList: true, subtree: true });
  }
  renderPill();
  return () => {
    observer.disconnect();
    for (const detach of listeners.splice(0)) detach();
    pill.remove();
    panel.remove();
    floatPill = undefined;
    floatPanel = undefined;
    floatOpen = false;
  };
}

/** 跟随当前会话：cwd 变化 → 通知宿主切换项目级 MCP + 刷新浮窗。 */
function bindSession(ctx: any) {
  const list = ctx.sessions?.list;
  if (list === undefined || typeof list.getSnapshot !== "function") return () => {};
  const sync = () => {
    let cwd: any;
    try {
      const snapshot = list.getSnapshot();
      const sessionId = snapshot?.current;
      cwd = sessionId === undefined ? undefined : snapshot?.byId?.[sessionId]?.cwd;
    } catch {
      cwd = undefined;
    }
    if (cwd === currentCwd) return;
    currentCwd = cwd;
    // 无论 cwd 是否为空都通知宿主切换：空 cwd（blank 会话/新会话还没选
    // 工作区）也要显式清空宿主的项目级 MCP，否则宿主全局单例会残留
    // 上一个会话的项目级服务器，别的会话就串台显示了。
    void api(API.session, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: typeof cwd === "string" ? cwd : "" }),
    }).then(() => refresh()).catch(() => {});
  };
  sync();
  if (typeof list.subscribe === "function") return list.subscribe(sync);
  return () => {};
}

/**
 * 挂载浏览器端：注入样式 + 右上角浮窗（会话跟随）+ 管理面板。
 * @param {import("@deepseek-ai/dsh-client-runtime/client").ClientContext} ctx
 * @returns {void}
 */
function apply(ctx: any) {
  try {
    if (document.querySelector('style[data-dsh-mcp-manager-style]') === null) {
      const style = document.createElement("style");
      style.dataset.dshMcpManagerStyle = "";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    const disposers: any[] = [];
    disposers.push(mountFloat());
    disposers.push(bindSession(ctx));

    // 首次刷新：立即执行，失败按 500ms/1s/2s 退避重试（宿主路由可能尚未就绪，
    // 不依赖固定延迟猜测）。
    let retryTimer: any = undefined;
    const attemptRefresh = (attempt: any) => {
      refresh().then((ok) => {
        if (!ok && attempt < 3) {
          retryTimer = setTimeout(() => attemptRefresh(attempt + 1), 500 * 2 ** attempt);
        }
      }).catch((error) => {
        // 防御：refresh 永不 reject（内部 try/catch），但兜底避免 unhandled rejection。
        console.warn("[dsh-mcp-manager] 首刷失败：", error);
      });
    };
    attemptRefresh(0);

    // 状态推送（SSE）：宿主状态变化（连接/重连/失败）→ 节流刷新；SSE 真正
    // 关闭（非自动重连）才降级为 10s 轮询兜底。
    let es: any = undefined;
    let refreshTimer: any = undefined;
    let esFailures = 0;
    let pollTimer: any = undefined;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh().catch(() => {});
      }, 500);
    };
    const startPolling = () => {
      if (pollTimer !== undefined) return;
      const tick = () => {
        pollTimer = setTimeout(() => {
          void refresh().catch(() => {});
          tick();
        }, 10_000);
      };
      tick();
    };
    try {
      es = new EventSource(API.events);
      es.onmessage = () => scheduleRefresh();
      es.onerror = () => {
        // 宿主重启/热重载/网络抖动会主动断开旧连接，浏览器随即自动重连
        // （readyState 回到 CONNECTING）——这种瞬时断连不是失败，不累计。
        // 只有连接真正关闭（如路由 404）才计数，3 次后放弃 SSE 改轮询。
        if (es !== undefined && es.readyState === EventSource.CLOSED) {
          esFailures += 1;
          if (esFailures >= 3) {
            es.close();
            es = undefined;
            startPolling();
          }
        }
      };
    } catch {
      // EventSource 不可用：直接轮询兜底。
      startPolling();
    }
    // 切回本标签页/窗口时兜底刷新：隐藏期间错过的 SSE 广播不会重放，
    // 恢复可见后主动拉一次，避免 UI 停留在过期状态（如项目级显示未连接）。
    const onVisible = () => {
      if (!document.hidden) void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);

    ctx.effect(() => () => {
      clearTimeout(retryTimer);
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (es !== undefined) es.close();
      document.removeEventListener("visibilitychange", onVisible);
      for (const dispose of disposers.splice(0)) dispose();
      if (overlay !== undefined && overlay.parentElement !== null) overlay.remove();
      overlay = undefined;
      open = false;
      // 重置全部模块级状态（HMR / 重复 apply 不残留旧 tab 与编辑态）。
      card = undefined;
      bodyEl = undefined;
      activeTab = "servers";
      servers = [];
      counts = {};
      editingName = undefined;
      editing = undefined;
      formName = formScope = formTransport = formCommand = formArgs = formEnv = formCwd = formUrl = formHeaders = formEnabled = undefined;
      floatPill = undefined;
      floatPanel = undefined;
      floatOpen = false;
      currentCwd = undefined;
      projectRoot = undefined;
    }, "dsh-mcp-manager: ui");
  } catch (error) {
    console.warn("[dsh-mcp-manager] mount failed:", error);
  }
}

		// 客户端插件声明：注入 sessions 服务以跟随当前会话（cwd 切换项目级 MCP）。
		const inject = ["sessions"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

})();