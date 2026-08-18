// 客户端干净模块：只导出 apply/inject，契约外壳（IIFE/load/Symbol.toStringTag 装配）
// 由 scripts/build-client.ts 统一生成——源码不写任何 loader 痕迹。
// 样式：独立 style.css（见同目录），build-client 的 .css text-loader 构建期内联为字符串
import STYLE from "./style.css";

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

/** 创建路由（与 host 端一致）。客户端不提供删除 UI，删除只走宿主路由，故不声明 DELETE_ROUTE。 */
const CREATE_ROUTE = "/api/dsh-skill-explorer/create";

/** 侧边栏入口图标：技能/书本字形（16px nav-icon 风格，与 shell 一致）。 */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.2C6.6 2 4.5 2 3 2v10.5c1.5 0 3.6 0 5 1.3 1.4-1.3 3.5-1.3 5-1.3V2c-1.5 0-3.6 0-5 1.2z"/><path d="M8 3.2v10.6"/></svg>';

/** 面板样式（一次性注入 <style>，dse- 前缀避免与 shell 样式冲突；颜色全部用皮肤变量 --dsw-alias-* 适配亮/暗主题，带浅色回退）。 */

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
export function apply(ctx: any) {
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

// ---- 客户端契约：apply/inject 由 build-client 经 factory 装配（干净模块）----
// 只使用核心 ctx.effect，不注入额外服务。
export const inject: string[] = [];