# dsh-web-file-preview 架构与运行机制

> 包：`@wingsky-1/dsh-web-file-preview` · 源码：`packages/dsh-web-file-preview/`
> 功能一句话：**把对话内「用默认应用打开」的文件请求，改写成官方右侧栏预览**。
>
> 快速上手（安装 / 验证 / 兼容性）见 [包 README](../../packages/dsh-web-file-preview/README.md)；
> 本文讲**原理与运行机制**。

---

## 1. 职责边界

插件在 0.1.5-rc.1 上只有一件事：收口 `POST /api/present.open`（且仅 `action=open`）。

需要它的原因：0.1.5 起对话内绝大多数文件点击已由官方右侧栏预览（`dsh-client-ui-sidebar-documentpreview`）接管，但 `present` 交付物仍有两条入口把文件交给桌面应用——它们最终都汇聚到同一个宿主路由：

- `present` 交付物卡片菜单的「用默认应用打开」/「在文件管理器中显示」；
- 助手最终回复里对 presented 文件的**提及点击**（`chatFileMentions.forClosing` 对 presented 文件走 `opener.open(sessionId, seq, index)`，而非 `openFile`）。

插件不注册官方 `documentPreviews` / `sidebarRightTabs`，不改官方 DOM 与样式，也不接管对话内其它文件点击。

## 2. 运行链路

```
点击 [data-presented-file] 卡片 / 回复里的提及
        │  （document 捕获阶段，见 §3）
        ▼
   记录 pending 路径（cardPreview 的 title / 提及 button 的 title）
        │
点击卡片菜单「用默认应用打开」
        │
        ▼
官方客户端 fetch("POST", /api/present.open?sessionId&seq&index)
        │  （window.fetch 包装，见 §3）
        ▼
  命中？ ──否──▶ 原样透传（reveal / 非 POST / 非该路径 / 无 pending）
        │是
        ▼
fileAddressFor(sessionId, cwd, path)   ← 官方地址语法的源码级复刻
        │
        ▼
ctx.sidebarRight.openResource(address)  ← 官方右侧栏打开预览 tab
        │
        ▼
合成 Response(null, { status: 204 })    ← 官方只读 ok / status===422
```

任何一步失败（地址构造异常、`openResource` 抛错）：**显式重放原始请求** `orig(input, init)`，绝不吞掉用户操作。

## 3. 关键设计取舍

- **收口选 `window.fetch`**：`/api/present.open` 是官方客户端的裸 HTTP POST，不经任何 `ctx` 服务；客户端 remote 也没有 `sessionQuery` 命名空间可反查事件，因此这是唯一能同时做到「阻止外开」与「打开侧栏预览」的收口点。包装体只读两个字段，其余原样透传，还原时按身份比对（不摘别人的包装）。
- **路径靠捕获阶段记录**：请求 query 只有 `sessionId/seq/index`，不含路径；客户端无法反查事件。捕获阶段（必须捕获：菜单面板由 portal 渲染到 body 且自带 `onClick` stopPropagation）从官方显式标记取路径——`[data-presented-file]` 与 `title`；官方 CSS Modules 类名是构建期哈希，不可作为选择器。
- **地址构造逐字复刻官方 `fileAddressFor`**：官方右侧栏以**地址本身**作 `contentId` 去重，只复刻模板而漏掉「cwd 内的绝对路径折叠为工作区相对路径」会让同一文件出现两个 tab。实现与官方 `@deepseek-ai/dsh-util-workspace-path@0.1.5-rc.1` 逐条对拍维护（18 条 golden，含 UNC / 盘符 / 编码边界）。仓库门禁只允许对官方包 `import type`，故为源码级复刻而非运行时依赖。
- **`reveal` 放行**：它不打开文件内容，dsh 内也没有「文件管理器定位」的等价物；接管只能降级成预览，并让官方卡片显示与实际不符的完成文案。
- **不做宿主端兜底**：可选方案是在宿主注册 `/api/present.open` 的 exact 影子路由，把失败路径从 fail-open 收紧为 fail-safe。维护者选择保持纯客户端微型形态——收口失效时退回官方原生打开（可感知、非静默损坏），而不是引入宿主代码与额外权限。

## 4. 失效面与降级

插件只读三条官方契约（详见包 README「兼容性」）：`/api/present.open` 的路径/方法/`action` 参数；`[data-presented-file]` 与 `title` 标记；地址语法与 cwd 折叠语义。

任一失效时的行为统一为**降级放行**：收口不命中，点击回到官方原生打开。

## 5. 落幕判据

官方把 presented 的卡片菜单与提及点击也改为右侧栏预览（或提供 `openWorkspacePath` 的 Web 兜底分支）时，本插件整体退役。跟踪：[issue #698](https://github.com/wingsky-1/dsh-plugin-hub/issues/698)。
