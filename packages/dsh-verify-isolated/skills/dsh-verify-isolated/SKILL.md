---
name: dsh-verify-isolated
description: >
  DSH 插件的隔离环境浏览器验证：对客户端 UI 改动（src/client/**、宿主端 UI 渲染逻辑、
  窄屏/响应式布局）在临时 DSH_HOME + 独立 profile + 独立端口 + 独立浏览器实例里实测，
  采集截图证据，全程不触碰用户正在使用的 ~/.dsh 与 web profile。
  一键脚本 scripts/verify-isolated.mjs 负责搭建与清理，browser-driver.mjs 负责页面操作。
  Do NOT trigger for: 纯宿主端逻辑（不涉及 UI 渲染）、纯文档改动、普通单元/smoke 测试。
---

# dsh-verify-isolated — 隔离环境浏览器验证

> 适用于任意 dsh 插件仓库的**客户端界面改动**（`src/client/**` 或宿主端 UI 渲染逻辑）
> 的浏览器实测。本 skill 是可执行清单；仓库级约定（截图归档路径、PR 证据要求）以被测
> 仓库自身为准。

## 0. 何时用

凡改动命中以下区域，**必须**做隔离环境浏览器验证并附截图：

- `src/client/**`（客户端 UI 渲染逻辑、样式、组件）
- 宿主端涉及 UI 渲染逻辑的改动（如路由注入、URL 重写、overlay/Modal 渲染、双主题适配）
- 涉及窄屏/响应式布局的调整

**不需要**的例外：纯文档改动、纯宿主端逻辑（不涉及 UI 渲染）、纯后端数据流变更。

## 1. 四重隔离

| 隔离层 | 做法 | 隔离内容 |
|--------|------|----------|
| 一：临时 `DSH_HOME` | `DSH_HOME=$(mktemp -d)` | 凭据、会话、全部用户数据、home 级 `cordis.patch.yml` |
| 二：独立 profile | `verify_<8位随机>`（非 `web`） | 插件组合栈（bundles）、profile 级 patch、插件依赖 |
| 三：独立端口 | `--port` 自选/探测空闲端口 | 与运行中主 `dsh web` 及其它验证实例互不冲突 |
| 四：独立浏览器实例 | `--browser` 拉起自带浏览器（独立 user-data-dir + 调试端口） | 页面/tab/console 完全独立，多会话并行互不可见 |

只建独立 profile 不够：profile 共享 home 级的凭据与会话；只有同时把 `DSH_HOME` 指向
临时目录，才做到与用户正在使用的环境完全隔离。

隔离默认只覆盖**回环访问形态**（脚本固定 `--host 127.0.0.1`）。要验证局域网/移动端
访问形态，用官方 `--trusted-host <authority>` 自行拉起，并自行确认被测插件在该形态下
的鉴权与围栏行为（与回环形态可能不同）。

## 2. 跑起来

```bash
# 工作目录：被测插件所在的仓库（插件参数的相对路径按当前 cwd 绝对化）
# SKILL_BASE 取注入的「Base directory for this skill:」后面的绝对路径：
SKILL_BASE="<Base directory for this skill 一行的绝对路径，见 skill_resources>"
# 最小可用：起隔离实例（--port 0 自动探测空闲端口）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 <插件包路径>
# 要跑浏览器验证：加 --browser（自带独立浏览器实例，见 §4 并行约束）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --browser <插件包路径>
# 验证特定 dsh 版本生态：--dsh 锚定入口（PATH 里碰巧是什么版本就验什么，结果不可复现）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --dsh /opt/dsh-0.1.2-rc.1/bin/dsh --port 0 <插件包路径>
# 排查用：--keep 保留临时 DSH_HOME；--no-build 跳过挂载前的 pnpm build
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --keep --no-build <插件包路径>
```

`--help` 是选项契约的唯一事实源（完整选项、退出码、verdict 字段、隔离审计细节都在
那里）；脚本内部行为的解读见 [`references/script-contracts.md`](references/script-contracts.md)。

插件参数接受两种形态：

- **本地插件路径**（推荐；在插件所在仓库根执行时写相对路径即可）：相对路径按当前
  cwd 解析为**绝对路径**后挂载——dsh 会把非绝对路径当 git URL 解析、报
  `Repository not found` 迷惑错误，脚本已自动规避。
- **包规格**（npm 包名 / git URL）：原样透传（仅适用 registry 可解析的包；内置 bundle
  如 `@deepseek-ai/dsh-web-app` 按 [`references/manual-setup.md`](references/manual-setup.md)
  手动注入，不走 add）。

脚本自动完成：建临时 `DSH_HOME` → 校验 dsh 入口 → 预置首启弹窗跳过 → 建
`verify_<随机>` profile → 注入内置 web-app bundle → 构建并把插件 link 进 profile →
（`--browser`）启动独立浏览器实例 → 启动隔离 `dsh web`（显式回环 + 遥测禁用）→
就绪断言 → 打印带令牌 URL → 前台等待，`Ctrl+C` 退出时统一清理。dsh 直读插件的构建
产物（`lib/` 或 `dist/`，见插件包 build 脚本），产物已就绪时 `--no-build` 可跳过构建。

`SKILL_BASE` 不可用或不确信时，先自证脚本位置（`ls "$SKILL_BASE/scripts/verify-isolated.mjs"`）
或用 glob 搜 `verify-isolated.mjs` 取真实绝对路径——脚本自包含、可从任意 cwd 以绝对
路径调用；尖括号是占位说明，不是可执行值。

## 3. 跑之前的两个硬前提

全新 `DSH_HOME` 的隔离实例，首屏不是插件界面，而是两个**阻断式**弹窗；同时 GUI 带
鉴权，裸端口访问拿不到界面。两者都会让「打开页面截图」看似成功、实则无效。

### 3.1 带令牌的访问 URL

dsh web 的 GUI 带鉴权，**不带令牌只得到 401 文本页**
（`dsh web authentication required; reopen the URL printed by dsh web.`）。就绪断言把
2xx-4xx 都算就绪，所以漏带令牌时验证会在 401 页面上继续跑下去。令牌的唯一来源是 dsh
启动打印的那一行：

```bash
# 三种取法（等价，取其一）：
# 1) 脚本启动时直接打印：`访问 URL（含访问令牌，GUI 鉴权必需）: http://127.0.0.1:<port>/?token=...`
# 2) 从 dsh.log 取（与端口解析同一行）：
grep -o 'dsh web: http://[^ ]*' "$DSH_HOME/dsh.log" | tail -1 | sed 's/^dsh web: //'
# 3) 交给 browser-driver（--browser 时脚本已写入 browser.state.dshWebUrl）：
node "$SKILL_BASE/scripts/browser-driver.mjs" snapshot --state "$DSH_HOME/browser.state" --url state
```

- `--url state` 是页面命令的保留取值：读 state 文件里的带令牌 URL，省掉手工拼接。
  省略 `--url` 仍是**不导航**（保留上一条命令的页面状态，多步交互验证不受影响）。
- **令牌是访问凭据**：命令回显的 URL 恒去令牌（`token=***`），真值只在 0o600 的
  `browser.state` / `dsh.log` 里。截图与快照 JSON 进证据前确认其中没有 `token=` 明文；
  手工传 `--url` 时同样用已脱敏的形态记录。
- 鉴权是**会话级**的：同一浏览器实例先用带令牌 URL 打开过，后续裸端口也能进；全新
  实例直接访问裸端口则必然 401。命中 401 文本页时命令输出 `authRequired` 并在 stderr
  提示。

### 3.2 首启弹窗默认跳过

两个弹窗都把 `#root` 置为 `inert`，页面上一切点击静默失效——所以跳过必须是默认行为，
而不是「记得点掉」：

| 顺序 | 弹窗 | 出现条件 | 默认处置 |
|------|------|----------|----------|
| 1 | 内测声明（`Continue` / `继续`） | `$DSH_HOME/settings.yaml` 的 `ui-onboarding.welcomeNoticeVersion` 与 dsh 客户端常量 `WELCOME_NOTICE_VERSION` **精确相等**才算已确认；全新 DSH_HOME 必然未确认 | 启动前预置该值（`--no-skip-onboarding` 关闭） |
| 2 | 添加 API Key（`Configure later` / `稍后配置`） | 隔离环境无任何可用 provider；且「稍后配置」**只在当前页面生命周期内有效**，刷新/新标签必重弹 | browser-driver 导航后自动点击跳过 |

跳过是**双保险**：预置消掉弹窗 1，浏览器侧兜底消掉弹窗 2（顺带兜住 dsh 升级导致的
版本漂移与 locale 文案变化）。要点：

- **版本号现取，不硬编码**：脚本从 dsh 产物读常量（`scripts/lib/onboarding.mjs`）；
  取不到只警告、不改判定，交给浏览器侧兜底——写死会在 dsh 升级后静默失效。
- **识别不到跳过按钮时不猜**：弹窗里可能并列「保存并继续」这类有副作用的按钮，此时
  只输出 `onboardingBlocked` 并在 stderr 警告，由人决定怎么处置。
- **预置只写隔离环境**：目标是 `$DSH_HOME/settings.yaml`，不触碰真实 `~/.dsh`；脚本也
  不注入任何凭据（弹窗 2 靠点击跳过，而不是伪造 API Key）。
- **要验证 onboarding 本身**：加 `--no-skip-onboarding` 保留原生首启态；需要弹窗 2
  也留着，再加 browser-driver 的 `--no-auto-dismiss`（只探测不点击）。

## 4. 隔离自检（并行验证前逐项核对）

| # | 隔离项 | 自检命令 / 判据 |
|---|--------|-----------------|
| 1 | DSH_HOME | `echo $DSH_HOME` → 必须是本次验证的临时目录（mktemp 路径），**不得是** `~/.dsh` |
| 2 | profile | 脚本输出 `profile=verify_<8位随机>`；`dsh plugin --profile web list` 不受影响 |
| 3 | 端口 | dsh web 端口与主实例及其它并行实例互不相同；`--port 0` 时脚本打印真实端口 |
| 4 | 浏览器实例 | `browser.state` 的 `port`/`pid`/`userDataDir` 为本任务独有；并行任务各自的 state 路径不同（各在各自 DSH_HOME 下） |
| 5 | 插件持久化隔离感知 | 验证涉及**读写插件自己的持久化文件**（通知记录、用量数据等）时，先确认插件落盘路径 DSH_HOME 感知（查源码里是否有 `process.env.DSH_HOME ?? homedir()/.dsh` 这类契约）。**不感知时的处置**：在验证记录中标注「该插件隔离盲区」→ 验证中避免触发会写持久化文件的操作（清理/发送测试类按钮）→ 在验证结论中提报。读面串同样算盲区，截图含真实数据时须说明 |

并行验证：每个任务**单独运行一个 `verify-isolated.mjs --port 0 --browser` 进程**
（各自独立的临时 DSH_HOME / profile / 端口 / 浏览器实例）；同一隔离环境内手拉多个
浏览器会让并行隔离失效。浏览器一律用本 skill 自带的 `--browser` 实例：工作区共享的
浏览器 MCP 只有一份「当前活动页」，多会话并行时 tab 会互相漂移、甚至漂到其他实例的
用户页面。

`--browser` 需要 Chromium 系内核（探测链、三平台自查与安装命令见
[`references/browser-kernel.md`](references/browser-kernel.md)）。

## 5. 核验与证据

页面命令（snapshot / click / eval / fill / wait / screenshot / console）统一 `--json`
输出，`--state` 指向本任务自己的 state 文件；完整参数见
`node "$SKILL_BASE/scripts/browser-driver.mjs" --help`。

### 5.1 核验步骤

1. **导航到改动对应的路由/页面**：`snapshot --state "$STATE" --url state`。
   判据：`bodyText` 里出现该页面的标志性文案，且输出无 `authRequired`。
2. **验证 UI 呈现**：`snapshot --selector <css>` 断言目标元素 `found: true` 且 `rect`
   非零；交互用 `click` / `fill` 后再 `eval` 读回状态。
   判据：每个改动点都有一组「操作 + 读回」的成对输出，不靠目测。
3. **检查 Console**：`console --state "$STATE" --url state --wait-ms 2000`。
   判据：无 `type: "exception"`、无 `level: "error"`；插件挂载失败只应 `console.warn`。
4. **双主题**：明/暗各采一张截图。
   判据：两张都在，且暗色下无浅底浅字这类硬编码色值问题。
5. **窄屏/响应式**（改动命中时）：按
   [`references/viewport-geometry.md`](references/viewport-geometry.md)（设备视口与几何验证）
   逐档设定视口核验，每档四项断言全过。

**穷尽要求**：本次改动涉及的每个 UI 触点（每个路由、每个交互状态）都要有对应证据；
主路径正常不替代次要分支的核验。

### 5.2 截图与归档

- 截图只截插件 UI 本身（`screenshot --selector` 元素截图），不带浏览器整窗，避免泄露
  本机环境（文件路径、IP 地址、其他标签页）。
- 格式：PNG；单张截图聚焦一个验证点，多场景拆多张。
- 归档路径与 PR 证据要求以**被测仓库自身约定**为准（本 skill 不规定路径；没有约定时
  放到 `docs/archive/` 之类的项目文档目录，并在结论里写明位置）。

### 5.3 等待一律轮询

等待一律用轮询、超时兜底，这样慢机器上偶发失败、快机器上白等的情况都不会出现：

- 元素出现/可点：`wait --selector <css> --timeout <ms>`，或直接用自带等待的 `click` / `fill`。
- 页面状态：`eval` 轮询到目标值（如 `document.readyState`）。
- 导航后异步挂载的组件（弹窗、懒加载区域）：轮询其存在性，而不是等固定时长。

## 6. 完成检查

- [ ] 隔离实例已启动且不冲突主实例端口（`--port 0` 时脚本打印真实端口，超时未就绪
      会给可操作错误）
- [ ] 隔离实例为显式回环 + 遥测禁用（脚本内置；手动拉起时核对 `--host 127.0.0.1` 与
      `DSH_TELEMETRY_DISABLED=1`）
- [ ] 页面命令用的是**带令牌**的访问 URL（`--url state` 或脚本打印的 URL）：输出无
      `authRequired`，body 可见插件界面
- [ ] 首启弹窗已跳过、应用根非 inert：输出无 `onboardingBlocked`；必要时用 `eval` 复核
      `document.getElementById('root').inert === false`
- [ ] §4 自检清单逐项通过（含插件持久化 DSH_HOME 感知的核对或盲区标注）
- [ ] §5.1 五个核验点按穷尽要求完成（每个 UI 触点都有成对的操作与读回证据）
- [ ] 响应式/窄屏改动：`references/viewport-geometry.md` 的逐档核验与四项断言全过
- [ ] 触控、软键盘、真机 UA 相关项已标注「仍需真机验证」或已真机复核
- [ ] Console 无未处理错误（挂载失败仅 warn）
- [ ] 截图已采集并按被测仓库约定归档，且证据内无 `token=` 明文
- [ ] 隔离实例已停止、浏览器实例已清理（`browser.state` 不再存在）、临时 `DSH_HOME`
      与 `verify_*` profile 已清理

## 7. 参考文件

| 文件 | 读它的时机 |
|------|-----------|
| [`references/script-contracts.md`](references/script-contracts.md) | 要解读 `verdict.json`、开隔离审计（`--audit`）、或启动/就绪失败要定位原因 |
| [`references/manual-setup.md`](references/manual-setup.md) | 一键脚本不可用，或要理解/手工调整某一层隔离 |
| [`references/browser-kernel.md`](references/browser-kernel.md) | `--browser` 报找不到 Chromium 系内核，或要确认命中了哪个内核 |
| [`references/viewport-geometry.md`](references/viewport-geometry.md) | 改动涉及响应式/窄屏布局，要逐档核验几何表现 |
