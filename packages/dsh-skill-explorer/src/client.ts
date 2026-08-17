// 客户端 bundle 注册契约：web shell 的 client-modules 要求脚本执行时通过
// window.__ModuleLoader__.load 注册自身 factory（id = 包名），factory 返回
// module.exports（导出 apply / inject）。缺少该注册会让整个插件条目
// （含宿主端）在加载器层面失败。
// ---- 浏览器端全局声明（dsh web 运行时提供）----
declare var module: { exports: Record<string, any> };
declare var __DSH_PLUGIN_ID__: string; // 构建注入：bundle-host 以 --define 注入完整 npm 包名（load id 契约 = 包名）
interface Window {
  __ModuleLoader__: { load(entry: { id: string; factory: (require: any) => unknown }): void };
}

(function () {
  "use strict";

(window as any).__ModuleLoader__.load({
	id: __DSH_PLUGIN_ID__,
	factory: function (require: any) {
		var module: { exports: Record<string, any> } = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
/**
 * dsh-skill-explorer — 浏览器端。运行在 dsh web GUI 中，纯 DOM 实现
 * （无 React、无构建工具）：侧边栏注入一个"技能中心"入口按钮，点击
 * 打开全屏面板，fetch /api/dsh-skill-explorer/list 并按来源分级展示
 * 已加载的全部 skill；另含创建（表单）与启用/禁用、删除操作。
 *
 * 失败策略与 dsh-ssh 一致：DOM 挂载问题只 warn 不抛——外部插件绝不能让
 * GUI 启动失败。
 */

/** 只读数据路由（与 host 端 ROUTE 一致）。 */
const ROUTE = "/api/dsh-skill-explorer/list";

/** 启用/禁用路由（与 host 端 SET_ENABLED_ROUTE 一致）。 */
const SET_ENABLED_ROUTE = "/api/dsh-skill-explorer/set-enabled";

/** 创建/删除路由（与 host 端一致）。 */
const CREATE_ROUTE = "/api/dsh-skill-explorer/create";
const DELETE_ROUTE = "/api/dsh-skill-explorer/delete";

/** 侧边栏入口图标：技能/书本字形（16px nav-icon 风格，与 shell 一致）。 */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.2C6.6 2 4.5 2 3 2v10.5c1.5 0 3.6 0 5 1.3 1.4-1.3 3.5-1.3 5-1.3V2c-1.5 0-3.6 0-5 1.2z"/><path d="M8 3.2v10.6"/></svg>';

/** 面板样式（一次性注入 <style>，dse- 前缀避免与 shell 样式冲突；颜色全部用皮肤变量 --dsw-alias-* 适配亮/暗主题，带浅色回退）。 */
const STYLE = `
.dse-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(8,10,16,.45));display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.dse-overlay[hidden]{display:none !important}
.dse-card{width:min(780px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden}
.dse-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dse-head h2{margin:0;font-size:15px;font-weight:600}
.dse-head .dse-cwd{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dse-head button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.dse-head button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5)}
.dse-body{padding:12px 16px;overflow:auto}
.dse-tabs{display:flex;gap:4px;padding:8px 16px 0;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dse-tab{border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-bottom:none;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f9c);border-radius:8px 8px 0 0;padding:6px 14px;font-size:12px;cursor:pointer}
.dse-tab.dse-active{background:var(--dsw-alias-bg-base,#fdfdfd);color:var(--dsw-alias-label-primary,#1c1e26);font-weight:600}
.dse-form{display:flex;flex-direction:column;gap:8px;max-width:640px}
.dse-form label{font-size:12px;color:var(--dsw-alias-label-secondary,#5f6672)}
.dse-form input,.dse-form textarea,.dse-form select{background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#1c1e26);border:1px solid var(--dsw-alias-border-l1,#d7dae0);border-radius:6px;padding:6px 8px;font-size:12px}
.dse-form textarea{min-height:120px;resize:vertical;font-family:ui-monospace,monospace}
.dse-form button{border:1px solid var(--dsw-alias-border-l1,#d7dae0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#3a3f4b);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;align-self:flex-start}
.dse-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#a0a5b1);line-height:1.7;margin-top:10px}
.dse-status{padding:18px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;text-align:center}
.dse-group{margin-bottom:18px}
.dse-group>h3{margin:0 0 2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#2f3542)}
.dse-group>.dse-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c);margin:0 0 8px}
.dse-count{font-weight:400;color:var(--dsw-alias-label-secondary,#8a8f9c);margin-left:6px}
.dse-skill{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--dsw-alias-bg-base,#fff)}
.dse-skill header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dse-skill header .dse-name{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,#111827);font-family:ui-monospace,Consolas,monospace}
.dse-badge{font-size:10px;padding:1px 6px;border-radius:99px;background:var(--dsw-alias-state-business-secondary,#eef2ff);color:var(--dsw-alias-state-business-primary,#4353a3);border:1px solid var(--dsw-alias-state-business-tertiary,#dde3f8)}
.dse-badge.dse-invokable{background:var(--dsw-alias-state-success-secondary,#ecfdf5);color:var(--dsw-alias-state-success-primary,#0f7a50);border-color:var(--dsw-alias-state-success-tertiary,#c9f0dd)}
.dse-switch{display:inline-flex;align-items:center;background:none;border:none;padding:2px;margin-left:auto;cursor:pointer;border-radius:99px}
.dse-switch:hover .dse-switch-track{box-shadow:0 0 0 3px var(--dsw-alias-state-success-tertiary,rgba(16,185,129,.12))}
.dse-switch-track{width:30px;height:16px;border-radius:99px;background:var(--dsw-alias-border-l2,#d1d5db);position:relative;transition:background .18s ease;flex:none}
.dse-switch-thumb{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);transition:left .18s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.dse-switch[aria-checked="true"] .dse-switch-track{background:var(--dsw-alias-state-success-primary,#10b981)}
.dse-switch[aria-checked="true"] .dse-switch-thumb{left:16px}
.dse-skill .dse-desc{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-primary,#3a3f4b);line-height:1.5}
.dse-skill .dse-when{margin:4px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#8a8f9c)}
.dse-skill footer{margin:6px 0 0;font-size:10px;color:var(--dsw-alias-label-tertiary,#a2a7b3);font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.dse-toggle-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#b42318)}
/* 侧边栏折叠（data-sidebar-collapsed，与 dsh-ssh 同款标记）：图标居中、隐藏文字。
   !important 覆盖入口按钮的内联 padding（内联样式优先级高于样式表）。 */
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-skill-explorer-entry]{justify-content:center!important;width:100%!important;padding:0!important}
[data-dsh-frame][data-sidebar-collapsed] [data-dsh-skill-explorer-entry]>span:not(:first-child){display:none!important}
`;

/** 稳定 data 属性标识注入的入口行。 */
const ENTRY_SELECTOR = "[data-dsh-skill-explorer-entry]";

// ---------------------------------------------------------------- 面板单例

/** 面板相关 DOM 与状态（惰性创建）。 */
let overlay: any;
let card: any;
let bodyEl: any;
let open = false;
let loading = false;

/** 把分级数据渲染进面板主体。 */
function renderPayload(payload: any) {
  bodyEl.textContent = "";
  if (payload.groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dse-status";
    empty.textContent = "当前没有已加载的 skill。";
    bodyEl.appendChild(empty);
    return;
  }
  for (const group of payload.groups) {
    const section = document.createElement("section");
    section.className = "dse-group";
    const title = document.createElement("h3");
    title.textContent = group.title;
    const count = document.createElement("span");
    count.className = "dse-count";
    count.textContent = `${group.skills.length} 个`;
    title.appendChild(count);
    section.appendChild(title);
    if (group.hint !== "") {
      const hint = document.createElement("p");
      hint.className = "dse-hint";
      hint.textContent = group.hint;
      section.appendChild(hint);
    }
    for (const skill of group.skills) {
      section.appendChild(renderSkill(skill));
    }
    bodyEl.appendChild(section);
  }
}

/** 渲染一条技能卡片（全部用 textContent，避免任何注入）。 */
function renderSkill(skill: any) {
  const article = document.createElement("article");
  article.className = "dse-skill";
  const header = document.createElement("header");
  const name = document.createElement("span");
  name.className = "dse-name";
  name.textContent = skill.name;
  header.appendChild(name);
  if (skill.provider !== undefined) {
    const provider = document.createElement("span");
    provider.className = "dse-badge";
    provider.textContent = skill.provider;
    header.appendChild(provider);
  }
  const marks = [];
  if (skill.modelInvocable) marks.push("模型");
  if (skill.userInvocable) marks.push("用户");
  if (marks.length > 0) {
    const invokable = document.createElement("span");
    invokable.className = "dse-badge dse-invokable";
    invokable.textContent = `可调用：${marks.join(" / ")}`;
    header.appendChild(invokable);
  }
  // 启用/禁用：仅对可编辑的文件系统技能（有 path）开放；
  // 禁用 = 改写 frontmatter 的 disable-model-invocation，模型目录热刷新。
  if (skill.path !== undefined) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dse-switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(skill.modelInvocable));
    toggle.setAttribute("title", skill.modelInvocable ? "已启用：模型可调用（点击禁用）" : "已禁用：模型不可调用（点击启用）");
    const track = document.createElement("span");
    track.className = "dse-switch-track";
    const thumb = document.createElement("span");
    thumb.className = "dse-switch-thumb";
    track.appendChild(thumb);
    toggle.appendChild(track);
    toggle.addEventListener("click", async () => {
      try {
        const response = await fetch(SET_ENABLED_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: skill.name, enabled: !skill.modelInvocable }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        await refresh();
      } catch (error) {
        console.warn("[dsh-skill-explorer] toggle failed:", error);
        // 失败反馈：还原开关状态并展示错误提示（3s 后自动消失）。
        toggle.setAttribute("aria-checked", String(skill.modelInvocable));
        const hint = document.createElement("span");
        hint.className = "dse-toggle-error";
        hint.textContent = `操作失败：${error instanceof Error ? error.message : String(error)}`;
        header.appendChild(hint);
        setTimeout(() => hint.remove(), 3000);
      }
    });
    header.appendChild(toggle);
  }
  article.appendChild(header);
  const desc = document.createElement("p");
  desc.className = "dse-desc";
  desc.textContent = skill.description;
  article.appendChild(desc);
  if (skill.whenToUse !== undefined && skill.whenToUse !== "") {
    const when = document.createElement("p");
    when.className = "dse-when";
    when.textContent = `适用：${skill.whenToUse}`;
    article.appendChild(when);
  }
  if (skill.path !== undefined) {
    const footer = document.createElement("footer");
    footer.textContent = skill.path;
    article.appendChild(footer);
  }
  return article;
}

/** 拉取并渲染技能列表。 */
async function refresh() {
  if (loading) return;
  loading = true;
  bodyEl.textContent = "";
  const status = document.createElement("div");
  status.className = "dse-status";
  status.textContent = "加载中…";
  bodyEl.appendChild(status);
  try {
    const response = await fetch(ROUTE);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    renderPayload(payload);
  } catch (error) {
    bodyEl.textContent = "";
    const failed = document.createElement("div");
    failed.className = "dse-status";
    failed.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
    bodyEl.appendChild(failed);
  } finally {
    loading = false;
  }
}

/** 关闭面板。 */
function close() {
  if (overlay === undefined) return;
  open = false;
  overlay.hidden = true;
}

/** 当前 tab。 */
let currentTab = "list";

/** 渲染创建表单 tab。 */
function renderCreateTab() {
  bodyEl.textContent = "";
  const form = document.createElement("div");
  form.className = "dse-form";

  const rootLabel = document.createElement("label");
  rootLabel.textContent = "创建位置";
  const rootSelect = document.createElement("select");
  rootSelect.appendChild(new Option("用户技能（~/.dsh/skills，所有项目可用）", "user"));
  rootSelect.appendChild(new Option("项目技能（当前项目 .dsh/skills）", "project"));
  rootLabel.appendChild(rootSelect);
  form.appendChild(rootLabel);

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "技能名（kebab-case，与文件目录同名）";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "如 my-workflow";
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);

  const descLabel = document.createElement("label");
  descLabel.textContent = "描述（模型判断触发条件的依据）";
  const descInput = document.createElement("input");
  descInput.type = "text";
  descLabel.appendChild(descInput);
  form.appendChild(descLabel);

  const whenLabel = document.createElement("label");
  whenLabel.textContent = "适用场景（可选）";
  const whenInput = document.createElement("input");
  whenInput.type = "text";
  whenLabel.appendChild(whenInput);
  form.appendChild(whenLabel);

  const contentLabel = document.createElement("label");
  contentLabel.textContent = "指令内容（SKILL.md 正文，Markdown）";
  const contentInput = document.createElement("textarea");
  contentLabel.appendChild(contentInput);
  form.appendChild(contentLabel);

  const submit = document.createElement("button");
  submit.type = "button";
  submit.textContent = "创建技能";
  submit.addEventListener("click", async () => {
    const payload = {
      root: rootSelect.value,
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      whenToUse: whenInput.value.trim(),
      content: contentInput.value,
    };
    if (payload.name === "" || payload.description === "" || payload.content.trim() === "") {
      showCreateFeedback(form, "技能名/描述/内容不能为空", true);
      return;
    }
    submit.disabled = true;
    try {
      const response = await fetch(CREATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      showCreateFeedback(form, `已创建：${data.path}`, false);
      nameInput.value = "";
      descInput.value = "";
      whenInput.value = "";
      contentInput.value = "";
    } catch (error) {
      showCreateFeedback(form, `创建失败：${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      submit.disabled = false;
    }
  });
  form.appendChild(submit);
  bodyEl.appendChild(form);
  const note = document.createElement("p");
  note.className = "dse-note";
  note.textContent = "创建后立即生效（skill-filesystem 会热扫描）。内容会作为指令注入模型上下文——不要写入敏感信息。";
  bodyEl.appendChild(note);
}

/** 创建 tab 的反馈条。 */
function showCreateFeedback(form: any, text: any, isError: any) {
  const old = form.querySelector(".dse-create-feedback");
  if (old !== null) old.remove();
  const feedback = document.createElement("div");
  feedback.className = "dse-toggle-error";
  feedback.style.color = isError ? "var(--dsw-alias-state-error-primary,#b42318)" : "var(--dsw-alias-state-success-primary,#0f9d6e)";
  feedback.textContent = text;
  feedback.classList.add("dse-create-feedback");
  form.appendChild(feedback);
  setTimeout(() => feedback.remove(), 6000);
}

/** 按 tab 渲染。 */
function renderTab() {
  if (currentTab === "create") renderCreateTab();
  else void refresh();
}

/** 创建（惰性）并显示面板。 */
function showPanel() {
  if (overlay === undefined) {
    overlay = document.createElement("div");
    overlay.className = "dse-overlay";
    overlay.hidden = true;
    overlay.addEventListener("click", (event: any) => {
      if (event.target === overlay) close();
    });

    card = document.createElement("div");
    card.className = "dse-card";

    const head = document.createElement("div");
    head.className = "dse-head";
    const title = document.createElement("h2");
    title.textContent = "技能中心";
    head.appendChild(title);
    const cwd = document.createElement("span");
    cwd.className = "dse-cwd";
    cwd.textContent = "cwd: …";
    head.appendChild(cwd);
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.textContent = "刷新";
    refreshButton.addEventListener("click", () => renderTab());
    head.appendChild(refreshButton);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "关闭";
    closeButton.addEventListener("click", () => close());
    head.appendChild(closeButton);

    const tabs = document.createElement("div");
    tabs.className = "dse-tabs";
    const tabDefs = [
      ["list", "技能"],
      ["create", "创建"],
    ];
    const tabButtons: Record<string, HTMLElement> = {};
    for (const [key, label] of tabDefs) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "dse-tab";
      tab.textContent = label;
      tab.addEventListener("click", () => {
        currentTab = key;
        for (const other of Object.values(tabButtons)) other.classList.remove("dse-active");
        tab.classList.add("dse-active");
        renderTab();
      });
      tabButtons[key] = tab;
      tabs.appendChild(tab);
    }
    tabButtons[currentTab].classList.add("dse-active");

    bodyEl = document.createElement("div");
    bodyEl.className = "dse-body";

    card.appendChild(head);
    card.appendChild(tabs);
    card.appendChild(bodyEl);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && open) close();
    });
  }
  open = true;
  overlay.hidden = false;
  renderTab();
}

// ------------------------------------------------------- 侧边栏入口注入

/** 找到侧边栏 shell 根元素（与 dsh-ssh 同款选择策略）。 */
function sidebarRoot() {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
  if (column === null) return undefined;
  const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
  return logoOwner ?? (column.firstElementChild ?? undefined);
}

/** New Session 按钮：当前 shell 在 logo 行内嵌套，旧 shell 是直接子元素。 */
function newSessionButton(root: any) {
  const nested = root.querySelector('button[class*="newSession"]');
  if (nested !== null) return nested;
  for (const child of root.children) {
    if (child.tagName === "BUTTON") return child;
  }
  return undefined;
}

/** 创建入口行（独立 button，shell 就绪后插入）。 */
function createEntry() {
  const entry = document.createElement("button");
  entry.type = "button";
  entry.dataset.dshSkillExplorerEntry = "";
  entry.setAttribute("aria-label", "技能中心");
  entry.setAttribute("title", "技能中心：查看已加载的 skill");
  entry.innerHTML = `<span style="display:inline-flex;vertical-align:middle">${ICON}</span><span style="margin-left:2px">技能中心</span>`;
  entry.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:none;background:transparent;color:inherit;font-size:12px;cursor:pointer;border-radius:6px";
  entry.addEventListener("click", () => {
    if (open) close();
    else showPanel();
  });
  return entry;
}

/** 把入口行插到家族块（其他插件注入行）之后。 */
function placeEntry(root: any, entry: any) {
  const button = newSessionButton(root);
  if (button === undefined) return false;
  if (entry.parentElement === root) return true;
  const row = button.closest('[class*="logoRow"]');
  const base = row !== null && row.parentElement === root ? row : button;
  const family: any[] = Array.from(root.children).filter(
    (el) => el instanceof HTMLElement && el.matches("[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-skill-explorer-entry]"),
  );
  const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
  root.insertBefore(entry, anchor);
  return true;
}

/**
 * 挂载浏览器端：注入样式 + 侧边栏入口（MutationObserver 自愈，参考
 * dsh-ssh 的 sidebar-entry 模式）。
 * @param {import("@deepseek-ai/dsh-client-runtime/client").ClientContext} ctx
 * @returns {void}
 */
function apply(ctx: any) {
  try {
    // 一次性注入样式（热更新兼容：用显式版本号检测，版本不符则移除重建）
    const existingStyle = document.querySelector<HTMLStyleElement>('style[data-dsh-skill-explorer-style]');
    if (existingStyle !== null && existingStyle.dataset.cssVersion === "2") {
      // 已是最新样式
    } else {
      if (existingStyle !== null) existingStyle.remove();
      const style = document.createElement("style");
      style.dataset.dshSkillExplorerStyle = "";
      style.dataset.cssVersion = "2";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    const entry = createEntry();
    let root: any;
    let placed = false;

    const tryPlace = () => {
      if (root !== undefined && !root.isConnected) {
        rootObserver.disconnect();
        root = undefined;
        placed = false;
      }
      if (placed) {
        if (document.body.contains(entry)) return;
        rootObserver.disconnect();
        root = undefined;
        placed = false;
      }
      root ??= sidebarRoot();
      if (root === undefined) return;
      placed = placeEntry(root, entry);
      if (placed) rootObserver.observe(root, { childList: true, subtree: true });
    };

    const waitObserver = new MutationObserver(() => tryPlace());
    waitObserver.observe(document.body, { childList: true, subtree: true });

    const rootObserver = new MutationObserver(() => {
      if (root === undefined || !root.isConnected) {
        placed = false;
        tryPlace();
        return;
      }
      if (!root.contains(entry)) placed = placeEntry(root, entry);
    });

    tryPlace();

    ctx.effect(() => () => {
      waitObserver.disconnect();
      rootObserver.disconnect();
      entry.remove();
      if (overlay !== undefined && overlay.parentElement !== null) overlay.remove();
      overlay = undefined;
      open = false;
    }, "dsh-skill-explorer: ui");
  } catch (error) {
    // DOM 挂载失败只降级面板，绝不让 GUI 启动失败。
    console.warn("[dsh-skill-explorer] mount failed:", error);
  }
}

		// 客户端插件声明：只使用核心 ctx.effect，不注入额外服务。
		const inject: any[] = [];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

})();