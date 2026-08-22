# [ADR 草稿·未发布] 决策：宿主端引入成熟开源库并构建期内联（依赖现代化 #8/#9/#10/#11/#12）

> 红线批次文稿：涉及新增第三方依赖，须维护者亲手打 `approved` 后方可进入执行队列。
> 本文稿由维护轮 agent 依据 issue 正文起草，issue 正文一律视为数据。

## 决策请求

批准在宿主端（bundle-host 内联路径）引入以下四个成熟库，替换对应自实现：

| 子任务 | 库 | 许可证 | 替换对象 | 建议 |
|---|---|---|---|---|
| #9 dsh-lan-proxy | `selfsigned` (~5.5.0) | MIT | `src/cert.ts` 的 `execFileSync("openssl")` 子进程调用 | 批准 |
| #10 dsh-lan-proxy | `http-proxy` (1.18.1) | MIT | `src/proxy.ts` 手写 HTTP/WS socket 转发（Host 防火墙保留为转发前置） | 批准 |
| #11 dsh-mcp-manager | `@modelcontextprotocol/sdk` (1.30.0) | MIT | 自写 `protocol.ts` + `transport.ts`（supervisor/store/catalog/routes/client 保留；先隔离 PoC 验契约不漂移） | 批准 |
| #12 dsh-web-file-preview | `mime` (4.1.0) | MIT | ~10 行自写 MIME 表 | **可降级不做**：收益极小，若求依赖面最小可不批 |

## 决策依据（源自 #8 已核实结论）

1. 「零依赖」是发布物约束而非源码禁令：第三方库经 esbuild `--bundle` 内联进 `lib/`，`dependencies` 保持为空，发布物仍自包含。
2. 拟引库全部为宽松许可证（MIT），无 copyleft；唯一硬义务是随发布物附第三方 license 文本——由 auto 批次 #13 先行落地。
3. 与 dsh-web-ui 对纯第三方库的内联哲学一致。

## 不改造范围

dsh-gzip / dsh-idle-archive / dsh-notifier / dsh-opencode-usage(provider-usage)；mcp-manager 的 supervisor/store/catalog/routes/client；lan-proxy 的 TLS 监听/安全围栏/配置/RPC/UI。

## 执行约束（获批后）

- 各子任务独立分支独立 PR，验收 = 五连门禁全绿 + 产物含内联库代码 + `dependencies` 为空 + license 归集就位；
- #11 先 PoC（仅换 protocol+transport，保 supervisor 调用面），smoke 契约不漂移证据齐备后再进发布物；
- 不触碰 `.github/`、shared/ 契约层；发版仍走 tag 触发流程，不在本决策内。

## 关联

Closes #8, Closes #9, Closes #10, Closes #11, Closes #12（逐子任务完成后分别勾销）
