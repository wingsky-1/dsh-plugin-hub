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
- **四重隔离**：`DSH_HOME=$(mktemp -d)` 隔离凭据/会话/home 级 patch；独立
  `verify_<8位随机>` profile 隔离插件组合栈；独立端口隔离网络面；**独立浏览器
  实例**（`--browser`）隔离页面/tab/console——多会话并行互不可见，从结构上杜绝
  共享 MCP 浏览器的 tab 漂移串扰；
- **自带浏览器驱动** `skills/dsh-verify-isolated/scripts/browser-driver.mjs`：
  raw CDP 零依赖（仅 Node ≥22 内置全局 WebSocket），launch 独立 chromium
  （临时 user-data-dir + 自选空闲调试端口 + headless），原子操作 CLI
  （snapshot / click / eval / fill / wait / screenshot / console / quit），
  统一 `--json` 输出，实例信息写入 `browser.state`；三平台内核探测链
  （`DSH_VERIFY_CHROME` env → ms-playwright 缓存 → PATH → 平台常见路径），
  全缺失 fail-fast 打印安装指引；
- **最小启动依赖**：profile bundles 含 `@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app`（内置 bundle 按名从 dsh 安装目录解析，不走 npm）；
- **一键脚本** `skills/dsh-verify-isolated/scripts/verify-isolated.sh`：校验 dsh
  入口并打印版本（`--dsh` 锚定目标 dsh 版本）→ 建临时 DSH_HOME → 建 profile
  （`plugin list` 显式初始化）→ 注入 web-app bundle → 构建并 link 本地插件
  （`--no-build` 时校验产物存在 + 陈旧警告）→ （可选 `--browser`）启动独立浏览器
  实例 → 启动（显式 `--host 127.0.0.1` 回环 + `DSH_TELEMETRY_DISABLED=1` 遥测
  禁用）→ 就绪断言 → 退出 trap 统一清理（dsh 进程 + 浏览器进程 +
  user-data-dir + DSH_HOME 无残留）；`--port 0` 自动探测真实空闲端口（不再打印
  无效的 0）。

## 包结构

```text
skills/dsh-verify-isolated/
  SKILL.md                        # skill 定义（frontmatter name=dsh-verify-isolated）
  scripts/verify-isolated.sh      # 一键隔离验证脚本（--dsh / --browser / --port 0 / --keep / --no-build）
  scripts/resolve-pkg-paths.mjs   # 插件参数归一化（相对路径→绝对 / 包规格透传，#517 C11）
  scripts/browser-driver.mjs      # 自带独立浏览器驱动（raw CDP 零依赖，--json 原子操作 CLI）
cordis.patch.yml                  # 复用官方 dsh-skill-filesystem + bundledSkillDir
lib/index.js                      # 宿主门禁出口（name + 空 apply）
```

## 使用

skill 加载后按清单执行；也可直接调包内一键脚本。脚本相对 skill 的资源基础目录
（加载 skill 时注入的 `Base directory for this skill:` 绝对路径）恒为
`scripts/verify-isolated.sh`，安装形态自适应（npm 副本 / `link:` 开发态 / 仓库内
浏览均可用），详见 SKILL.md §2：

```bash
# SKILL_BASE = 加载 skill 时注入的「Base directory for this skill:」绝对路径
bash "$SKILL_BASE/scripts/verify-isolated.sh" --port 3456 <插件包路径>
# 多会话并行/浏览器验证：--port 0 自动探测端口，--browser 拉起独立浏览器实例
bash "$SKILL_BASE/scripts/verify-isolated.sh" --port 0 --browser <插件包路径>
# 锚定 dsh 版本（验证特定 dsh 版本生态时必带，防 PATH 漂移）
bash "$SKILL_BASE/scripts/verify-isolated.sh" --dsh /opt/dsh-0.1.2-alpha.2/bin/dsh --port 0 <插件包路径>
```

插件参数支持**本地插件路径**（相对路径基于当前 cwd 自动解析为绝对路径后挂载，
规避 dsh 把非绝对路径当 git URL 解析——#517 C11）或**包规格**（npm 包名/git URL
原样透传）。

浏览器实例操作（实例信息在 `$DSH_HOME/browser.state`；命令契约见
`browser-driver.mjs --help`。**页面操作命令需 Node ≥22**——依赖内置全局
WebSocket，更低版本会在连接时报错提示升级）：

```bash
node "$SKILL_BASE/scripts/browser-driver.mjs" snapshot --state "$DSH_HOME/browser.state" --url http://127.0.0.1:<端口>
node "$SKILL_BASE/scripts/browser-driver.mjs" click --state "$DSH_HOME/browser.state" --selector "button.start"
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$DSH_HOME/browser.state" --path shot.png
```

## 安全模型

- 隔离环境不携带真实凭据（临时 `DSH_HOME` 无 `~/.dsh` 数据）；
- 隔离 `dsh web` 显式回环绑定（`--host 127.0.0.1`，仅本机可连）并显式禁用遥测
  （`DSH_TELEMETRY_DISABLED=1`，测试数据不外发）；
- 不关闭/重启运行中的主 `dsh web` 进程（独立端口）；
- 浏览器实例只绑定回环调试端口（`--remote-debugging-address=127.0.0.1`），
  仅本机可连；
- 脚本只用 `mktemp -d` 临时目录，退出即清理（`--browser` 时浏览器进程与
  user-data-dir 随 trap 一并清理），不留残留。
