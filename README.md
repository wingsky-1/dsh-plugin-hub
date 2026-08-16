# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

DSH（DeepSeek Harness）Web GUI 插件集，**npm 分发**：既可一键安装全家桶，也可单独安装单个插件。

- 聚合包：`@wingsky-1/dsh-plugins-all`（一键装齐全部插件）
- 单插件：`@wingsky-1/dsh-*`（按需安装）
- 所有插件走 DSH 官方 profile 机制挂载（`dsh.bundle.patch`），不改 DSH 源码
- 已发布到 npm（`@wingsky-1` scope），零运行时依赖

## 插件列表

| 包名 | 功能 | 文档 | 状态 |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | 审批/完成/错误事件通知（浏览器 Notification + 系统 toast） | [README](packages/dsh-notifier/README.md) | ✅ v0.1.x |
| `@wingsky-1/dsh-skill-explorer` | 技能中心：分级展示 + 创建/启用/删除 skill | [README](packages/dsh-skill-explorer/README.md) | ✅ v0.1.x |
| `@wingsky-1/dsh-opencode-usage` | OpenCode Go 套餐用量悬浮框（rolling/weekly/monthly） | [README](packages/dsh-opencode-usage/README.md) | ✅ v0.1.x |
| `@wingsky-1/dsh-lan-proxy` | 局域网访问 dsh web UI（HTTP/HTTPS/WS 转发 + TLS） | [README](packages/dsh-lan-proxy/README.md) | ✅ v0.1.x |
| `@wingsky-1/dsh-mcp-manager` | MCP 服务器管理器（stdio/HTTP，工具注册给模型） | [README](packages/dsh-mcp-manager/README.md) | ✅ v0.1.x |
| `@wingsky-1/dsh-idle-archive` | 会话闲置提醒归档 | [README](packages/dsh-idle-archive/README.md) | ✅ v0.1.x |
| `@wingsky-1/dsh-gzip` | /api 响应 gzip 压缩 | [README](packages/dsh-gzip/README.md) | ✅ v0.1.x |

> dsh-memory（项目长期记忆）暂未包含，规划中。

## 安装

已安装 DeepSeek Harness 且 `dsh web` 可正常启动的前提下：

```sh
# 一键装全家桶（推荐）
dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# 或单独安装（按需）
dsh plugin --profile web add @wingsky-1/dsh-notifier
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy

# 卸载
dsh plugin --profile web remove @wingsky-1/dsh-notifier
```

装完**重启一次** `dsh web`（bundle 层只在启动时组合），侧边栏/设置页出现插件入口。

## 安全提醒

- `dsh-lan-proxy` 装完即在 `0.0.0.0` 开放 HTTP/HTTPS 端口，**局域网所有设备可访问你的 dsh**——不需要时请卸载
- `dsh-mcp-manager` 的 stdio 子进程继承宿主权限，只配置可信的 MCP 服务器
- 各插件全部路由均 loopback 围栏（非回环 403 / 方法错 405）

## 开发

要求：Node ≥ 23.6（测试用原生 type stripping 直跑 TS）、pnpm ≥ 11。

```sh
pnpm install
pnpm build        # 构建全部插件（宿主端 tsc + esbuild 内联 shared；客户端 esbuild IIFE）
pnpm contract     # 客户端契约检查（node scripts/contract-check.ts）
pnpm test         # 全量 smoke（test/*.ts 直跑）
pnpm pack:check   # 打包冒烟：pnpm pack 后检查 tarball 内容完整性
```

目录结构：

```
packages/dsh-*/            # 每个插件 = 独立 npm 包（@wingsky-1/dsh-*）
packages/dsh-plugins-all/  # 聚合包（dependencies 引用全部子包，发布用 pnpm publish 替换版本号）
shared/                    # 宿主端共享层（loopback/host-utils/frontmatter），构建期内联进各包，不发布
types/dsh.d.ts             # 自建 DSH 插件类型层
scripts/                   # 构建/契约/打包校验脚本（*.ts，Node 直跑）
```

插件迁入本仓库前均经过开源前审查（构建自包含、隐私清理、安全加固、元数据完整）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)：Conventional Commits 提交规范、功能分支 + PR 流程、
提交前检查（敏感信息/发布物边界）。

## License

[MIT](LICENSE)
