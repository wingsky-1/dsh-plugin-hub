# dsh-web-file-preview 适配 rc8 `@` 引用 — 对抗性评审与阶段性实施计划

> 状态：**已实施**（2026-08，PR #5）。
> 范围：方案 1（修 `@file` 冲突）+ 方案 2（`@file` 即点即预览）。
> 评审方式说明：本环境独立子 agent 评审机制不可用（前台两次启动失败、后台异步退出无回执），
> 故由主会话以多维度对抗视角直接评审，维度与 `AGENTS.md` 规则 4 一致（正确性/边界、性能/资源、
> 安全、可维护性、兼容性、规范冲突、过度设计、可测性）。

## 1. 背景与冲突根因

rc8 的 `@` 引用由 `@deepseek-ai/dsh-client-ui-reference` 实现：输入框 `@` 菜单聚合文件/文件夹
（`ctx.remote.fileReferences.list()`）与会话（`ctx.remote.sessionReferenceResolver.candidates()`）两类发现；
发送后对话气泡由 `packages/client/ui-conversation/src/client/chat/MessageItem.tsx:156-213`
的 `projectUserText` 把引用渲染成带域图标的 `refChip`：

| 引用类型 | 渲染形态 | `title` 内容 |
|---|---|---|
| 文件 | `<span data-ref-chip="file" …>` | `@/abs/path/file.ts`（带前导 `@`） |
| 文件夹 | `<span data-ref-chip="folder" …>` | `@/abs/path/dir/`（带前导 `@`、尾 `/`） |
| 会话 | `<span data-ref-chip="session" …>` | `@label` |

`title` **始终带前导 `@`**，引号路径还带引号；chip **当前无 onClick**（点击无反应）。

预览插件客户端 `src/client/index.ts` 靠 document 捕获点击 `onClickCapture` → `findFileLink(target)`
（`src/client/index.ts:161-182`）→ `openPreview(path, cwd)`。`findFileLink` 向上爬祖先匹配三类信号：
`title` 属性 `isPathLike` / `<a href>` `isPathLike` / CODE·SPAN·A·BUTTON 内联文本 `isPathLike`。
`isLikelySingleFilePath`（`src/grouping.ts`，双端单一事实源）**不排斥前导 `@`**，接受含已知扩展名且含 `/`
的路径 → `isLikelySingleFilePath("@/abs/path/file.ts")` 为 `true`。

**冲突（bug）**：`@file` chip 的 `title="@/abs/path/file.ts"` 被通用嗅探命中，`findFileLink` 调
`openPreview("@/abs/path/file.ts", cwd)`，宿主 `stat` 不存在的 `@/abs/…` → ENOENT → **404 坏预览**。
folder/session chip 因无扩展名当前恰为 no-op，但标题形如 `foo.ts` 的会话 chip 也会被误拦。

## 2. `@` 引用能力支持矩阵（本插件视角）

| 能力 | 支持度 | 处置 |
|---|---|---|
| **文件引用** `@path` / `@"…"` | ✅ 完整（核心） | 用干净路径复用现有 Modal（图片/MD/代码/文本/Diff + 大文件 413 兜底） |
| **文件夹引用** `@path/` | ⚠️ 识别、给友好提示 | 无目录浏览能力；点 folder chip 弹轻量提示，不开 Modal |
| **会话引用** `@[label](dsh-session:…)` | ❌ 不支持 | 与文件预览正交；显式忽略 `data-ref-chip="session"` |
| 对话内联图 embed / composer 候选 peek | ❌ 可行性低 | 需 core 扩展点（`ui-conversation`/`ui-input-trigger`），后置、不在本计划 |

## 3. 对抗性评审结论（多维度）

