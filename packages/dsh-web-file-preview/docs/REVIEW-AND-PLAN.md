# dsh-web-file-preview 评审结论与分阶段修复计划

> 状态：计划已评审并归档（2026-08）。实施按阶段推进；**U8（markdown 相对引用）与大文件（W10）两个专项后置，另行评审后再实施**。S1（白名单后缀文件匿名可读）与 U4（Ctrl/中键语义）为**明确不做项**，原因见范围表。

## 1. 评审背景与方法

- 对象：`packages/dsh-web-file-preview`（宿主 `src/*` + 客户端 `src/client/*` + `shared/loopback.js`）。
- 方法：全量源码精读 + 两个独立上下文对抗性子代理（宿主端/安全/性能、客户端/UX/兼容性/a11y，均可复现的实机验证）+ 实测（LAN 3443 转发链路、白名单文件可读边界、`nosniff` 缺失、md 响应头）。
- 部署现实（影响定级）：dsh web 部署于 Linux，经 dsh-lan-proxy（0.0.0.0:3443/3081 → 127.0.0.1:3080）供局域网 Windows/iPad/iPhone 访问；lan-proxy 重写 Host/Origin 后，插件的 loopback 围栏防线被穿透（实测 health 200）。

## 2. 范围决策

| 项 | 决策 | 理由 |
|---|---|---|
| S1 白名单后缀文件匿名可读（P0，平台面） | **不做** | 属平台/部署治理（lan-proxy 会话鉴权、转发表）；插件 README「安全模型」已声明不兜底；修在插件层属重复实现 |
| S2 响应安全头 + SVG 处置（P1） | **做** | 低成本高价值；阻断「新标签导航渲染 SVG 内脚本」的同源 XSS 通道 |
| C1+C2 打开竞态「串文件」+ 无 AbortController（P1） | **做** | 正确性命门；快速开关 Modal 会显示错文件 |
| C3+C4 diff 同步 `spawnSync` 阻塞 SSE；`maxBuffer` 1MB 静默丢 diff（P1/P2） | **做** | 阻塞宿主事件循环，数十个打开即卡死对话流 |
| C5 cwd 必需但绝对路径不需要（P2） | **做** | 无 cwd 会话预览全 400，文案误导 |
| C6 `maxTextBytes` 死配置（P2） | **做** | 实现或删除——选实现（425/413 截断），并同步 README |
| C7 stat↔readFile TOCTOU 错误码漂移（P2） | **做** | 同根因同码（ENOENT/EISDIR→404） |
| U1 移动端滚动穿透（P1） | **做** | 锁 body 滚动 + overscroll-behavior |
| U2 剪贴板三态静默失败（P2） | **做** | 降级 `execCommand` + `.catch` 提示 |
| U5 识别边界误拦/漏拦（200 截断、BUTTON 文本、单空格拼接）（P2） | **做** | 提长度、扩嗅探范围、修正拼接判定、选中态不拦 |
| U9 diff 探测无反馈/静默失败（P2） | **做** | 状态化提示 + 失败重试 |
| U6 灯箱无捏合 / U7 触控目标 / U11 a11y 焦点与细节（P2/P3） | **做**（4c） | 移动端体验一致目标 |
| U8 markdown 相对引用 404 + 无 target（P2） | **专项后置，先评审** | 方案已在文内；待评审通过后实施 |
| W10 大文件/大 diff 全量渲染（P2，少见场景但关键） | **专项后置，先评审** | 先服务端兜底（截断 413）+ 客户端降级；懒渲染/流式后议 |
| U4 Ctrl/中键被吞/被绕（P2） | **不做** | 用户决策：保持现有语义 |

## 3. 分阶段实施计划

### 阶段一：正确性根基（竞态 + 传输安全）
- S2：`routes.ts` 全部 200 响应加 `X-Content-Type-Options: nosniff`；SVG 二进制分支 `Content-Disposition: inline; filename=…`（阻断「新标签导航渲染执行脚本」）。
- C1+C2：`client/index.ts` 预览状态机重建——每次打开自增代数（`openSeq`）+ `AbortController`；三方 fetch 计代数校验，落地不一致即弃；`rawText/diffText/diffUntracked/previewMode` 由模块级迁至本次打开的闭包级对象；`trackedObjectUrl` 泄漏修复。
- C7：`routes.ts` 文本/图片 catch 区分 `ENOENT/EISDIR` → 404，其余 500。
- 回归：smoke 增 nosniff 断言；`seq` 竞态在纯函数层可测的部分；**错误码**用例。

