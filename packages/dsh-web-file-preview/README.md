# @wingsky-1/dsh-web-file-preview
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-web-file-preview)](https://www.npmjs.com/package/@wingsky-1/dsh-web-file-preview)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

点击对话中的文件链接，在 **web 端**直接预览文件内容（**图片 / 文本 / Markdown / 代码 / git Diff**）。

DSH 自带的“可点击文件引用”在点击产出文件 chip / 行内文件引用时走的是桌面原生打开器——桌面可用，但**纯 Web（局域网浏览器 / iPad / iPhone，或 `nativeOpen:false` 部署）没有 Web 端预览**。本插件补上这一环：点击对话中可点击的文件链接，改为在**对话框内弹出预览 Modal**，图片直接 `<img>` 显示、文本以等宽 `<pre>` 渲染，明暗主题自适应。

## 能力

- **图片预览**：`png / jpg / jpeg / gif / webp / svg / avif / bmp`；点击进入灯箱放大/平移（滚轮缩放 + 拖拽）。
- **Markdown 预览**：`.md / .markdown` 默认渲染预览（marked + GFM 常用能力），可切「原始」；文内 ` ```mermaid ` 代码块渲染为图（首次出现时才懒加载 mermaid 引擎，普通预览首屏零额外开销），语法错误自动回退为代码块并提示。
- **代码语法高亮**：`js/ts/py/java/…` 等 25+ 语言（highlight.js 子集）高亮，可切「原始」。
- **HTML 预览（issue #73）**：`.html / .htm` 走「serve 路由 + `<iframe sandbox>`」静态伺服——HTML 与相对路径的 css/js/img 资源按浏览器原生解析正常加载渲染（root = HTML 文件所在目录，root 内任意深度相对引用含 `../` 均可达；根 HTML 引用 root 外资源因 token 前缀语义不可达，属安全边界）；**不执行 `<script>`**（sandbox 无 `allow-scripts`，首版边界）；可切「原始」tab 查看源码。
- **文本预览**：`txt / log / csv / conf …` 等宽展示。
- **Diff 视图（git）**：`.md/代码/文本/HTML` 若在 git 仓库且有未提交变更，顶栏多出第 3 个 **Diff** tab，红/绿展示 `git diff HEAD -- <file>`（未跟踪新文件给提示）。
- Modal 内动作：**预览/原始/Diff**、**复制路径**、**在新标签打开**、**关闭**（Esc / 点遮罩）。
- **`@` 引用适配（dsh rc8）**：对话气泡里 `@` 引用渲染的 `data-ref-chip`（文件/文件夹/会话）统一识别——文件引用 `@path` / `@"…"` 点 chip 用**干净路径**（去前导 `@` 与引号）直接打开预览 Modal；文件夹引用 `@path/` 点 chip 弹轻量提示（无目录浏览能力，不开 Modal）；会话引用显式忽略（与文件预览正交）。
- **加载错误态**：错误细分 + 「在新标签打开」兜底。
- **缓存**：不设 JS 内存缓存（文件常被修改，永久缓存会显示陈旧内容）；改用浏览器 HTTP 缓存 + 宿主弱 ETag（`Cache-Control: no-cache` + `If-None-Match`）自动协商——未变 304 秒回、已变自动拿最新。

## 实现

- **宿主端**：`GET /api/dsh-file-preview/file?cwd=&path=`（绝对路径可省 cwd；loopback 围栏，非回环 403 / 方法非 GET 405），按 `resolve(cwd, path)` 定位读取（`~`/`~/` 前缀用 `untildify` 展开为用户主目录）；后缀分组：图片/文本/Markdown/代码/HTML 直出，其余 415；文本超过 `maxTextBytes` 返回 `413`+`truncated`（先 `stat` 判大小、不整读）。`GET /api/dsh-file-preview/diff?cwd=&path=`（异步 execFile 计算 git diff）与 `GET /api/dsh-file-preview/health` 健康检查。文件响应统一 `X-Content-Type-Options: nosniff`，SVG 额外 `Content-Security-Policy: sandbox`。
- **HTML serve 虚拟伺服（issue #73）**：`GET /api/dsh-file-preview/alloc?cwd=&path=` 把「HTML 文件所在目录」登记为只读 root 并返回随机 token（128-bit，进程级单例映射，内存态不落盘）；`GET /api/dsh-file-preview/serve/<token>/<rest>`（prefix 路由，loopback 围栏 + GET-only）按 token → root 伺服任意子路径资源，`realpath` 双向校验闭合符号链接逃逸、root 越界 / 目录请求 / 编码攻击面一律 404；`GET /api/dsh-file-preview/release?token=` 显式释放（幂等）。HTML 返回 `text/html`，其余按 `mime` 库判定；流式 `createReadStream` 直出（`Content-Length` 来自 `stat`）；单资源超过 `maxAssetBytes` 返回 `413`+`truncated`+`no-store`；idle TTL 30min + LRU 上限 64（不淘汰活跃预览）兜底回收。
- **客户端**：双机制拦截（`workspaces.openPath` 调用点收口 + document 捕获静态拦截）+ 分组渲染（`renderGroupFor`）+ 三 tab（预览/原始/Diff，Diff 仅 git 有变更才显示）。md 用 `marked`、代码用 `highlight.js` 子集、Diff 用 `diff2html`；HTML 预览 tab 渲染 `<iframe sandbox>`（无 `allow-scripts` / 无 `allow-same-origin`），`src = /serve/<token>/<encodeURI(rest)>`，关闭 Modal 时上报 release。
- **后缀分组单一事实源**：`src/grouping.ts` 供宿主 `mime.ts` 与客户端 `renderer.ts`/`client.ts` 共用，杜绝双端各写一份后缀表导致漂移；`.html/.htm` 自 issue #73 起为独立 **html 渲染组**（宿主产出 `renderedHtml` kind，双端一致）；`cleanRefChipPath`（@-mention chip 标签 → 干净路径的纯函数）同处，与 DSH 的 `formatFileMention` 互逆。
- **跨包契约假设（`@` 引用）**：按 `data-ref-chip` 属性 + `title="@…"` 形态（由 DSH `ui-conversation` 产出）识别。若未来 DSH 调整该形态，`data-ref-chip` 门失效时 file chip 静默退回「点击无反应」（不会 404，属可接受降级）；若 DSH 提供干净路径属性（如 `data-ref-path`）则优先采用。
- **依赖**：`marked` / `highlight.js` / `diff2html` / `untildify` / `mime` 为构建期打包依赖（宿主/客户端分别内联进 `lib/index.js` 与 `lib/client.js`），**运行时零 npm 依赖**；图片与 serve 子资源 Content-Type 由 `mime` 库提供（mime-db 全表，issue #12/#47 approved，构建期内联，消除自写映射表漂移）。
- **Mermaid 懒加载 chunk（issue #104）**：`mermaid` 整库内联为独立产物 `lib/client-mermaid.js`（ESM，minify），与 `client.js` 物理分离；宿主经 `GET /api/dsh-file-preview/mermaid`（loopback 围栏 + 弱 ETag 协商缓存）伺服。客户端仅在 md 渲染出 mermaid 代码块后才以运行时变量 URL 动态 import 拉取——普通 md / 文本 / 图片预览从不触发加载。minified 产物的 esbuild 路径注释会被移除，故构建期由 metafile 生成内联清单 sidecar `lib/client-mermaid.deps.json` 随包发布，作为 license 归集与 pack 断言的唯一证据源。
- **构建体积**：客户端 esbuild `--minify`，`client.js` 约 550KB（gzip ~120KB）；`client-mermaid.js` 全量约 **3.29MB（gzip ~940KB）**——复核口径基线（验收不设体积硬阈值；仅首次遇到 mermaid 块时下载一次，浏览器模块缓存 + 304 协商后续零成本）。

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
| `maxTextBytes` | `20971520` (20MB) | 文本类（text/markdown/code/html 源码）预览最大字节数；超限返回 `413` + `truncated` 标记（`Cache-Control: no-store`），客户端提示「文件过大」，可在新标签打开原文（issue #344：默认 512KB→20M；客户端对 >1MB 超大文本降级为纯 `<pre>` 截断渲染，防主线程阻塞） |
| `maxAssetBytes` | `20971520` (20MB) | serve 单资源（HTML 预览的 html/css/js/img 等）最大字节数；超限返回 `413` + `truncated` 标记（`Cache-Control: no-store`），客户端提示（与 `maxTextBytes` 对称，issue #73 PR 声明 + #344 同步提升）；SVG 与 /file 一致补 `Content-Security-Policy: sandbox` |

## 验证

```sh
pnpm build && pnpm test                 # 仓库内：构建 + smoke
curl http://127.0.0.1:3080/api/dsh-file-preview/health
```

## 兼容性（issue #37 起）

静态点击拦截的生效范围与让权约定如下：

- **作用域圈定**：document 捕获拦截仅在**宿主对话流子树**内生效——判定锚点为祖先链上存在 `[data-chat-flow]` 或 `[data-chat-anchor-key]`（DSH ChatView 官方自用的滚动锚点属性，见 `src/client/link-resolver.ts` 的 `SCOPE_SELECTORS`，追加式数组）。**对话流之外的任何元素一律放行**（下条豁免属性除外，其跨区域优先）：第三方插件 UI（文件树、浮层、面板等）不再被全局路径嗅探劫持。这是行为变更：旧版对全 document 生效的宽松拦截自本版起收敛到对话流内。
- **解析优先级**：元素显式声明的路径凭证（`data-ref-chip` / `title` / `<a href>`）永远优先于"文本像路径"的启发式嗅探；凭证与本轮文本命中 basename 一致时采信凭证完整路径，不一致则跳过该凭证不猜（与 DSH `producedFileMentions` 的保守原则同源）。第三方文件树常见的 `<div title="完整路径"><span>裸文件名</span></div>` 行结构因此能解析出完整路径。
- **逃生门属性**：任何元素子树标注 `data-dsh-no-preview` 即对本插件豁免（跨区域生效，优先级高于作用域圈定）。第三方插件在自有可点击 UI 上加此属性即可确保零干扰。
- **适配点**：若未来 DSH 改版调整了对话流 DOM 标识，更新 `src/client/link-resolver.ts` 中 `SCOPE_SELECTORS` 常量即可（追加新锚点，无需改动算法）。

## 安全模型

- **⚠️ 局域网部署高危告警（务必阅读）**：本插件经 `dsh-lan-proxy`（或任何把外部流量转发到 127.0.0.1 的代理）对外暴露时，**loopback 围栏会被代理重写 Host/Origin 而穿透**——此时**局域网内任意设备**（无需任何 dsh 凭据/登录态）可直接访问 `/api/dsh-file-preview/file?path=…` 预览本机任意扩展名在文本/图片/Markdown/代码白名单内的文件，**包括 `~/.dsh/.credentials.yaml`、`~/.dsh/*.json` 等凭据/配置文件**（`path` 支持 `~` 展开与绝对路径，`stat` 跟随符号链接，不做逃出拦截）。请在**可信局域网**部署（勿暴露到公共 WiFi/互联网），或自行在网络层配置**会话鉴权 / API 前缀白名单**后再对外。被穿透后的后果由部署方承担——本插件按下方"不做重复兜底"条款不提供插件层访问控制。
- **保留 loopback 围栏**：所有 `/api` 路由强制校验回环来源（跨站 / DNS 重绑定防护），与平台既有约定一致；`health` 之外的 /file、/diff 也仅允许 GET（方法不符 405）。该围栏对**本机/回环直连**有效；对经代理的局域网访问生效与否取决于代理是否重写 Host/Origin（见上一条）。
- **不做重复兜底**：本插件的语义是“能打开 dsh web 页面即已持有高权限”，因此**不做**任意文件访问强校验、会话鉴权、敏感名拦截——访问控制由平台/用户负责，本插件不重复实现每一套。
- **路径定位**：`/file` 按 `resolve(cwd, path)` 直接定位，不做“逃出 cwd”拦截（任意文件访问由平台/用户负责）。`~`/`~/` 前缀展开为用户主目录。
- **渲染安全**：文件响应一律带 `X-Content-Type-Options: nosniff`；SVG 额外带 `Content-Security-Policy: sandbox`（顶层导航时不执行内嵌脚本）。Markdown / 代码渲染输出为 HTML 呈现层，`marked` / `highlight.js` 对正文做转义；本插件不承诺对渲染结果做 XSS 消毒——预览内容来自会话已见的文件，安全边界同“能打开 dsh web 即高权限”。
- **Mermaid 图表（issue #104，新增用户可影响渲染面）**：md 文件内的 ` ```mermaid ` 块由 mermaid 引擎渲染。默认 `securityLevel: "strict"`（文本转义、禁用 click 交互回调）+ `htmlLabels: false`（标签走纯 SVG text）+ `startOnLoad: false`（仅手动按块渲染）；渲染产物 SVG 在插入 DOM 前再经 DOMPurify（svg profile）二次消毒——`foreignObject` 默认剔除、不开放 `securityLevel`/主题等配置项。主题仅随系统 `prefers-color-scheme` 在 default/dark 间自适应，不接受文档内容控制。与上条边界一致：图源来自会话已见文件，strict + 双层消毒是纵深而非安全承诺。
- **`@` 引用不新增安全面**：`data-ref-chip`/`title` 仅经 `getAttribute` 读取并作为路径字符串拼 `URLSearchParams`，从不 `innerHTML` 渲染；清洗后的文件路径仍走 `/file` 既有 loopback/cwd 围栏（相对路径强制 cwd、绝对路径沿用既有进程可读范围），与「deliverable chip 预览」同一安全模型。
- **HTML serve 路由（issue #73，新增「目录→web root」映射）**：`/serve/<token>/<rest>` 把 token 登记的目录映射为可访问 web root，是安全模型变更点，**刻意与 `/file` 相反**做严格防护：
  - **`realpath` 双向根越界校验**：token 分配时 `root = fs.realpath(dir)`；请求时对目标再次 `realpath` 后判定仍落在 root 内——**闭合符号链接逃逸**（`root/link -> /etc`）一律 404；`..`/`.` 段、`%2e%2e`/`%2f` 编码、NUL、交替分隔符（`\`）、绝对路径等编码攻击面一律 404（不越界、不 5xx）；
  - **目录请求 404**，不做目录列表（不泄露目录内容）；root 越界 404；
  - **只读伺服、不落盘不拷贝**：token 映射为内存态，进程崩溃即消失；`release` 显式释放 + idle TTL（默认 30min）+ LRU 上限（默认 64，不淘汰活跃预览）三重回收；
  - **iframe sandbox 无脚本**：客户端以 `<iframe sandbox>`（**无 `allow-scripts`、无 `allow-same-origin`**——两者同开隔离失效，禁止）渲染，HTML 内 `<script>` 不执行（首版边界，二期独立红线）；iframe `referrerpolicy="no-referrer"` 防外部资源收到含 token 的 Referer；
  - **`/file` 对 `.html/.htm` 保持 `text/plain`**：若改为 `text/html`，新标签/顶层直接访问 `file?path=foo.html` 会成为同源顶层脚本执行通道——serve 的 `text/html` 只作用于 `/serve` 沙箱路径；
  - **loopback 围栏不放宽**：serve/alloc/release 与 `/file` 同围栏（非回环 403 / 非 GET 405）；LAN / 移动端 HTML 预览经 `dsh-lan-proxy` 现状穿透，风险沿用上方局域网部署高危告警，插件层不为 HTML 放开围栏；
  - 响应统一 `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`；不设 `Access-Control-Allow-Origin`（压抑 iframe 内 fetch 数据外联）。

## 已知限制

- 文本类超过 `maxTextBytes`（默认 20MB）返回 413+截断标记，不再整读全文（大文件流式/虚拟滚动未实现，见 W10 专项）；客户端对 >1MB 的超大文本降级为纯 `<pre>` 截断渲染（原始 tab / 新标签可看全文）。
- HTML 预览（issue #73）已知限制：iframe 内 `fetch`/XHR 在 opaque origin 下因 CORS 被阻断（属预期，静态子资源加载不受影响）；**根绝对路径**（`<script src="/assets/app.js">`）不支持——浏览器按服务器 origin 解析会请求 dsh web 根，与 token 虚拟伺服不一致（支持需注入 `<base>` = 改写 HTML，属更高风险选项，另行决策）；iframe 内导航（SPA 路由 / 页面跳转）不进 Modal 返回栈；**预览长期不交互可能失效**（serve token idle TTL 30min 兜底回收，关闭 Modal 会显式释放）；**预览期间 root 目录被移动/删除后预览失效**（只读伺服不落盘语义，需重新打开）。
- 可点击范围较宽（凡路径 title / 本地 href / 内联路径文本都可能进预览），`data-ref-chip` 权威分支优先于通用嗅探，避免 `@` 引用误触发。
- 文件夹 `@` 引用不开预览（仅提示），目录浏览能力不在本插件范畴。
- client bundle 含 `marked` + `highlight.js` 子集 + `diff2html`，min 后约 550KB（gzip ~120KB）。
- Mermaid 懒加载 chunk 全量约 3.29MB min / ~940KB gzip（整库内联、不做按图类型裁剪——与业界惯例一致，见 issue #104 复核结论；首次渲染 mermaid 块时一次性拉取，低带宽首图延迟明显）。
- 多会话切换以当前活跃会话 cwd 为准。
