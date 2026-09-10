/**
 * dsh-mcp-manager — 客户端「服务器列表页」渲染。
 *
 * 按状态分级展示服务器卡片（端点 / 错误 / 工具列表 / 操作按钮）。
 * 跨模块动作（refresh / resetForm / beginEdit）经 actions 注入，不直接引用
 * panel/quick-add 模块，避免循环依赖。
 */

import { el } from "../core/dom.ts";
import { api, toolDisableServerKey, cwdQueryOf } from "../core/api.ts";
import { STATUS_ORDER } from "../core/constants.ts";
import { tStatus } from "../core/i18n.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { McpState, UiActions } from "../core/state.ts";

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
        window.alert(t("actionFail", { msg: error instanceof Error ? error.message : String(error) }));
      }
    },
  });
}

/** 工具级禁用 checkbox（PATCH /api/dsh-mcp/tool-disable；#362 交互拍板 2b）。 */
function toolCheckbox(server: any, tool: string, disabled: boolean, state: McpState, actions: UiActions): any {
  const label = el("label", { class: "dm-tool" });
  const input = el("input", { type: "checkbox", checked: disabled });
  input.addEventListener("change", () => {
    // C6：全名形态经 toolDisableServerKey 归一，projectRoot 缺失时跳过提交
    // （防御非法 @/name，与浮窗 toolCheckbox 同口径）。
    const serverKey = toolDisableServerKey(server, state);
    if (serverKey === undefined) {
      input.checked = !input.checked;
      console.warn("[dsh-mcp-manager] projectRoot 缺失，跳过 tool-disable（非法 @/name 防御）");
      return;
    }
    void api(state.API.toolDisable, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: serverKey,
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
export function renderServer(server: any, state: McpState, actions: UiActions, opts: { tools: boolean; openTools?: Set<string> } = { tools: true }): any {
  const article = el("article", { class: "dm-server" });
  const header = el("header");
  header.appendChild(el("span", { class: "dm-name", text: server.name }));
  header.appendChild(el("span", {
    class: `dm-badge ${server.transport === "streamable-http" ? "dm-http" : "dm-stdio"}`,
    text: server.transport === "streamable-http" ? "HTTP" : "stdio",
  }));
  header.appendChild(el("span", { class: "dm-badge", text: server.scope === "project" ? t("badgeScopeProject") : t("badgeScopeGlobal") }));
  const statusBadge = el("span", { class: `dm-badge dm-st-${server.status}`, text: tStatus(server.status) });
  header.appendChild(statusBadge);
  const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
  header.appendChild(el("span", { class: "dm-count", text: t("toolsCountPlain", { n: toolCount }) }));
  article.appendChild(header);

  article.appendChild(el("div", { class: "dm-endpoint", text: endpointOf(server) }));
  if (server.error !== undefined && server.error !== "") {
    article.appendChild(el("div", { class: "dm-err", text: server.error }));
  }

  if (toolCount > 0 && opts.tools) {
    const details = el("details", { class: "dm-tools", dataset: { dmServer: server.name } });
    if (opts.openTools?.has(server.name) === true) details.open = true;
    details.appendChild(el("summary", { text: t("toolsCount", { n: toolCount }) }));
    const list = el("ul");
    const disabledSet = new Set(Array.isArray(server.disabledTools) ? server.disabledTools : []);
    for (const tool of server.tools) {
      list.appendChild(el("li", {}, [toolCheckbox(server, tool, disabledSet.has(tool), state, actions)]));
    }
    details.appendChild(list);
    article.appendChild(details);
  } else if (toolCount > 0 && !opts.tools) {
    const details = el("details", { class: "dm-tools", dataset: { dmServer: server.name } });
    if (opts.openTools?.has(server.name) === true) details.open = true;
    details.appendChild(el("summary", { text: t("toolsCount", { n: toolCount }) }));
    const list = el("ul");
    for (const tool of server.tools) list.appendChild(el("li", { text: tool }));
    details.appendChild(list);
    article.appendChild(details);
  }

  const actionsEl = el("div", { class: "dm-actions" });
  const busy = server.status === "connecting" || server.status === "reconnecting";
  const scopeQuery = `&scope=${server.scope}`;
  // #412 复报：宿主 dsh web 重启后 projectRoot 丢失，connect/reconnect 路由的
  // maybeSession 需 cwd 才能恢复会话（否则 middleware connect(scope=project) 抛
  // "no active project session"）。带上当前会话 cwd，宿主 setSession 幂等短路，
  // 正常时零副作用。
  const cwdQuery = cwdQueryOf(state);
  if (server.status === "connected") {
    actionsEl.appendChild(actionButton(t("disconnect"), async () => {
      // C7：disconnect 同样带 cwd（#412 场景浮窗/面板操作自愈，与 connect 对齐）。
      await api(`${state.API.disconnect}?name=${encodeURIComponent(server.name)}${scopeQuery}${cwdQuery}`, { method: "POST" });
      await actions.refresh();
    }));
    actionsEl.appendChild(actionButton(t("reconnect"), async () => {
      await api(`${state.API.reconnect}?name=${encodeURIComponent(server.name)}${scopeQuery}${cwdQuery}`, { method: "POST" });
      await actions.refresh();
    }));
  } else if (server.status === "disabled") {
    actionsEl.appendChild(actionButton(t("enableAndConnect"), async () => {
      await api(`${state.API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      await api(`${state.API.connect}?name=${encodeURIComponent(server.name)}${scopeQuery}${cwdQuery}`, { method: "POST" });
      await actions.refresh();
    }, true));
  } else {
    actionsEl.appendChild(actionButton(t("connect"), async () => {
      await api(`${state.API.connect}?name=${encodeURIComponent(server.name)}${scopeQuery}${cwdQuery}`, { method: "POST" });
      await actions.refresh();
    }, true));
  }
  // 禁用开关：非 disabled 状态可一键禁用（宿主断开并注销工具）
  if (server.status !== "disabled") {
    actionsEl.appendChild(actionButton(t("disable"), async () => {
      // C7：disable 同样带 cwd（与 disconnect 对齐，#412 自愈）。
      await api(`${state.API.servers}?name=${encodeURIComponent(server.name)}${scopeQuery}${cwdQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (state.editingName === server.name) actions.resetForm();
      await actions.refresh();
    }));
  }
  actionsEl.appendChild(actionButton(t("edit"), () => actions.beginEdit(server)));
  actionsEl.appendChild(actionButton(t("delete"), async () => {
    if (!window.confirm(t("confirmDelete", { name: server.name }))) return;
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
  // C8：checkbox 操作后 actions.refresh 全量重建会丢 <details> 折叠态——渲染
  // 前收集当前展开的工具组（按 server 名），重建后恢复（连续禁用 N 个工具
  // 免反复展开）。
  const openTools = new Set<string>();
  for (const d of state.bodyEl.querySelectorAll("details.dm-tools")) {
    if (d.open && d.dataset.dmServer !== undefined) openTools.add(d.dataset.dmServer);
  }
  state.bodyEl.textContent = "";
  if (state.servers.length === 0) {
    state.bodyEl.appendChild(el("div", { class: "dm-status", text: t("serversEmpty") }));
    return;
  }
  const isAll = state.middlewareMode === "all";
  const toolsEnabled = (scope: string) => scope === "project" || isAll;
  for (const scope of ["project", "global"]) {
    const list = state.servers.filter((server: any) => server.scope === scope);
    if (list.length === 0) continue;
    const section = el("section", { class: "dm-group" });
    const title = el("h3");
    title.appendChild(document.createTextNode(scope === "project" ? t("groupProject") : t("groupGlobal")));
    title.appendChild(el("span", { class: "dm-count", text: `${list.length}` }));
    section.appendChild(title);
    // 各自内部再按状态分组（状态序：运行中 → 连接中 → 重连中 → 未连接 → 已停用 → 失败）。
    // C13 未知状态策略：与浮窗统一口径——未知状态按 stopped 投影、不丢卡
    // （修复前 filter(status===key) 会静默丢弃未知状态服务器）。
    const byStatus = new Map<string, any[]>();
    for (const group of STATUS_ORDER) byStatus.set(group.key, []);
    for (const server of list) {
      const bucket = byStatus.get(server.status);
      if (bucket !== undefined) bucket.push(server);
      else if (byStatus.has("stopped")) byStatus.get("stopped")!.push(server);
    }
    for (const group of STATUS_ORDER) {
      const bucket = byStatus.get(group.key) ?? [];
      if (bucket.length === 0) continue;
      const sub = el("div", { class: "dm-subgroup" });
      sub.appendChild(el("h4", { class: "dm-subgroup-title", text: t("statusGroupCount", { status: t(group.titleKey), n: bucket.length }) }));
      for (const server of [...bucket].sort((a: any, b: any) => a.name.localeCompare(b.name))) {
        sub.appendChild(renderServer(server, state, actions, { tools: toolsEnabled(scope), openTools }));
      }
      section.appendChild(sub);
    }
    if (scope === "global" && !isAll) {
      section.appendChild(el("div", { class: "dm-status", text: t("globalToolHint") }));
    }
    state.bodyEl.appendChild(section);
  }
}