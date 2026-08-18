# @wingsky-1/dsh-gzip

DSH Web GUI 的 `/api` 响应 gzip 压缩插件：为远程 / 低带宽链路开启 `/api` 响应
压缩，解决「历史加载失败：The user aborted a request.（internal）」的问题。

## 为什么需要

DSH Web GUI 加载会话历史时，一页历史可能包含全部流式 chunk 事件，响应体可达
4~13MB 且服务端默认不压缩；浏览器侧 RPC 又有 30s 硬超时。在低带宽链路
（easytier / ZeroTier / Tailscale / 移动网络）上会直接超时失败。

本插件在服务端对可压缩的 `/api` 响应做 gzip 压缩：同一页历史压缩后约 1.2MB，
实测加载时间由约 36s 降到约 3s（隔离环境）。

## 安装

```sh
# 锁定 0.1.3 稳定版（避免解析漂移到历史/未稳定版本）
dsh plugin --profile web add @wingsky-1/dsh-gzip@0.1.3
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

`mounted` 反映当前的实际接管方式（`replace` / `register-patch`），见下方
「工作原理」。

## 工作原理

- **压缩条件**：请求 `Accept-Encoding` 协商 gzip（q=0 视为拒绝）且响应
  content-type 可压缩（JSON / JSON 系 / text）且未自带 `content-encoding`。
- **双分支挂点、无时序依赖**：优先直接替换 `webServer.prefixes` 中已注册的
  `/api` route.handler（运行时替换立即生效）；`register` patch 仅作兜底，
  覆盖本插件先装配或 `/api` 未来重新注册的情形。
- **实例级遮蔽**：writeHead / write / end 仅在本请求的 ServerResponse 实例上
  替换，不动任何 prototype，请求结束自然释放；gzip 背压与 res 的 drain 事件
  桥接。

## 安全模型

- **豁免原样透传**：SSE（`text/event-stream`）、zip 导出、未协商 gzip、已自带
  `content-encoding` 的响应——一律不压缩、原样透传，避免破坏流式或已编码语义。
- **只作用于 /api**：路由 loopback 围栏（非回环 403 / 方法错 405）；健康检查
  路由仅回环可访问。
- **无全局副作用**：卸载恢复被替换的 handler 与 register（身份级恢复）；
  `enabled: false` 时不注册任何东西。
- **依赖非公开字段**：主挂点读取 `webServer.prefixes`（实例公开字段但非官方
  API）。上游改结构时自动退化到备用挂点（register patch），若时序不利则表现为
  「不压缩、不报错」——安全降级，可用 health 路由诊断 `mounted` 状态。

## 定位

过渡方案：根治在上游（历史响应瘦身 / 官方压缩 / 超时策略），上游修复后本插件
自然退场；即使失效也只是「不压缩」，不会破坏任何功能。

## 开发

```sh
# 源码在 src/*.ts，改后必须 build（dsh 直接 import lib 产物）
pnpm --filter @wingsky-1/dsh-gzip build
node test/smoke.mjs
```

冒烟测试覆盖：q 值解析、SSE / 已编码豁免、真实 zlib 压缩解压一致、双挂点
（已注册 replace / 未注册 register-patch）、非 /api 路由不受影响、卸载恢复、
health 路由（GET 200 / POST 405 / 非回环 403）、`enabled: false` 不注册。

## License

MIT。压缩包装逻辑借鉴上游 [040822/dsh-gzip](https://github.com/040822/dsh-gzip)（MIT）。
