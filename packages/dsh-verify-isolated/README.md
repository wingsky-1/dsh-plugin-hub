# dsh-verify-isolated

DSH 插件开发的**隔离环境浏览器验证** skill 插件：临时 `DSH_HOME` + 独立
`verify_<随机>` profile + 独立端口 + **独立浏览器实例**四重隔离，一键拉起隔离
`dsh web`，退出自动清理，不污染正在使用的 `web` profile。

## 安装

```bash
dsh plugin --profile web add @wingsky-1/dsh-verify-isolated
```

安装后 `dsh-verify-isolated` skill 自动注册为内置 skill，profile 内所有会话
即可用（`/skill dsh-verify-isolated` 查看）。

## 工作原理

- **内置 skill 注册**：`cordis.patch.yml` 复用官方 `@deepseek-ai/dsh-skill-filesystem`
  的 `bundledSkillDir` 配置，从包 manifest 解析本包 `skills/` 目录（参照
  [archify-dsh](https://github.com/tt-a1i/archify) 模式）——官方 provider 发现并
  注册 `skills/dsh-verify-isolated/SKILL.md`，无需自写注册代码；
- **主线 + 支线披露**：`SKILL.md` 只放每次验证都要用的判据与步骤（何时用、快速路径、
  两个硬前提、隔离自检、核验与完成检查），支线内容（脚本契约、手动步骤、内核排查、
  视口几何方法论）下沉到 `references/`，各文件自包含、由主线按「读它的时机」指向——
  一次常规验证不必加载支线，触发到对应分支时才读；
- **四重隔离**：`DSH_HOME=$(mktemp -d)` 隔离凭据/会话/home 级 patch；独立
  `verify_<8位随机>` profile 隔离插件组合栈；独立端口隔离网络面；**独立浏览器
  实例**（`--browser`）隔离页面/tab/console——多会话并行互不可见，从结构上杜绝
  共享 MCP 浏览器的 tab 漂移串扰；
- **自带浏览器驱动** `skills/dsh-verify-isolated/scripts/browser-driver.mjs`：
  raw CDP 零依赖（仅 Node ≥22 内置全局 WebSocket），launch 独立 chromium
  （临时 user-data-dir + 自选空闲调试端口 + headless），原子操作 CLI
  （snapshot / click / eval / fill / wait / screenshot / console / quit），
  统一 `--json` 输出，实例信息写入 `browser.state`；**设备模拟**：页面命令通用
  `--width / --height / --dpr / --mobile` 逐档设定视口验证响应式布局——命令内生效、
  结束即清除，命令之间互不影响（不做粘性状态的原因见 `scripts/lib/emulation.mjs`：
  CDP 的 Emulation 状态按 session 归属，跨连接清除会静默失效并残留）；三平台内核
  探测链（`DSH_VERIFY_CHROME` env → ms-playwright 缓存 → PATH → 平台常见路径），
  全缺失 fail-fast 打印安装指引；
- **最小启动依赖**：profile bundles 含 `@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app`（内置 bundle 按名从 dsh 安装目录解析，不走 npm）；
- **一键脚本** `skills/dsh-verify-isolated/scripts/verify-isolated.mjs`（node 实现，
  需 Node ≥22；历史 bash 版 `.sh` 已删除且不留 shim）：校验 dsh
  入口并打印版本（`--dsh` 锚定目标 dsh 版本）→ 建临时 DSH_HOME → **预置首启弹窗
  跳过**（写隔离 `settings.yaml` 的内测声明版本，见下）→ 建 profile
  （`plugin list` 显式初始化）→ 注入 web-app bundle → 构建并 link 本地插件
  （`--no-build` 时校验产物存在 + 陈旧警告）→ （可选 `--browser`）启动独立浏览器
  实例 → 启动（显式 `--host 127.0.0.1` 回环 + `DSH_TELEMETRY_DISABLED=1` 遥测
  禁用）→ 就绪断言 → **解析并打印带访问令牌的 URL**（同时写入
  `browser.state.dshWebUrl`）→ 退出统一清理（dsh 进程 + 浏览器进程 +
  user-data-dir + DSH_HOME 无残留）；`--port 0` 自动探测真实空闲端口（不再打印
  无效的 0）；**B6** 就绪后写 `$DSH_HOME/verdict.json` 启动自检（0o600，端口三通道
  source，退出终态更新 cleanup）；**B7** 证据目录 `--evidence-dir` 默认
  `$DSH_HOME/evidence/`、外部化建 `<dir>/evidence-<profile>/` 绝不动外部目录；
  **B4** 可选隔离审计 `--audit`——对比隔离 `$ISOLATED_HOME` 写面与预置白名单
  （版本化 `WHITELIST_V`，`scripts/lib/audit.mjs` 纯函数），白名单外新增/删除/修改
  与越界 symlink 报「可疑」、**不阻断退出**（`--audit-extra-dirs <dir>` 可加额外
  审计目录，必须是目录；局限：不扫真实 home；白名单含 dsh 自身写面
  `.credentials.yaml`/`settings.yaml`/`storages/**`，随版本漂移的官方 bundle link
  由就绪后 t0 基线覆盖——审计面 = 就绪后运行期增量写面；`--keep` 落
  `$DSH_HOME/audit/audit.json`，否则随 `--json` 终态 verdict 输出 `audit` 字段）；
  `--json` 时 stdout 只出最终 verdict JSON。退出码
  契约：0 正常 / 1 启动或就绪失败 / 2 参数错误 / 130 SIGINT / 143 SIGTERM。
- **首启弹窗默认跳过**：全新 DSH_HOME 的首屏是两个**阻断式**弹窗（「内测声明」→
  「添加 API Key」），两者都把 `#root` 置为 `inert`，页面上一切点击静默失效。脚本
  启动前预置 `settings.yaml` 的 `ui-onboarding.welcomeNoticeVersion`（值从 dsh
  客户端产物 `WELCOME_NOTICE_VERSION` 现取，不硬编码——dsh 升级后旧值会让弹窗
  重新出现且不报错）消掉第一个；「添加 API Key」无法预置消除（其「稍后配置」只在
  当前页面生命周期内有效，刷新必重弹），由 browser-driver 在导航后自动点击跳过。
  识别不到跳过按钮时**不猜**（弹窗内可能并列「保存并继续」这类有副作用的按钮），
  只输出 `onboardingBlocked` 并警告。`--no-skip-onboarding` 保留原生首启态，
  供验证 onboarding 本身；`--no-auto-dismiss` 让浏览器侧只探测不点击。
  纯函数与探测逻辑见 `scripts/lib/onboarding.mjs`。
- **访问鉴权（必须带令牌）**：dsh web 的 GUI 带鉴权，裸端口只返回 401 文本页
  （`dsh web authentication required`），而就绪断言把 2xx-4xx 都算就绪，因此漏带
  令牌会让验证在 401 页面上继续跑。令牌只在 dsh 启动打印的那一行里；脚本解析它并
  打印、写入 `browser.state.dshWebUrl`（0o600）供 browser-driver 的保留取值
  `--url state` 取用；verdict 只记不含令牌的 `web.url`，命令回显的 URL 恒去令牌
  （`token=***`），令牌不进 CI 日志与证据文件。

## 包结构

```text
skills/dsh-verify-isolated/
  SKILL.md                        # skill 定义（frontmatter name=dsh-verify-isolated；主线：何时用/快速路径/硬前提/自检/核验/完成检查）
  references/script-contracts.md  # 支线：verdict 字段、隔离审计白名单与时序、退出码、Windows 承诺
  references/manual-setup.md      # 支线：手动搭建隔离环境（脚本的等价展开）
  references/browser-kernel.md    # 支线：Chromium 内核探测链、三平台自查与安装
  references/viewport-geometry.md # 支线：设备视口逐档核验与几何断言方法论
  scripts/verify-isolated.mjs     # 一键隔离验证脚本（node，--dsh / --browser / --port 0 / --keep / --no-build / --evidence-dir / --audit / --audit-extra-dirs / --no-skip-onboarding / --json）
  scripts/lib/verify-core.mjs     # 共享基础工具（退出码常量/poll/findFreePort/端口与带令牌 URL 解析/C11 归一化）
  scripts/lib/audit.mjs           # B4 隔离审计纯函数（scanSnapshot/diffAgainstWhitelist/checkSymlinkEscape/runAudit + 版本化白名单 WHITELIST_V）
  scripts/lib/emulation.mjs       # 设备模拟参数纯函数（parseEmulationFlags / buildDeviceMetrics；CDP 会话语义依据）
  scripts/lib/onboarding.mjs      # 首启弹窗跳过纯函数（版本常量探测 / settings 文档 / 弹窗探针表达式 / 令牌脱敏）
  scripts/browser-driver.mjs      # 自带独立浏览器驱动（raw CDP 零依赖，--json 原子操作 CLI）
cordis.patch.yml                  # 复用官方 dsh-skill-filesystem + bundledSkillDir
lib/index.js                      # 宿主门禁出口（name + 空 apply）
```

## 使用

skill 加载后按清单执行；也可直接调包内一键脚本。脚本相对 skill 的资源基础目录
（加载 skill 时注入的 `Base directory for this skill:` 绝对路径）恒为
`scripts/verify-isolated.mjs`（node 实现，需 Node ≥22；原 bash 版升级路径：
`bash .../verify-isolated.sh ...` → `node .../verify-isolated.mjs ...`），安装形态
自适应（npm 副本 / `link:` 开发态 / 仓库内浏览均可用），详见 SKILL.md §2：

```bash
# SKILL_BASE = 加载 skill 时注入的「Base directory for this skill:」绝对路径
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 3456 <插件包路径>
# 多会话并行/浏览器验证：--port 0 自动探测端口，--browser 拉起独立浏览器实例
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --browser <插件包路径>
# 锚定 dsh 版本（验证特定 dsh 版本生态时必带，防 PATH 漂移）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --dsh /opt/dsh-0.1.2-rc.1/bin/dsh --port 0 <插件包路径>
# 证据目录外部化 + stdout 只出最终 verdict JSON（人类文案走 stderr）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --evidence-dir /tmp/my-evidence --json <插件包路径>
# 隔离审计（B4）：白名单外变化报「可疑」不阻断退出；--keep 落 $DSH_HOME/audit/audit.json
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --audit --keep <插件包路径>
# 保留原生首启态（验证 onboarding 弹窗本身时用；默认预置跳过，见 SKILL.md §3.2）
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --no-skip-onboarding <插件包路径>
```

插件参数支持**本地插件路径**（相对路径基于当前 cwd 自动解析为绝对路径后挂载，
规避 dsh 把非绝对路径当 git URL 解析）或**包规格**（npm 包名/git URL
原样透传）。

浏览器实例操作（实例信息在 `$DSH_HOME/browser.state`；命令契约见
`browser-driver.mjs --help`。**页面操作命令需 Node ≥22**——依赖内置全局
WebSocket，更低版本会在连接时报错提示升级）：

```bash
# --url state：用 state 里的带令牌 URL（GUI 带鉴权，裸端口只会得到 401 文本页）
node "$SKILL_BASE/scripts/browser-driver.mjs" snapshot --state "$DSH_HOME/browser.state" --url state
node "$SKILL_BASE/scripts/browser-driver.mjs" click --state "$DSH_HOME/browser.state" --selector "button.start"
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$DSH_HOME/browser.state" --url state --path shot.png
# 设备模拟（页面命令通用）：逐档视口验证响应式布局；命令内生效、结束即清除
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$DSH_HOME/browser.state" --url state --width 375 --height 667 --path phone.png
node "$SKILL_BASE/scripts/browser-driver.mjs" eval --state "$DSH_HOME/browser.state" --width 375 --height 667 --expression "innerWidth+'x'+innerHeight"
```

导航命令在导航后会自动跳过首启弹窗（输出 `dismissed` 记录所点按钮；识别不到跳过
按钮时输出 `onboardingBlocked` 并警告）；`--no-auto-dismiss` 只探测不点击，
`--overlay-wait <ms>` 调整弹窗等待窗口（默认 1500）。`eval` / `fill` 不导航，
不触发这套逻辑。

## 安全模型

- 隔离环境不携带真实凭据（临时 `DSH_HOME` 无 `~/.dsh` 数据）；首启弹窗跳过只写
  隔离 `$DSH_HOME/settings.yaml`（0o600）与点击弹窗自身的「稍后配置」按钮，**不注入
  也不复制任何 API Key**；脚本继承启动环境（`{...process.env}`，与既有语义一致），
  环境里已有的 provider 凭据变量会照 dsh 官方优先级生效——需要绝对干净的凭据面时
  自行在无凭据变量的 shell 中启动；
- **访问令牌最小暴露**：带令牌的 GUI URL 只落 0o600 的
  `$DSH_HOME/browser.state`（`dshWebUrl`）与 `$DSH_HOME/dsh.log`；脚本与
  browser-driver 回显的 URL 恒去令牌（`token=***`），verdict 只记不含令牌的
  `web.url`——令牌不进 `--json` 输出、CI 日志与证据归档；
- 隔离 `dsh web` 显式回环绑定（`--host 127.0.0.1`，仅本机可连）并显式禁用遥测
  （`DSH_TELEMETRY_DISABLED=1`，测试数据不外发）；
- 隔离验证只覆盖**回环访问形态**（脚本固定 `--host 127.0.0.1`）。要验证局域网/
  移动端访问形态，需自行用官方 `--trusted-host <authority>` 拉起，并自行确认被测
  插件在该形态下的鉴权与围栏行为；
- 不关闭/重启运行中的主 `dsh web` 进程（独立端口）；
- 浏览器实例只绑定回环调试端口（`--remote-debugging-address=127.0.0.1`），
  仅本机可连；
- 脚本只用 `mktemp -d` 临时目录，退出即清理（`--browser` 时浏览器进程与
  user-data-dir 一并清理），不留残留。
