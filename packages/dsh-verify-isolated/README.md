# dsh-verify-isolated

DSH 插件开发的**隔离环境浏览器验证** skill 插件：临时 `DSH_HOME` + 独立
`verify_<随机>` profile 双重隔离，一键拉起隔离 `dsh web`，退出自动清理，
不污染正在使用的 `web` profile。

## 安装

```bash
dsh plugin --profile web add @wingsky-1/dsh-verify-isolated
```

安装后插件 `apply()` 经 `ctx.skills.registerProvider` 注册 `dsh-verify-isolated`
skill，profile 内所有会话即可用（`/skill dsh-verify-isolated` 查看）。

## 使用

skill 加载后按清单执行；也可直接调包内一键脚本：

```bash
# 用户级安装（本机所有 dsh 项目可用）
git clone https://github.com/wingsky-1/dsh-dev-utils.git "$DSH_HOME/skills/dsh-dev-utils"
# 或插件包内脚本
node_modules/@wingsky-1/dsh-verify-isolated/scripts/verify-isolated.sh --port 3456 <插件包路径>
```

## 工作原理

- **双重隔离**：`DSH_HOME=$(mktemp -d)` 隔离凭据/会话/home 级 patch；独立
  `verify_<8位随机>` profile 隔离插件组合栈，不触碰用户 `web` profile；
- **最小启动依赖**：profile bundles 含 `@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app`（内置 bundle 按名从 dsh 安装目录解析，不走 npm）；
- **一键脚本** `scripts/verify-isolated.sh`：建临时 DSH_HOME → 建 profile →
  注入 web-app bundle → 构建并 link 本地插件 → 启动 → 退出 trap 自动清理。

## 安全模型

- 隔离环境不携带真实凭据（临时 `DSH_HOME` 无 `~/.dsh` 数据）；
- 不关闭/重启运行中的主 `dsh web` 进程（独立端口）；
- 脚本只用 `mktemp -d` 临时目录，退出即清理，不留残留。
