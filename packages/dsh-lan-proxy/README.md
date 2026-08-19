# @wingsky-1/dsh-lan-proxy

局域网访问 dsh web UI：在 `0.0.0.0:<port>` 监听，把 HTTP/HTTPS 与 WebSocket/wss
转发到回环 web 服务器（默认 `127.0.0.1:3080`）。

- 重写 Host/Origin 以通过 /api 浏览器信任围栏
- 仅接受 IP 字面量或 localhost 的 Host 头（**DNS 重绑定防护**）
- HTTPS 默认并存（3443），证书可配置或自动生成自签名

## 安装

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

安装后**重启一次** `dsh web`。插件注入 webServer，仅在回环服务器绑定后启动，
并自动解析真实上游端口。

> ⚠️ **安装即开端口**：本插件会在 `0.0.0.0:3081`（HTTP）与 `0.0.0.0:3443`
> （HTTPS）监听，局域网内所有设备都可访问你的 dsh web。不需要时请
> `dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `3081` | HTTP 监听端口 |
| `httpsPort` | `3443` | HTTPS 监听端口 |
| `targetHost` | `127.0.0.1` | 回环上游主机（**仅允许回环地址**） |
| `targetPort` | 自动 | 上游端口（默认取 web 服务器实际绑定端口） |
| `httpsEnabled` | `true` | 是否并存 HTTPS |
| `tlsCertFile` / `tlsKeyFile` | 无 | 自定义证书（mkcert 等） |
| `wsCompressEnabled` | `true` | 是否对命中 `wsCompressPaths` 的 WebSocket 做压缩桥接 |
| `wsCompressPaths` | `/api/events.mux, /api/events.host` | 参与 WebSocket 压缩的路径白名单 |

GUI 设置入口：设置 → 插件 → 「局域网访问」卡片（保存即热更新）。

## WebSocket 压缩（wss 事件流）

- 对命中 `wsCompressPaths`（默认会话事件流 `/api/events.mux`、`/api/events.host`）
  的 WebSocket 升级，lan-proxy 做**终结 + permessage-deflate**：浏览器段压缩
  （浏览器自动协商并解压）、DSH 段明文，再双向桥接转发。
- 收益：events.mux/events.host 是 dsh 实时事件流（会话轨迹/进度），未压缩时
  经远程/慢链路访问流量大；permessage-deflate 实测约省 **75~79%**。
- DSH 服务端即使未来自身开启 permessage-deflate，这里 DSH 段固定不协商压缩，
  两段各自独立，**不会双重压缩、不冲突**。
- 其余 WebSocket 路径保持 TCP 字节透传（不受影响）。

## HTTPS 支持

- **证书来源（两级）**：① 配置 `tlsCertFile`/`tlsKeyFile`（正式证书或 mkcert
  本地 CA，浏览器零警告）；② 自动生成自签名证书（系统 `openssl` 生成并缓存到
  `<DSH_HOME>/lan-proxy/`，私钥权限 0600）
- 自签名证书首次访问需手动"继续访问"；内网设备零警告推荐 mkcert

## 安全模型

- **出站目标白名单（L1）**：`targetHost` 仅允许回环地址（localhost / 127.0.0.1 /
  ::1），配置层与运行时入口双重校验——**防止开放转发/SSRF**
- **DNS 重绑定防护**：只接受 Host 为 IP 字面量或 `localhost` 的请求，域名一律
  403/断开；IP 字面量在任何端口都安全
- **凭据面**：dsh settings RPC 仅回环可读写；通过本插件访问的远程设备在
  浏览器信任围栏内可读写服务器 settings（**含凭据类数据**）——确保你的局域网
  可信，或禁用该插件
- **私钥权限**：自动生成的自签名私钥落盘 0600
- **开放端口提醒**：0.0.0.0 监听对局域网所有设备可见

## 验证

```sh
# 健康检查（回环）
curl -s http://127.0.0.1:3081/api/lan-proxy/health

# 局域网访问（在另一台设备上）
curl http://<本机局域网IP>:3081/api/dsh-gzip/health
```

## 已知限制

- HTTPS 需要系统 `openssl`（不可用且未配置证书文件时，HTTPS 通道自动降级关闭）
- 换网段导致 IP 变化时，自签名证书需重新生成或更新 config.json
- 命中 `wsCompressPaths` 的 WebSocket 走「终结 + 压缩桥接」（多一跳、额外压缩 CPU），
  仅建议对 events 这类大流量路径开启；其余 WebSocket 保持透传

## License

MIT
