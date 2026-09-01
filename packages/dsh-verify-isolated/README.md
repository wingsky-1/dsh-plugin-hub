# dsh-verify-isolated

DSH 插件开发的**隔离环境浏览器验证** skill 插件：临时 `DSH_HOME` + 独立
`verify_<随机>` profile 双重隔离，一键拉起隔离 `dsh web`，退出自动清理，
不污染正在使用的 `web` profile。

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
- **双重隔离**：`DSH_HOME=$(mktemp -d)` 隔离凭据/会话/home 级 patch；独立
  `verify_<8位随机>` profile 隔离插件组合栈，不触碰用户 `web` profile；
- **最小启动依赖**：profile bundles 含 `@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app`（内置 bundle 按名从 dsh 安装目录解析，不走 npm）；
- **一键脚本** `skills/dsh-verify-isolated/scripts/verify-isolated.sh`：建临时
  DSH_HOME → 建 profile → 注入 web-app bundle → 构建并 link 本地插件 → 启动 →
  退出 trap 自动清理。

## 包结构

```text
skills/dsh-verify-isolated/
  SKILL.md                        # skill 定义（frontmatter name=dsh-verify-isolated）
  scripts/verify-isolated.sh      # 一键隔离验证脚本
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
```

## 安全模型

- 隔离环境不携带真实凭据（临时 `DSH_HOME` 无 `~/.dsh` 数据）；
- 不关闭/重启运行中的主 `dsh web` 进程（独立端口）；
- 脚本只用 `mktemp -d` 临时目录，退出即清理，不留残留。
