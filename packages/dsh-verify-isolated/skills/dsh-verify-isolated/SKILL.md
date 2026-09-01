---
name: dsh-verify-isolated
description: >
  DSH 插件开发的隔离环境浏览器验证 skill——**适用于任意 dsh 插件仓库**
  （dsh-plugin-hub / xiaozhuge 等）。触发信号：需要对客户端 UI 改动（src/client/**
  或宿主端 UI 渲染逻辑）做隔离浏览器实测、采集截图证据归档、验证不污染正在使用的
  web profile。核心做法：临时 DSH_HOME + verify_<8位随机> 独立 profile 双重隔离，
  一键脚本 scripts/verify-isolated.sh 拉起隔离 dsh web，退出自动清理。
  Do NOT trigger for: 纯宿主端逻辑（不涉及 UI 渲染）、纯文档改动、普通单元/smoke
  测试（那些走仓库自身 test 门禁）。
---

# dsh-verify-isolated — 隔离环境浏览器验证

> 适用于任意 dsh 插件仓库的**客户端界面改动**（`src/client/**` 或宿主端 UI 渲染逻辑）
> 的浏览器实测。本 skill 是可执行清单；仓库级细节（截图归档路径、PR 证据要求）以
> 各仓库 AGENTS.md / docs 为准。

## 0. 何时用

凡改动命中以下区域，**必须**做隔离环境浏览器验证并附截图：

- `src/client/**`（客户端 UI 渲染逻辑、样式、组件）
- 宿主端涉及 UI 渲染逻辑的改动（如路由注入、URL 重写、overlay/Modal 渲染、双主题适配）
- 涉及窄屏/响应式布局的调整

**不需要**隔离验证的例外：纯文档改动、纯宿主端逻辑（不涉及 UI 渲染）、纯后端数据流变更。

## 1. 双重隔离原理

验证使用**全新临时 `DSH_HOME` + 独立 profile** 的双重隔离环境，与正在使用的真实
`~/.dsh`（含用户日常的 `web` profile）完全隔绝：

| 隔离层 | 做法 | 隔离内容 |
|--------|------|----------|
| 第一层：临时 `DSH_HOME` | `DSH_HOME=$(mktemp -d)` | 凭据、会话、全部用户数据、home 级 `cordis.patch.yml` |
| 第二层：独立 profile | `verify_<8位随机>`（非 `web`） | 插件组合栈（bundles）、profile 级 patch、插件依赖 |

只建独立 profile 不够：profile 共享 home 级的凭据与会话；只有同时把 `DSH_HOME`
指向临时目录，才能做到与用户正在使用的环境完全隔离。验证结束后删除临时
`DSH_HOME` 与 `verify_*` profile，不留残留。

## 2. 一键脚本（推荐）

脚本随本 skill 分发，相对本 skill 的**资源基础目录**恒为 `scripts/verify-isolated.sh`。
资源基础目录 = 加载本 skill 时系统注入的 `<skill_resources>` 块中
`Base directory for this skill:` 一行的**绝对路径**（本 skill 所在目录，安装形态
自适应：npm 副本安装、`link:` 开发态挂载、仓库 checkout 内浏览均自动指向 skill
实际所在位置，跟随 `cordis.patch.yml` 的 `bundledSkillDir` 解析，不以路径拼接猜测）。

```bash
# 工作目录：worktree 根（非主 checkout）
# SKILL_BASE 取注入的「Base directory for this skill:」后面的绝对路径：
SKILL_BASE="<Base directory for this skill 一行的绝对路径，见上方 skill_resources>"
bash "$SKILL_BASE/scripts/verify-isolated.sh" --port 3456 <插件包路径>
# 多包：... --port 3456 <包A路径> <包B路径>
# 端口冲突：--port 0 让系统随机分配；--keep 保留临时环境便于排查
# 跳过构建：--no-build（默认会先 pnpm build 各插件，保证 lib/ 或 dist/ 产物存在）
```

若注入的 base 不可用或不确信，先自证脚本位置再执行
（`ls "$SKILL_BASE/scripts/verify-isolated.sh"`），或直接用 glob 全局搜索
`verify-isolated.sh` 取其真实绝对路径——脚本从任意 cwd 以绝对路径调用
（自包含、不依赖自身位置）；`SKILL_BASE` 里的尖括号是占位说明，不是可执行值。

脚本自动完成：建临时 `DSH_HOME` → 建 `verify_<8位随机>` profile → 注入内置
`@deepseek-ai/dsh-web-app` bundle → **构建并**把本地插件 link 进 profile → 启动隔离
`dsh web`（前台阻塞）。`Ctrl+C` 退出时 `trap` 自动删除临时 `DSH_HOME` 与 profile。

> **构建说明**：dsh 直读构建产物（dsh-plugin-hub 各包的 `lib/`、xiaozhuge 的 `dist/`），
> 脚本默认在挂载前 `pnpm build` 各插件，保证产物存在；产物已就绪时可 `--no-build` 跳过。

## 3. 手动步骤（等价于脚本做的事）

```bash
# 工作目录：worktree 根（非主 checkout）
# 1. 第一层隔离：全新临时 DSH_HOME
DSH_HOME=$(mktemp -d)
export DSH_HOME

# 2. 第二层隔离：独立 profile（verify_<8位随机>，避免与真实环境冲突）
PROFILE=verify_$(openssl rand -hex 4)
dsh plugin --profile "$PROFILE" add --help >/dev/null   # 初始化 profile（含 dsh-base 模板）

# 3. 注入内置 web-app bundle：@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app 按名
#    从 dsh 安装目录解析，不进 dependencies、不走 npm
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const b = j.dsh.profile.bundles;
  if (!b.includes("@deepseek-ai/dsh-web-app")) {
    b.splice(b.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app");
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$DSH_HOME/profiles/$PROFILE/package.json"

# 4. 挂载本地插件（主 checkout 的 packages/*，link 进 profile）
dsh plugin --profile "$PROFILE" add /path/to/main-checkout/packages/dsh-<name>

# 5. 启动隔离 dsh web（指定不冲突端口；--port 0 让系统随机）
dsh --profile "$PROFILE" --port 3456
```

## 4. 关键原则

- **DSH_HOME 设到临时目录**：`$(mktemp -d)` 生成唯一临时目录，隔离凭据、会话与
  home 级 patch，防止测试数据污染 `~/.dsh` 真实用户配置。
- **独立 profile 命名 `verify_<8位随机>`**：不占用/不触碰用户正在使用的 `web`
  profile；随机后缀避免多实例/多次验证间冲突。
- **插件从主 checkout 的 `lib/` 加载**：`dsh plugin --profile <name> add` 指向主
  checkout 的 `packages/*/`，以 `link:` 依赖挂载（符号链接，非复制），确保访问构建
  后的成品（而非源文件）。
- **最小启动依赖**：自定义 profile 要启动 web 界面，`dsh.profile.bundles` 必须含
  `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`。这两个内置 bundle 从 dsh
  安装目录按名解析，**不要**用 `dsh plugin add` 走 npm 安装（其依赖
  `@deepseek-ai/dsh-frontend` 不在 registry，会 404）。
- **独立端口**：`--port <n>` 选择与运行中主 `dsh web` 不冲突的端口（如 3456），
  **不要关闭或重启运行中的主 dsh web 进程**。
- **不复制真实凭据**：隔离环境使用临时 `DSH_HOME`，不携带 `~/.dsh` 下的真实凭据、
  令牌、API 密钥等。若验证需要凭据，使用测试专用凭据或 mock 数据。
- **验证完成后清理**：停止隔离 `dsh web` 进程后，删除临时 `DSH_HOME` 目录
  （`rm -rf "$DSH_HOME"`），避免残留无用的 `verify_*` profile。

## 5. 浏览器验证方法

使用浏览器自动驾驶工具（Playwright 或 chrome-devtools MCP）在隔离环境内进行自动化验证。

### 5.1 准备工作

- Playwright：`npx playwright install chromium`
- chrome-devtools：需系统已安装 Chrome/Chromium
- 仓库 `.dsh/mcp.json` 若已配置浏览器 MCP，可在 DSH 会话中直接使用。

### 5.2 核验改动

1. **导航到改动对应的路由/页面**：打开 `http://localhost:<port>` 下的对应路径。
2. **验证 UI 呈现**：确认组件渲染正确、样式符合预期、交互行为正常。
3. **检查 Console**：检查是否有未处理的错误或警告。
   - 重点关注：`console.error`、未捕获的异常、插件相关的 `console.warn` 消息。
   - 挂载失败只应 `console.warn` 不应 throw。
