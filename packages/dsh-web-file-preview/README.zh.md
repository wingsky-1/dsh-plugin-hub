# dsh-web-file-preview

点击对话中的文件链接，在 **web 端**直接预览文件内容（**图片 / 文本 / Markdown / 代码 / git Diff**）。

DSH 自带的“可点击文件引用”在点击产出文件 chip / 行内文件引用时走的是桌面原生打开器——桌面可用，但**纯 Web（局域网浏览器 / iPad / iPhone，或 `nativeOpen:false` 部署）没有 Web 端预览**。本插件补上这一环：点击对话中可点击的文件链接，改为在**对话框内弹出预览 Modal**，图片直接 `<img>` 显示、文本以等宽 `<pre>` 渲染，明暗主题自适应（Windows / iPad / iPhone 三种访问形态共用一套体验）。

## 能力

- **图片预览**：`png / jpg / jpeg / gif / webp / svg / avif / bmp`；点击进入灯箱：滚轮缩放、拖拽平移（桌面），双指捏合缩放（触屏），`＋/－/重置` 工具栏。
- **Markdown 预览**：`.md / .markdown` 默认渲染预览（marked + GFM 常用能力），可切「原始」。
- **代码语法高亮**：`js/ts/py/java/…` 等 25+ 语言（highlight.js 子集）高亮，可切「原始」。
- **文本预览**：`txt / log / csv / conf …` 等宽展示。
- **Diff 视图（git）**：在 git 仓库且有未提交变更时顶栏多出 **Diff** tab（红/绿展示 `git diff HEAD -- <file>`；未跟踪新文件给提示；探测失败显示「Diff 不可用」，与“无变化”区分）。
- Modal 内动作：**复制路径**（剪贴板不可用时自动降级并反馈）、**在新标签打开原文**、**关闭**（Esc / 点遮罩）。
- **加载错误态**：错误细分 + 「在新标签打开原文」兜底。
- **缓存**：不设 JS 内存缓存；浏览器 HTTP 缓存 + 宿主弱 ETag（`Cache-Control: no-cache` + `If-None-Match`）自动协商（未变 304、已变 200）。

## 实现

- **宿主端**：`GET /api/dsh-file-preview/file?cwd=&path=`（绝对路径可省 cwd；loopback 围栏，非回环 403 / 方法非 GET 405），按 `resolve(cwd, path)` 定位读取（`~` 前缀 `untildify` 展开）；后缀分组：图片/文本/Markdown/代码直出，其余 415；文本超过 `maxTextBytes` 返回 413 + `truncated` 标记。`GET /api/dsh-file-preview/diff?cwd=&path=`（异步 execFile，不阻塞服务；输出超 32MB 标记失败）计算 git diff；`/health` 健康检查。文件响应统一 `X-Content-Type-Options: nosniff`，SVG 额外 `Content-Security-Policy: sandbox`。
- **客户端**：双机制拦截（`workspaces.openPath` 调用点收口 + document 捕获静态拦截）；所有请求带代数校验与 AbortController（快速开关预览不会串文件、关闭即取消）；分组渲染 + 三 tab（预览/原始/Diff）。md 用 `marked`、代码用 `highlight.js` 子集、Diff 用 `diff2html`，输出经 `DOMPurify` 消毒。
- **后缀分组单一事实源**：`src/grouping.ts` 宿主/客户端共用。
- **依赖**：`marked` / `highlight.js` / `diff2html` / `untildify` 构建期内联，**发布物运行时零 npm 依赖**。

## 安装

已安装 DeepSeek Harness 且 `dsh web` 可启动：

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
```

安装后**重启一次 dsh web** 生效（客户端 bundle 需页面刷新加载）。

## 配置

| Key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭则不注册任何路由 |
| `maxTextBytes` | `524288` (512KB) | 文本类（text/markdown/code）预览最大字节数；超限返回 `413` + `truncated` 标记，客户端提示「文件过大」，可在新标签打开原文 |

## 验证

```sh
pnpm build && pnpm test      # 仓库内：构建 + smoke
curl http://127.0.0.1:3080/api/dsh-file-preview/health
```

## 安全模型

- **loopback 围栏**：所有 `/api` 路由强制回环来源校验（详见 `shared/loopback.js`）；`/file`、`/diff`、`/health` 均仅允许 GET。
- **不做重复兜底**：本插件语义是“能打开 dsh web 页面即已持有高权限”，不做任意文件访问强校验、会话鉴权、敏感名拦截——访问控制由平台/用户负责。
- **路径定位**：`/file` 按 `resolve(cwd, path)` 直接定位（不做“逃出 cwd”拦截），`~` 前缀展开为用户主目录。
- **渲染安全**：文件响应一律带 `nosniff`，SVG 额外 CSP `sandbox`（顶层导航不执行内嵌脚本）；Markdown/代码渲染输出均经 `DOMPurify` 消毒后插入。

## 已知限制

- 文本超过 `maxTextBytes` 返回 413 截断提示；大文件流式/虚拟滚动未实现（规划中）。
- 仅支持 **UTF-8** 文本（带 BOM 会残留 `\uFEFF` 首字符；GBK 等编码会乱码）。
- 可点击范围较宽（路径 title / 本地 href / 内联路径文本都可能进预览），已对多文件拼接（逗号/换行/多空格/单空格斜杠并列）做防误判。
- 多会话切换以当前活跃会话 cwd 为准（历史会话的链接按当前 cwd 解析，若路径不同会 404）。
- 新版客户端 bundle 约 226KB min（gzip ~68KB）。