### 阶段二：宿主性能与配置兑现
- C3+C4：`git.ts` `spawnSync` → `execFile`（promisify，保持 3 步顺序，非阻塞），`maxBuffer: 32MB`，失败与「无 diff」分流（新 `reason:"error"`）；`/diff` handler 异步化并 try/catch。
- C5：`serveFileRoute` 绝对路径免 cwd；相对路径仍强制 cwd。
- C6：读完 `stat.size` 超 `maxTextBytes` → 413 `{error,truncated:true,size}`（与 W10 服务端机制同源）。

### 阶段三→阶段五：体验一致与收尾
- 4a：U1（锁滚动）、U2（剪贴板降级）。
- 4b：U5（识别边界）、U9（diff 状态提示）。
- 4c：U6（双指捏合）、U7（触控 ≥44px + safe-area）、U11（a11y 焦点 trap/还原、aria-label、img 失败兜底新标签、`/health` 405、删 `.fwp-diff-*` 死代码、补 README.zh）。
- 收尾：全量门禁 `pnpm build && pnpm test && pnpm contract && pnpm pack:check`；README（含安全模型 LAN 现状、配置表、编码已知限制）。

## 4. U8 专项草案（后置，待评审）

**思路**：客户端 DOMPurify `afterSanitizeAttributes` hook 将 markdown 内**相对引用**（`./a.png`、`../b.md`、根相对）重写为 `API.file?cwd=…&path=<resolve(dirname(当前文件),rel)>`；`img[src]` 走预览 API，`a[href]` 重写后加 `target="_blank" rel="noopener"`。

**约束/边界**：
- 新建 `resolveRelPath(base, rel)` 纯函数（±20 行）；仅重写相对路径，`http(s)/mailto/#/?/data:` 保留；解析结果落在 cwd 内才重写（否则保留原语义）。
- 不做宿主端正则改写（与渲染器耦合、易错）；不引入新 npm 依赖。
- 测试：纯函数单测（相对/绝对/越界/`..`/解码）+ Modl 渲染 smoke。

### 开放问题（评审焦点）
1. 重写范围：只 `img[src]` 还是含 `a[href]`？（首版建议都做，a 走新标签）
2. 越界行为：保留原 href（原生） vs 灰化提示？
3. 是否给 markdown 链接补 `target="_blank"`（防 SPA 内整页导航丢上下文）？

## 5. W10 大文件专项（后置，先评审）

- 目标：防「服务端整读 OOM（Buffer+String 双倍）+ 客户端全量 DOM 冻死」。
- 首批建议：服务端截断（文本 >512KB → 413+`truncated`；图片 >32MB → 413；`/diff` >200KB 截头尾+`diffTruncated`），客户端对 413 给「文件过大」提示 +「新标签打开」兜底。
- 冻结项：类目边界、不引第三方渲染。
- 后议项：客户端懒渲染（首 2000 行 + 加载更多）、流式（TransformStream）——低价、场景少，仅在真实需求出现时再做。

## 5.5 U8/W10 专项对抗性评审结论（2026-08 归档）

