# @wingsky-1/dsh-web-file-preview
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-web-file-preview)](https://www.npmjs.com/package/@wingsky-1/dsh-web-file-preview)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

点击对话中的文件链接，在 **web 端**直接预览文件内容（**图片 / 文本 / Markdown / 代码 / git Diff**）。

DSH 自带的“可点击文件引用”在点击产出文件 chip / 行内文件引用时走的是桌面原生打开器——桌面可用，但**纯 Web（局域网浏览器 / iPad / iPhone，或 `nativeOpen:false` 部署）没有 Web 端预览**。本插件补上这一环：点击对话中可点击的文件链接，改为在**对话框内弹出预览 Modal**，图片直接 `<img>` 显示、文本以等宽 `<pre>` 渲染，明暗主题自适应。

## 能力

- **图片预览**：`png / jpg / jpeg / gif / webp / svg / avif / bmp`；点击进入灯箱放大/平移（滚轮缩放 + 拖拽）。
- **Markdown 预览**：`.md / .markdown` 默认渲染预览（marked + GFM 常用能力），可切「原始」。
- **代码语法高亮**：`js/ts/py/java/…` 等 25+ 语言（highlight.js 子集）高亮，可切「原始」。
- **文本预览**：`txt / log / csv / conf …` 等宽展示。
- **Diff 视图（git）**：`.md/代码/文本` 若在 git 仓库且有未提交变更，顶栏多出第 3 个 **Diff** tab，红/绿展示 `git diff HEAD -- <file>`（未跟踪新文件给提示）。
- Modal 内动作：**预览/原始/Diff**、**复制路径**、**在新标签打开**、**关闭**（Esc / 点遮罩）。
- **加载错误态**：错误细分 + 「在新标签打开」兜底。
- **缓存**：不设 JS 内存缓存（文件常被修改，永久缓存会显示陈旧内容）；改用浏览器 HTTP 缓存 + 宿主弱 ETag（`Cache-Control: no-cache` + `If-None-Match`）自动协商——未变 304 秒回、已变自动拿最新。

## 实现

- **宿主端**：`GET /api/dsh-file-preview/file?cwd=&path=`（绝对路径可省 cwd；loopback 围栏，非回环 403 / 方法非 GET 405），按 `resolve(cwd, path)` 定位读取（`~`/`~/` 前缀用 `untildify` 展开为用户主目录）；后缀分组：图片/文本/Markdown/代码直出，其余 415；文本超过 `maxTextBytes` 返回 `413`+`truncated`（先 `stat` 判大小、不整读）。`GET /api/dsh-file-preview/diff?cwd=&path=`（异步 execFile 计算 git diff）与 `GET /api/dsh-file-preview/health` 健康检查。文件响应统一 `X-Content-Type-Options: nosniff`，SVG 额外 `Content-Security-Policy: sandbox`。
- **客户端**：双机制拦截（`workspaces.openPath` 调用点收口 + document 捕获静态拦截）+ 分组渲染（`renderGroupFor`）+ 三 tab（预览/原始/Diff，Diff 仅 git 有变更才显示）。md 用 `marked`、代码用 `highlight.js` 子集、Diff 用 `diff2html`。
- **后缀分组单一事实源**：`src/grouping.ts` 供宿主 `mime.ts` 与客户端 `renderer.ts`/`client.ts` 共用，杜绝双端各写一份后缀表导致漂移。
- **依赖**：`marked` / `highlight.js` / `diff2html` / `untildify` 为构建期打包依赖（宿主/客户端分别内联进 `lib/index.js` 与 `lib/client.js`），**运行时零 npm 依赖**；Content-Type 用内置小型映射（无需 mime-db 大表，避免宿主第三方依赖内联的 ESM/CJS 兼容问题）。
- **构建体积**：客户端 esbuild `--minify`，`client.js` min 后约 226KB（gzip ~68KB）。

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

## 配置

| Key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭则不注册任何路由 |
| `maxTextBytes` | `524288` (512KB) | 文本类（text/markdown/code）预览最大字节数；超限返回 `413` + `truncated` 标记（`Cache-Control: no-store`），客户端提示「文件过大」，可在新标签打开原文 |

## 验证

```sh
pnpm build && pnpm test                 # 仓库内：构建 + smoke
curl http://127.0.0.1:3080/api/dsh-file-preview/health
```

## 安全模型

- **⚠️ 局域网部署高危告警（务必阅读）**：本插件经 `dsh-lan-proxy`（或任何把外部流量转发到 127.0.0.1 的代理）对外暴露时，**loopback 围栏会被代理重写 Host/Origin 而穿透**——此时**局域网内任意设备**（无需任何 dsh 凭据/登录态）可直接访问 `/api/dsh-file-preview/file?path=…` 预览本机任意扩展名在文本/图片/Markdown/代码白名单内的文件，**包括 `~/.dsh/.credentials.yaml`、`~/.dsh/*.json` 等凭据/配置文件**（`path` 支持 `~` 展开与绝对路径，`stat` 跟随符号链接，不做逃出拦截）。请在**可信局域网**部署（勿暴露到公共 WiFi/互联网），或自行在网络层配置**会话鉴权 / API 前缀白名单**后再对外。被穿透后的后果由部署方承担——本插件按下方"不做重复兜底"条款不提供插件层访问控制。
- **保留 loopback 围栏**：所有 `/api` 路由强制校验回环来源（跨站 / DNS 重绑定防护），与平台既有约定一致；`health` 之外的 /file、/diff 也仅允许 GET（方法不符 405）。该围栏对**本机/回环直连**有效；对经代理的局域网访问生效与否取决于代理是否重写 Host/Origin（见上一条）。
- **不做重复兜底**：本插件的语义是“能打开 dsh web 页面即已持有高权限”，因此**不做**任意文件访问强校验、会话鉴权、敏感名拦截——访问控制由平台/用户负责，本插件不重复实现每一套。
- **路径定位**：`/file` 按 `resolve(cwd, path)` 直接定位，不做“逃出 cwd”拦截（任意文件访问由平台/用户负责）。`~`/`~/` 前缀展开为用户主目录。
- **渲染安全**：文件响应一律带 `X-Content-Type-Options: nosniff`；SVG 额外带 `Content-Security-Policy: sandbox`（顶层导航时不执行内嵌脚本）。Markdown / 代码渲染输出为 HTML 呈现层，`marked` / `highlight.js` 对正文做转义；本插件不承诺对渲染结果做 XSS 消毒——预览内容来自会话已见的文件，安全边界同“能打开 dsh web 即高权限”。

## 已知限制

- 文本类超过 `maxTextBytes`（默认 512KB）返回 413+截断标记，不再整读全文（大文件流式/虚拟滚动未实现，见 W10 专项）。
- 可点击范围较宽（凡路径 title / 本地 href / 内联路径文本都可能进预览），后续可收窄到产出引用。
- client bundle 含 `marked` + `highlight.js` 子集 + `diff2html`，min 后约 226KB（gzip ~68KB）。
- 多会话切换以当前活跃会话 cwd 为准。