### 3.1 正确性与边界
- `cleanRefChipPath` 与 `formatFileMention` 互逆，边界已逐项核对：
  - `@/a/b.ts` → `/a/b.ts`；`@"a b/c.ts"` → `a b/c.ts`（引号去除）；
  - **路径内含 `@`** 如 `node_modules/@scope/x.ts`（mention 为 `@node_modules/@scope/x.ts`）
    → 仅去**一个**前导 `@` → `node_modules/@scope/x.ts`（正确，不误删 scope 的 `@`）；
  - 文件 mention 由 `formatFileMention` 保证**不带尾 `/`**（尾 `/` 仅目录），故 file 标题无尾 `/` 情形；
  - `title` 缺失但 `data-ref-chip="file"`：`cleanRefChipPath("", "file")` → `null` → 该节点 `continue`、
    不拦截（合理：无路径无法预览，且不恶化）。
- **ref-chip 与通用嗅探的交互**：ref-chip 检查置于循环**最前**。命中 `file` 且解析成功→`return`；
  `folder`/`session`/`skill`/解析失败→`node = node.parentNode; continue`。`continue` 只跳过**本节点**的
  title/文本嗅探，下一轮仍正常评估**祖先**的 title/href/text（不会误跳过祖先合法链接）。✓ 无双重匹配。
- **ref-chip 嵌套在 `<a>` 内**：从 `event.target` 向上第一个 ref-chip 即被处理并 `return`，`<a>` 不再被使用——
  对 `@file` 引用这是正确优先级（引用即文件），无副作用。
- **`data-ref-chip` 与 `title` 形状不一致**（极端）：以 `data-ref-chip` 为权威门，但 `cleanRefChipPath`
  对 `file` 接受任意可解析标题；若标题无法解析则降级为不拦截。不抛出、不误开。

### 3.2 性能与资源
- 每个祖先多一次 `getAttribute("data-ref-chip")` 读取，O(深度) 常量成本，可忽略；无新监听、无新模块级状态。
  现有 `openSeq`/`activeAbort` 代数门禁对 ref-chip 路径与既有路径完全一致复用。✓

### 3.3 安全
- **路径穿越**：清洗后的路径仍经 `openPreview`→`fileUrl`→宿主 `serveFileRoute` 现有 loopback 围栏与
  cwd 校验（相对路径强制 cwd；绝对路径沿用既有进程可读范围——这与现有"deliverable chip 预览"行为一致，
  **非新引入的回归面**）。`title` 由 dsh 自身渲染产出，非外部注入新通道。
- **XSS**：`title` 仅经 `getAttribute` 读取并作为路径字符串传入 `URLSearchParams`，**从不** `innerHTML`；
  Modal 标题用 `el(..., { text: path })`（`textContent`），友好提示文案为**硬编码字符串**。无注入面。✓
- **不削弱既有围栏**：改动只动客户端识别逻辑，不动宿主路由/围栏。✓

### 3.4 可维护性
- `cleanRefChipPath` 落 `src/grouping.ts`（双端单一事实源，与 `isLikelySingleFilePath` 同处，smoke 可直测），
  不引入 harness 内部 `file-reference/grammar` 依赖（插件自包含）。✓
- `findFileLink` 返回值：去掉冗余 `via`，仅用 `kind: "file" | "folder" | undefined` 判别——
  `file`→`path` 有值；`folder`→`path:null`+`kind:"folder"`；`null`→未命中。判别干净。✓

### 3.5 兼容性
- **明暗主题**：友好提示元素用 `--dsw-alias-*` 主题变量 + 浅色回退，写入 `src/client/style.css`
  （build-client 内联，不游离 css）。
- **三端访问形态**：捕获阶段委托已对触摸点击生效（iOS/iPad/Windows 桌面一致）；提示定位为底部居中
  `role="status"` toast，自动消失、可点关，**不遮挡 chip**；若可点则触控目标 ≥44px（safe-area 适配）。
- **跨包耦合脆弱性（主要风险）**：`data-ref-chip` / `title="@…"` 形态由 dsh core（`ui-conversation`）产出。
  若未来该形态改名，`data-ref-chip` 门失效 → file chip 退回"点击无反应"（非 404，属**静默降级**，可接受）；
  `title` 语法（`@` 前缀 + 引号）与 `formatFileMention` 同源契约，相对稳定。
  **缓解**：README 显式记录该跨包契约假设；`cleanRefChipPath` 对 `@`/引号解析保持鲁棒；
  若 dsh 未来提供干净路径属性（如 `data-ref-path`），优先采用（开放问题，非本次实现）。