### U8（markdown 相对引用）—— 可行，按以下修正后实施
- 方法定案：DOMPurify `afterSanitizeAttributes` hook（非 marked renderer），统一覆盖 md 输出与 raw HTML；封装 `sanitizePreview(html)` 统一 index.ts:320/323/364 三处 sanitize；**禁止 `DOMPurify.addHook` 全局注册**（生命周期不可控、与同页插件互相污染）。
- 硬伤 1：`data:` URI 在 `afterSanitizeAttributes` 阶段已被 URI 白名单剥离、读不到原值 → 需改用 `uponSanitizeAttribute`（可改写/阻止剥离）；相对路径（`./`、`../`、裸名）默认**不会被剥离**（方案地基成立，需 smoke 固化）。
- 硬伤 2：路径展开用 `new URL(rel, "file://" + base)`（勿自写 parser）；`%20` 需 `decodeURIComponent` 后再入 `path`；`?query` 丢弃；绝对路径 `/x.md`、`http/mailto://`、协议相对 `//` 保留；**越界 cwd 照常重写**（服务端本不拦逃逸；「保留」=死链）；重写后 `a` 打 `data-fwp-referenced-file` 标记 + `findFileLink` 显式排除（防二次拦截，勿依赖 overlay 豁免偶然性）；`rel` 追加而非覆盖。
- 硬伤 3（与 W10 交点）：md 内嵌图重写为 `<img src="/api/...">` **直连**会撞「HTTP/1.1 + SSE 占满连接池 → 低优先级图片排队」老坑（index.ts 图片注释的自踩坑）→ 写为已知限制；重写 img 挂统一 `onerror` 占位。
- 附加：重写幂等（URL 已以 API 前缀开头 → 跳过）。

### U8 v2（2026-08，基于用户质询的修订，待实施）

**质询 1：query 传超长路径可行性** —— 已实测定量：
- Node 默认 `maxHeaderSize` 16KB，超长 URL 返回 **431**（约 20KB path 实测 431；约 9KB 可正常到达服务端，404 为文件不存在）。
- 现实路径量级：本工作区含深层 node_modules 的最长路径 **284 字符**（编码后 ~1KB），日常工作目录更短——距 16KB 极限差一个数量级。
- 处置（v2）：客户端重写前校验「编码后 ≥ 8KB 不重写、保留原链接」（防极端/恶意长度）；服务端 431 天然兜底（无 OOM/危险面）；smoke 断言 8KB 边界与 431 行为。

**质询 2：内嵌图传输复用 fetch→blob，避免直连排队** —— 采纳，从「已知限制」升级为实现项：
- 渲染（innerHTML）后统一「blob 化」：遍历重写标记的 `img[data-fp-ref]` → `fetch(API_URL, { signal: 本次预览 signal })` → blob → objectURL → 替换 `img.src`（与 Modal 主图同一条高优先级通道，可取消、可管理）。
- objectURL 注册进「本次预览对象清单」，`closeModal` 统一 revoke（不泄漏）。
- 任一图失败（fetch 或解码）→ 占位态 + 保留原 `src`（可新标签/长按查看），不阻塞其它图。
- `<a href>` 仍保留 API URL（新标签是唯一正解，无需 blob）。
- 代价：多图异步闪现（可加 loading 占位样式）；渲染后额外一轮 DOM 遍历。

### U8 引用面全量分析（2026-08 归档）

Markdown 中可能引用其他文件的语法面，逐一分析「渲染去向 → 是否被现有 hook 覆盖 → 处置 → 风险」：

