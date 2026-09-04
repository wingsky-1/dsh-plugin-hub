---
name: dsh-verify-isolated
description: >
  DSH 插件开发的隔离环境浏览器验证 skill——**适用于任意 dsh 插件仓库**
  （dsh-plugin-hub / xiaozhuge 等）。触发信号：需要对客户端 UI 改动（src/client/**
  或宿主端 UI 渲染逻辑）做隔离浏览器实测、采集截图证据归档、验证不污染正在使用的
  web profile。核心做法：临时 DSH_HOME + verify_<8位随机> 独立 profile + 独立端口 +
  独立浏览器实例四重隔离，一键脚本 scripts/verify-isolated.mjs 拉起隔离 dsh web 与
  自带浏览器实例（browser-driver.mjs，raw CDP 零依赖），退出自动清理。
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

## 1. 四重隔离原理

验证使用**全新临时 `DSH_HOME` + 独立 profile + 独立端口 + 独立浏览器实例**的四重
隔离环境，与正在使用的真实 `~/.dsh`（含用户日常的 `web` profile）完全隔绝：

| 隔离层 | 做法 | 隔离内容 |
|--------|------|----------|
| 第一层：临时 `DSH_HOME` | `DSH_HOME=$(mktemp -d)` | 凭据、会话、全部用户数据、home 级 `cordis.patch.yml` |
| 第二层：独立 profile | `verify_<8位随机>`（非 `web`） | 插件组合栈（bundles）、profile 级 patch、插件依赖 |
| 第三层：独立端口 | `--port` 自选/探测空闲端口 | 与运行中主 `dsh web` 及其它验证实例互不冲突 |
| 第四层：独立浏览器实例 | `--browser` 拉起 skill 自带浏览器（独立 user-data-dir + 调试端口） | 页面/tab/console 完全独立，多会话并行互不可见 |

只建独立 profile 不够：profile 共享 home 级的凭据与会话；只有同时把 `DSH_HOME`
指向临时目录，才能做到与用户正在使用的环境完全隔离。验证结束后删除临时
`DSH_HOME` 与 `verify_*` profile，不留残留。

## 2. 一键脚本（推荐）

脚本随本 skill 分发，相对本 skill 的**资源基础目录**恒为
`scripts/verify-isolated.mjs`（node 实现，原 bash 版 `verify-isolated.sh` 已随
#517 C8 重写删除，不留 shim；升级路径：`bash .../verify-isolated.sh ...` →
`node .../verify-isolated.mjs ...`，参数与输出文案逐行对齐）。
资源基础目录 = 加载本 skill 时系统注入的 `<skill_resources>` 块中
`Base directory for this skill:` 一行的**绝对路径**（本 skill 所在目录，安装形态
自适应：npm 副本安装、`link:` 开发态挂载、仓库 checkout 内浏览均自动指向 skill
实际所在位置，跟随 `cordis.patch.yml` 的 `bundledSkillDir` 解析，不以路径拼接猜测）。

```bash
# 工作目录：worktree 根（非主 checkout）
# SKILL_BASE 取注入的「Base directory for this skill:」后面的绝对路径：
SKILL_BASE="<Base directory for this skill 一行的绝对路径，见上方 skill_resources>"
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 3456 <插件包路径>
# 多包：... --port 3456 <包A路径> <包B路径>
# 端口冲突：--port 0 让脚本自动探测真实空闲端口；--keep 保留临时环境便于排查
# 跳过构建：--no-build（默认会先 pnpm build 各插件，保证 lib/ 或 dist/ 产物存在；
#           产物缺失会报可操作错误，源码比产物新会给陈旧警告）
# 浏览器验证：加 --browser 自动拉起 skill 自带独立浏览器实例（见 §5 多会话并行）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --browser <插件包路径>
# 锚定 dsh 版本：验证特定 dsh 版本的生态时必须 --dsh 指定入口（默认用 PATH 中的
# dsh——PATH 碰巧是什么版本就验什么，结果不可复现）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --dsh /opt/dsh-0.1.2-alpha.2/bin/dsh --port 0 <插件包路径>
# 证据目录外部化（截图/快照归档到 <dir>/evidence-<profile>/，绝不动外部目录）：
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --evidence-dir /tmp/my-evidence <插件包路径>
# 隔离审计（B4）：对比隔离 DSH_HOME 写面与预置白名单，白名单外变化报「可疑」、
# 不阻断退出；--keep 时报告落 $DSH_HOME/audit/audit.json，否则并入 verdict 的 audit 字段
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --audit --keep <插件包路径>
# 额外审计目录（插件写到隔离环境外的数据面，可重复；局限：不扫真实 home）：
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --audit --audit-extra-dirs /tmp/plugin-data <插件包路径>
```

插件参数（`--` 之后或直接位置参数）接受两种形态，脚本内建统一归一化
（#517 C11 语义，随 C8 内建于 `lib/verify-core.mjs` 的 `resolvePkgArg`）：

- **本地插件路径**（推荐，worktree 根执行时写相对路径即可）：相对路径基于当前
  cwd 解析为**绝对路径**后挂载——dsh 会把非绝对路径当 git URL 解析、报
  `Repository not found` 迷惑错误，脚本已自动规避；绝对路径原样使用。
- **包规格**（npm 包名 / git URL）：原样透传（仅适用 registry 可解析的包；
  内置 bundle 如 `@deepseek-ai/dsh-web-app` 仍需按 §3 手动注入，不走 add）。

若注入的 base 不可用或不确信，先自证脚本位置再执行
（`ls "$SKILL_BASE/scripts/verify-isolated.mjs"`），或直接用 glob 全局搜索
`verify-isolated.mjs` 取其真实绝对路径——脚本从任意 cwd 以绝对路径调用
（自包含、不依赖自身位置）；`SKILL_BASE` 里的尖括号是占位说明，不是可执行值。

脚本自动完成：建临时 `DSH_HOME` → 校验 dsh 入口并打印版本（`--dsh` 锚定）→ 建
`verify_<8位随机>` profile（`dsh plugin --profile <p> list` 显式初始化，失败即报
可操作错误）→ 注入内置 `@deepseek-ai/dsh-web-app` bundle → **构建并**把本地插件
link 进 profile（`--no-build` 时校验产物存在 + 陈旧警告；插件参数相对路径基于 cwd
绝对化、npm 包名/git URL 原样透传）→ `--browser` 时启动独立浏览器实例（实例信息
写入 `$DSH_HOME/browser.state`）→ 启动隔离 `dsh web`（显式 `--host 127.0.0.1`
回环 + `DSH_TELEMETRY_DISABLED=1` 遥测禁用）→ **就绪断言**（轮询 HTTP 可达，
2xx-4xx 就绪、15s 超时报可操作错误）→ 前台等待。`Ctrl+C` 退出时统一清理 dsh
进程、浏览器实例、临时 `DSH_HOME` 与 profile（SIGINT/SIGTERM 透传退出码
130/143）。

**B6 启动自检 verdict**：就绪后写 `$DSH_HOME/verdict.json`（0o600），退出终态更新
cleanup 字段（`"done"`/`"kept"`）；端口实际绑定解析 dsh.log 端口行（parsed）→
就绪断言端口（asserted）→ 探测端口（probed）三通道标注 source。可用
`--json` 让 stdout 只出最终 verdict JSON（人类文案走 stderr）。

**B7 证据目录**：默认 `$DSH_HOME/evidence/`（脚本会打印路径；退出随临时目录一并
清理，`--keep` 保留）；显式 `--evidence-dir <dir>` 外部化时建
`<dir>/evidence-<profile>/` 子目录，**绝不动外部目录**（不删、不覆盖）。

**B4 隔离审计（`--audit`）**：可选开启，对比隔离 `$DSH_HOME` 写面与**预置白名单**
（版本化 `WHITELIST_V`，模式数组随 `scripts/lib/audit.mjs` 分发、smoke 断言存在）：
白名单外的新增/删除/修改报「可疑」（纯 stat 路径级，不读内容）；白名单内变化
忽略（dsh 重写 settings 是常态）；未知顶层路径 → 可疑。白名单分工：
`profiles/**`、`*.json/*.jsonl/*.log`、`.credentials.yaml`、`browser.state`、
`browser-profile/**`（整树白名单 + 跳过深扫）、`evidence/**`、`audit/**`、
`storages/**`（dsh 官方存储写面）、`dsh.log`、`verdict.json`；随 dsh 版本漂移的
面（如 profiles/node_modules/** 官方 bundle link）由 **t0 动态基线**覆盖（见下）。
**symlink 防逃逸**：快照 lstat 不跟随；`t1` 时**新增的**或**目标变化**且 resolve
后在**所在扫描根**（`$ISOLATED_HOME` 或 `--audit-extra-dirs` 目录）外的 symlink
报「越界 symlink」（防插件经 symlink 写回主 checkout），`t0` 已存在且目标未变的
外部 symlink（`link:` 挂载点，合法）不报；防逃逸优先于白名单——`profiles/**` 内
新增越界 symlink 同样报。**局限**：只扫 `$ISOLATED_HOME` 子树 +
`--audit-extra-dirs <dir>`（可重复，相对路径基于 cwd 绝对化、必须是目录）指定的
额外目录，**不扫真实 home**。时序：`t0` 基线在**就绪断言成功之后**（dsh 启动期
自身写面与官方 bundle link 进基线——语义为「**就绪后运行期写面审计**」，审计面 =
dsh 就绪后、退出前的增量写面；verdict 中间态在其后写入，先扫后写 + 白名单双
保险）；审计插在退出清理序列「kill dsh → browser quit → **审计** → verdict 终态
→ rm」之间，**不阻断退出**（审计是补充非门禁，退出码契约不变）；就绪前退出/
超时路径不审计（`audit` 为 null）；`--keep` 时报告落 `$DSH_HOME/audit/audit.json`，
否则随 `--json` 终态 verdict 输出（stdout `audit` 字段；错误路径错误 JSON 恒带
`audit` 字段，与 verdict 对齐）。

**退出码契约**：0 正常完成 / 1 启动或就绪失败（profile 初始化失败、add 失败、
dsh 就绪前退出、15s 就绪超时）/ 2 参数错误（未知选项、缺参、找不到 dsh 入口、
--no-build 缺产物）/ 130 SIGINT（Ctrl+C）/ 143 SIGTERM。

**Windows 承诺等级：试验性**——spawn .cmd 回退、无 POSIX 信号（taskkill /T 进程
树清理）等兼容点在代码逐处注释标注，但未在 CI 实测；smoke 不启动 dsh，Windows
行为走代码审查（见 verify-isolated.mjs 头部注释「Windows 三坑」）。

> **构建说明**：dsh 直读构建产物（dsh-plugin-hub 各包的 `lib/`、xiaozhuge 的 `dist/`），
> 脚本默认在挂载前 `pnpm build` 各插件，保证产物存在；产物已就绪时可 `--no-build` 跳过。

## 3. 手动步骤（等价于脚本做的事）

```bash
# 工作目录：worktree 根（非主 checkout）
# 1. 第一层隔离：全新临时 DSH_HOME
DSH_HOME=$(mktemp -d)
export DSH_HOME

# 2. 第二层隔离：独立 profile（verify_<8位随机>，避免与真实环境冲突）
PROFILE="verify_$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
dsh plugin --profile "$PROFILE" list >/dev/null   # 显式初始化 profile（含 dsh-base 模板；失败即停）

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

# 5. 启动隔离 dsh web（指定不冲突端口；--port 0 让系统随机；显式回环 + 遥测禁用）
DSH_TELEMETRY_DISABLED=1 dsh --profile "$PROFILE" --host 127.0.0.1 --port 3456 --no-open

# 6. 就绪断言（对齐脚本 M2 行为）：轮询 HTTP 可达再开始验证（GUI 带鉴权，2xx-4xx
#    均算就绪；连接拒绝继续等，15s 超时报错）
node -e 'const t=Date.now();(async()=>{for(;;){try{const r=await fetch("http://127.0.0.1:3456/",{signal:AbortSignal.timeout(1500)});if(r.status<500)break}catch{}if(Date.now()-t>15000)throw new Error("15s 未就绪");await new Promise(r=>setTimeout(r,250))}})()'
```

需要浏览器实例时（第四层隔离，等价于脚本 `--browser`）：

```bash
node "$SKILL_BASE/scripts/browser-driver.mjs" launch \
  --state "$DSH_HOME/browser.state" --user-data-dir "$DSH_HOME/browser-profile"
# 退出前清理（与脚本统一清理相同语义）：
node "$SKILL_BASE/scripts/browser-driver.mjs" quit --state "$DSH_HOME/browser.state"
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
  `--port 0` 自动探测真实空闲端口，**不要关闭或重启运行中的主 dsh web 进程**。
- **显式回环 + 遥测禁用**：隔离实例一律 `--host 127.0.0.1`（当前 dsh 默认即回环，
  显式写死防上游默认变更）+ `DSH_TELEMETRY_DISABLED=1`（测试数据不外发遥测）；
  一键脚本已内置，手动拉起时也必须带上。
- **锚定 dsh 版本**：验证特定 dsh 版本的生态时用 `--dsh <path>` 指定入口，默认
  PATH 中的 `dsh` 会让验证结果随环境漂移、不可复现。
- **不复制真实凭据**：隔离环境使用临时 `DSH_HOME`，不携带 `~/.dsh` 下的真实凭据、
  令牌、API 密钥等。若验证需要凭据，使用测试专用凭据或 mock 数据。
- **验证完成后清理**：停止隔离 `dsh web` 进程后，删除临时 `DSH_HOME` 目录
  （`rm -rf "$DSH_HOME"`），避免残留无用的 `verify_*` profile。

## 5. 多会话并行（浏览器硬隔离）

**强制规则：客户端 UI 验证一律走本 skill 自带浏览器实例（`--browser`），禁用
工作区共享 MCP 浏览器**（`.dsh/mcp.json` 的 playwright / chrome-devtools 由
dsh-mcp-manager 管理，**同一工作区的所有会话共享同一个 MCP server 子进程**——
浏览器实例只有一份，`browser_snapshot/click` 等工具操作该 server 的「当前活动
页」，多会话并行时 tab/页面互相漂移串扰，甚至漂到其他实例的用户页面。官方
`--isolated` 只解「状态串」（每会话新 context），不解「操作面串」；`--browser`
才是结构性硬隔离）。

每个验证任务**自带独立浏览器实例**：独立 user-data-dir + 自选空闲调试端口 +
headless 内核，实例信息写入各任务自己的 `browser.state`（`--browser` 时在
`$DSH_HOME/browser.state`，随 DSH_HOME 同生命周期），多会话并行互不可见、
互不打断、tab 不漂移。

### 5.1 四重隔离自检清单（并行验证前逐项核对）

| # | 隔离项 | 自检命令 / 判据 |
|---|--------|-----------------|
| 1 | DSH_HOME | `echo $DSH_HOME` → 必须是本次验证的临时目录（mktemp 路径），**不得是** `~/.dsh` |
| 2 | profile | 脚本输出 `profile=verify_<8位随机>`；`dsh plugin --profile web list` 不受影响 |
| 3 | 端口 | dsh web 端口与主实例及其它并行实例互不相同；`--port 0` 时脚本会打印探测到的真实端口 |
| 4 | 浏览器实例 | `browser.state` 的 `port`/`pid`/`userDataDir` 为本任务独有；并行任务各自的 state 文件路径不同（各在各自 DSH_HOME 下） |
| 5 | 插件持久化隔离感知 | 验证涉及**读写插件自己的持久化文件**（通知记录、用量数据等）时，先确认该插件落盘路径 DSH_HOME 感知（hub 内查是否有 `process.env.DSH_HOME ?? homedir()/.dsh` 契约）。**不感知时的处置**：在验证记录中标注「该插件隔离盲区」→ 验证中避免触发会写持久化文件的操作（清理/发送测试类按钮）→ 提报 issue（先例 #510）。读面串同样算盲区，截图含真实数据时须说明 |

并行验证建议：每个任务**单独运行一个 `verify-isolated.mjs --port 0 --browser` 进程**
（各自独立临时 DSH_HOME / profile / 端口 / 浏览器实例），不要在同一隔离环境内
手拉多个浏览器。

## 6. 浏览器验证方法

使用 skill 自带浏览器驱动（`browser-driver.mjs`，raw CDP 零依赖）在隔离环境内
自动化验证；浏览器 MCP 仅限**非并行**的简单场景。

### 6.1 前置检查：浏览器内核

`--browser` 需要 Chromium 系内核（Chrome / Edge / Chromium）。探测链（
`browser-driver.mjs detectChrome()`，唯一收敛点）：

`DSH_VERIFY_CHROME` 环境变量 → ms-playwright 缓存 → PATH → 平台常见路径，
全缺失时 fail-fast 并打印可执行安装指引。

| 平台 | ms-playwright 缓存目录 | 常见安装路径（PATH 之外兜底） |
|------|------------------------|------------------------------|
| Linux | `~/.cache/ms-playwright` | `/usr/bin/google-chrome`、`/usr/bin/chromium`、`/snap/bin/chromium` |
| macOS | `~/Library/Caches/ms-playwright` | `/Applications/Google Chrome.app/.../Google Chrome`、`/Applications/Chromium.app/.../Chromium` |
| Windows | `%LOCALAPPDATA%\ms-playwright` | `%ProgramFiles%\Google\Chrome\Application\chrome.exe`、`%ProgramFiles(x86)%\...`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` |

自查命令：

```bash
# Linux / macOS：确认内核可执行文件存在
ls ~/.cache/ms-playwright 2>/dev/null      # ms-playwright 缓存命中？
command -v google-chrome chromium          # PATH 命中？
# macOS 额外：
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null
# Windows（PowerShell）：
Test-Path "$env:LOCALAPPDATA\ms-playwright"          # ms-playwright 缓存
Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
# 全部缺失时一键安装内核：
#   Linux: sudo apt-get install -y chromium-browser   或   npx playwright install chromium
#   macOS: brew install --cask google-chrome          或   npx playwright install chromium
#   Windows: winget install Google.Chrome             或   npx playwright install chromium
# 已装但探测不到时显式指定：
#   DSH_VERIFY_CHROME=/path/to/chrome node "$SKILL_BASE/scripts/verify-isolated.mjs" --browser <pkg>
```

### 6.2 browser-driver 操作命令

`--browser` 启动后（实例信息在 `$DSH_HOME/browser.state`），所有命令统一
`--json` 输出、默认即 JSON；`--state` 必须指向本任务自己的 state 文件
（并行任务各用各的，互不覆盖）。完整契约见 `browser-driver.mjs --help`：

```bash
# 先看帮助（契约唯一事实源）
node "$SKILL_BASE/scripts/browser-driver.mjs" --help
STATE="$DSH_HOME/browser.state"

# 页面状态快照（导航 + title/readyState/body 文本/选择器元素）
node "$SKILL_BASE/scripts/browser-driver.mjs" snapshot --state "$STATE" --url http://127.0.0.1:<端口>
# 点击 / 填充 / 执行 JS / 等待元素（轮询，替代固定 sleep）
node "$SKILL_BASE/scripts/browser-driver.mjs" click  --state "$STATE" --selector "button.start"
node "$SKILL_BASE/scripts/browser-driver.mjs" fill   --state "$STATE" --selector "input[name=q]" --value "测试"
node "$SKILL_BASE/scripts/browser-driver.mjs" eval   --state "$STATE" --expression "document.title"
node "$SKILL_BASE/scripts/browser-driver.mjs" wait   --state "$STATE" --selector ".done" --timeout 10000
# 截图（整页或元素）与 console 捕获
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$STATE" --url http://127.0.0.1:<端口> --path shot.png
node "$SKILL_BASE/scripts/browser-driver.mjs" console   --state "$STATE" --url http://127.0.0.1:<端口> --wait-ms 2000
```

### 6.3 核验改动

1. **导航到改动对应的路由/页面**：打开 `http://127.0.0.1:<port>` 下的对应路径
   （`--port 0` 时用脚本打印的真实端口）。
2. **验证 UI 呈现**：`snapshot` 确认组件渲染正确、样式符合预期；`click`/`fill`/
   `eval` 验证交互行为。
3. **检查 Console**：`console` 命令捕获 `console.error`、未捕获异常、插件相关的
   `console.warn` 消息。挂载失败只应 `console.warn` 不应 throw。
4. **双主题验证**：切换明/暗主题确认颜色引用正确，无硬编码固定色值。
5. **窄屏验证**：`eval` 设置视口（如 `window.resizeTo(768,1024)`）后核验 pad
   （768×1024）和 phone（375×667）尺寸下的响应式布局。

### 6.4 防 flake 纪律

浏览器自动化验证**不得使用固定时间等待**（如 `setTimeout(resolve, 300)`），
必须采用轮询等待机制：

- 等待元素出现：用 `wait --selector <css> --timeout <ms>`（browser-driver 内置
  轮询），或 `click`/`fill` 内部自带先等待；不要固定 sleep。
- 等待 DOM 更新：轮询目标元素状态直到满足条件，设置合理超时兜底。
- 等待网络请求完成：轮询页面状态标志（如 `eval --expression "document.readyState"`）
  而非固定延时。

### 6.5 截图采集

- 截图只截插件 UI 本身（`screenshot --selector` 元素截图），不带浏览器整窗，
  避免泄露本机环境（文件路径、IP 地址、其他标签页）。
- 格式：PNG；单张截图聚焦一个验证点，多场景拆多张。
- 归档路径与 PR 证据要求以各仓库 AGENTS.md 为准（dsh-plugin-hub 归档至
  `packages/dsh-<name>/docs/archive/`）。

## 7. 完成检查

- [ ] 隔离 `dsh web` 实例已启动且不冲突主实例端口（`--port 0` 时打印真实端口；
      脚本会做就绪断言，超时未就绪会给出可操作错误）
- [ ] 隔离实例为显式回环 + 遥测禁用（脚本内置；手动拉起时核对 `--host` 与
      `DSH_TELEMETRY_DISABLED=1`）
- [ ] 若验证涉及插件持久化文件：已核对插件 DSH_HOME 感知（不感知按 §5.1 第 5 项处置）
- [ ] 若做并行验证：四重隔离自检清单（§5.1）逐项通过，各任务浏览器 state 独立
- [ ] 插件 UI 在隔离环境渲染正常（双主题 + 窄屏如适用）
- [ ] Console 无未处理错误（挂载失败仅 warn）
- [ ] 截图已采集并按仓库规范归档（如适用）
- [ ] 隔离实例已停止、浏览器实例已清理（`browser.state` 不再存在）、临时
      `DSH_HOME` 与 `verify_*` profile 已清理
