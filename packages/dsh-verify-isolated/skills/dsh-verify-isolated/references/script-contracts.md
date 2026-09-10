# 脚本契约（`verify-isolated.mjs` 的内部行为）

> 读它的时机：要解读 `verdict.json`、要开隔离审计（`--audit`）、或启动/就绪失败需要
> 定位原因。日常跑一次隔离验证不需要本文件——`node .../verify-isolated.mjs --help`
> 是选项契约的唯一事实源，选项冲突时以 `--help` 为准。

## 脚本自动完成的链路

建临时 `DSH_HOME` → 校验 dsh 入口并打印版本（`--dsh` 锚定）→ **预置首启弹窗跳过**
（写隔离 `$DSH_HOME/settings.yaml` 的内测声明版本，见 SKILL.md「首启弹窗默认跳过」；
`--no-skip-onboarding` 关闭）→ 建 `verify_<8位随机>` profile
（`dsh plugin --profile <p> list` 显式初始化，失败即报可操作错误）→ 注入内置
`@deepseek-ai/dsh-web-app` bundle → 构建并把本地插件 link 进 profile（`--no-build`
时校验产物存在 + 陈旧警告）→ `--browser` 时启动独立浏览器实例（实例信息写入
`$DSH_HOME/browser.state`）→ 启动隔离 `dsh web`（显式 `--host 127.0.0.1` 回环 +
`DSH_TELEMETRY_DISABLED=1` 遥测禁用）→ 就绪断言（轮询 HTTP 可达，2xx-4xx 就绪、
15s 超时报可操作错误）→ 打印带访问令牌的 URL 并写入 `browser.state.dshWebUrl` →
前台等待。`Ctrl+C` 退出时统一清理 dsh 进程、浏览器实例、临时 `DSH_HOME` 与 profile
（SIGINT/SIGTERM 透传退出码 130/143）。

## B6 启动自检 verdict

就绪后写 `$DSH_HOME/verdict.json`（0o600），退出终态更新 `cleanup` 字段
（`"running"` → `"done"` / `"kept"`）。字段要点：

| 字段 | 含义 |
|------|------|
| `port` | `{ requested, actual, source }`；`source` 三通道：`parsed`（解析 dsh 输出行）→ `asserted`（就绪断言端口）→ `probed`（`--port 0` 探测值） |
| `web` | `{ url, tokenSource }`：**不含令牌**的访问 URL（verdict 会经 `--json` 进 CI 日志，令牌只落 0o600 的 `browser.state` / `dsh.log`） |
| `onboarding` | 首启弹窗预置结果：`source` 为 `preset`（已预置）/ `unavailable`（未取到版本）/ `disabled`（`--no-skip-onboarding`）/ `existing` / `write-failed` |
| `audit` | `--audit` 时的审计结果；否则 `null`（错误路径的错误 JSON 也恒带该字段） |
| `ready` / `readyAt` | 就绪断言是否通过及其时刻 |

`--json` 让 stdout 只出最终 verdict JSON，人类文案全部走 stderr。

## B7 证据目录

默认 `$DSH_HOME/evidence/`（脚本打印路径；退出随临时目录清理，`--keep` 保留）。
显式 `--evidence-dir <dir>` 外部化时建 `<dir>/evidence-<profile>/` 子目录，
**绝不动外部目录本体**（不删、不覆盖）。

## B4 隔离审计（`--audit`）

对比隔离 `$DSH_HOME` 的写面与**预置白名单**（`scripts/lib/audit.mjs` 的版本化
`WHITELIST_V`）：白名单外的新增/删除/修改报「可疑」（纯 stat 路径级，不读内容）；
白名单内变化忽略；未知顶层路径 → 可疑。**不阻断退出**——审计是补充证据，不是门禁，
退出码契约不因它改变。

白名单覆盖 dsh 自身写面：`profiles/**`、`*.json`、`*.jsonl`、`*.log`、
`.credentials.yaml`、`settings.yaml`（官方设置文档：首启弹窗跳过会预置它，此后页面里
改任何设置也由 dsh 重写）、`browser.state`、`browser-profile/**`（整树 + 跳过深扫）、
`evidence/**`、`audit/**`、`storages/**`、`dsh.log`、`verdict.json`。
随 dsh 版本漂移的面（如 `profiles/node_modules/**` 的官方 bundle link）由 **t0 动态
基线**覆盖。

**symlink 防逃逸**：快照 lstat 不跟随；`t1` 时**新增的**或**目标变化**、且 resolve 后
落在**所在扫描根**之外的 symlink 报「越界 symlink」（防插件经 symlink 写到隔离环境
之外的用户数据或仓库）；`t0` 已存在且目标未变的外部 symlink（`link:` 挂载点，合法）
不报。防逃逸优先于白名单——`profiles/**` 内新增越界 symlink 同样报。

**时序**：`t0` 基线在**就绪断言成功之后**扫描，语义是「**就绪后运行期写面审计**」——
dsh 启动期的自身写面与官方 bundle link 进基线，审计面 = dsh 就绪后、退出前的增量写面。
审计插在退出清理序列「kill dsh → browser quit → **审计** → verdict 终态 → rm」之间；
就绪前退出/超时路径不审计（`audit` 为 `null`）。

**局限**：只扫 `$ISOLATED_HOME` 子树 + `--audit-extra-dirs <dir>`（可重复，相对路径
基于 cwd 绝对化、必须是目录）指定的额外目录，**不扫真实 home**——插件写到真实 `~/.dsh`
的数据面不在判定面内（这类盲区按 SKILL.md「隔离自检」第 5 项处置）。`--keep` 时报告落
`$DSH_HOME/audit/audit.json`，否则随 `--json` 终态 verdict 的 `audit` 字段输出。

## 退出码契约

| 码 | 含义 |
|----|------|
| 0 | 正常完成：启动 + 就绪 + 前台等待 dsh 退出，清理完毕 |
| 1 | 启动或就绪失败：profile 初始化失败 / add 失败 / dsh 就绪前退出 / 15s 就绪超时 |
| 2 | 参数错误：未知选项 / 缺参 / 找不到 dsh 入口 / `--no-build` 缺产物 |
| 130 / 143 | SIGINT / SIGTERM：终态清理后透传 |

就绪后 dsh 自身异常退出时，其退出码原样透传。

## Windows 承诺等级：试验性

`spawn`/`execFile` 对 `.cmd` 的回退、无 POSIX 信号（`taskkill /T` 进程树清理）等兼容点
在代码里逐处标注，但未在 CI 实测。排查看 `verify-isolated.mjs` 头部注释的「Windows
三坑」。

## 构建说明

dsh 直读插件的构建产物（随各仓约定为 `lib/` 或 `dist/`，见插件包 `package.json` 的
build 脚本），脚本默认在挂载前 `pnpm build` 各插件以保证产物存在；产物已就绪时可用
`--no-build` 跳过（此时脚本校验产物存在，源码比产物新会给陈旧警告——警告出现即意味着
你可能在验证旧界面）。
