# dsh-codegraph

codegraph MCP + worktree 开发纪律 —— 把 [codegraph](https://github.com/colbymchenry/codegraph)
（本地代码图谱 MCP，`@colbymchenry/codegraph`）与配套 worktree 开发纪律打包成 dsh 插件一键交付。

## 功能

- **探测 + 引导安装**：自动探测 codegraph CLI；未装时注入引导（输出安装命令，默认不自动执行）。
- **运行时注册**：经 dsh-mcp-manager 核心服务（`ctx.mcpManager`）注册 codegraph MCP 服务器
  （`codegraph serve --mcp`，内存态不落盘）；MCP 的注册/管理/使用基于 mcp-manager 接入
  （inject 强依赖，见「依赖」节）。
- **工具层硬纪律**（核心价值）：`codegraph_explore` 封装——查询前强制 `codegraph sync`
  （新鲜度硬保证，worktree 索引不过期）+ 校验/补全 `projectPath`（缺省补全为当前会话
  worktree，自动不了则拒绝并提示）。杜绝「worktree 索引静默过期」与「漏传 projectPath
  查错对象」。
- **agent 纪律钩子**：`agent/created` + 会话 cwd 判定，git 仓（主 checkout / worktree）会话
  才注入 worktree 开发纪律——以 systemPrompt 段注入（order 161，恒在 mcp-manager
  能力目录段之后，agent scope 注册沿 scope 链自动继承给子 agent）；非 git 仓
  （日常维护/讨论空间）不注入——多工作空间天然区分（按会话 cwd 判定，无需配置）。

## 安装

```bash
# 1. 安装 codegraph CLI（本插件不自动执行第三方命令，需用户/agent 显式安装）
npm install -g @colbymchenry/codegraph
# 或官方 install.sh（装二进制到 ~/.local/bin）
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | bash

# 2. 项目建索引（每 worktree 独立）
cd your-project && codegraph init

# 3. dsh 挂载插件（经 profile 安装 @wingsky-1/dsh-codegraph，需 dsh-mcp-manager 已启用）
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoInstall` | `false` | 未装 codegraph CLI 时自动安装（默认仅引导；开启需知悉供应链风险） |
| `installCommand` | `npm install -g @colbymchenry/codegraph` | 自定义安装命令 |
| `injectDiscipline` | `true` | 注入纪律到 git 仓会话 |

> 工具层纪律（查询前强制 sync + projectPath 校验/补全）是核心价值，固化为默认行为，
> 不提供关闭开关——保证「worktree 索引不过期」「不漏传 projectPath」不被配置绕过。

## Worktree 开发流程

```
git worktree add ../dsh-hub-task-<n> -b task/<n>   # 建 worktree
codegraph init ../dsh-hub-task-<n>                 # 建该 worktree 索引（每 worktree 独立）
# 开发中改文件 → 查询时工具自动先 sync（无需手动）
# 任务结束清理 worktree 时 .codegraph/ 随目录删除
```

- `.codegraph/` 是本地运行时产物（已建议 gitignore），不入库；
- 未 init 的目录查询返回引导而非报错；索引只覆盖 init/sync 时的文件。

## 安全模型

- **不自动执行第三方安装命令**（默认 `autoInstall: false`）：安装命令来自
  `@colbymchenry/codegraph`（第三方），供应链风险由用户显式执行安装时自担；
  开启 `autoInstall` 需知悉插件会执行该命令。
- **stdio 子进程继承宿主权限**：codegraph MCP 服务器以宿主进程权限运行（同其他 stdio MCP）。
- **索引为本地 SQLite 无加密**：`.codegraph/` 含全部源码结构，多用户机器上注意目录权限。
- **外部二进制非自包含**：codegraph 是独立安装的二进制，不随本插件发布；本插件只探测 +
  引导安装（发布物自包含，无运行时 npm 依赖）。
- **工具在真实服务器上执行**：`codegraph_explore` 会真实查询本地索引，先确认再操作。

## 依赖

- **dsh-mcp-manager**（提供 `ctx.mcpManager` service）：**强依赖**（inject 声明）。
  MCP 的注册/管理/使用基于 mcp-manager 接入；mcp-manager 未启用时本插件由 cordis
  内核自动停用（启用后自动激活），不单独降级。
- codegraph CLI（`@colbymchenry/codegraph`，探测 + 引导安装）
