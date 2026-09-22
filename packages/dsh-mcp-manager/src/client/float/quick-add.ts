/**
 * dsh-mcp-manager — 客户端「快速接入」页：表单与 mcpServers JSON 导入。
 *
 * 表单构建、读写、编辑、保存、重置；跨模块动作（refresh / switchTab）经
 * actions 注入，不直接引用 panel 模块，避免循环依赖。
 */

import { el } from "../core/dom.ts";
import { api } from "../core/api.ts";
import { t } from "../../../../../shared/client/i18n.js";
import type { McpState, UiActions } from "../core/state.ts";

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

/**
 * #770-A3 只读投影回写 guard：投影值永不进入写路径。
 * - env/headers 在投影中整体省略（无占位符），表单空白即省略、宿主沿用既有；
 * - url 投影含 B8 脱敏占位符 "[REDACTED]"（或其 URL 序列化形态）时视为未改动，
 *   保存时省略该字段（PATCH 沿用既有；迁移 POST 缺 url 则中止并提示重填）。
 */
export function isProjectionValue(value: unknown): boolean {
  return (
    typeof value === "string" && (value.includes("[REDACTED]") || value.includes("%5BREDACTED%5D"))
  );
}

/** 当前表单选择的归属（project/global）。 */
export function formScopeValue(state: McpState): string {
  if (
    state.formScope !== undefined &&
    (state.formScope.value === "project" || state.formScope.value === "global")
  ) {
    return state.formScope.value;
  }
  return state.projectRoot !== undefined && state.projectRoot !== "" ? "project" : "global";
}

/** 当前会话 cwd（POST body 携带，宿主据此切换项目级 MCP）。 */
export function currentCwdBody(state: McpState): Record<string, string> {
  return typeof state.currentCwd === "string" && state.currentCwd !== ""
    ? { cwd: state.currentCwd }
    : {};
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
    const args = (state.formArgs?.value ?? "")
      .split(",")
      .map((part: any) => part.trim())
      .filter(Boolean);
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
  state.formScope!.value =
    state.projectRoot !== undefined && state.projectRoot !== "" ? "project" : "global";
  state.formTransport!.value = "stdio";
  state.formCommand!.value = "";
  state.formArgs!.value = "";
  state.formEnv!.value = "";
  state.formCwd!.value = "";
  state.formUrl!.value = "";
  state.formHeaders!.value = "";
  state.formEnabled!.checked = true;
  state.formTransport!.dispatchEvent(new Event("change"));
  const title = document.getElementById("dm-form-title");
  if (title !== null) title.textContent = t("addServer");
  const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
  if (cancel !== null) cancel.disabled = true;
}

