/**
 * dsh-mcp-manager — 客户端「快速接入」页：表单与 mcpServers JSON 导入。
 *
 * 表单构建、读写、编辑、保存、重置；跨模块动作（refresh / switchTab）经
 * actions 注入，不直接引用 panel 模块，避免循环依赖。
 */

import { el, api } from "./dom.js";
import type { McpState, UiActions } from "./state.js";

/** 解析 "KEY: VALUE" / "KEY=VALUE" 多行文本为对象。 */
export function parseKV(text: any): Record<string, string> {
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

/** 当前表单选择的归属（project/global）。 */
export function formScopeValue(state: McpState): string {
  if (state.formScope !== undefined && (state.formScope.value === "project" || state.formScope.value === "global")) {
    return state.formScope.value;
  }
  return state.projectRoot !== undefined && state.projectRoot !== "" ? "project" : "global";
}

/** 当前会话 cwd（POST body 携带，宿主据此切换项目级 MCP）。 */
export function currentCwdBody(state: McpState): Record<string, string> {
  return typeof state.currentCwd === "string" && state.currentCwd !== "" ? { cwd: state.currentCwd } : {};
}

/** 表单数据 → 服务器配置对象（scope 由 formScope 决定）。 */
export function readForm(state: McpState): any {
  const server: any = {
    name: state.formName?.value.trim() ?? "",
    transport: state.formTransport?.value ?? "stdio",
    enabled: state.formEnabled?.checked ?? true,
  };
  if (server.transport === "stdio") {
    server.command = state.formCommand?.value.trim() ?? "";
    const args = (state.formArgs?.value ?? "").split(",").map((part: any) => part.trim()).filter(Boolean);
    if (args.length > 0) server.args = args;
    const env = parseKV(state.formEnv?.value ?? "");
    if (Object.keys(env).length > 0) server.env = env;
    if ((state.formCwd?.value ?? "").trim() !== "") server.cwd = state.formCwd?.value.trim();
  } else {
    server.url = state.formUrl?.value.trim() ?? "";
    const headers = parseKV(state.formHeaders?.value ?? "");
    if (Object.keys(headers).length > 0) server.headers = headers;
  }
  return server;
}

/** 重置表单为默认值。 */
export function resetForm(state: McpState): void {
  state.editingName = undefined;
  state.editing = undefined;
  if (state.formName === undefined) return;
  state.formName.value = "";
  state.formScope.value = state.projectRoot !== undefined && state.projectRoot !== "" ? "project" : "global";
  state.formTransport.value = "stdio";
  state.formCommand.value = "";
  state.formArgs.value = "";
  state.formEnv.value = "";
  state.formCwd.value = "";
  state.formUrl.value = "";
  state.formHeaders.value = "";
  state.formEnabled.checked = true;
  state.formTransport.dispatchEvent(new Event("change"));
  const title = document.getElementById("dm-form-title");
  if (title !== null) title.textContent = "添加服务器";
  const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
  if (cancel !== null) cancel.disabled = true;
}

/** 用服务器数据填充表单（编辑模式）。 */
export function fillForm(state: McpState, fill: any): void {
  resetForm(state);
  if (fill.name !== undefined) state.formName.value = fill.name;
  state.formTransport.value = fill.transport ?? "stdio";
  if (fill.command !== undefined) state.formCommand.value = fill.command;
  if (Array.isArray(fill.args)) state.formArgs.value = fill.args.join(", ");
  if (fill.env !== undefined) {
    state.formEnv.value = Object.entries(fill.env).map(([key, value]) => `${key}=${value}`).join("\n");
  }
  if (fill.cwd !== undefined) state.formCwd.value = fill.cwd;
  if (fill.url !== undefined) state.formUrl.value = fill.url;
  if (fill.headers !== undefined) {
    state.formHeaders.value = Object.entries(fill.headers).map(([key, value]) => `${key}: ${value}`).join("\n");
  }
  state.formTransport.dispatchEvent(new Event("change"));
}

/** 保存表单（新增或更新）。 */
export async function saveForm(state: McpState, actions: UiActions): Promise<void> {
  const server = readForm(state);
  try {
    const payload = { ...server, scope: formScopeValue(state), ...currentCwdBody(state) };
    if (state.editingName !== undefined) {
      await api(`${state.API.servers}?name=${encodeURIComponent(state.editingName)}&scope=${formScopeValue(state)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await api(state.API.servers, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    resetForm(state);
    await actions.refresh();
  } catch (error) {
    window.alert(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 进入编辑模式：填充表单，切换到快速接入 tab。 */
export function beginEdit(state: McpState, actions: UiActions, server: any): void {
  state.editingName = server.name;
  state.editing = server;
  actions.switchTab("quick");
  fillForm(state, server);
  if (state.formScope !== undefined && (server.scope === "project" || server.scope === "global")) {
    state.formScope.value = server.scope;
  }
  const title = document.getElementById("dm-form-title");
  if (title !== null) title.textContent = `编辑服务器：${server.name}`;
  const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
  if (cancel !== null) cancel.disabled = false;
}

/** 构建「快速接入」页面（表单 + JSON 导入）。 */
export function buildQuickAdd(state: McpState, actions: UiActions): any {
  const page = el("div");

  // 表单
  const form = el("section", { class: "dm-section" });
  form.appendChild(el("h3", { id: "dm-form-title", text: "添加服务器" }));
  state.formName = el("input", { id: "dm-f-name", placeholder: "context7", value: state.editing?.name ?? "" });
  state.formScope = el("select", { id: "dm-f-scope" });
  state.formScope.appendChild(el("option", { value: "project", text: "项目级（<项目>/.dsh/mcp.json，随会话切换）" }));
  state.formScope.appendChild(el("option", { value: "global", text: "全局（~/.dsh/dsh-mcp.json）" }));
  state.formScope.value = state.editing?.scope ?? (state.projectRoot !== undefined && state.projectRoot !== "" ? "project" : "global");
  state.formTransport = el("select", { id: "dm-f-transport" });
  state.formTransport.appendChild(el("option", { value: "stdio", text: "stdio（本地子进程）" }));
  state.formTransport.appendChild(el("option", { value: "streamable-http", text: "streamable-http（远程）" }));
  state.formCommand = el("input", { id: "dm-f-command", placeholder: "npx" });
  state.formArgs = el("input", { id: "dm-f-args", placeholder: "-y, @context7/mcp-server" });
  state.formEnv = el("textarea", { id: "dm-f-env", placeholder: "每行 KEY=VALUE，如\nCONTEXT7_API_KEY=${CONTEXT7_API_KEY}" });
  state.formCwd = el("input", { id: "dm-f-cwd", placeholder: "可选工作目录" });
  state.formUrl = el("input", { id: "dm-f-url", placeholder: "https://mcp.context7.com/mcp" });
  state.formHeaders = el("textarea", { id: "dm-f-headers", placeholder: '每行 KEY: VALUE，支持 ${ENV} 引用，如\nAuthorization: Bearer ${CONTEXT7_API_KEY}' });
  state.formEnabled = el("input", { id: "dm-f-enabled", type: "checkbox", checked: true });

  const grid = el("div", { class: "dm-form" });
  grid.appendChild(el("div", { class: "dm-field", children: [el("label", { text: "服务器名称（唯一，作为 mcp__<name>__ 前缀）" }), state.formName] }));
  grid.appendChild(el("div", { class: "dm-field", children: [el("label", { text: "归属" }), state.formScope] }));
  grid.appendChild(el("div", { class: "dm-field", children: [el("label", { text: "传输类型" }), state.formTransport] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "命令（stdio）" }), state.formCommand] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "参数（逗号分隔）" }), state.formArgs] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "环境变量（每行 KEY=VALUE，支持 ${ENV} 引用，值为空则继承父环境）" }), state.formEnv] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "工作目录（可选）" }), state.formCwd] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "URL（streamable-http）" }), state.formUrl] }));
  grid.appendChild(el("div", { class: "dm-field dm-full", children: [el("label", { text: "请求头（每行 KEY: VALUE，支持 ${ENV} 引用）" }), state.formHeaders] }));
  grid.appendChild(el("div", { class: "dm-check dm-field dm-full", children: [state.formEnabled, el("label", { text: "启用（保存后立即连接）" })] }));
  const actionsEl = el("div", { class: "dm-form-actions" });
  const save = el("button", { class: "dm-primary", text: "保存", onclick: () => void saveForm(state, actions) });
  const cancel = el("button", { text: "取消编辑", onclick: () => resetForm(state), disabled: true });
  cancel.dataset.dmCancel = "";
  actionsEl.appendChild(save);
  actionsEl.appendChild(cancel);
  grid.appendChild(actionsEl);
  form.appendChild(grid);
  page.appendChild(form);

  // 传输类型切换显示/隐藏
  const syncTransport = () => {
    const isHttp = state.formTransport.value === "streamable-http";
    for (const field of [state.formCommand, state.formArgs, state.formEnv, state.formCwd]) {
      (field as any).closest(".dm-field").style.display = isHttp ? "none" : "flex";
    }
    for (const field of [state.formUrl, state.formHeaders]) {
      (field as any).closest(".dm-field").style.display = isHttp ? "flex" : "none";
    }
  };
  state.formTransport.addEventListener("change", syncTransport);

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
        const payload = await api(state.API.importJson, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: textarea.value, scope: formScopeValue(state), ...currentCwdBody(state) }),
        });
        result.textContent = `已导入：${payload.imported.join(", ") || "（无）"}`;
        if (payload.skipped.length > 0) {
          result.appendChild(el("div", { class: "dm-skip", text: `跳过（已存在）：${payload.skipped.join(", ")}` }));
        }
        await actions.refresh();
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