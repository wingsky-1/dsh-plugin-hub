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

### W10（大文件）—— 方向正确，3 处修正

1. 413 截断有界防 OOM（stat 判定、不 readFile、每请求 O(1)），但**必须在 ETag/304 之前**（否则带缓存标签的超限文件被 304 短路、永远不进 413）——已并入 C6 实现；`?raw=1` **砍掉**（破坏有界保证；「新标签打开」已是等价语义）。
2. diff 截头尾有缺陷 → 升级为 `git diff --stat` 摘要 + 截断 + `diffTruncated:true` + 客户端先摘要后详情；`maxDiffBytes=200KB`（normalizeConfig 可配）。
3. 「新标签打开」大文本在 iOS 是「一个卡死拖进另一个卡死」→ 增加「下载」按钮（`a[download]` 纯前端）+ 文案「未全文渲染，可下载完整文件」；md/code 阈值建议 256KB（text 仍 512KB）。
- 语义：**413 而非 416**；413 body `{error,truncated:true,size,max}` + `Cache-Control: no-store`（已在 C6 落地）。

## 6. 明知但有意不做

- S1：平台治理面，README 已声明；后续应放 lan-proxy 的「会话鉴权/API 前缀白名单」层解决。
- U4：Ctrl/Cmd+单击与中键（auxclick）语义保持现状（桌面习惯保存）。
- 空 `catch` 保留：现有静默分支维持到对应改动重启之后（按阶段逐项解决）。

## 7. 进度记录

- [x] 阶段一：S2/C1/C2/C7（提交 `446e2c3`；smoke + contract + pack:check 全通过）
- [x] 阶段二：C3/C4/C5/C6（提交 `446e2c3`）
- [x] 阶段四 4a/4b：U1/U2/U3/U5/U9（提交 `21f5482`；锁滚动/剪贴板降级/识别边界/diff 状态）
- [x] 阶段四 4c：U6/U7/U11 + `/health` 405 + 死代码清理 + README.zh（提交 `40e7797`；捏合/44px/safe-area/焦点管理）
- [ ] 阶段五：最终全量回归（build/test/contract/pack 已在各 commit 通过；如需发布前再整体跑一遍）
- [ ] 专项：U8（方案已评审，按 §5.5 修正后实施；**待用户确认最终方案**）
- [ ] 专项：W10（方案已评审，整体后置；C6 的 413 文本截断已随阶段二落地；**待用户确认最终方案**）