4. **双主题验证**：切换明/暗主题确认颜色引用正确，无硬编码固定色值。
5. **窄屏验证**：调整视口到 pad（768×1024）和 phone（375×667）尺寸，确认响应式布局正常。

### 5.3 防 flake 纪律

浏览器自动化验证**不得使用固定时间等待**（如 `setTimeout(resolve, 300)`），
必须采用轮询等待机制：

- 等待元素出现：使用 MCP 工具的 `wait_for` 或 `waitForSelector` 而非固定 sleep。
- 等待 DOM 更新：轮询目标元素状态直到满足条件，设置合理超时兜底。
- 等待网络请求完成：使用 `wait_for` 等待响应完成标志，而非固定延时。

正例（Playwright）：

```javascript
await page.waitForSelector('text=预期内容', { timeout: 5000 });
```

反例：

```javascript
await new Promise(r => setTimeout(r, 1000)); // 固定 sleep，禁止
```

### 5.4 截图采集

- 截图只截插件 UI 本身（headless element screenshot），不带浏览器整窗，
  避免泄露本机环境（文件路径、IP 地址、其他标签页）。
- 格式：PNG；单张截图聚焦一个验证点，多场景拆多张。
- 归档路径与 PR 证据要求以各仓库 AGENTS.md 为准（dsh-plugin-hub 归档至
  `packages/dsh-<name>/docs/archive/`）。

## 6. 完成检查

- [ ] 隔离 `dsh web` 实例已启动且不冲突主实例端口
- [ ] 插件 UI 在隔离环境渲染正常（双主题 + 窄屏如适用）
- [ ] Console 无未处理错误（挂载失败仅 warn）
- [ ] 截图已采集并按仓库规范归档（如适用）
- [ ] 隔离实例已停止、临时 `DSH_HOME` 与 `verify_*` profile 已清理
