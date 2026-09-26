/**
 * dsh-mcp-manager — 客户端「服务器列表页」渲染。
 *
 * 按状态分级展示服务器卡片（端点 / 错误 / 工具列表 / 操作按钮）。
 * 跨模块动作（refresh / resetForm / beginEdit）经 actions 注入，不直接引用
 * panel/quick-add 模块，避免循环依赖。
 */

import { el, pangu } from "../core/dom.ts";
import { api, toolDisableServerKey, cwdQueryOf } from "../core/api.ts";
import { STATUS_ORDER } from "../core/constants.ts";
import { tStatus } from "../core/i18n.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { McpServerListEntry, McpState, UiActions } from "../core/state.ts";

/** 服务器端点摘要：streamable-http 显示 URL，stdio 显示 command + args。 */
export function endpointOf(server: McpServerListEntry): string {
  if (server.transport === "streamable-http") return server.url ?? "";
  const args =
    Array.isArray(server.args) && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
  return `${server.command ?? ""}${args}`;
}

/** 操作按钮（统一失败提示）。 */
export function actionButton(
  label: string,
  onClick: () => void | Promise<void>,
  primary = false,
  danger = false,
): HTMLElement {
  return el("button", {
    class: `${primary ? "dm-primary" : ""} ${danger ? "dm-danger" : ""}`.trim(),
    text: label,
    onclick: async () => {
      try {
        await onClick();
      } catch (error) {
        window.alert(
          t("actionFail", { msg: error instanceof Error ? error.message : String(error) }),
        );
      }
    },
  });
}

/** 工具级禁用 checkbox（PATCH /api/dsh-mcp/tool-disable；#362 交互拍板 2b）。 */
function toolCheckbox(
  server: McpServerListEntry,
  tool: string,
  disabled: boolean,
  state: McpState,
  actions: UiActions,
): HTMLElement {
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
    void api<unknown>(state.API.toolDisable, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: serverKey,
        tool,
        disabled: input.checked,
      }),
    })
      .then(() => actions.refresh())
      .catch((error: unknown) => {
        input.checked = !input.checked;
        console.warn("[dsh-mcp-manager] tool-disable failed:", error);
      });
  });
  label.appendChild(input);
  label.appendChild(document.createTextNode(tool));
  return label;
}

/** 工具折叠组：interactive 出 checkbox（可逐个禁用），否则出纯文本工具名。 */
export function serverToolsDetails(
  server: McpServerListEntry,
  toolCount: number,
  opts: { tools: boolean; openTools?: Set<string> },
  state: McpState,
  actions: UiActions,
  interactive: boolean,
): HTMLElement {
  const details = el("details", { class: "dm-tools", dataset: { dmServer: server.name } });
  if (opts.openTools?.has(server.name) === true) details.open = true;
  details.appendChild(el("summary", { text: t("toolsCount", { n: toolCount }) }));
  const list = el("ul");
  const tools = Array.isArray(server.tools) ? server.tools : [];
  if (interactive) {
    const disabledSet = new Set(Array.isArray(server.disabledTools) ? server.disabledTools : []);
    for (const tool of tools) {
      list.appendChild(
        el("li", {}, [toolCheckbox(server, tool, disabledSet.has(tool), state, actions)]),
      );
    }
  } else {
    for (const tool of tools) list.appendChild(el("li", { text: tool }));
  }
  details.appendChild(list);
  return details;
}

/** 一个操作按钮的规格（label / 主按钮样式 / 执行体）。 */
interface ActionSpec {
  label: string;
  primary: boolean;
  danger?: boolean;
  run: () => void | Promise<void>;
}

/** JSON 写请求 init（PATCH enabled 用；形态与 quick-add 同款）。 */
export function jsonPatchInit(enabled: boolean): {
  method: "PATCH";
  headers: Record<string, string>;
  body: string;
} {
  return {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  };
}

/** POST 后刷新（连接/断开/重连三个动作的执行体同式）。 */
export function postThenRefresh(
  state: McpState,
  actions: UiActions,
  url: string,
): () => Promise<void> {
  return async () => {
    await api<unknown>(url, { method: "POST" });
    await actions.refresh();
  };
}

