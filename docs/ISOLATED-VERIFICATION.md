# 隔离环境验证指导

> 适用于本仓库 `packages/dsh-*` 的**客户端界面改动**（`src/client/**` 或宿主端 UI 渲染逻辑）
> 的浏览器实测流程。该文档从 [DEVELOPMENT.md](DEVELOPMENT.md) 的 smoke 防 flake 纪律（§5）
> 与多端兼容验证（§6）中独立出来，作为客户端 PR 的验证证据标准。
>
> 相关流程约定也见 [ISSUE-WORKFLOW.md §2](ISSUE-WORKFLOW.md#2-处理流水线维护者)（验证证据、
> 代码复核闸、收敛与冲突处理）。

## 1. 何时做

凡改动命中以下区域的 PR，**必须**做隔离环境浏览器验证并附截图：

- `packages/*/src/client/**`（客户端 UI 渲染逻辑、样式、组件）
- 宿主端涉及 UI 渲染逻辑的改动（如路由注入、URL 重写、overlay/Modal 渲染、双主题适配）
- 涉及窄屏/响应式布局的调整

**不需要**隔离验证的例外：纯文档改动、纯宿主端逻辑（不涉及 UI 渲染）、纯后端数据流变更。

## 2. 环境搭建

验证使用完全隔离的临时环境，不干扰主 checkout 的 `dsh web` 运行实例。

### 2.1 最简启动

```bash
# 工作目录：worktree 根（非主 checkout）
DSH_HOME=$(mktemp -d)
export DSH_HOME

# 从主 checkout link 插件（已构建的 lib/ 产物）
# 注意：主 checkout 路径不含 worktree 后缀
dsh link /path/to/main-checkout/packages/dsh-<name>

# 启动独立 dsh web，指定不冲突的端口
dsh web --port 3456
```

### 2.2 关键原则

- **DSH_HOME 设到临时目录**：`$(mktemp -d)` 生成唯一临时目录，防止测试数据污染
  `~/.dsh` 真实用户配置，也避免多个验证实例间的竞态（见 DEVELOPMENT.md §5.2）。
- **插件从主 checkout 的 `lib/` 加载**：`dsh link` 指向主 checkout 的 `packages/*/lib/` 产物，
  确保访问的是构建后的成品，而非源文件。
- **独立端口**：`--port <n>` 选择一个与运行中主 `dsh web` 不冲突的端口（如 3456）。
  **不要关闭或重启运行中的主 dsh web 进程**。
- **不复制真实凭据**：隔离环境使用临时 `DSH_HOME`，不携带 `~/.dsh` 下的真实凭据、
  令牌、API 密钥等。若验证需要凭据，使用测试专用凭据或 mock 数据。
- **验证完成后清理**：停止隔离 `dsh web` 进程（`kill %1` 或 `pkill -f "dsh web.*port 3456"`），
  删除临时 `DSH_HOME` 目录（`rm -rf "$DSH_HOME"`）。

### 2.3 多包验证

若改动涉及多个包（如宿主端 + 客户端配合），需同时 link 所有相关包：

```bash
for pkg in dsh-notifier dsh-mcp-manager; do
  dsh link /path/to/main-checkout/packages/$pkg
done
```

## 3. 验证方法

使用浏览器自动驾驶工具（Playwright 或 chrome-devtools MCP）在隔离环境内进行自动化验证。

### 3.1 准备工作

确保已安装浏览器自动化工具：

- Playwright：`npx playwright install chromium`
- chrome-devtools：需系统已安装 Chrome/Chromium

本仓库 `.dsh/mcp.json` 已配置 Playwright 和 chrome-devtools MCP，可在 DSH 会话中直接使用。

### 3.2 核验改动

1. **导航到改动对应的路由/页面**：使用浏览器工具的 `navigate` 或新页面打开
   `http://localhost:3456` 下的对应路径。
2. **验证 UI 呈现**：确认组件渲染正确、样式符合预期、交互行为正常。
3. **检查 Console**：使用浏览器工具的 `list_console_messages`（chrome-devtools）或
   `browser_console_messages`（Playwright）检查是否有未处理的错误或警告。
   - 重点关注：`console.error`、未捕获的异常、插件相关的 `console.warn` 消息。
   - 挂载失败只应 `console.warn` 不应 throw（见 DEVELOPMENT.md §2.3）。
4. **双主题验证**：切换明/暗主题确认颜色引用正确，无硬编码固定色值。
5. **窄屏验证**：调整视口到 pad（768×1024）和 phone（375×667）尺寸，确认响应式布局正常。

### 3.3 防 flake 纪律

浏览器自动化验证**不得使用固定时间等待**（如 `setTimeout(resolve, 300)`），
必须采用轮询等待机制（见 DEVELOPMENT.md §5.3）：

- 等待元素出现：使用 MCP 工具的 `wait_for` 或 `waitForSelector` 而非固定 sleep。
- 等待 DOM 更新：轮询目标元素状态直到满足条件，设置合理超时兜底。
- 等待网络请求完成：使用 `wait_for` 等待响应完成标志，而非固定延时。

正例（Playwright）：

```javascript
// 等待目标文本出现（推荐）
await page.waitForSelector('text=预期内容', { timeout: 5000 });

// 或使用 DSH MCP 的 wait_for
await mcp.browser.wait_for({ text: "预期内容" });
```

反例：

```javascript
await new Promise(r => setTimeout(r, 1000)); // 固定 sleep，禁止
```

### 3.4 截图采集

```bash
# 使用 Playwright MCP 截图
# 1. 导航到目标页面
# 2. 等待渲染完成
# 3. 截图

# 截图只截插件 UI 本身（headless element screenshot），
# 不带浏览器整窗，避免泄露本机环境。
```

## 4. 证据归档

### 4.1 存放位置

截图归档至**包内** `packages/dsh-<name>/docs/archive/` 目录，命名规则：

```
packages/dsh-<name>/docs/archive/<issue号>-<行为描述>.png
```

示例：

```
packages/dsh-notifier/docs/archive/37-basename-fallback-overlay.png
packages/dsh-mcp-manager/docs/archive/42-connection-form-validation.png
```

> **为什么放在包内而非仓库根 `docs/archive/`**：包内归档与具体插件绑定，便于按包追溯；
> 发布边界已核实安全：各包 `files` 白名单不含 `docs/`，截图不入 tarball，
> 不破坏「发布物不含内部文档」约定（见 ISSUE-WORKFLOW.md §2.4）。

### 4.2 截图规范

- 截图只截插件 UI 本身（headless element screenshot），**不带浏览器整窗**，
  避免泄露本机环境（文件路径、IP 地址、其他标签页）。
- 格式：PNG。
- 单张截图聚焦一个验证点，多场景拆多张。
- 文件名使用英文短横线命名，`<issue号>-<行为描述>`。

### 4.3 双向引用

归档后必须建立双向引用，确保可追溯：

1. **PR 正文**：贴截图并引用文件路径，如：
   `![baseline 回退 overlay](packages/dsh-notifier/docs/archive/37-basename-fallback-overlay.png)`
2. **Issue 评论**：回链对应 PR（`Refs #<PR号>` 或直接链接）。

## 5. 流程契约

### 5.1 coder 交付物

coder 交付的 PR 中，凡涉及客户端 UI 改动的，**必须包含**「隔离验证证据」：

- 截图归档在 `packages/dsh-<name>/docs/archive/` 目录
- PR 正文贴图并引用文件路径
- 截图覆盖：主场景、双主题（若适用）、窄屏表现（若适用）

### 5.2 hardener / qa 复核

- **hardener**：在补强测试断言时，确认 coder 的 smoke 测试覆盖了界面行为（如元素渲染、
  交互响应），而非仅依赖人工截图。hardener 不直接检查截图证据，但需保证测试可
  自动化验证界面行为（见 DEVELOPMENT.md §5 防 flake 纪律）。
- **qa**：在系统级实测阶段，从用户视角使用浏览器 MCP 真点查 DOM，覆盖双主题和窄屏
  视口。结果必须是**确定性断言**，不接受"看起来正常"（见 qa.md 角色定义）。
  qa 的交接凭据须包含截图已归档路径清单。
- 对缺失证据的客户端 PR，**在 PR 评审阶段即以「未自证截图」要求补齐/退回**，
  不进入 CI 门禁豁免。评审者（任意 reviewer）在首次审查时发现缺失即可退回。

### 5.3 缺失证据的处理

| 场景 | 处理方式 |
|------|----------|
| coder 提交 PR 未附截图 | hardener/qa 评论要求补齐，标注 `needs-evidence` 标签 |
| 纯宿主端/文档改动无需截图 | coder 在 PR 正文说明「无客户端 UI 改动，跳过隔离验证」 |
| 截图不符合规范（整窗截图/泄露环境） | 要求重新采集并替换 |

### 5.4 与 oss-pipeline 流水线集成

在 `oss-pipeline` 驱动的自治循环中，`spec-writer` → `coder` 交付后，
`hardener` 复核时自动检查 `packages/dsh-<name>/docs/archive/` 下是否包含
对应 issue 的截图证据。缺失则标记 `needs-evidence` 并退回 coder 补充。

## 参考

- [DEVELOPMENT.md §5 — Smoke 测试防 flake 纪律](DEVELOPMENT.md#5-smoke-测试防-flake-纪律)
- [DEVELOPMENT.md §6 — 多端兼容验证](DEVELOPMENT.md#6-多端兼容三操作系统--三访问形态--明暗双主题)
- [ISSUE-WORKFLOW.md §2 — 验证证据与代码复核闸](ISSUE-WORKFLOW.md#2-处理流水线维护者)
- [AGENTS.md — 开发隔离纪律](AGENTS.md)