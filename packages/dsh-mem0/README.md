# @wingsky-1/dsh-mem0

DeepSeek Harness (DSH) 长期记忆系统插件：基于 mem0 的本地/轻量持久记忆系统。

## 功能特性

- **本地 stdio 极简运行时**：通过管道拉起轻量 Python 子进程，随 Node 父进程同生共死，天然零孤儿进程、零端口冲突。
- **Git 工作空间感知**：原生识别会话 `cwd`，并通过 Git Canonical 溯源自动统一主仓与所有 Worktree 的记忆空间。
- **全英文工具契约**：提供 `memory_search`、`memory_add`、`memory_list`、`memory_delete` 4 个核心工具，面向 LLM 的描述全英文，具备离线无感降级容错。
- **中文事实沉淀**：内置中文约束提示词模板，自动过滤琐碎寒暄，保证记忆全中文提炼入库。
- **全面配置化支持**：LLM 与 Embedder 端点全可配（支持 DeepSeek、SiliconFlow 等 OpenAI 兼容端点），支持自定义 TopK 与中文抽取指令，持久化至 DSH 官方 settings（`~/.dsh/settings.yaml`）。
- **记忆中心双区大盘**：官方 `settings.section` 挂载独立页面，提供“记忆条目列表”与“引擎配置大盘”双区，支持可视化脱敏修改与即时热重启。
- **自愈诊断与优雅降级**：当宿主缺少 Python 或依赖库时，前端自动精准诊断并提供一键复制命令；Agent 工具层自动熔断优雅降级，绝不抛红崩溃。
- **dsh-mcp-manager 统一纳管**：生命周期与工具状态完全交由 `dsh-mcp-manager` 统管。

## 安全模型

- **进程隔离**：本地 stdio 模式通过操作系统管道通信，不监听外部网络端口。
- **Loopback 围栏**：所有 `/api/dsh-mem0/*` REST 接口强制执行回环校验，拒绝一切非 loopback 跨站访问（403 阻断）。
- **凭据保护**：继承 DSH 现有 Model Provider 配置，API Key 通过环境变量安全透传，不落盘至明文文件。
- **防误清库**：不暴露批量清库工具，单条物理删除需经过前端二次确认。

## 许可证

MIT