/** 状态动作：connected → 断开 + 重连；disabled → 启用并连接；其余 → 连接。 */
export function statusActions(
  server: McpServerListEntry,
  state: McpState,
  actions: UiActions,
  scopeQuery: string,
  cwdQuery: string,
): ActionSpec[] {
  const name = encodeURIComponent(server.name);
  if (server.status === "connected") {
    return [
      {
        label: t("disconnect"),
        primary: false,
        run: postThenRefresh(
          state,
          actions,
          `${state.API.disconnect}?name=${name}${scopeQuery}${cwdQuery}`,
        ),
      },
      {
        label: t("reconnect"),
        primary: false,
        run: postThenRefresh(
          state,
          actions,
          `${state.API.reconnect}?name=${name}${scopeQuery}${cwdQuery}`,
        ),
      },
    ];
  }
  if (server.status === "disabled") {
    return [
      {
        label: t("enableAndConnect"),
        primary: true,
        run: async () => {
          await api<unknown>(`${state.API.servers}?name=${name}${scopeQuery}`, jsonPatchInit(true));
          await api<unknown>(`${state.API.connect}?name=${name}${scopeQuery}${cwdQuery}`, {
            method: "POST",
          });
          await actions.refresh();
        },
      },
    ];
  }
  return [
    {
      label: t("connect"),
      primary: true,
      run: postThenRefresh(
        state,
        actions,
        `${state.API.connect}?name=${name}${scopeQuery}${cwdQuery}`,
      ),
    },
  ];
}

/** 禁用动作（非 disabled 行才有）：PATCH 后若正在编辑该条目则重置表单。 */
export function disableAction(
  server: McpServerListEntry,
  state: McpState,
  actions: UiActions,
  scopeQuery: string,
  cwdQuery: string,
): ActionSpec {
  const name = encodeURIComponent(server.name);
  return {
    label: t("disable"),
    primary: false,
    run: async () => {
      // C7：disable 带 cwd（与 disconnect 对齐，#412 会话自愈）。
      await api<unknown>(
        `${state.API.servers}?name=${name}${scopeQuery}${cwdQuery}`,
        jsonPatchInit(false),
      );
      if (state.editingName === server.name) actions.resetForm();
      await actions.refresh();
    },
  };
}

/** 删除动作：先确认（未确认即中止），DELETE 后若正在编辑该条目则重置表单。 */
export function deleteAction(
  server: McpServerListEntry,
  state: McpState,
  actions: UiActions,
  scopeQuery: string,
): ActionSpec {
  const name = encodeURIComponent(server.name);
  return {
    label: t("delete"),
    primary: false,
    danger: true,
    run: async () => {
      if (!window.confirm(t("confirmDelete", { name: server.name }))) return;
      await api<unknown>(`${state.API.servers}?name=${name}${scopeQuery}`, { method: "DELETE" });
      if (state.editingName === server.name) actions.resetForm();
      await actions.refresh();
    },
  };
}

/** 需要置顶提醒的服务器（失败 + 重连中）。 */
export function needsAttention(server: McpServerListEntry): boolean {
  return server.status === "failed" || server.status === "reconnecting";
}

/** 按状态分桶（桶序 = STATUS_ORDER；未知状态归 stopped 桶，不丢行）。 */
export function bucketByStatus(list: McpServerListEntry[]): Map<string, McpServerListEntry[]> {
  const byStatus = new Map<string, McpServerListEntry[]>();
  for (const group of STATUS_ORDER) byStatus.set(group.key, []);
  for (const server of list) {
    const bucket = byStatus.get(server.status) ?? byStatus.get("stopped");
    if (bucket !== undefined) bucket.push(server);
  }
  return byStatus;
}
/** 卡片根类名：失败 / 重连中加 --fail 修饰。 */
export function serverCardClass(server: McpServerListEntry): string {
  return needsAttention(server) ? "dm-server dm-server--fail" : "dm-server";
}

/** 卡片头部：名称 / transport 徽标 / scope 徽标 / 状态徽标 / 工具计数。 */
export function serverCardHeader(server: McpServerListEntry, toolCount: number): HTMLElement {
  const isHttp = server.transport === "streamable-http";
  const header = el("header");
  header.appendChild(el("span", { class: "dm-name", text: server.name }));
  header.appendChild(
    el("span", {
      class: `dm-badge ${isHttp ? "dm-http" : "dm-stdio"}`,
      text: isHttp ? "HTTP" : "stdio",
    }),
  );
  header.appendChild(
    el("span", {
      class: "dm-badge",
      text: server.scope === "project" ? t("badgeScopeProject") : t("badgeScopeGlobal"),
    }),
  );
  header.appendChild(
    el("span", { class: `dm-badge dm-st-${server.status}`, text: tStatus(server.status) }),
  );
  header.appendChild(
    el("span", { class: "dm-count", text: t("toolsCountPlain", { n: toolCount }) }),
  );
  return header;
}