| # | 语法/标签 | marked 渲染结果 | DOMPurify 行为 | U8 hook 是否覆盖 | 处置与风险 |
|---|---|---|---|---|---|
| 1 | 内联链接 `[t](url)` | `<a href>` | 保留 | ✅（`afterSanitizeAttributes` 遍历 a） | 见 v2；「url 指向 .md」时的跳转语义见决策点 D1 |
| 2 | 内联图片 `![a](url)` | `<img src>` | 保留 | ✅ | v2 blob 化（见上） |
| 3 | 参考式链接 `[t][r]` + `[r]: url` | 最终仍是 `<a href>` | 保留 | ✅ 天然覆盖（hook 只管 DOM） | 无额外成本 |
| 4 | 参考式图片 `![a][r]` | `<img src>` | 保留 | ✅ 同上 | 无额外成本 |
| 5 | raw HTML `<img src>` / `<a href>` | 原样透传 | 保留 | ✅ 覆盖（选 hook 方案的核心理由） | 与其他来源行为一致 |
| 6 | raw HTML `<iframe src>` / `<object data>` / `<embed>` | 透传 | **默认移除**（白名单不含） | 无节点可处理 | 不会渲染也不会泄露；如需嵌入类内容＝扩展白名单（不推荐，风险大），标注「不支持」 |
| 7 | raw HTML `<video src>/<audio src>/<source>` | 透传 | **默认移除** | — | 媒体内容不渲染（显示为空）；如需支持＝扩展白名单+blob 化（决策点 D3） |
| 8 | 协议相对 `//host/x` | `<a href>` | 保留 | 跳过不重写（v2 已定） | 指向外域，原样保留即正确 |
| 9 | `data:`(img base64) | `<img src>` | img 的 data: 在默认 URI 白名单内保留 | 需 `uponSanitizeAttribute` 判定（不能靠 after 钩子） | 本地内联图**无需重写**（本来就是完整数据）；hook 必须避免误重写 |
| 10 | `file:///…` | `<a href>` | 保留（非脚本协议） | 跳过不重写 | 浏览器不会导航 file:（现代浏览器 block）→ 点击无动作；可加 title 提示「本地路径在 web 端不可打开」 |
| 11 | 绝对路径 `/etc/x` | `<a href="/etc/x">` | 保留 | 跳过（v2 定为「web 根语义」） | 若用户本意是「服务端文件」则语义不符——经当前资源体系本就不指向会话文件，可接受 |
| 12 | `#anchor` / `?query` 尾巴 | href 原样 | 保留 | 丢弃 fragment/query 再重写（v2 已定） | 已处理；`#` 需防误入 path 参数 |
| 13 | 嵌套在 blockquote/列表/表格里的链接 | 仍为 a/img 节点 | 保留 | ✅ hook 按节点处理，天然覆盖 | 无 |
| 14 | `%20`/实体解码 | href 为字面编码 | 保留 | `decodeURIComponent` 后入 `path`（v2 已定） | 已处理 |
| 15 | 文件名含空格/中文/`#`/`?` | 原样 | 保留 | `new URL` 规范化 + 编码 | v2 已覆盖；smoke 断言 |
| 16 | md 内链接到其它 md | `<a href="02.md">` | 保留 | hook 重写为 API URL | **决策点 D1**：新标签打开原文 vs Modal 内跳转预览（后者更贴近「阅读文档」预期，需内部导航处理） |
| 17 | 大量内嵌图（N 张） | N 个 `<img>` | 保留 | blob 化逐一 fetch | **并发上限**（决策点 D4）：如同时在途 ≤6、其余惰性加载；关闭时全部 revoke；避免 N×OOM/连接池占满 |
| 18 | 链接到不可预览后缀（`.zip`） | `<a href>` | 保留 | 重写后仍走 file API → 415 | 点开是 415 提示；应改为「不改写，保留原 href 下载语义」或标注不可预览——v2 需按分组判定过滤（只重写可预览后缀） |

**风险归纳**：① 引用面全部收敛到 `<a href>` / `<img src>` 两个 DOM 节点类型（DOMPurify 白名单的天然结果），hook 单一实现点覆盖全部语法面；② 唯一系统性风险是「不可预览后缀被重写后 415」（#18）与「大量图并发」（#17），两者都在 v2 中补规则；③ `data:`、`file://`、协议相对按保留处理，不扩大引用语义。

**待用户确认的决策点（U8 v2 实施前）**：
- D1：`a[href]` 指向可预览文件时——(a) 新标签打开原文（现状 v2）；(b) Modal 内跳转预览（更像文档阅读，需加内部导航与返回栈）。
- D2：`a[href]` 指向不可预览/非白名单后缀——(a) 原样保留（浏览器下载/原生），(b) 直接不渲染链接「（不支持预览）」。
- D3：raw HTML 视频/音频——(a) 保持 DOMPurify 默认移除（内容消失但安全）；(b) 加白名单+blob 化（扩展面大，不建议首版）。
- D4：内嵌图并发上限默认 6，超出惰性排队（渲染完一批再取下一批）。

### 实施落地记录（2026-08；U8 已完成并通过浏览器 MCP 验证）

