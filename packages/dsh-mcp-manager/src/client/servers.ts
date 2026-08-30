/**
 * dsh-mcp-manager — 客户端「服务器列表页」渲染。
 *
 * 按状态分级展示服务器卡片（端点 / 错误 / 工具列表 / 操作按钮）。
 * 跨模块动作（refresh / resetForm / beginEdit）经 actions 注入，不直接引用
 * panel/quick-add 模块，避免循环依赖。
 */

import { el, api } from "./dom.ts";
import { STATUS_ORDER, STATUS_TEXT } from "./constants.ts";
import type { McpState, UiActions } from "./state.ts";

/** 服务器端点摘要：streamable-http 显示 URL，stdio 显示 command + args。 */
export function endpointOf(server: any): string {
  if (server.transport === "streamable-http") return server.url ?? "";
  const args = Array.isArray(server.args) && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
  return `${server.command ?? ""}${args}`;
}

/** 操作按钮（统一失败提示）。 */
export function actionButton(label: any, onClick: any, primary = false, danger = false): any {
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

/** 工具级禁用 checkbox（PATCH /api/dsh-mcp/tool-disable；#362 交互拍板 2b）。 */
function toolCheckbox(server: any, tool: string, disabled: boolean, state: McpState, actions: UiActions): any {
  const label = el("label", { class: "dm-tool" });
  const input = el("input", { type: "checkbox", checked: disabled });
  input.addEventListener("change", () => {
    void api(state.API.toolDisable, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: `@${server.scope === "global" ? "@global" : state.projectRoot ?? ""}/${server.name}`,
        tool,
        disabled: input.checked,
      }),
    }).then(() => actions.refresh())
      .catch((error: any) => {
        input.checked = !input.checked;
        console.warn("[dsh-mcp-manager] tool-disable failed:", error);
      });
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode(tool));
  return label;
}

/** 渲染单台服务器卡片。 */
export function renderServer(server: any, state: McpState, actions: UiActions, opts: { tools: boolean } = { tools: true }): any {
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

  if (toolCount > 0 && opts.tools) {
    const details = el("details", { class: "dm-tools" });
    details.appendChild(el("summary", { text: `工具（${toolCount}）` }));
    const list = el("ul");
    const disabledSet = new Set(Array.isArray(server.disabledTools) ? server.disabledTools : []);
    for (const tool of server.tools) {
      list.appendChild(el("li", {}, [toolCheckbox(server, tool, disabledSet.has(tool), state, actions)]));
    }
    details.appendChild(list);
    article.appendChild(details);
  } else if (toolCount > 0 && !opts.tools) {
    const details = el("details", { class: "dm-tools" });
    details.appendChild(el("summary", { text: `工具（${toolCount}）` }));
    const list = el("ul");
    for (const tool of server.tools) list.appendChild(el("li", { text: tool }));
    details.appendChild(list);
    article.appendChild(details);
  }

  const actionsEl = el("div", { class: "dm-actions" });
  const busy = server.status === "connecting" || server.status === "reconnecting";
  const scopeQuery = `&scope=${server.scope}`;
  if (server.status === "connected") {
    actionsEl.appendChild(actionButton("断开", async () => {
      await api(`${state.API.disconnect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await actions.refresh();
    }));
    actionsEl.appendChild(actionButton("重连", async () => {
      await api(`${state.API.reconnect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await actions.refresh();
    }));
  } else if (server.status === "disabled") {
    actionsEl.appendChild(actionButton("启用并连接", async () => {
      await api(`${state.API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      await api(`${state.API.connect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await actions.refresh();
    }, true));
  } else {
    actionsEl.appendChild(actionButton("连接", async () => {
      await api(`${state.API.connect}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "POST" });
      await actions.refresh();
    }, true));
  }
  // 禁用开关：非 disabled 状态可一键禁用（宿主断开并注销工具）
  if (server.status !== "disabled") {
    actionsEl.appendChild(actionButton("禁用", async () => {
      await api(`${state.API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (state.editingName === server.name) actions.resetForm();
      await actions.refresh();
    }));
  }
  actionsEl.appendChild(actionButton("编辑", () => actions.beginEdit(server)));
  actionsEl.appendChild(actionButton("删除", async () => {
    if (!window.confirm(`删除 MCP 服务器「${server.name}」？`)) return;
    await api(`${state.API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, { method: "DELETE" });
    if (state.editingName === server.name) actions.resetForm();
    await actions.refresh();
  }, false, true));
  actionsEl.children[actionsEl.children.length - 1].disabled = busy;
  article.appendChild(actionsEl);
  return article;
}

/** 渲染服务器列表页（#362 交互拍板 1a：项目级 / 全局级两大分组，各自内部再按状态）。
 * project 模式：全局组显示服务器但无工具 checkbox（提示切 all 模式可管理全局工具）。 */
export function renderServers(state: McpState, actions: UiActions): void {
  if (state.bodyEl === undefined) return;
  state.bodyEl.textContent = "";
  if (state.servers.length === 0) {
    state.bodyEl.appendChild(el("div", { class: "dm-status", text: "还没有配置 MCP 服务器。切到「快速接入」页添加，或粘贴 mcpServers JSON 导入。" }));
    return;
  }
  const isAll = state.middlewareMode === "all";
  const toolsEnabled = (scope: string) => scope === "project" || isAll;
  for (const scope of ["project", "global"]) {
    const list = state.servers.filter((server: any) => server.scope === scope);
    if (list.length === 0) continue;
    const section = el("section", { class: "dm-group" });
    const title = el("h3");
    title.appendChild(document.createTextNode(scope === "project" ? "项目级" : "全局级"));
    title.appendChild(el("span", { class: "dm-count", text: `${list.length}` }));
    section.appendChild(title);
    for (const group of STATUS_ORDER) {
      const grouped = list.filter((server: any) => server.status === group.key);
      if (grouped.length === 0) continue;
      const sub = el("div", { class: "dm-subgroup" });
      sub.appendChild(el("h4", { class: "dm-subgroup-title", text: `${group.title}（${grouped.length}）` }));
      for (const server of grouped.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
        sub.appendChild(renderServer(server, state, actions, { tools: toolsEnabled(scope) }));
      }
      section.appendChild(sub);
    }
    if (scope === "global" && !isAll) {
      section.appendChild(el("div", { class: "dm-status", text: "全局工具开关需在 all 模式（中间层全量接管）下管理——切 all 模式可管理全局工具" }));
    }
    state.bodyEl.appendChild(section);
  }
}