### 3.6 与规范冲突
- hub 干净模块：客户端仅改 `src/client/index.ts`（单一入口），共享纯逻辑在 `src/grouping.ts`；不改 DSH 源码。✓
- 不新增第三方库。✓
- 契约门禁：`pnpm contract` 校验 load id===包名、`apply/inject` 装配——本次不改动这些，门禁不受影响。✓
- 阶段 commit：A（grouping+smoke）与 B+C（client）分两个独立收口 commit。✓

### 3.7 过度设计
- **folder 友好提示 vs 替代方案**：
  - (a) 轻量 toast（采用）：~20 行 + 少量 CSS，符合本插件"给反馈、不静默失败"的一贯取向（U2/U9）。
  - (b) 直接忽略 folder（零新 UI）：最省，但用户点了无反应、困惑。
  - (c) 开 Modal 报错态：复用但需拉起 Modal 机制，成本高于 toast。
  - 结论：**采用 (a)**，控制为最小 toast，不膨胀。
- 已去掉 `via` 冗余字段（§3.4），避免返回值过度设计。

### 3.8 可测性与验证
- `cleanRefChipPath` 纯函数 smoke 断言（加在 `test/smoke.ts`，与 `isLikelySingleFilePath` 断言并列）：
  - `@/a/b.ts`→`/a/b.ts`；`@"a b/c.ts"`→`a b/c.ts`；`node_modules/@scope/x.ts`→`node_modules/@scope/x.ts`；
  - `@/a/dir/`→`/a/dir/`（folder，保留尾 `/`）；`""`→`null`；`appearance==="session"`→`null`。
- **DOM 拦截行为**（无单测台，按 hub §7 用**浏览器 MCP 真点**验证，fixture 放 `fwp-verify/`，不发布）：
  - 构造含 `@/abs/path/file.ts` 的 refChip（`data-ref-chip="file"` `title="@/abs/path/file.ts"`），点击 →
    Modal 打开且 `fwp-title` 文案为**干净路径（无前导 `@`）**、内容正确加载；
  - folder chip 点击 → 出现 `role="status"` 提示、不开 Modal；
  - session chip 点击 → 无任何拦截（无 Modal、无提示）。

## 4. 最终设计（修订后）

### 改动 A — `src/grouping.ts` 新增（双端单一事实源）
```ts
/**
 * 从对话渲染的 @-mention chip 标签还原干净文件路径（formatFileMention 的逆）。
 * @param raw - chip 的 title 属性，如 "@/abs/path/file.ts" 或 '@"a b/c.ts"'。
 * @param appearance - chip 的 data-ref-chip 取值。
 * @returns 干净路径；非文件类或无法解析 → null。
 */
export function cleanRefChipPath(raw: string, appearance: 'file' | 'folder' | 'session' | 'skill'): string | null {
  if (appearance === 'session' || appearance === 'skill') return null;
  if (typeof raw !== 'string' || raw === '') return null;
  let s = raw.startsWith('@') ? raw.slice(1) : raw;        // 去一个前导 @
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1); // 去引号（含空格路径）
  if (s === '') return null;
  return s; // folder 保留尾 /；file 由 formatFileMention 保证无尾 /
}
```
（host 侧 `lib/` 为构建产物，改动后须 `pnpm build` 同步。）

### 改动 B — `src/client/index.ts` 的 `findFileLink`（161-182 行）
在祖先循环**最前**、现有 title/href/文本检查之前插入：
```js
const chip = node.getAttribute ? node.getAttribute("data-ref-chip") : null;
if (chip !== null && chip !== "") {
  if (chip === "file") {
    const clean = cleanRefChipPath(node.getAttribute("title") || "", "file");
    if (clean !== null) return { path: clean, node, kind: "file" };
  } else if (chip === "folder") {
    return { path: null, node, kind: "folder" };
  }
  // session / skill / 无法解析的 file：跳过本节点，继续向上（避免误匹配 "@label"）
  node = node.parentNode;
  continue;
}
```