- **方法修正**：per-call `config.hooks` 在当前 DOMPurify 3.4 实测**不受支持**（被静默忽略）；实例级 `addHook` 会在无完整 window 的契约测试环境于加载期抛错。最终实现为 **「清洗后 DOM 后处理」**：`sanitizePreview` = DOMPurify.sanitize → 临时容器遍历 img/a 重写 → 返回（`src/client/rewrite.ts` + `src/relpath.ts`，纯渲染期执行、契约安全、可单测）。
- **验证结果（playwright MCP，样例 `fwp-verify/sample.md`）**：13 张相对内嵌图全部 blob 化（`blob:` 13 张、无残留 `api:` 直连）；data: 图保留；4 个内部链接全部重写（part2 / ../越界 / ?query / #fragment 归一）；zip 与绝对路径未重写；点击 part2 → Modal 内跳转成功（标题与正文切换）；关闭正常。样例数据位于仓库外工作区 `fwp-verify/`（不纳入本包发布）。

### W10 收敛结论（2026-08 用户决策）

- **采纳「简单：大文件不返回内容」**——这**正是 C6 已实现**：`/file` 先 `stat()` 拿 `info.size`，超 `maxTextBytes` 直接 `413`（不 `readFile`），且判断在 ETag/304 之前；客户端 Modal 显示「文件过大…」+「新标签打开原文」。
- **间隔延迟量化**：超限路径仅一次 stat（本地 ~μs 级，常量）；无预判整读则随文件大小线性（实测旧进程：600KB≈10ms、10MB≈60ms，且内存按 Buffer+String 双倍放大、大文件可达秒级）——**对大文件响应延迟差异相当明显，stat 预判价值成立**。
- ⚠️ **生效前提**：C6 在源码已实现，但运行中的 dsh web 进程加载的是**旧 lib**（实测 600KB 仍返回 200 即为证据）——需**重启一次 dsh web** 才使新代码生效（建 green 线，重启操作由用户/平台执行，本会话不代操作）。
- **后续增强全部后置（可做可不做）**：`maxImageBytes`（图片）、diff stat 摘要+截断、前后端「下载」按钮、md 256KB 档、懒渲染/流式。**首版不实现**。

### W10（大文件）—— 方向正确，3 处修正

1. 413 截断有界防 OOM（stat 判定、不 readFile、每请求 O(1)），但**必须在 ETag/304 之前**（否则带缓存标签的超限文件被 304 短路、永远不进 413）——已并入 C6 实现；`?raw=1` **砍掉**（破坏有界保证；「新标签打开」已是等价语义）。
2. diff 截头尾有缺陷 → 升级为 `git diff --stat` 摘要 + 截断 + `diffTruncated:true` + 客户端先摘要后详情；`maxDiffBytes=200KB`（normalizeConfig 可配）。
3. 「新标签打开」大文本在 iOS 是「一个卡死拖进另一个卡死」→ 增加「下载」按钮（`a[download]` 纯前端）+ 文案「未全文渲染，可下载完整文件」；md/code 阈值建议 256KB（text 仍 512KB）。
- 语义：**413 而非 416**；413 body `{error,truncated:true,size,max}` + `Cache-Control: no-store`（已在 C6 落地）。

## 6. 明知但有意不做

- S1：平台治理面，README 已声明；后续应放 lan-proxy 的「会话鉴权/API 前缀白名单」层解决。
- U4：Ctrl/Cmd+单击与中键（auxclick）语义保持现状（桌面习惯保存）。
- 空 `catch` 保留：现有静默分支维持到对应改动重启之后（按阶段逐项解决）。

## 8. 能力 × 开源对标评审（2026-08）

对照「优先引入成熟开源库，实在没有才自写」纪律，把插件全部能力（**含本次评审改动引入的手写逻辑**）逐项与开源生态对标。结论先行：**现存自写未构成「重复造轮子」，仅两处有成熟库可替换（均为可选）**。

