# dsh-plugin-hub

DSH（DeepSeek Harness）Web GUI 插件集，**npm 分发**：既可一键安装全家桶，也可单独安装单个插件。

- 聚合包：`@wingsky/dsh-plugins-all`（一键装齐全部插件）
- 单插件：`@wingsky/dsh-notifier`、`@wingsky/dsh-skill-explorer` 等（按需安装）
- 所有插件走 DSH 官方 profile 机制挂载（`dsh.bundle.patch`），不改 DSH 源码

## 插件列表

| 包名 | 功能 | 状态 |
|---|---|---|
| `@wingsky/dsh-gzip` | /api 响应 gzip 压缩 | ✅ 已迁入（待发布） |
| `@wingsky/dsh-idle-archive` | 会话闲置提醒归档 | ✅ 已迁入（待发布） |
| `@wingsky/dsh-notifier` | 审批/完成/错误事件通知（浏览器 Notification + 系统 toast） | 🚧 待迁入 |
| `@wingsky/dsh-skill-explorer` | 技能中心：只读展示已加载 skill，按来源分级 | 🚧 待迁入 |
| `@wingsky/dsh-opencode-usage` | OpenCode Go 套餐用量悬浮框（rolling/weekly/monthly） | 🚧 待迁入 |
| `@wingsky/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS 转发 + TLS） | 🚧 待迁入 |
| `@wingsky/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP，工具注册给模型） | 🚧 待迁入 |


> dsh-memory（项目长期记忆）未包含在本集合内。

## 安装

已安装 DeepSeek Harness 且 `dsh web` 可正常启动的前提下：

```sh
# 一键装全家桶（推荐，当前包含 gzip / idle-archive）
dsh plugin --profile web add @wingsky/dsh-plugins-all

# 或单独安装
dsh plugin --profile web add @wingsky/dsh-gzip
dsh plugin --profile web add @wingsky/dsh-idle-archive

# 卸载
dsh plugin --profile web remove @wingsky/dsh-gzip
dsh plugin --profile web remove @wingsky/dsh-idle-archive
```

装完**重启一次** `dsh web`（bundle 层只在启动时组合），侧边栏/设置页出现插件入口。

## 开发

```sh
pnpm install
pnpm build        # 构建全部插件（宿主端 tsc + esbuild 内联 shared；客户端 esbuild IIFE）
pnpm contract     # 客户端 8 项契约检查
pnpm test         # 全量 smoke
pnpm pack:check   # 打包冒烟：pnpm pack 后检查 tarball 内容完整性
```

目录结构：

```
packages/dsh-*/        # 每个插件 = 独立 npm 包（@wingsky/dsh-*）
packages/dsh-plugins-all/  # 聚合包（dependencies 引用全部子包）
shared/                # 宿主端共享层（loopback/host-utils/frontmatter），构建期内联进各包，不发布
types/dsh.d.ts         # 自建 DSH 插件类型层
scripts/               # 构建/契约/打包校验脚本（bundle-host / contract-check / pack-check）
```

插件迁入本仓库前均经过开源前审查（构建自包含、隐私清理、安全加固、元数据完整）。

## License

[MIT](LICENSE)