### 改动 C — `src/client/index.ts` 的 `onClickCapture`（789-804 行）
`findFileLink` 返回后分支：
```js
const hit = findFileLink(event.target);
if (hit === null) return;
if (hit.kind === "folder") { showFolderNotice(); return; } // 轻量 toast，不开 Modal
// file（含既有 deliverable/link 命中）：原逻辑不变
event.preventDefault(); event.stopPropagation();
openPreview(hit.path, activeCwd());
```
`showFolderNotice()`：注入 `role="status"` 小元素（主题变量样式、自动消失、可点关），文案硬编码
「文件夹无法在 web 端预览，请使用文件树打开」；样式入 `src/client/style.css`。

### 不变
机制 A（`wrapOpenPath`）、宿主路由、loopback 围栏、`openPreview`、Modal、a11y/滚动/灯箱、`groupOfPath` 全部不变。

## 5. 阶段性实施计划

### 阶段一：纯函数 + 单测契约（低风险、可独立收口）
- A：`src/grouping.ts` 加 `cleanRefChipPath`（含 JSDoc）。
- `test/smoke.ts` 加上述纯函数断言（含 `@` 内含、`node_modules/@scope`、引号、空、session→null）。
- 门禁：`pnpm build && pnpm test`（smoke）+ `pnpm contract`。
- 提交：`feat(preview): 新增 cleanRefChipPath 解析 @-mention chip 标签`。

### 阶段二：客户端识别与交互（核心修复）
- B：`findFileLink` 加 ref-chip 权威分支（`file`→干净路径 / `folder`→`kind:"folder"` / 其余 `continue`）。
- C：`onClickCapture` 分支（`folder`→`showFolderNotice()`；`file`→原 `openPreview`）。
- 新增 `showFolderNotice()`（DOM 注入 + 自动消失），样式入 `src/client/style.css`（明暗主题变量 + 浅色回退）。
- 门禁：`pnpm build && pnpm test && pnpm contract && pnpm pack:check`。
- 浏览器 MCP 真点验证（fixture `fwp-verify/`）：file chip→干净路径 Modal；folder→toast；session→无拦截。
- 提交：`fix(preview): 适配 rc8 @-mention chip，修复 @file 点击 404 并支持 folder 提示`。

### 阶段三：收尾与文档
- README（中文 + 英文）补充「`@` 引用适配」小节：支持矩阵 + 跨包契约假设 + 安全模型不变声明。
- `docs/TECH-DEBT.md` / 本文件状态更新为「已实施」。
- 全量门禁复核 + 运行时产物 rev/size 比对；**若运行 dsh web 进程加载的是旧 lib，需用户/平台重启才生效**
  （红线：agent 不代操作 dsh web）。

## 6. 待确认决策点（实施前）
1. **folder 提示形态**：采用 (a) 轻量 toast（本计划默认）；或 (b) 直接忽略（零新 UI）。
2. **跨包契约**：`data-ref-chip`/`title="@…"` 由 dsh core 产出，本插件按此假设实现；若 dsh 后续提供
   干净路径属性（如 `data-ref-path`），下个迭代优先采用（开放问题，非本次阻塞）。

## 7. 开放问题（非阻塞，后续可议）
- 是否对 `cleanRefChipPath` 失败增加「去 `@`+引号后 `isLikelySingleFilePath` 兜底」以进一步抗 core 形态漂移
  （当前认为 `data-ref-chip` 门已足够，避免过度设计，暂不加）。
- 是否在未来把 file chip 点击同时接 `workspaces.openPath`（机制 A）以获得更统一的入口
  （当前 chip 无 onClick，走机制 B 即可；若 core 未来为 chip 加 openPath 调用，机制 A 已自动覆盖）。
