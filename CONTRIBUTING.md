# Contributing

感谢对 dsh-plugin-hub 感兴趣！本仓库是 DSH（DeepSeek Harness）插件集的开源发布仓，
代码规范遵循 [Conventional Commits](https://www.conventionalcommits.org)。

## 提交信息

```
<type>(<scope>): <subject>
```

- type：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci` / `perf`
- scope：插件名（如 `dsh-gzip`）或省略
- subject：动词开头，一行说清改动

示例：`fix(dsh-lan-proxy): 收紧 targetHost 回环白名单`

## 开发流程

1. Fork 本仓库（或直接提 issue 讨论）
2. 创建功能分支：`feat/<主题>` 或 `fix/<主题>`
3. 本地验证全绿：

```sh
pnpm install
pnpm --filter @wingsky-1/<插件> build && pnpm --filter @wingsky-1/<插件> test
node scripts/contract-check.ts && node scripts/pack-check.ts
```

4. 推分支 → 开 PR（描述动机 + 改动 + 验证结果）
5. CI 全绿后 review → squash merge

## 提交前检查

- 敏感信息：不提交本机路径/用户名/IP/凭据（全仓库 grep 本机用户名、`192.168`、`/home/<user>`、token 形状应为空）
- 发布物：`pnpm pack` 后 tarball 不含 `src/`、`test/`、内部文档
- 只推功能代码与对外文档，不推内部治理/讨论细节

## 测试

- smoke 全部无网络、无真实凭据，本地可直接运行
- 新功能/修复必须带 smoke 断言（含路由 403/405 围栏用例）

## 参考文档

- 开发规范（宿主/客户端写法、构建契约、多端兼容、测试防 flake 纪律）：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 仓库规则（全局约定、发布纪律）：[AGENTS.md](AGENTS.md)

## License

MIT
