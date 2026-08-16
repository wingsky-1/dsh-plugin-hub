# @wingsky/dsh-gzip

/api 响应 gzip 压缩插件：解决远程/低带宽访问时「历史加载失败：The user aborted a request.（internal）」的问题（历史页响应大且无压缩，浏览器超时）。

## 安装

```sh
dsh plugin --profile web add @wingsky/dsh-gzip
```

安装后**重启一次** `dsh web`。

## 验证

```sh
# 1. 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-gzip/health
# → {"ok":true,"plugin":"dsh-gzip","mounted":"replace",...}

# 2. 响应头带 content-encoding: gzip
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3080/api/session.list \
  -H "Content-Type: application/json" -H "Accept-Encoding: gzip" \
  -d '{"type":"client-request","rpcId":"test","method":"session.list","payload":{}}' \
  | grep -i content-encoding
```

## 工作原理与安全边界

- **压缩条件**：请求 `Accept-Encoding` 协商 gzip（q=0 视为拒绝）且响应
  content-type 可压缩（JSON/JSON 系/text）且未自带 `content-encoding`。
- **豁免**：SSE（`text/event-stream`）、zip 导出、未协商、已编码——原样透传。
- **实例级遮蔽**：writeHead/write/end 仅在本请求的 ServerResponse 实例上替换，
  不动任何 prototype，请求结束自然释放；gzip 背压与 res 的 drain 事件桥接。
- **无全局副作用**：卸载恢复被替换的 handler 与 register（身份级恢复）。
- **依赖非公开字段**：主挂点读取 `webServer.prefixes`（实例公开字段但非
  官方 API）。上游改结构时自动退化到备用挂点（register patch），若时序不利则
  表现为「不压缩、不报错」——安全降级，可用 health 路由诊断 `mounted` 状态。
- 本插件仅路由 /api 前缀（loopback 围栏，非回环 403 / 方法错 405）。

## 定位

过渡方案：根治在上游（历史响应瘦身 / 官方压缩 / 超时策略），上游修复后本插件
自然退场；即使失效也只是「不压缩」，不会破坏任何功能。

## 开发

```sh
# 源码在 src/*.ts，改后必须 build（dsh 直接 import lib 产物）
pnpm --filter @wingsky/dsh-gzip build
node test/smoke.mjs
```

冒烟测试覆盖：q 值解析、SSE/已编码豁免、真实 zlib 压缩解压一致、双挂点
（已注册 replace / 未注册 register-patch）、非 /api 路由不受影响、卸载恢复、
health 路由（GET 200 / POST 405 / 非回环 403）、enabled=false 不注册。

## License

MIT。压缩包装逻辑借鉴上游 [040822/dsh-gzip](https://github.com/040822/dsh-gzip)（MIT）。
