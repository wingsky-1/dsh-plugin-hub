# @wingsky-1/dsh-web-file-preview
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-web-file-preview)](https://www.npmjs.com/package/@wingsky-1/dsh-web-file-preview)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

把对话内「用默认应用打开」的文件请求，改写成**官方右侧栏预览**——让文件查看留在 dsh 里完成。

## 它做什么

dsh 0.1.5 起，对话内绝大多数文件点击已经是官方右侧栏预览；仍会把文件交给**外部应用**的只剩一条链路：`POST /api/present.open`（宿主 `sessionController.openWorkspacePath`），它有两个客户端入口：

- `present` 交付物卡片菜单的「用默认应用打开」；
- 助手最终回复里对 presented 文件的**提及点击**（inline code 引用）。

本插件在客户端把这条请求收口：拦到「用默认应用打开」后不再出网，改为用官方地址语法（`dsh-resource://file/session/<id>/<path>`）请 `ctx.sidebarRight.openResource` 打开右侧栏预览，并合成官方调用方读得懂的成功响应。

**不接管**的路径（按「减少功能面」的维护者决策）：

- `reveal`（「在文件管理器中显示」）原样放行——它不打开文件内容，dsh 内也没有等价物；
- 会话头部的 `open-in-app`（在外部编辑器中打开工作区目录）；
- 对话内其它文件点击（官方本来就打开右侧栏预览，本插件不碰）。

插件**不注册**官方 `documentPreviews` / `sidebarRightTabs` 扩展点，也不修改官方 DOM 或样式。

## 能力变更（重定位说明）

本插件早期版本自带预览器（Modal + 图片灯箱 + Markdown/Mermaid + 代码高亮 + git Diff + HTML 虚拟伺服 + 二进制下载卡 + 路径兜底搜索 + 自建宿主路由）与对话内点击拦截。官方预览自 dsh 0.1.5 起覆盖了主干能力，插件因此收缩为上面的单一转发职责，相关代码、依赖与宿主路由已全部移除。

**升级须知**：升级后行为变化是——`present` 交付物卡片与回复提及的点击，从「拉起桌面应用」变为「打开右侧栏预览」；原 Modal 内的 Diff / Mermaid / HTML 多文件资源等能力不再提供（交给官方预览渲染器）。插件不再有用户可配置项，关闭方式即卸载。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-web-file-preview
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-web-file-preview
```

## 验证

单元测试只维护 `test/*.test.ts`（`import "../lib/index.js"` 测产物）；stryker 经 lib→src hook 复用同一份断言。

```sh
pnpm build && pnpm test                 # 仓库内：构建 + smoke（含地址构造 golden 表与 fetch 收口夹具）
```

地址构造与官方 `@deepseek-ai/dsh-util-workspace-path` 的 `fileAddressFor` 逐条对拍维护：官方右侧栏 tab 以地址本身作 contentId 去重，任一条漂移都会让同一文件出现两个 tab。

## 兼容性（只读耦合点）

插件不改官方源码、不注册官方扩展点，但**读取**以下官方契约；官方改版时这些点是唯一的失效面：

- `/api/present.open` 的路径、`POST` 方法与 `action` 查询参数（`reveal` 依赖 `action=reveal` 区分）；
- presented 卡片的 `[data-presented-file]` 标记、卡片覆盖按钮与正文提及的 `title` 属性（路径来源）；官方 CSS Modules 类名是构建期哈希，不可依赖；
- `dsh-resource://file/session/<id>/<path>` 地址语法与 `fileAddressFor` 的 cwd 折叠语义。

任一点失效时的行为是**降级放行**：收口不生效，点击退回官方原生打开（可感知，不会静默损坏数据）。

## 安全模型

- **不再有自建路由**：早期版本的 `/api/dsh-file-preview/*`（文件直出、HTML 虚拟伺服、token 体系）已随重定位移除。插件不再向浏览器暴露任何文件读取面，也不再需要 loopback 围栏、serve token 与 CSP 兜底——**早期 README 中「经代理暴露可预览本机文件」的局域网高危告警随之消失**。
- **只读耦合**：插件只读取（不写入）请求 URL 与官方卡片 DOM 的 `title` 属性；采集到的路径仅用于拼接官方地址字符串。
- **不出网**：命中收口时插件不发任何网络请求，直接调用官方右侧栏导航；未命中或异常时原样重放官方请求。
- **最小权限**：客户端只注入 `sessions`（取会话 cwd 用于地址折叠）与 `sidebarRight`（官方右侧栏导航）；宿主端不再需要 `webServer`、文件系统或任何官方服务。

## 已知限制

- **依赖官方 DOM 标记**：路径采集依赖 `[data-presented-file]` 与 `title`。官方改版后若标记变化，收口会降级为放行原生打开（见「兼容性」）。
- **pending 窗口**：路径在「点击卡片/提及」时采集，随后该次「用默认应用打开」使用它。极少见的情形（如键盘直接唤起菜单、或长时间停留后点击）可能采集不到，此时同样降级放行。
- **每次点击后需重启生效**：与所有 dsh 客户端插件一致，插件产物只在 `dsh web` 启动时组合。

## 落幕判据

以下任一条件满足时，本插件即可退役：

- 官方把 `presented` 的卡片菜单与提及点击也改为右侧栏预览（或提供 `openWorkspacePath` 的 Web 兜底分支）；
- 官方提供等价的「打开行为重定向」扩展点。

相关跟踪：[issue #698](https://github.com/wingsky-1/dsh-plugin-hub/issues/698)。
