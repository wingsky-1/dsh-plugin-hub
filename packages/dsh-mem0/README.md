# @wingsky-1/dsh-mem0

DeepSeek Harness (DSH) 长期记忆系统插件：基于 mem0 的本地/轻量持久记忆系统。

## 功能特性

- **本地 stdio 极简运行时**：通过管道拉起轻量 Python 子进程，随 Node 父进程同生共死，天然零孤儿进程、零端口冲突。
- **Git 工作空间感知**：原生识别会话 `cwd`，并通过 Git Canonical 溯源自动统一主仓与所有 Worktree 的记忆空间。
- **全英文工具契约**：提供 `memory_search`、`memory_add`、`memory_list`、`memory_delete` 4 个核心工具，面向 LLM 的描述全英文，具备离线无感降级容错。
- **中文事实沉淀**：内置中文约束提示词模板，自动过滤琐碎寒暄，保证记忆全中文提炼入库。
- **记忆中心设置 Tab**：官方 `settings.section` 挂载独立页面，支持记忆检索、列表浏览与单条删除。
- **dsh-mcp-manager 统一纳管**：生命周期与工具状态完全交由 `dsh-mcp-manager` 统管。

## 安全模型

- **进程隔离**：本地 stdio 模式通过操作系统管道通信，不监听外部网络端口。
- **Loopback 围栏**：所有 `/api/dsh-mem0/*` REST 接口强制执行回环校验，拒绝一切非 loopback 跨站访问（403 阻断）。
- **凭据保护**：继承 DSH 现有 Model Provider 配置，API Key 通过环境变量安全透传，不落盘至明文文件。
- **防误清库**：不暴露批量清库工具，单条物理删除需经过前端二次确认。

## 许可证

MIT