/** 用服务器数据填充表单（编辑模式）。 */
export function fillForm(state: McpState, fill: any): void {
  // C1 链路修复：不再调 resetForm()——resetForm 会清空 editingName，导致
  // beginEdit 设置的编辑态丢失、saveForm 恒走 POST → 宿主抛 already exists
  // （编辑保存整体坏死）。表单元素由 buildQuickAdd 按 state.editing 构建，
  // 此处仅覆盖字段值，编辑态（editingName）保持 beginEdit 设定。
  if (fill.name !== undefined) state.formName!.value = fill.name;
  state.formTransport!.value = fill.transport ?? "stdio";
  if (fill.command !== undefined) state.formCommand!.value = fill.command;
  if (Array.isArray(fill.args)) state.formArgs!.value = fill.args.join(", ");
  // #770-A3：投影省略 env/headers（缺键）时表单清零——残留旧值会被 readForm
  // 原样读回并 PATCH 落盘（占位符同理）；缺键在宿主即「沿用既有」。
  if (fill.env !== undefined) {
    state.formEnv!.value = Object.entries(fill.env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  } else if (state.formEnv !== undefined) {
    state.formEnv.value = "";
  }
  if (fill.cwd !== undefined) state.formCwd!.value = fill.cwd;
  // url 投影为 B8 脱敏展示值（含占位符时仅展示用，保存时由 saveForm 省略，见上）。
  if (fill.url !== undefined) state.formUrl!.value = fill.url;
  if (fill.headers !== undefined) {
    state.formHeaders!.value = Object.entries(fill.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
  } else if (state.formHeaders !== undefined) {
    state.formHeaders.value = "";
  }
  // C1 enabled 回填：resetForm 强制 checked=true，编辑 enabled:false 的服务器
  // 必须回填，否则保存时被静默重新启用并自动连接（宿主 update 分支）。
  if (state.formEnabled !== undefined) state.formEnabled.checked = fill.enabled !== false;
  state.formTransport!.dispatchEvent(new Event("change"));
}

/** 保存表单（新增或更新）。 */
export async function saveForm(state: McpState, actions: UiActions): Promise<void> {
  const server = readForm(state);
  try {
    const payload = { ...server, scope: formScopeValue(state), ...currentCwdBody(state) } as Record<
      string,
      unknown
    >;
    // #770-A3：投影 URL（含占位符）永不进入写路径——PATCH 省略即沿用既有；
    // 迁移 POST 无既有可保，含占位符即中止并提示重填真值。
    if (typeof payload.url === "string" && isProjectionValue(payload.url)) {
      const editingForGuard = state.editingName !== undefined;
      const serverName = String((server as { name?: unknown }).name ?? "");
      const migratedForGuard =
        editingForGuard &&
        (state.editingName !== serverName ||
          (state.editing?.scope !== undefined && state.editing.scope !== payload.scope));
      if (migratedForGuard || !editingForGuard) {
        window.alert(t("saveFail", { msg: "URL 含脱敏占位符，请重填真实 URL 后再保存" }));
        return;
      }
      delete payload.url;
    }
    // env/headers 占位符同理（投影本不下发占位符，此处防手工粘贴/直调污染写路径）。
    for (const key of ["env", "headers"] as const) {
      const table = (payload as Record<string, unknown>)[key];
      if (typeof table === "object" && table !== null && !Array.isArray(table)) {
        const kept = Object.entries(table as Record<string, unknown>).filter(
          ([, value]) => !isProjectionValue(value),
        );
        if (kept.length === 0) delete (payload as Record<string, unknown>)[key];
        else (payload as Record<string, unknown>)[key] = Object.fromEntries(kept);
      }
    }
    const editing = state.editingName !== undefined;
    // C11 迁移式保存：宿主 PATCH 按 (scope,name) 定位且强制沿用定位名——
    // 编辑改名/改归属会 404 not found 无引导。先 POST 新条目再 DELETE 旧条目，
    // 任何失败即中止（保留原条目，alert 提示），避免半迁移脏数据。
    const migrated =
      editing &&
      (state.editingName !== server.name ||
        (state.editing?.scope !== undefined && state.editing.scope !== payload.scope));
    if (migrated) {
      // #770-L2：改名/改归属迁移丢 stdio 秘密——POST 新条目无既有可沿用，
      // 省略的 env/headers 即永久丢失。M7 大声失败：原条目有秘密时无条件中止
      // （表单即便已填值也不放行：payload 完整值放行本次不做，保持 fail-closed）。
      // 文案须指引手动路径（新建同名条目填真值后删旧条目），不得承诺“重填后保存”
      // ——无条件拦截下该后续路径不存在，旧文案误导。
      if ((state.editing as { hasSecrets?: unknown } | undefined)?.hasSecrets === true) {
        window.alert(
          t("saveFail", {
            msg: "改名/改归属迁移不会带入原有凭据，请新建同名条目并填写真实凭据，确认可用后再删除旧条目",
          }),
        );
        return;
      }
      await api(state.API.servers, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await api(
        `${state.API.servers}?name=${encodeURIComponent(state.editingName!)}&scope=${state.editing!.scope}`,
        { method: "DELETE" },
      );
    } else if (editing) {
      await api(
        `${state.API.servers}?name=${encodeURIComponent(state.editingName!)}&scope=${formScopeValue(state)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
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
    window.alert(t("saveFail", { msg: error instanceof Error ? error.message : String(error) }));
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
  if (title !== null) title.textContent = t("editServer", { name: server.name });
  const cancel = document.querySelector<HTMLButtonElement>("[data-dm-cancel]");
  if (cancel !== null) cancel.disabled = false;
}

/** 构建「快速接入」页面（表单 + JSON 导入）。 */
export function buildQuickAdd(state: McpState, actions: UiActions): any {
  const page = el("div");

  // 表单
  const form = el("section", { class: "dm-section" });
  form.appendChild(el("h3", { id: "dm-form-title", text: t("addServer") }));
  state.formName = el("input", {
    id: "dm-f-name",
    placeholder: "context7",
    value: state.editing?.name ?? "",
  });
  state.formScope = el("select", { id: "dm-f-scope" });
  state.formScope!.appendChild(el("option", { value: "project", text: t("scopeProjectOpt") }));
  state.formScope!.appendChild(el("option", { value: "global", text: t("scopeGlobalOpt") }));
  state.formScope!.value =
    state.editing?.scope ??
    (state.projectRoot !== undefined && state.projectRoot !== "" ? "project" : "global");
  state.formTransport = el("select", { id: "dm-f-transport" });
  state.formTransport!.appendChild(el("option", { value: "stdio", text: t("transportStdioOpt") }));
  state.formTransport!.appendChild(
    el("option", { value: "streamable-http", text: t("transportHttpOpt") }),
  );
  state.formCommand = el("input", { id: "dm-f-command", placeholder: "npx" });
  state.formArgs = el("input", { id: "dm-f-args", placeholder: "-y, @context7/mcp-server" });
  state.formEnv = el("textarea", { id: "dm-f-env", placeholder: t("envPlaceholder") });
  state.formCwd = el("input", { id: "dm-f-cwd", placeholder: t("cwdPlaceholder") });
  state.formUrl = el("input", { id: "dm-f-url", placeholder: "https://mcp.context7.com/mcp" });
  state.formHeaders = el("textarea", { id: "dm-f-headers", placeholder: t("headersPlaceholder") });
  state.formEnabled = el("input", { id: "dm-f-enabled", type: "checkbox", checked: true });

  const grid = el("div", { class: "dm-form" });
  grid.appendChild(
    el("div", {
      class: "dm-field",
      children: [el("label", { text: t("nameLabel") }), state.formName],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field",
      children: [el("label", { text: t("ownershipLabel") }), state.formScope],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field",
      children: [el("label", { text: t("transportLabel") }), state.formTransport],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field dm-full",
      children: [el("label", { text: t("commandLabel") }), state.formCommand],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field dm-full",
      children: [el("label", { text: t("argsLabel") }), state.formArgs],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field dm-full",
      children: [el("label", { text: t("envLabel") }), state.formEnv],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field dm-full",
      children: [el("label", { text: t("cwdLabel") }), state.formCwd],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field dm-full",
      children: [el("label", { text: t("urlLabel") }), state.formUrl],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-field dm-full",
      children: [el("label", { text: t("headersLabel") }), state.formHeaders],
    }),
  );
  grid.appendChild(
    el("div", {
      class: "dm-check dm-field dm-full",
      children: [state.formEnabled, el("label", { text: t("enabledLabel") })],
    }),
  );
  const actionsEl = el("div", { class: "dm-form-actions" });
  const save = el("button", {
    class: "dm-primary",
    text: t("save"),
    onclick: () => void saveForm(state, actions),
  });
  const cancel = el("button", {
    text: t("cancelEdit"),
    onclick: () => resetForm(state),
    disabled: true,
  });
  cancel.dataset.dmCancel = "";
  actionsEl.appendChild(save);
  actionsEl.appendChild(cancel);
  grid.appendChild(actionsEl);
  form.appendChild(grid);
  page.appendChild(form);

  // 传输类型切换显示/隐藏
  const syncTransport = () => {
    const isHttp = state.formTransport!.value === "streamable-http";
    for (const field of [state.formCommand, state.formArgs, state.formEnv, state.formCwd]) {
      (field!.closest(".dm-field") as HTMLElement).style.display = isHttp ? "none" : "flex";
    }
    for (const field of [state.formUrl, state.formHeaders]) {
      (field!.closest(".dm-field") as HTMLElement).style.display = isHttp ? "flex" : "none";
    }
  };
  state.formTransport!.addEventListener("change", syncTransport);

  // 粘贴 JSON 导入
  const paste = el("section", { class: "dm-section" });
  paste.appendChild(el("h3", { text: t("pasteTitle") }));
  const pasteBox = el("div", { class: "dm-paste-box" });
  const textarea = el("textarea", {
    class: "dm-full",
    placeholder:
      '{"my-server":{"command":"npx","args":["-y","pkg"],"env":{"KEY":"value"}},"remote":{"url":"https://...","headers":{}}}',
    style:
      "width:100%;min-height:90px;border:1px solid #d7dae0;border-radius:6px;padding:6px 8px;font-size:12px;font-family:ui-monospace,Consolas,monospace;box-sizing:border-box",
  });
  pasteBox.appendChild(textarea);
  pasteBox.appendChild(
    el("div", {
      class: "dm-actions",
      children: [
        el("button", {
          class: "dm-primary",
          text: t("importJson"),
          onclick: async () => {
            const result = pasteBox.querySelector(".dm-result");
            try {
              const payload = await api(state.API.importJson, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  json: textarea.value,
                  scope: formScopeValue(state),
                  ...currentCwdBody(state),
                }),
              });
              result.textContent = t("importedOk", {
                names: payload.imported.join(", ") || t("importedNone"),
              });
              if (payload.skipped.length > 0) {
                result.appendChild(
                  el("div", {
                    class: "dm-skip",
                    text: t("importSkipped", { names: payload.skipped.join(", ") }),
                  }),
                );
              }
              await actions.refresh();
            } catch (error) {
              result.textContent = t("importFail", {
                msg: error instanceof Error ? error.message : String(error),
              });
            }
          },
        }),
      ],
    }),
  );
  pasteBox.appendChild(el("div", { class: "dm-result" }));
  paste.appendChild(pasteBox);
  page.appendChild(paste);

  return page;
}