| 能力（来源） | 现状 | 成熟开源库 | 结论 |
|---|---|---|---|
| Markdown 渲染 | ✅ 已用 `marked` | markdown-it / remark | 保持（成熟度高，无替代收益） |
| 代码高亮 | ✅ 已用 `highlight.js` 子集 | Shiki / Prism.js | 保持（hljs 体积/性能适合；Shiki 2MB+ 过重） |
| Diff 渲染 | ✅ 已用 `diff2html` | jsdiff+自渲染 | 保持（行号/折叠既有） |
| 输出消毒 | ✅ 已用 `DOMPurify` | — | 保持（U8 重写复用其 hook 机制） |
| `~` 展开 | ✅ 已用 `untildify` | — | 保持 |
| 图片 fetch→blob 通道（含 C1/C2 的 Abort） | 浏览器原生 fetch/URL | — | 原生能力，非轮子 |
| 竞态代数门禁（C1）、AbortController（C2） | 编程模式（自写） | — | 浏览器原语约定，非库可替代 |
| git 调用（C3/C4：execFile+maxBuffer+error 分流） | 自写 60 行 | [simple-git](https://github.com/steveukx/git-js) | **不换**：本插件仅需 3 个精确命令（-C/--porcelain/--no-ext-diff）且需精确控 timeout/maxBuffer/输出语义；simple-git 引入又封一层，反增加适配面 |
| ETag/304、413 截断、错误码（S2/C6/C7） | 自写（HTTP 语义） | — | 协议层实现，无需库 |
| 路径分组/识别（grouping、U5） | 自写（~30 行） | path-browserify 等 | **不换**：client 端已用 `new URL` 规范化，宿主用 node:path；extOf/拼接判定是领域逻辑 |
| markdown 链接/图片重写（U8 v2 待实施） | `DOMPurify` hook + 自写展开 | unified/remark/rehype（如 rehype 系列） | **不换**：重写只需 20~30 行且须接入现有 marked+DOMPurify 管线；换 unified = 改整条渲染链，收益为零 |
| 剪贴板降级（U2） | 原生 clipboard + execCommand 降级 | clipboard-polyfill（轻量） | 保持（原生已覆盖；polyfill 主要补旧浏览器） |
| **灯箱手势：拖拽/滚轮/双指捏合（U6）** | 自写 ~60 行（pointer 状态机） | **[panzoom](https://github.com/timmywil/panzoom) (v4.x, 活跃)** | **可选替换**：成熟、统一 touch/pen/鼠标，~3KB gzip；代价=工具栏（zoomIn/out）需改调 panzoom API、行为微调。若替换：inline 进 bundle（dsh.client.inlineBareImports 已支持） |
| **焦点陷阱（U11）** | 自写 ~20 行（Tab 循环） | [focus-trap](https://github.com/focus-trap/focus-trap) | **保持自写**（当前仅 Modal/灯箱两个简单容器；focus-trap 增加全局 document 事件管理与插件注入的独立性冲突；20 行已可测、行为可控） |

**结论**：
- 原则「复用 > 自研」已覆盖所有大能力（渲染/高亮/diff/消毒/untildify）；本次改动引入的 C1-C7/U1-U11 全部为「浏览器/Node 原生能力 + 协议实现」，无轮子。
- 仅 **灯箱手势（U6）** 值得评估换 [panzoom](https://github.com/timmywil/panzoom)（决策 D0，可在实施 U8 v2 时一并定）：换 → bundle 体积 +3KB gzip、手势兼容性更稳（iOS/触摸边缘）；不换 → 保持依赖面最小。倾向：**首版不换**（手势自实现已过测、可控），若后续端形适配增多再换。
- 焦点陷阱保持自写；git 封装保持自写；md 链接重写保持自写（复用 DOMPurify 能力）。

## 9. 进度记录

- [x] 阶段一：S2/C1/C2/C7（提交 `446e2c3`；smoke + contract + pack:check 全通过）
- [x] 阶段二：C3/C4/C5/C6（提交 `446e2c3`）
- [x] 阶段四 4a/4b：U1/U2/U3/U5/U9（提交 `21f5482`；锁滚动/剪贴板降级/识别边界/diff 状态）
- [x] 阶段四 4c：U6/U7/U11 + `/health` 405 + 死代码清理 + README.zh（提交 `40e7797`；捏合/44px/safe-area/焦点管理）
- [ ] 阶段五：最终全量回归（build/test/contract/pack 已在各 commit 通过；如需发布前再整体跑一遍）
- [x] 专项：U8（已实施并浏览器 MCP 验证通过；含方法修正记录，见 §5.5「实施落地记录」）
- [x] 专项：W10（**收敛为「size 预判 + 413 拒绝」＝C6 已实现**；增强项全部后置；见 §5.5「W10 收敛结论」）- [x] 专项：路径兜底搜索通用化 + 宿主权威 resolved 回传（#486，见 §10）

## 10. #486 专项：宿主三级定位 + 权威路径回传（实施记录）

> 触发：`diagrams/lan-proxy-architecture.html`（相对引用目录缺 `docs/architecture` 前缀）
> web 预览 404。两轮独立对抗评审（整体方案 + 通用载体选型）+ 实测后定稿实施。

**根因**：① 客户端 `normalizeBasePath`（#479）把相对引用预归一成绝对，屏蔽了宿主 #41
basename 兜底（只对相对 path 触发）；② html 预览走 `/alloc`，该路由**无任何兜底**。

**设计原则（用户拍板）**：客户端零路径预处理，路径解析/搜索全部交由宿主端；宿主按
绝对 → 相对 → cwd 内唯一搜索三级定位；命中后回传真实 resolved，客户端以之为权威。

**实施要点**：
- 兜底搜索通用化：弃 `git ls-files`（非通用/固定 spawn 开销），改 **fdir 6.5.0**（零
  依赖、内联 <30KB、license 自动归集）+ 自写薄壳——`excludeSymlinks` + 黑名单
  （dot 目录/node_modules）+ filter+AbortSignal 真早停 + stat 收敛（>1 即弃）+
  壁钟 1500ms 超时/20000 触顶双保险。选型实测（10 万文件）：fdir 全量 76ms 最快、
  abort 早停 19ms；git 3 万文件 21.5ms 与 Node 遍历打平无优势。
- 并发去重：in-flight 合并（同 key 并发只爬一次）+ **仅缓存「完整遍历 0 命中」**的
  秒级负缓存（触顶/超时/歧义不缓存——受限搜索结论不得错当全局不存在；unit 实测
  踩坑后修正）。20 并发 miss 实测 325ms → 23.6ms。
- gitignore 语义 A1：**物理存在 + 唯一即暴露**（不解析 .gitignore）——对齐 /file 任意
  读模型，不新增访问面（被忽略文件本就经 /file 直读可达）；dot 目录跳过但 dot 文件
  （.env/.gitignore 裸名）可命中（单测钉死）。README 安全模型明示。
- `routes.ts` 抽 `resolveFile` 三级定位（file/alloc 共用）；**目录命中（EISDIR）不进
  搜索改名换读**（评审 P0-3）；分组判定统一按 resolved 扩展名。
- `/file` 成功响应加 `X-File-Path`（encodeURIComponent(resolved)，200/304 同值，>8000
  字符省略防超 Node 16KB header 上限）；`/alloc` 响应加 `path` 字段。
- 客户端：`openPreview` 移除预归一；**首响应 resolved 落地先改 currentPath 再渲染**
  （评审 P0-2，防双击渲染副作用重放）；**返回栈快照同步段捕获、resolved 落地才入栈**
  （评审 P0-1，条目恒为权威绝对路径）；probeDiff defer 发 resolved（防 Diff tab 误判
  不可用）；分组变化（入口 txt 命中真实 html）整体重建。
- `/diff` 宿主零改动（git 语义本体保留——diff 依赖 git 基线是功能依赖非搜索依赖）。

**测试**：smoke #41 段去 git 化（git 仓仅证明可用性）+ 用例 5（gitignore）翻转 + dot
目录/文件 + 绝对 path 三级全开 + X-File-Path 断言 + resolveFile 纯函数分支；unit 补
dot 文件/中文命中；esbuild data-URL 直测模块因 fdir 内联 createRequire 失效 → 改经
lib/index.js + opts 注入（测试基建适配）。

**文档**：README（能力/实现/依赖/安全模型）、docs/architecture/dsh-web-file-preview.md
（路由表/返回栈/安全）同步更新。

**新增依赖**：fdir@~6.5.0（issue #486 评审 approved；THIRD-PARTY-LICENSES 自动归集，
pack:check 断言通过）。
