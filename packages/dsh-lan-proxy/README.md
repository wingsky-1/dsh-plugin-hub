# @wingsky-1/dsh-lan-proxy
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-lan-proxy)](https://www.npmjs.com/package/@wingsky-1/dsh-lan-proxy)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

局域网访问 dsh web UI：在 `0.0.0.0:<port>` 监听，把 HTTP/HTTPS 与 WebSocket/wss
转发到回环 web 服务器（默认 `127.0.0.1:3080`）。

- 重写 Host/Origin 以通过 /api 浏览器信任围栏
- 仅接受 IP 字面量或 localhost 的 Host 头（**DNS 重绑定防护**）
- HTTPS 默认并存（3443），证书可配置或自动生成自签名

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
```

> ⚠️ **安装即开端口**：本插件会在 `0.0.0.0:3081`（HTTP）与 `0.0.0.0:3443`（HTTPS）监听，局域网内所有设备都可访问你的 dsh web。不需要时请卸载（见上方 remove）。

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
| `httpCompressEnabled` | `true` | HTTP 响应压缩总开关（Brotli/gzip 自适应协商，合并自 dsh-gzip） |
| `httpCompressLevel` | `1` | 压缩档位预设 0..3：`0` 默认 / `1` 低（gzip 1 / br 2，最快）· `2` 中（gzip 5 / br 5，均衡）/ `3` 高（gzip 9 / br 9，最高压缩比），对 gzip 与 Brotli **同时生效**；旧配置整数 4..9 自动迁移为 3 |

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

## HTTP 响应压缩（Brotli/gzip 自适应，合并自 dsh-gzip）

- v0.1.10 起，原独立插件 dsh-gzip（源码已自本仓移除）的 HTTP 响应压缩能力已合并进本插件，
  在**转发层**实现（成熟开源库 [compression](https://www.npmjs.com/package/compression)
  中间件，构建期内联进产物）：经本插件访问时，对 `/api`（RPC）、
  `/plugins`（客户端 bundle）与静态资源/index.html 等可压缩响应（JSON / 文本）
  自动协商压缩——客户端 Accept-Encoding 含 br 时优先 Brotli，否则回退 gzip；SSE（text/event-stream）、zip 导出、已编码响应、HEAD、
  带 Range 的请求、小于 1KB 的响应原样透传。
- 收益：会话历史等大 JSON 响应（4~13MB 未压缩）经远程/慢链路访问时常触发
  浏览器 RPC 30s 超时「历史加载失败」；压缩后约 ~1.2MB，隔离环境实测由
  ~36s 降到 ~3s。
- 实现位置在转发器自己的监听链上，不修改 dsh web 与任何其他插件的运行时行为；
  `httpCompressEnabled: false` 一键关闭。注意：直连回环 web（本机浏览器访问
  `127.0.0.1:3080`，不经本插件）的流量不在压缩面内——回环链路无需压缩。
- **从 dsh-gzip 迁移**：升级本插件并确认压缩生效后，卸载独立 gzip 包：

  ```sh
  dsh plugin --profile web update @wingsky-1/dsh-lan-proxy    # 需 >= 0.1.10
  curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health      # 回环校验：httpCompressMounted 为 true 再继续
  dsh plugin --profile web remove @wingsky-1/dsh-gzip
  # 重启 dsh web 生效
  ```

- 存量 gzip@0.1.9（无检测逻辑）与本插件双装时，因 content-encoding 检查只会
  压缩一次（已实测任意装配顺序均单层），不会损坏响应；建议尽快卸载以免
  health 诊断口径混淆。

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
- **HTTP 响应压缩**：压缩在转发层完成，只作用于「本插件与局域网客户端之间」
  的链路，不触碰 dsh web 的响应生成；不新增可达数据面，仅增加少量 CPU 开销
  （可经 `httpCompressEnabled: false` 关闭）。health/标记路由的 loopback 围栏
  对**直连回环 web** 的请求生效；经本插件转发的请求按设计视为受信（见凭据面）

## 验证

```sh
# 健康检查（回环；含压缩配置与生效状态/协商计数）
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health

# 合并版压缩标记路由（回环）
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/compression

# 局域网访问（在另一台设备上）
curl http://<本机局域网IP>:3081/api/dsh-lan-proxy/health
```

## 已知限制

- HTTPS 需要系统 `openssl`（不可用且未配置证书文件时，HTTPS 通道自动降级关闭）
- 换网段导致 IP 变化时，自签名证书需重新生成或更新 config.json
- 命中 `wsCompressPaths` 的 WebSocket 走「终结 + 压缩桥接」（多一跳、额外压缩 CPU），
  仅建议对 events 这类大流量路径开启；其余 WebSocket 保持透传

## License

MIT