/** 渲染单台服务器卡片。 */
export function renderServer(
  server: McpServerListEntry,
  state: McpState,
  actions: UiActions,
  opts: { tools: boolean; openTools?: Set<string> } = { tools: true },
): HTMLElement {
  const article = el("article", { class: serverCardClass(server) });
  const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
  article.appendChild(serverCardHeader(server, toolCount));

  article.appendChild(el("div", { class: "dm-endpoint", text: endpointOf(server) }));
  if (server.error !== undefined && server.error !== "") {
    article.appendChild(el("div", { class: "dm-err", text: server.error }));
  }

  if (toolCount > 0) {
    article.appendChild(serverToolsDetails(server, toolCount, opts, state, actions, opts.tools));
  }

  const actionsEl = el("div", { class: "dm-actions" });
  const busy = server.status === "connecting" || server.status === "reconnecting";
  const scopeQuery = `&scope=${server.scope}`;
  // #412 复报：宿主 dsh web 重启后 projectRoot 丢失，connect/reconnect 路由的
  // maybeSession 需 cwd 才能恢复会话（否则 connect(scope=project) 抛
  // "no active project session"）。带上当前会话 cwd，宿主 setSession 幂等短路，
  // 正常时零副作用。
  const cwdQuery = cwdQueryOf(state);
  // C7：disconnect / connect / disable 同样带 cwd（#412 场景浮窗/面板操作自愈）。
  for (const spec of statusActions(server, state, actions, scopeQuery, cwdQuery)) {
    actionsEl.appendChild(actionButton(spec.label, spec.run, spec.primary));
  }
  // 禁用开关：非 disabled 状态可一键禁用（宿主断开并注销工具）
  if (server.status !== "disabled") {
    const disable = disableAction(server, state, actions, scopeQuery, cwdQuery);
    actionsEl.appendChild(actionButton(disable.label, disable.run, disable.primary));
  }
  actionsEl.appendChild(actionButton(t("edit"), () => actions.beginEdit(server)));
  const remove = deleteAction(server, state, actions, scopeQuery);
  actionsEl.appendChild(
    actionButton(remove.label, remove.run, remove.primary, remove.danger === true),
  );
  (actionsEl.children[actionsEl.children.length - 1] as HTMLButtonElement).disabled = busy;
  article.appendChild(actionsEl);
  return article;
}

/** 渲染服务器列表页（#362 交互拍板 1a：项目级 / 全局级两大分组，各自内部再按状态）。
 * 单池（#767）后两大分组的服务器都经中间层，工具 checkbox 一律可用。 */
export function renderServers(state: McpState, actions: UiActions): void {
  if (state.bodyEl === undefined) return;
  // C8：checkbox 操作后 actions.refresh 全量重建会丢 <details> 折叠态——渲染
  // 前收集当前展开的工具组（按 server 名），重建后恢复（连续禁用 N 个工具
  // 免反复展开）。
  const openTools = new Set<string>();
  for (const d of state.bodyEl.querySelectorAll<HTMLDetailsElement>("details.dm-tools")) {
    if (d.open && d.dataset.dmServer !== undefined) openTools.add(d.dataset.dmServer);
  }
  state.bodyEl.textContent = "";
  if (state.servers.length === 0) {
    state.bodyEl.appendChild(
      el("div", { class: "dm-status", children: [document.createTextNode(t("serversEmpty"))] }),
    );
    return;
  }
  // 失败优先：需关注组置顶（跨 scope），其余再按 project/global × 状态。
  const attention = state.servers.filter(needsAttention);
  const rest = state.servers.filter((server: McpServerListEntry) => !needsAttention(server));
  const appendGroup = (title: string, list: McpServerListEntry[], alert: boolean): void => {
    if (list.length === 0) return;
    const section = el("section", { class: "dm-group" });
    // class 键省略（勿传 undefined，否则 className="undefined"）
    const titleEl = alert ? el("h3", { class: "dm-group-alert" }) : el("h3");
    titleEl.appendChild(document.createTextNode(title));
    section.appendChild(titleEl);
    const byStatus = bucketByStatus(list);
    for (const group of STATUS_ORDER) {
      const bucket = byStatus.get(group.key) ?? [];
      if (bucket.length === 0) continue;
      const sub = el("div", { class: "dm-subgroup" });
      sub.appendChild(
        el("h4", {
          class: "dm-subgroup-title",
          text: pangu(t("statusGroupCount", { status: t(group.titleKey), n: bucket.length })),
        }),
      );
      for (const server of [...bucket].sort((a: McpServerListEntry, b: McpServerListEntry) =>
        a.name.localeCompare(b.name),
      )) {
        sub.appendChild(renderServer(server, state, actions, { tools: true, openTools }));
      }
      section.appendChild(sub);
    }
    state.bodyEl!.appendChild(section);
  };
  appendGroup(t("groupAttention", { n: attention.length }), attention, true);
  for (const scope of ["project", "global"]) {
    const list = rest.filter((server: McpServerListEntry) => server.scope === scope);
    if (list.length === 0) continue;
    // 标题自带数量，不再额外挂 dm-count（避免双计数）；字面量已带空格，
    // 不经 pangu（计数拼装与盘古分层，避免语义错层）。
    const label = scope === "project" ? t("groupProject") : t("groupGlobal");
    appendGroup(`${label} (${list.length})`, list, false);
  }
}
