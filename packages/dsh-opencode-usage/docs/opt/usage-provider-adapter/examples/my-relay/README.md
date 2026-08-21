# my-relay 自定义适配器示例

演示如何为 `@wingsky-1/dsh-opencode-usage` 接入一个自定义中转站：
**识别 provider → 宿主拉数 → 胶囊/面板渲染** 端到端链路。

## 文件

| 文件 | 作用 |
| --- | --- |
| `my-relay-host.mjs` | 宿主取数适配器（Node 进程，完整权限）：调你中转站的用量接口，归一化返回 |
| `my-relay-client.js` | 客户端渲染器（浏览器）：自注册胶囊文案（可选）与面板卡片 |

## 接线步骤

1. 把两个文件放到任意本地路径（示例用 `~/.dsh/`）：

```sh
cp my-relay-host.mjs ~/.dsh/my-relay-host.mjs
cp my-relay-client.js ~/.dsh/my-relay-client.js
```

2. 在用户 patch 层（`cordis.patch.yml`）加配置：

```yml
plugins:
  ui-dsh-opencode-usage:
    adapters:
      host:
        - provider: my-relay
          file: ~/.dsh/my-relay-host.mjs   # enabled 缺省 true；false 可只留候选不启用
      client:
        - file: ~/.dsh/my-relay-client.js
```

3. 重启 `dsh web`（bundle 层启动时组合）。

4. 冒烟：

```sh
# 候选已注册且启用
curl -s http://127.0.0.1:3080/api/dsh-opencode-usage/adapters.json

# 会话模型选到 my-relay provider 后，浮窗出现「中转 额度 xx%」；
# 或直接验证取数链路（provider 参数）：
curl -s "http://127.0.0.1:3080/api/dsh-opencode-usage/stats?provider=my-relay"
```

## 切换启用适配器

同一 provider 有多个候选时（如内置 + 本示例），任一时刻只启用一个：

```sh
# 切到本示例适配器
curl -s -X POST http://127.0.0.1:3080/api/dsh-opencode-usage/adapters/select \
  -H 'Content-Type: application/json' \
  -d '{"provider":"my-relay","adapterId":"my-relay"}'

# 切回内置（opencode-go 场景）
curl -s -X POST http://127.0.0.1:3080/api/dsh-opencode-usage/adapters/select \
  -H 'Content-Type: application/json' \
  -d '{"provider":"opencode-go","adapterId":"opencode-go-builtin"}'
```

切换后该 provider 缓存立即失效，浮窗下一个轮询周期即展示新启用适配器的数据。

## 安全须知

- **宿主 `.mjs` 拥有完整 Node 权限**（网络/文件/环境变量），等同你自己写的插件进程；
  仅加载你信任的本地文件。
- **客户端 `.js`** 与其它 web 插件同信任级（浏览器沙箱内）；契约版本不符只 warn 跳过。
- 插件的 stripSecrets 护栏会对你返回的数据做密钥脱敏（键名 + 值模式），但这是尽力而为，
  **不要**在 `ProviderUsage` / 胶囊文案里回传密钥。
